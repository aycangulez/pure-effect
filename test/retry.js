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
                        attempts: 2,
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
        assert.equal(sawError.attempts, 2);
        assert.equal(sawError.lastError.message, 'down');
    });

    it('should propagate a failing fallback unwrapped', async function () {
        const flow = Retry(
            Command(function cmdPrimary() {
                return Promise.reject('primary down');
            }),
            { attempts: 1, delay: 0, onExhausted: () => Failure('cache empty') }
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
                attempts: 1,
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
                    attempts: 1,
                    delay: 0,
                    onExhausted: () =>
                        Command(function cmdFetchCached() {
                            calls.cached++;
                            return Promise.resolve(95);
                        })
                }
            );
        const { result, trace } = await recordEffect(flow, 'sku-1');
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
                    attempts: 1,
                    delay: 0,
                    onExhausted: () =>
                        Retry(
                            Command(function cmdSecondary() {
                                return Promise.reject('still nope');
                            }),
                            { attempts: 2, delay: 200 }
                        )
                }
            );
        const { trace } = await recordEffect(flow, 1);
        const started = Date.now();
        const { result: replayed } = /** @type {any} */ (await replayEffect(flow(1), trace));
        const elapsed = Date.now() - started;
        assert.equal(replayed.type, 'Failure');
        assert.ok(elapsed < 150, `replay must not wait out the fallback backoff, took ${elapsed}ms`);
    });
});

describe('Retry attempts and the removed global retry', function () {
    beforeEach(function () {
        configureEffect();
    });

    const failing = () =>
        Command(function cmdAlwaysFails() {
            return Promise.reject(new Error('down'));
        });

    it('should refuse attempts that are not a positive integer as the Retry is built', function () {
        // A Retry that does not retry is not a Retry. `attempts: 0` was also the one spelling that
        // turned `onExhausted` into a plain catch at no cost, which is not what the option is for.
        // It was checked only when the Retry ran, after the Commands ahead of it, and as a plain TypeError,
        // while a misspelt name was an EffectTypeError as the flow was built.
        for (const attempts of [0, -1, 1.5, '3', null]) {
            assert.throws(() => Retry(failing(), { attempts: /** @type {any} */ (attempts) }), {
                name: 'EffectTypeError',
                message: /Retry 'attempts' must be a positive integer, received/
            });
        }
    });

    it('should name the alternatives when it rejects attempts', function () {
        assert.throws(() => Retry(failing(), { attempts: 0 }), /settled|data/);
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
        // checked again on every run: a changed `attempts: 0` would make `onExhausted` a free catch.
        let fallbacks = 0;
        const given = { attempts: 1, delay: 0, onExhausted: () => (fallbacks++, Success('fallback')) };
        const retry = Retry(failing(), given);
        given.attempts = 0;
        assert.equal(retry.options.attempts, 1, "a change to the caller's object does not reach the node");
        assert.throws(() => {
            /** @type {any} */ (retry.options).attempts = 0;
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
        const result = await runEffect(Retry(flaky(), { attempts: 1, delay: 1 }));
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
        // A config key that is absent arrives as undefined, and it used to override the default: `attempts`
        // threw, and `backoff` made every wait after the first NaN milliseconds, which is no wait at all.
        /** @type {number[]} */
        const stamps = [];
        const timed = Command(function cmdTimed() {
            stamps.push(performance.now());
            return Promise.reject(new Error('down'));
        });
        const result = await runEffect(Retry(timed, { attempts: undefined, delay: 20, backoff: undefined }));
        assert.equal(result.type, 'Failure');
        assert.equal(stamps.length, 4, 'attempts keeps the default of three retries');
        const waits = stamps.slice(1).map((stamp, i) => stamp - stamps[i]);
        assert.ok(
            waits.every((ms) => ms >= 15),
            `backoff keeps the flat default, waits were ${waits}`
        );
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

    it('should refuse a retry key in configureEffect, as any key no hook has', function () {
        assert.throws(() => configureEffect(/** @type {any} */ ({ retry: { attempts: 5 } })), {
            name: 'TypeError',
            message: "configureEffect has no option named 'retry'; its options are onStep, onRun and onBeforeCommand."
        });
    });

    it('should refuse a retry key in a per-call config, as any key no hook has', async function () {
        await assert.rejects(() => runEffect(Success(1), undefined, /** @type {any} */ ({ retry: { attempts: 5 } })), {
            name: 'TypeError',
            message:
                "runEffect's callConfig has no option named 'retry'; its options are onStep, onRun, onBeforeCommand and inherit."
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
            { attempts: 2, delay: 0 }
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
            /runEffect's callConfig has no option named 'onstep'; its options are onStep, onRun, onBeforeCommand and inherit\./
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
