// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Retry,
    Parallel,
    effectPipe,
    runEffect,
    configureEffect,
    recordEffect,
    replayEffect
} from '../index.js';

describe('Retry onExhausted', function () {
    beforeEach(() => configureEffect());

    it('should run the fallback on exhaustion and feed its value downstream', async function () {
        let liveCalls = 0;
        /** @type {any} */
        let sawError;
        const flow = effectPipe(
            (/** @type {any} */ sku) =>
                Retry(
                    Command(function cmdFetchLive() {
                        liveCalls++;
                        return Promise.reject(new Error('down'));
                    }),
                    {
                        retries: 2,
                        delay: 0,
                        onExhausted: (/** @type {any} */ err) => {
                            sawError = err;
                            return Command(function cmdFetchCached() {
                                return Promise.resolve({ sku, amount: 95 });
                            });
                        }
                    }
                ),
            (/** @type {any} */ price) => Success({ ...price, stale: true })
        );
        const result = /** @type {any} */ (await runEffect(flow('sku-1')));
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { sku: 'sku-1', amount: 95, stale: true });
        assert.equal(liveCalls, 3, 'the primary still runs the full retry schedule first');
        assert.equal(sawError.retryExhausted, true);
        assert.equal(sawError.retries, 2);
        assert.equal(sawError.lastError.message, 'down');
    });

    it('should propagate a failing fallback unwrapped', async function () {
        const flow = Retry(
            Command(function cmdPrimary() {
                return Promise.reject('primary down');
            }),
            { retries: 1, delay: 0, onExhausted: () => Failure('cache empty') }
        );
        const result = /** @type {any} */ (await runEffect(flow));
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'cache empty', 'the fallback failure must not be wrapped in retryExhausted');
    });

    it('should not run the fallback in a cancelled Parallel branch', async function () {
        let fallbackRuns = 0;
        let attempt = 0;
        const slowFailing = Retry(
            Command(async function cmdSlowFail() {
                // The first attempt fails at once, so the last one is in flight when the sibling fails. That is
                // the only way to reach the fallback in a cancelled branch: a cancellation during the backoff
                // stops the branch before the next attempt instead.
                if (attempt++ === 0) throw new Error('first attempt failed');
                await new Promise((resolve) => setTimeout(resolve, 30));
                throw new Error('slow branch failed');
            }),
            {
                retries: 1,
                delay: 0,
                onExhausted: () => {
                    fallbackRuns++;
                    return Success('recovered');
                }
            }
        );
        const fastFailing = Command(async function cmdFastFail() {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error('fast branch failed');
        });
        const result = /** @type {any} */ (await runEffect(Parallel([fastFailing, slowFailing])));
        assert.equal(result.type, 'Failure');
        assert.equal(result.error.message, 'fast branch failed');
        assert.equal(fallbackRuns, 0, 'a cancelled branch must not start its fallback');
    });

    it('should record the fallback under its own path and replay it with zero I/O', async function () {
        const calls = { live: 0, cached: 0 };
        const flow = (/** @type {any} */ sku) =>
            Retry(
                Command(function cmdFetchLive() {
                    calls.live++;
                    return Promise.reject(new Error('down'));
                }),
                {
                    retries: 1,
                    delay: 0,
                    onExhausted: () =>
                        Command(function cmdFetchCached() {
                            calls.cached++;
                            return Promise.resolve(95);
                        })
                }
            );
        const { result, trace } = await recordEffect(flow('sku-1'));
        assert.equal(result.type, 'Success');
        assert.ok(
            trace.trace.some((/** @type {any} */ e) => e.command === 'cmdFetchCached' && /f\//.test(e.path)),
            'the fallback step must be recorded under a fallback path prefix'
        );
        const before = { ...calls };
        const { result: replayed } = /** @type {any} */ (await replayEffect(flow('sku-1'), trace));
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(replayed.value, /** @type {any} */ (result).value);
        assert.deepEqual(calls, before, 'replay must perform no I/O');
    });

    it('should strip Retry delays inside the fallback during replay', async function () {
        const flow = (/** @type {any} */ n) =>
            Retry(
                Command(function cmdPrimary() {
                    return Promise.reject('nope');
                }),
                {
                    retries: 1,
                    delay: 0,
                    onExhausted: () =>
                        Retry(
                            Command(function cmdSecondary() {
                                return Promise.reject('still nope');
                            }),
                            { retries: 2, delay: 200 }
                        )
                }
            );
        const { trace } = await recordEffect(flow(1));
        const started = Date.now();
        const { result: replayed } = /** @type {any} */ (await replayEffect(flow(1), trace));
        const elapsed = Date.now() - started;
        assert.equal(replayed.type, 'Failure');
        assert.ok(elapsed < 150, `replay must not wait out the fallback backoff, took ${elapsed}ms`);
    });
});

describe('Retry options and the removed global retry', function () {
    it('should wait as long as setTimeout can hold for a backoff longer than that, rather than not at all', async function () {
        // A wait past 2^31 - 1 ms overflowed setTimeout, which fired after 1 ms, so a long backoff hammered the gateway
        // it was meant to spare. Here the sibling's failure cancels the wait, which still has days to run.
        let attempts = 0;
        const flaky = Retry(
            Command(function cmdCharge() {
                attempts++;
                throw new Error('503');
            }),
            { retries: 1, delay: 3e9 }
        );
        const failing = Command(
            async function cmdLater() {
                await new Promise((resolve) => setTimeout(resolve, 30));
            },
            () => Failure('declined')
        );
        /** @type {string[]} */
        const warnings = [];
        const onWarning = (/** @type {Error} */ w) => void warnings.push(w.name);
        process.on('warning', onWarning);
        try {
            assert.deepEqual(await runEffect(Parallel([flaky, failing])), Failure('declined'));
        } finally {
            process.off('warning', onWarning);
        }
        assert.equal(attempts, 1, 'the second attempt waited');
        assert.deepEqual(warnings, []);
    });
    beforeEach(function () {
        configureEffect();
    });

    const failing = () =>
        Command(function cmdAlwaysFails() {
            return Promise.reject(new Error('down'));
        });

    it('should refuse retries that are not a positive integer as the Retry is built', function () {
        // A Retry that does not retry is not a Retry. `retries: 0` was also the one spelling that
        // turned `onExhausted` into a plain catch at no cost, which is not what the option is for.
        // It was checked only when the Retry ran, after the Commands ahead of it, and as a plain TypeError,
        // while a misspelt name was an EffectTypeError as the flow was built.
        for (const retries of [0, -1, 1.5, '3', null]) {
            assert.throws(() => Retry(failing(), { retries: /** @type {any} */ (retries) }), {
                name: 'EffectTypeError',
                message: /Retry 'retries' must be a positive integer, received/
            });
        }
    });

    it('should refuse a third argument, which nothing reads', function () {
        // `Retry(effect, options, next)` dropped the next without a word, while Parallel refused an argument it
        // would ignore.
        const retry = /** @type {any} */ (Retry);
        assert.throws(() => retry(failing(), { retries: 1 }, (/** @type {any} */ x) => Success(x)), {
            name: 'EffectTypeError',
            message: /Retry takes no next: continue in the step after the Retry/
        });
        assert.throws(() => retry(failing(), { retries: 1 }, { delay: 5 }), {
            name: 'EffectTypeError',
            message: /Retry takes the Effect and its options, so its third argument, a plain object, would be ignored/
        });
        // An absent third argument, as a caller forwarding one may pass, is still fine.
        assert.doesNotThrow(() => retry(failing(), { retries: 1 }, undefined));
        assert.doesNotThrow(() => retry(failing(), undefined, null));
    });

    it('should name retryIf when it rejects retries: 0', function () {
        assert.throws(() => Retry(failing(), { retries: 0 }), /return false for it from retryIf.*onExhausted/);
    });

    it('should refuse an onExhausted that is not a function as the Retry is built', function () {
        // Anything else meant no fallback, so `onExhausted: fetchCachedPrice(sku)`, the Effect rather than a
        // function returning it, failed with the exhaustion it was written to handle.
        assert.throws(() => Retry(failing(), { onExhausted: /** @type {any} */ (Success(0)) }), {
            name: 'EffectTypeError',
            message:
                /Retry 'onExhausted' must be a function that returns the fallback, received an Effect of type 'Success'/
        });
    });

    it('should keep a frozen copy of the options a Retry or Parallel is built with', async function () {
        // A node kept the caller's own options object, which could change after the check, so the options were
        // checked again on every run: a changed `retries: 0` would make `onExhausted` a free catch.
        let fallbacks = 0;
        const given = { retries: 1, delay: 0, onExhausted: () => (fallbacks++, Success('fallback')) };
        const retry = Retry(failing(), given);
        given.retries = 0;
        assert.equal(retry.options.retries, 1, "a change to the caller's object does not reach the node");
        assert.throws(() => {
            /** @type {any} */ (retry.options).retries = 0;
        }, TypeError);
        assert.deepEqual(await runEffect(retry), Success('fallback'));
        assert.equal(fallbacks, 1);

        const limits = { limit: 1 };
        const parallel = Parallel([Success(1), Success(2)], limits);
        limits.limit = 0;
        assert.equal(parallel.options?.limit, 1);
        assert.throws(() => {
            /** @type {any} */ (parallel.options).limit = 0;
        }, TypeError);
        assert.deepEqual(await runEffect(parallel), Success([1, 2]));
    });

    it('should still accept the smallest real retry', async function () {
        let calls = 0;
        const flaky = () =>
            Command(function cmdFlaky() {
                calls++;
                return calls === 1 ? Promise.reject(new Error('down')) : Promise.resolve('ok');
            });
        const result = await runEffect(Retry(flaky(), { retries: 1, delay: 1 }));
        assert.deepEqual(result, Success('ok'));
        assert.equal(calls, 2);
    });

    it('should apply the library retry defaults when a Retry names none', async function () {
        let calls = 0;
        const counted = () =>
            Command(function cmdCounted() {
                calls++;
                return Promise.reject(new Error('down'));
            });
        const result = await runEffect(Retry(counted(), { delay: 1 }));
        assert.equal(result.type, 'Failure');
        assert.equal(calls, 4, 'the default is three retries after the first try');
    });

    it('should treat an option passed as undefined as unset', async function () {
        // A config key that is absent arrives as undefined, and it used to override the default: the retry
        // count threw, and `backoff` made every wait after the first NaN milliseconds, which is no wait at all.
        /** @type {number[]} */
        const stamps = [];
        const timed = Command(function cmdTimed() {
            stamps.push(performance.now());
            return Promise.reject(new Error('down'));
        });
        const result = await runEffect(Retry(timed, { retries: undefined, delay: 20, backoff: undefined }));
        assert.equal(result.type, 'Failure');
        assert.equal(stamps.length, 4, 'retries keeps its default of three');
        const waits = stamps.slice(1).map((stamp, i) => stamp - stamps[i]);
        assert.ok(
            waits.every((ms) => ms >= 15),
            `backoff keeps the flat default, waits were ${waits}`
        );
    });

    it('should treat an onExhausted passed as undefined as no fallback', async function () {
        // The types refused it, as no other option, so a fallback chosen at runtime needed two Retry calls.
        const result = await runEffect(Retry(failing(), { retries: 1, delay: 0, onExhausted: undefined }));
        assert.equal(result.type, 'Failure');
        assert.equal(/** @type {any} */ (result).error.retryExhausted, true);
    });

    it('should refuse a delay or backoff that is not a finite number of 0 or more as the Retry is built', function () {
        // Each of these used to mean no wait at all, so a flapping dependency was called back to back.
        for (const bad of [NaN, -1, Infinity, '250ms', null]) {
            const value = /** @type {any} */ (bad);
            assert.throws(() => Retry(failing(), { delay: value }), { name: 'EffectTypeError' });
            assert.throws(() => Retry(failing(), { backoff: value }), { name: 'EffectTypeError' });
        }
        assert.throws(() => Retry(failing(), { delay: NaN }), /Retry 'delay' .*the number NaN/);
    });

    it('should name a function given as a backoff plainly', function () {
        // It once guessed that a flow had been passed without its input, which an option never is.
        const grow = /** @type {any} */ (() => 2);
        assert.throws(
            () => Retry(failing(), { backoff: grow }),
            (/** @type {Error} */ error) => {
                assert.equal(
                    error.message,
                    "Retry 'backoff' must be a finite number of 0 or more, received a function."
                );
                return true;
            }
        );
    });

    it('should wait what a delay function returns for the error thrown and the attempt about to run', async function () {
        /** @type {number[]} */
        const stamps = [];
        /** @type {[any, number][]} */
        const asked = [];
        const limited = Command(function cmdLimited() {
            stamps.push(performance.now());
            return Promise.reject(Object.assign(new Error('rate limited'), { retryAfterMs: 30 * stamps.length }));
        });
        const delay = (/** @type {any} */ error, /** @type {number} */ attempt) => {
            asked.push([error.retryAfterMs, attempt]);
            return error.retryAfterMs;
        };
        const result = await runEffect(Retry(limited, { retries: 2, delay }));
        assert.equal(result.type, 'Failure');
        assert.deepEqual(asked, [
            [30, 1],
            [60, 2]
        ]);
        const waits = stamps.slice(1).map((stamp, i) => stamp - stamps[i]);
        assert.ok(waits[0] >= 25 && waits[0] < 55, `the first wait is the 30 ms asked for, was ${waits[0]}`);
        assert.ok(waits[1] >= 55, `the second wait is the 60 ms asked for, was ${waits[1]}`);
    });

    it('should hand a delay function the exhaustion of a Retry it wraps', async function () {
        /** @type {any[]} */
        const seen = [];
        const delay = (/** @type {any} */ error) => {
            seen.push(error);
            return 0;
        };
        await runEffect(Retry(Retry(failing(), { retries: 1, delay: 0 }), { retries: 1, delay }));
        assert.equal(seen.length, 1);
        assert.equal(seen[0].retryExhausted, true);
        assert.equal(seen[0].lastError.message, 'down');
    });

    it('should refuse a backoff beside a delay function, which grows its own wait', function () {
        assert.throws(() => Retry(failing(), { delay: () => 10, backoff: 2 }), {
            name: 'EffectTypeError',
            message: /^Retry 'backoff' multiplies a delay given as a number/
        });
        // An absent config key arrives as undefined, and keeps meaning no backoff.
        assert.doesNotThrow(() => Retry(failing(), { delay: () => 10, backoff: undefined }));
    });

    it('should reject the run when a delay function returns no wait, rather than retry at once', async function () {
        let calls = 0;
        const counted = Command(function cmdCounted() {
            calls++;
            return Promise.reject(new Error('down'));
        });
        for (const bad of [undefined, NaN, -1, '250', Infinity]) {
            calls = 0;
            const delay = /** @type {any} */ (() => bad);
            await assert.rejects(runEffect(Retry(counted, { retries: 2, delay })), {
                name: 'EffectTypeError',
                message:
                    /^Retry's delay function must return a finite number of 0 or more, and it returned .* before attempt 1\.$/
            });
            assert.equal(calls, 1, 'no attempt follows a wait that could not be read');
        }
    });

    it('should reject the run with what a delay function throws, and not retry it', async function () {
        let calls = 0;
        const counted = Command(function cmdCounted() {
            calls++;
            return Promise.reject(new Error('down'));
        });
        const delay = () => {
            throw new RangeError('bug in the delay function');
        };
        // An enclosing Retry must not take the bug for an outage.
        const flow = Retry(Retry(counted, { retries: 2, delay }), { retries: 3, delay: 0 });
        await assert.rejects(runEffect(flow), { name: 'RangeError', message: 'bug in the delay function' });
        assert.equal(calls, 1);
    });

    it('should not ask a delay function for a wait in a branch already cancelled', async function () {
        let asked = 0;
        const slowToFail = Command(function cmdSlowToFail() {
            return new Promise((resolve, reject) => setTimeout(() => reject(new Error('down')), 20));
        });
        const stops = Command(
            function cmdStops() {
                return Promise.resolve('no');
            },
            (/** @type {string} */ reason) => Failure(reason)
        );
        const delay = () => {
            asked++;
            return 0;
        };
        const result = await runEffect(Parallel([stops, Retry(slowToFail, { retries: 2, delay })]));
        assert.deepEqual(result, Failure('no'));
        assert.equal(asked, 0);
    });

    describe('retryIf', function () {
        /** A Command that throws each error in turn, then returns 'ok', and counts its calls. */
        const throwing = (/** @type {any[]} */ errors) => {
            const state = { calls: 0 };
            const effect = Command(function cmdCall() {
                state.calls++;
                const error = errors[state.calls - 1];
                return error === undefined ? Promise.resolve('ok') : Promise.reject(error);
            });
            return { state, effect };
        };
        const http = (/** @type {number} */ status) => Object.assign(new Error(`HTTP ${status}`), { status });
        const transient = (/** @type {any} */ error) => error.status >= 500;

        it('should try again while it returns true, with the error thrown and the attempt about to run', async function () {
            const { state, effect } = throwing([http(503), http(502)]);
            /** @type {[number, number][]} */
            const asked = [];
            const retryIf = (/** @type {any} */ error, /** @type {number} */ attempt) => {
                asked.push([error.status, attempt]);
                return transient(error);
            };
            const result = await runEffect(Retry(effect, { retries: 3, delay: 0, retryIf }));
            assert.deepEqual(result, Success('ok'));
            assert.equal(state.calls, 3);
            assert.deepEqual(asked, [
                [503, 1],
                [502, 2]
            ]);
        });

        it('should give up at once when it returns false, with the retries made in the exhaustion', async function () {
            const { state, effect } = throwing([http(503), http(404), http(503)]);
            const result = await runEffect(Retry(effect, { retries: 5, delay: 0, retryIf: transient }));
            assert.equal(state.calls, 2, 'the 404 is not retried');
            assert.equal(result.type, 'Failure');
            const error = /** @type {any} */ (result).error;
            assert.equal(error.retryExhausted, true);
            assert.equal(error.lastError.status, 404);
            assert.equal(error.retries, 1, 'one retry was made, not the five allowed');
        });

        it('should hand what it gave up on to onExhausted, whose value the flow goes on with', async function () {
            const { state, effect } = throwing([http(404)]);
            /** @type {any} */
            let seen;
            const flow = effectPipe(
                () =>
                    Retry(effect, {
                        retries: 3,
                        delay: 0,
                        retryIf: transient,
                        onExhausted: (/** @type {any} */ exhausted) => {
                            seen = exhausted;
                            return Success({ found: false, status: exhausted.lastError.status });
                        }
                    }),
                (/** @type {any} */ answer) => Success(answer.found === false ? 'missing' : 'there')
            );
            assert.deepEqual(await runEffect(flow(null)), Success('missing'));
            assert.equal(state.calls, 1);
            assert.equal(seen.retries, 0);
            assert.equal(seen.lastError.status, 404);
        });

        it('should not ask after the last attempt, which is exhaustion whatever it would say', async function () {
            const { state, effect } = throwing([http(503), http(503), http(503)]);
            let asked = 0;
            const retryIf = () => {
                asked++;
                return true;
            };
            const result = await runEffect(Retry(effect, { retries: 2, delay: 0, retryIf }));
            assert.equal(state.calls, 3);
            assert.equal(asked, 2);
            assert.equal(/** @type {any} */ (result).error.retries, 2);
        });

        it('should wait for nothing before giving up', async function () {
            const { effect } = throwing([http(400)]);
            let waits = 0;
            const delay = () => {
                waits++;
                return 5000;
            };
            const started = performance.now();
            await runEffect(Retry(effect, { retries: 2, delay, retryIf: transient }));
            assert.equal(waits, 0);
            assert.ok(performance.now() - started < 1000);
        });

        it('should leave an abort alone, which is never retried and never asked about', async function () {
            let asked = 0;
            const stops = Command(
                function cmdStops() {
                    return Promise.resolve(1);
                },
                () => Failure('no')
            );
            const retryIf = () => {
                asked++;
                return true;
            };
            assert.deepEqual(await runEffect(Retry(stops, { retries: 2, delay: 0, retryIf })), Failure('no'));
            assert.equal(asked, 0);
        });

        it('should let an enclosing Retry decide on the exhaustion of the one it wraps', async function () {
            const { state, effect } = throwing([http(404), http(404), http(404)]);
            /** @type {any[]} */
            const outerSaw = [];
            const inner = Retry(effect, { retries: 3, delay: 0, retryIf: transient });
            const outer = Retry(inner, {
                retries: 2,
                delay: 0,
                retryIf: (/** @type {any} */ error) => {
                    outerSaw.push(error);
                    return error.lastError.status !== 404;
                }
            });
            const result = await runEffect(outer);
            assert.equal(state.calls, 1, 'neither Retry tries a 404 again');
            assert.equal(outerSaw.length, 1);
            assert.equal(outerSaw[0].retryExhausted, true);
            const error = /** @type {any} */ (result).error;
            assert.equal(error.retries, 0);
            assert.equal(error.lastError.lastError.status, 404);
        });

        it('should refuse a retryIf that is not a function as the Retry is built', function () {
            assert.throws(() => Retry(failing(), { retryIf: /** @type {any} */ (true) }), {
                name: 'EffectTypeError',
                message:
                    /^Retry 'retryIf' must be a function that returns whether to try again, received the boolean true\./
            });
            assert.doesNotThrow(() => Retry(failing(), { retryIf: undefined }));
        });

        it('should reject the run when it returns neither true nor false, rather than give up', async function () {
            for (const [bad, hint] of /** @type {[any, RegExp][]} */ ([
                [undefined, /before attempt 1, and it returned undefined, which usually means a missing return\.$/],
                [1, /before attempt 1, and it returned the number 1\.$/],
                ['yes', /^Retry's retryIf must return true or false before attempt 1, and it returned /],
                [null, /before attempt 1, and it returned null\.$/]
            ])) {
                const { state, effect } = throwing([http(503), http(503)]);
                await assert.rejects(runEffect(Retry(effect, { retries: 2, delay: 0, retryIf: () => bad })), {
                    name: 'EffectTypeError',
                    message: hint
                });
                assert.equal(state.calls, 1);
            }
        });

        it('should reject the run with what it throws, and not let an enclosing Retry retry that', async function () {
            const { state, effect } = throwing([http(503), http(503)]);
            const retryIf = () => {
                throw new RangeError('bug in retryIf');
            };
            const flow = Retry(Retry(effect, { retries: 2, delay: 0, retryIf }), { retries: 3, delay: 0 });
            await assert.rejects(runEffect(flow), { name: 'RangeError', message: 'bug in retryIf' });
            assert.equal(state.calls, 1);
        });

        it('should not be asked in a branch already cancelled', async function () {
            let asked = 0;
            const slowToFail = Command(function cmdSlowToFail() {
                return new Promise((resolve, reject) => setTimeout(() => reject(http(503)), 20));
            });
            const stops = Command(
                function cmdStops() {
                    return Promise.resolve('no');
                },
                (/** @type {string} */ reason) => Failure(reason)
            );
            const retryIf = () => {
                asked++;
                return true;
            };
            const result = await runEffect(Parallel([stops, Retry(slowToFail, { retries: 2, delay: 0, retryIf })]));
            assert.deepEqual(result, Failure('no'));
            assert.equal(asked, 0);
        });

        it('should make the same decisions in a replay, from the errors the trace holds', async function () {
            const build = (/** @type {any[]} */ errors) => {
                const { state, effect } = throwing(errors);
                const flow = Retry(effect, {
                    retries: 4,
                    delay: 0,
                    retryIf: transient,
                    onExhausted: (/** @type {any} */ exhausted) =>
                        Success({ gaveUpOn: exhausted.lastError.status, after: exhausted.retries })
                });
                return { state, flow };
            };
            const live = build([http(503), http(404)]);
            const { result, trace } = await recordEffect(live.flow);
            assert.deepEqual(result, Success({ gaveUpOn: 404, after: 1 }));
            assert.equal(live.state.calls, 2);
            const again = build([]);
            const replay = await replayEffect(again.flow, JSON.parse(JSON.stringify(trace)));
            assert.deepEqual(replay.result, result);
            assert.deepEqual(replay.unreached, []);
            assert.equal(replay.changed, null);
            assert.equal(again.state.calls, 0, 'the replay ran no Command');
        });
    });

    it('should not call a delay function in a replay, which does not wait', async function () {
        let asked = 0;
        let calls = 0;
        const flaky = () =>
            Retry(
                Command(function cmdFlaky() {
                    calls++;
                    if (calls < 3) return Promise.reject(new Error('down'));
                    return Promise.resolve('up');
                }),
                {
                    retries: 2,
                    delay: () => {
                        asked++;
                        return 1;
                    }
                }
            );
        const { result, trace } = await recordEffect(flaky());
        assert.deepEqual(result, Success('up'));
        assert.equal(asked, 2);
        calls = 0;
        const replayed = await replayEffect(flaky(), trace);
        assert.deepEqual(replayed.result, Success('up'));
        assert.equal(calls, 0, 'the replay ran no Command');
        assert.equal(asked, 2, 'the replay asked for no wait');
        // With the waits kept, the function gets the error as the trace holds it.
        await replayEffect(flaky(), trace, { fastRetry: false });
        assert.equal(asked, 4);
    });

    it('should refuse a retry key in configureEffect, as any key no hook has', function () {
        assert.throws(() => configureEffect(/** @type {any} */ ({ retry: { retries: 5 } })), {
            name: 'TypeError',
            message: "configureEffect has no option named 'retry'; its options are onStep, onRun and onBeforeCommand."
        });
    });

    it('should refuse a retry key in a per-call config, as any key no hook has', async function () {
        await assert.rejects(() => runEffect(Success(1), undefined, /** @type {any} */ ({ retry: { retries: 5 } })), {
            name: 'TypeError',
            message:
                "runEffect's callConfig has no option named 'retry'; its options are onStep, onRun, onBeforeCommand, inherit and flowName."
        });
    });

    it('should refuse a hook name configureEffect does not read', function () {
        // A misspelt hook was ignored, so telemetry or recording switched off with nothing to say so.
        const hook = async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => op();
        assert.throws(
            () => configureEffect(/** @type {any} */ ({ onstep: hook })),
            /configureEffect has no option named 'onstep'; its options are onStep, onRun and onBeforeCommand\./
        );
    });

    it('should refuse a hook that is not a function, before the run it would turn into an I/O fault', async function () {
        // `onStep: 42` made every Command an I/O fault, so a Retry retried a configuration mistake and reported
        // an exhausted outage for a Command that never ran.
        let calls = 0;
        const flow = Retry(
            Command(function cmdCount() {
                calls++;
                return 1;
            }),
            { retries: 2, delay: 0 }
        );
        assert.throws(
            () => configureEffect(/** @type {any} */ ({ onStep: 42 })),
            /configureEffect's onStep must be a function, got the number 42\./
        );
        assert.throws(() => configureEffect(/** @type {any} */ ({ onBeforeCommand: {} })), TypeError);
        assert.throws(() => configureEffect(/** @type {any} */ ({ onRun: 'audit' })), TypeError);
        await assert.rejects(
            () => runEffect(flow, {}, /** @type {any} */ ({ onStep: 42 })),
            /callConfig\.onStep must be a function/
        );
        await assert.rejects(
            () => runEffect(flow, {}, /** @type {any} */ ({ onstep: () => {} })),
            /runEffect's callConfig has no option named 'onstep'; its options are onStep, onRun, onBeforeCommand, inherit and flowName\./
        );
        assert.equal(calls, 0, 'nothing ran under a refused configuration');
        assert.deepEqual(await runEffect(flow), Success(1), 'and nothing was installed');
    });

    it('should refuse a configuration that is not an object', async function () {
        assert.throws(
            () => configureEffect(/** @type {any} */ ('telemetry')),
            /configureEffect expects configuration objects, got the string "telemetry"\./
        );
        await assert.rejects(
            () => runEffect(Success(1), {}, /** @type {any} */ (42)),
            /runEffect's callConfig must be an object, got the number 42\./
        );
    });

    it('should accept a hook left undefined, as a slot left unset', async function () {
        const remove = configureEffect({ onStep: undefined, onRun: undefined });
        assert.deepEqual(await runEffect(Success(1), {}, { onBeforeCommand: undefined }), Success(1));
        remove();
    });

    it('should refuse null for a configuration or a hook, as the types do', async function () {
        // `configureEffect` skipped any falsy argument and a hook set to null, while `runEffect` refused a null
        // callConfig, so a kill switch wired as `killSwitch ?? null` switched itself off without a word.
        let calls = 0;
        const charge = Command(function cmdCharge() {
            calls++;
            return 'ch_1';
        });
        for (const config of [null, false, 0, '']) {
            assert.throws(
                () => configureEffect(/** @type {any} */ (config)),
                /configureEffect expects configuration objects/
            );
        }
        assert.throws(
            () => configureEffect(/** @type {any} */ ({ onBeforeCommand: null })),
            /configureEffect's onBeforeCommand must be a function, got null\./
        );
        await assert.rejects(
            () => runEffect(charge, {}, /** @type {any} */ ({ onBeforeCommand: null })),
            /callConfig\.onBeforeCommand must be a function, got null\./
        );
        assert.equal(calls, 0);
        assert.doesNotThrow(() => configureEffect(undefined), 'undefined still leaves a configuration out');
    });

    it('should name an array and a function that builds hooks for what they are', async function () {
        // An array was described as a plain object, and a hook factory passed uncalled got a hint about flows.
        assert.throws(
            () => configureEffect(/** @type {any} */ ([{}])),
            /configureEffect expects configuration objects, got an array\./
        );
        const telemetryHooks = () => ({});
        const factoryHint =
            /got a function, which usually means one that builds hooks was passed without being called\./;
        assert.throws(() => configureEffect(/** @type {any} */ (telemetryHooks)), factoryHint);
        await assert.rejects(() => runEffect(Success(1), {}, /** @type {any} */ (telemetryHooks)), factoryHint);
    });

    it('should leave no installed layer behind when configureEffect refuses', function () {
        let calls = 0;
        assert.throws(() =>
            configureEffect(
                /** @type {any} */ ({
                    onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
                        calls++;
                        return op();
                    },
                    retry: {}
                })
            )
        );
        return runEffect(
            Command(function cmdOne() {
                return Promise.resolve(1);
            })
        ).then(() => {
            assert.equal(calls, 0, 'a refused configuration must not install its hooks');
        });
    });
});
