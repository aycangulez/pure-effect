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
import { errorOf } from './helpers.js';

/** @import { CommandInterceptor } from "../index.js" */

describe('Parallel cancellation', function () {
    beforeEach(function () {
        configureEffect();
    });

    /**
     * Resolves after `ms`, or rejects as soon as `signal` aborts.
     * @param {number} ms
     * @param {AbortSignal} [signal] - Optional, matching the Command contract: absent outside a `Parallel`.
     */
    const cancellableSleep = (ms, signal) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                },
                { once: true }
            );
        });

    it('should cancel a branch whose thunk honours the signal', async function () {
        let completed = false;
        const started = Date.now();
        const result = await runEffect(
            Parallel(
                [
                    Command(function cmdFail() {
                        throw new Error('fail_fast');
                    }),
                    Command(async function cmdSlow(/** @type {AbortSignal | undefined} */ signal) {
                        await cancellableSleep(400, signal);
                        completed = true;
                        return 'wrote';
                    })
                ],
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(result.type, 'Failure');
        assert.equal(/** @type {Error} */ (errorOf(result)).message, 'fail_fast');
        assert.equal(completed, false, 'the cancelled branch never finished its work');
        assert.ok(Date.now() - started < 200, 'the run did not wait out the cancelled branch');
    });

    it('should hand the signal only to a function that declares a parameter', async function () {
        // A parameter with a default value does not count toward a function's `length`, so a function passed by
        // name like `nanoid(size = 21)` keeps its default inside a Parallel instead of reading the signal as its size.
        const makeId = /** @type {any} */ ((size = 21) => 'x'.repeat(size | 0));
        /** @type {unknown[]} */
        const seen = [];
        const takesSignal = (/** @type {AbortSignal | undefined} */ signal) => {
            seen.push(signal);
            return 'ok';
        };
        const result = await runEffect(Parallel([Command(makeId), Command(takesSignal)]));
        assert.deepEqual(result, Success(['x'.repeat(21), 'ok']));
        assert.ok(seen[0] instanceof AbortSignal, 'a declared parameter still receives the signal');
    });

    it('should not start a later Command in a cancelled branch', async function () {
        /** @type {string[]} */
        const ran = [];
        const step = (/** @type {string} */ name) => () =>
            Command(
                async function cmdWrite() {
                    await cancellableSleep(30, undefined);
                    ran.push(name);
                    return name;
                },
                (/** @type {any} */ v) => Success(v)
            );
        const result = await runEffect(
            Parallel(
                [
                    Command(async function cmdFail() {
                        await cancellableSleep(5, undefined);
                        throw new Error('validation_failed');
                    }),
                    effectPipe(step('write1'), step('write2'), step('write3'))(null)
                ],
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(result.type, 'Failure');
        assert.deepEqual(ran, ['write1'], 'the in-flight write landed; the two after it never started');
    });

    it('should stop retrying in a cancelled branch', async function () {
        let attempts = 0;
        const result = await runEffect(
            Parallel(
                [
                    Command(async function cmdFail() {
                        await cancellableSleep(30, undefined);
                        throw new Error('primary_failed');
                    }),
                    Retry(
                        Command(function cmdFlaky() {
                            attempts++;
                            throw new Error('flaky');
                        }),
                        { attempts: 5, delay: 100 }
                    )
                ],
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(/** @type {Error} */ (errorOf(result)).message, 'primary_failed');
        assert.ok(attempts < 5, `the cancelled branch stopped retrying (made ${attempts} attempts, not 6)`);
    });

    it('should not wait out a retry backoff in a branch it cancels', async function () {
        // A branch between attempts has nothing in flight, so cancelling it ends the wait at once. Otherwise
        // the Parallel, which waits for every branch, would report its failure only once the backoff ran out.
        const start = Date.now();
        const result = await runEffect(
            Parallel([
                Command(async function cmdFails() {
                    await new Promise((r) => setTimeout(r, 5));
                    throw new Error('declined');
                }),
                Retry(
                    Command(function cmdFlaky() {
                        throw new Error('ECONNRESET');
                    }),
                    { attempts: 1, delay: 1500 }
                )
            ])
        );
        const elapsed = Date.now() - start;
        assert.equal(/** @type {any} */ (result).error.message, 'declined');
        assert.ok(elapsed < 500, `the Parallel reported its failure after ${elapsed} ms`);
    });

    it('should not wait out a retry backoff that starts after the branch was cancelled', async function () {
        // The recommended Command, one that honours the signal, rejects the moment a sibling fails. That is an
        // I/O fault, so the Retry around it starts its backoff on a signal that has already fired, and a
        // listener added to an aborted signal never runs.
        const start = Date.now();
        const result = await runEffect(
            Parallel([
                Command(async function cmdFails() {
                    await new Promise((r) => setTimeout(r, 5));
                    throw new Error('declined');
                }),
                Retry(
                    Command(function cmdFetch(/** @type {AbortSignal | undefined} */ signal) {
                        return cancellableSleep(1000, signal);
                    }),
                    { attempts: 1, delay: 1500 }
                )
            ])
        );
        const elapsed = Date.now() - start;
        assert.equal(/** @type {any} */ (result).error.message, 'declined');
        assert.ok(elapsed < 500, `the Parallel reported its failure after ${elapsed} ms`);
    });

    it('should not start a Command whose onBeforeCommand was still running when the branch was cancelled', async function () {
        // A rate limiter that waits before a Command is an interceptor that performs I/O. The branch was checked
        // for cancellation before the interceptor and not after it, so the charge started once the wait ended,
        // after a sibling had already failed.
        /** @type {string[]} */
        const started = [];
        /** @type {CommandInterceptor} */
        const rateLimiter = async (command) => {
            if (command.meta?.name === 'chargeCard') await new Promise((r) => setTimeout(r, 50));
        };
        const checkout = Command(
            function cmdReserve() {
                started.push('reserve');
                return 'r1';
            },
            () =>
                Command(
                    function cmdCharge() {
                        started.push('charge');
                        return 'ch_1';
                    },
                    undefined,
                    { name: 'chargeCard' }
                )
        );
        const result = await runEffect(
            Parallel([
                checkout,
                Command(async function cmdCheckStock() {
                    await new Promise((r) => setTimeout(r, 10));
                    throw new Error('out of stock');
                })
            ]),
            {},
            { onBeforeCommand: rateLimiter }
        );
        assert.equal(/** @type {any} */ (result).error.message, 'out of stock');
        assert.deepEqual(started, ['reserve'], 'the charge never started');
    });

    it('should propagate cancellation into a nested Parallel', async function () {
        let inner = false;
        const result = await runEffect(
            Parallel(
                [
                    Command(function cmdOuterFail() {
                        throw new Error('outer_failed');
                    }),
                    Parallel(
                        [
                            Command(async function cmdInner(/** @type {AbortSignal | undefined} */ signal) {
                                await cancellableSleep(300, signal);
                                inner = true;
                                return 1;
                            })
                        ],
                        (/** @type {any} */ v) => Success(v)
                    )
                ],
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(/** @type {Error} */ (errorOf(result)).message, 'outer_failed');
        assert.equal(inner, false, 'the inner branch was cancelled with the outer one');
    });

    it('should return the triggering Failure rather than the cancellation', async function () {
        const result = await runEffect(
            Parallel(
                [
                    Command(async function cmdSlowOk(/** @type {AbortSignal | undefined} */ signal) {
                        await cancellableSleep(200, signal);
                        return 'ok';
                    }),
                    Command(function cmdRealFailure() {
                        throw new Error('THE_REAL_ERROR');
                    })
                ],
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(
            /** @type {Error} */ (errorOf(result)).message,
            'THE_REAL_ERROR',
            'a cancelled sibling must not displace the failure that caused the cancellation'
        );
    });

    it('should still pick the first Failure by array order when branches fail together', async function () {
        const result = await runEffect(Parallel([Failure('a'), Failure('b')], (/** @type {any} */ v) => Success(v)));
        assert.equal(errorOf(result), 'a');
    });

    it('should pass no argument to a Command outside a Parallel', async function () {
        /** @type {any[]} */
        const args = [];
        // It declares a parameter, so it is a function that takes the signal inside a Parallel; one without would
        // be called with nothing anywhere, and could not tell this rule apart from that one.
        const result = await runEffect(
            Command(function cmdRecordArgs(/** @type {AbortSignal | undefined} */ signal) {
                args.push([...arguments]);
                return 'done';
            })
        );
        assert.equal(result.type, 'Success');
        assert.deepEqual(args, [[]], 'a function outside a Parallel is called with no arguments at all');
    });
});

describe('Parallel limit and settled', function () {
    beforeEach(function () {
        configureEffect();
    });

    /** A Command that records when it starts and finishes, so in-flight counts can be asserted. */
    const tracked = (/** @type {{ inFlight: number, peak: number }} */ meter, /** @type {any} */ value, ms = 5) =>
        Command(function cmdTracked() {
            meter.inFlight++;
            meter.peak = Math.max(meter.peak, meter.inFlight);
            return new Promise((resolve) =>
                setTimeout(() => {
                    meter.inFlight--;
                    resolve(value);
                }, ms)
            );
        });

    it('should cap how many branches are in flight at once', async function () {
        const meter = { inFlight: 0, peak: 0 };
        const effects = Array.from({ length: 9 }, (_, i) => tracked(meter, i));
        const result = await runEffect(Parallel(effects, { limit: 3 }));
        assert.equal(result.type, 'Success');
        assert.equal(meter.peak, 3);
    });

    it('should keep results in array order regardless of the limit', async function () {
        const meter = { inFlight: 0, peak: 0 };
        // Descending durations, so completion order is the reverse of array order.
        const effects = [tracked(meter, 'a', 30), tracked(meter, 'b', 20), tracked(meter, 'c', 1)];
        const result = await runEffect(Parallel(effects, { limit: 2 }));
        assert.deepEqual(/** @type {any} */ (result).value, ['a', 'b', 'c']);
    });

    it('should keep paths tied to array position, not to completion order', async function () {
        // Two slots, and the second branch is the faster, so it finishes first. The trace lists it first,
        // and its path still names its place in the array.
        const meter = { inFlight: 0, peak: 0 };
        const effects = [tracked(meter, 'a', 20), tracked(meter, 'b', 1)];
        const { trace } = await recordEffect(() => Parallel(effects, { limit: 2 }), null);
        assert.deepEqual(
            trace.trace.map((e) => [e.path, e.result]),
            [
                ['0p1/0', 'b'],
                ['0p0/0', 'a'],
                ['0p', { cancelled: false, branches: 2 }]
            ]
        );
    });

    it('should run branches one after another, in array order, under a limit of 1', async function () {
        // The README translates a `for` loop into this, so the order branches start in is part of what
        // it promises, not only the order results come back in.
        const events = /** @type {string[]} */ ([]);
        const step = (/** @type {string} */ id, /** @type {number} */ ms) =>
            Command(function cmdStep() {
                events.push(`start ${id}`);
                return new Promise((resolve) =>
                    setTimeout(() => {
                        events.push(`end ${id}`);
                        resolve(id);
                    }, ms)
                );
            });
        // Descending durations, so any overlap or reordering would show.
        await runEffect(Parallel([step('a', 3), step('b', 2), step('c', 1)], { limit: 1 }));
        assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    });

    it('should not start queued branches once one has failed', async function () {
        let started = 0;
        const counted = (/** @type {boolean} */ fail) =>
            Command(function cmdCounted() {
                started++;
                return fail ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
            });
        const effects = [counted(true), counted(false), counted(false), counted(false)];
        const result = await runEffect(Parallel(effects, { limit: 1 }));
        assert.equal(result.type, 'Failure');
        assert.equal(started, 1, 'the branches behind the failure should never have started');
    });

    it('should refuse a limit that is not a positive integer as the Parallel is built', function () {
        for (const limit of [0, -1, 1.5, '3', null]) {
            assert.throws(() => Parallel([Success(1)], { limit: /** @type {any} */ (limit) }), {
                name: 'EffectTypeError',
                message: /Parallel 'limit' must be a positive integer, received/
            });
        }
    });

    it('should refuse a settled that is not true or false as the Parallel is built', function () {
        // `settled: 'false'` was truthy, so it ran the batch settled.
        for (const settled of ['false', 1, null]) {
            assert.throws(() => Parallel([Success(1)], { settled: /** @type {any} */ (settled) }), {
                name: 'EffectTypeError',
                message: /Parallel 'settled' must be true or false, received/
            });
        }
    });

    it('should hand settled branches to next as their own outcomes, in order', async function () {
        const effects = [
            Command(function cmdOk() {
                return Promise.resolve('a');
            }),
            Command(function cmdBoom() {
                return Promise.reject(new Error('boom'));
            }),
            Command(function cmdAlsoOk() {
                return Promise.resolve('c');
            })
        ];
        const result = await runEffect(Parallel(effects, { settled: true }));
        assert.equal(result.type, 'Success');
        assert.deepEqual(
            /** @type {any} */ (result).value.map((/** @type {any} */ o) => o.type),
            ['Success', 'Failure', 'Success']
        );
        const outcomes = /** @type {any[]} */ (result.value);
        assert.equal(outcomes[0].value, 'a');
        assert.equal(outcomes[1].error.message, 'boom');
        assert.equal(outcomes[2].value, 'c');
    });

    it('should let every settled branch finish rather than cancelling siblings', async function () {
        let finished = 0;
        const slow = () =>
            Command(function cmdSlow() {
                return new Promise((resolve) => setTimeout(() => resolve(++finished), 10));
            });
        const effects = [
            Command(function cmdFailsFast() {
                return Promise.reject(new Error('boom'));
            }),
            slow(),
            slow()
        ];
        const result = await runEffect(Parallel(effects, { settled: true }));
        assert.equal(result.type, 'Success');
        assert.equal(finished, 2, 'both slow branches should have run to completion');
    });

    it('should turn a thrown Command into that branch and not the whole Parallel', async function () {
        const effects = [
            effectPipe(
                () =>
                    Command(function cmdFirst() {
                        return Promise.resolve(1);
                    }),
                () =>
                    Command(function cmdThrows() {
                        throw new TypeError('unmodelled');
                    })
            )(null),
            Success('sibling')
        ];
        const result = await runEffect(Parallel(effects, { settled: true }));
        assert.equal(result.type, 'Success');
        const outcomes = /** @type {any[]} */ (result.value);
        assert.equal(outcomes[0].type, 'Failure');
        assert.equal(outcomes[0].error.message, 'unmodelled');
        assert.equal(outcomes[1].value, 'sibling');
    });

    it('should still let an EffectTypeError escape a settled Parallel', async function () {
        // A malformed flow is a bug, not a branch outcome; settled mode must not be where flow bugs
        // go quiet.
        const effects = [
            effectPipe(
                () =>
                    Command(function cmdFine() {
                        return Promise.resolve(1);
                    }),
                /** @type {any} */ (
                    function missingReturn() {
                        /* returns undefined */
                    }
                )
            )(null),
            Success('sibling')
        ];
        await assert.rejects(() => runEffect(Parallel(effects, { settled: true })), /missingReturn/);
    });

    it('should combine a limit with settled', async function () {
        const meter = { inFlight: 0, peak: 0 };
        const effects = [
            tracked(meter, 'a'),
            Command(function cmdBoom() {
                return Promise.reject(new Error('boom'));
            }),
            tracked(meter, 'c'),
            tracked(meter, 'd')
        ];
        const result = await runEffect(Parallel(effects, { limit: 2, settled: true }));
        assert.deepEqual(
            /** @type {any} */ (result).value.map((/** @type {any} */ o) => o.type),
            ['Success', 'Failure', 'Success', 'Success']
        );
        assert.ok(meter.peak <= 2);
    });

    it('should accept next alongside options', async function () {
        const effects = [Success(1), Success(2)];
        const result = await runEffect(
            Parallel(effects, (values) => Success(values.reduce((a, b) => a + b, 0)), { limit: 1 })
        );
        assert.deepEqual(result, Success(3));
    });

    it('should still read the options when next is passed as undefined or null', async function () {
        // A caller forwarding an absent next keeps its options. They were dropped, so a batch ran with no
        // limit and one failing branch cancelled the rest.
        for (const next of [undefined, null]) {
            const meter = { inFlight: 0, peak: 0 };
            const effects = [
                tracked(meter, 'a'),
                Command(function cmdBoom() {
                    return Promise.reject(new Error('boom'));
                }),
                tracked(meter, 'c'),
                tracked(meter, 'd')
            ];
            const result = await runEffect(Parallel(effects, /** @type {any} */ (next), { limit: 2, settled: true }));
            assert.equal(meter.peak, 2, `the limit should hold with next ${next}`);
            assert.deepEqual(
                /** @type {any} */ (result).value.map((/** @type {any} */ o) => o.type),
                ['Success', 'Failure', 'Success', 'Success']
            );
        }
    });

    it('should leave the existing two-argument forms alone', async function () {
        assert.deepEqual(await runEffect(Parallel([Success(1), Success(2)])), Success([1, 2]));
        assert.deepEqual(
            await runEffect(Parallel([Success(1), Success(2)], (values) => Success(values.join('-')))),
            Success('1-2')
        );
    });

    it('should replay a limited settled Parallel from its trace with no I/O', async function () {
        let calls = 0;
        const flow = () =>
            Parallel(
                [
                    Command(function cmdOne() {
                        calls++;
                        return Promise.resolve('one');
                    }),
                    Command(function cmdTwo() {
                        calls++;
                        return Promise.reject(new Error('two failed'));
                    })
                ],
                { limit: 1, settled: true }
            );
        const { result, trace } = await recordEffect(flow, null);
        const during = calls;
        const { result: replayed, unreached } = await replayEffect(flow(), trace);
        assert.equal(calls, during, 'replay must not execute a Command');
        assert.deepEqual(unreached, []);
        assert.deepEqual(
            /** @type {any} */ (replayed).value.map((/** @type {any} */ o) => o.type),
            /** @type {any} */ (result).value.map((/** @type {any} */ o) => o.type)
        );
    });
});
