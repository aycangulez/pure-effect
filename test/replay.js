// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Ask,
    Retry,
    Parallel,
    effectPipe,
    runEffect,
    configureEffect,
    recorder,
    recordEffect,
    replayEffect,
    timeTravel
} from '../index.js';
import { registerUserFlow, valueOf, errorOf, makeFlow } from './helpers.js';

/** @import { User } from "./helpers.js" */

describe('Replay', function () {
    beforeEach(() => configureEffect());

    it('should warn in timeTravel when recorded steps are anonymous', async function () {
        // Inline arrow Commands are all 'anonymous', and a replay tells steps apart by name, so a refactor that swapped
        // two of them replayed as a Success with each handed the other's recorded result.
        const inline = effectPipe(
            () => Command(() => 1),
            () => Command(() => 2)
        );
        const named = effectPipe(() =>
            Command(function cmdNamed() {
                return 1;
            })
        );
        for (const [flow, expected] of /** @type {const} */ ([
            [inline, true],
            [named, false]
        ])) {
            const { trace } = await recordEffect(flow, { id: 1 });
            /** @type {string[]} */
            const lines = [];
            await timeTravel(flow, trace, { log: (/** @type {string} */ line) => void lines.push(line) });
            const warning = lines.find((l) => l.includes("named 'anonymous'"));
            assert.equal(Boolean(warning), expected);
            if (warning) {
                assert.match(warning, /2 of the recorded steps/);
                assert.match(warning, /cannot tell them apart/);
                assert.match(warning, /a const or meta\.name/);
            }
        }
    });

    it('should record and replay the registration flow end to end', async function () {
        const input = { email: 'replay@test.com', password: 'password123' };
        const { result, trace } = await recordEffect(registerUserFlow, input);
        assert.equal(result.type, 'Success');
        assert.deepEqual(
            trace.trace.map((e) => e.command),
            ['cmdFindUser', 'cmdSaveUser'],
            'every Command in the flow is recorded, including the guard'
        );

        const { result: replayed } = await replayEffect(
            registerUserFlow(/** @type {User} */ (trace.initialInput)),
            trace
        );
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    /** A flow whose Commands count their own invocations, so tests can assert zero I/O. */

    it('should replay a recorded flow without performing any I/O', async function () {
        const a = makeFlow();
        const { result, trace } = await recordEffect(a.flow, { id: 'x1' }, { version: 'abc123' });
        assert.equal(result.type, 'Success');
        assert.deepEqual(a.calls, { read: 1, write: 1 });
        assert.equal(trace.version, 'abc123');

        const b = makeFlow();
        const { result: replayed } = await replayEffect(b.flow(trace.initialInput), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
        assert.deepEqual(b.calls, { read: 0, write: 0 }, 'replay must not touch the world');
    });

    it('should consume duplicate Command names in recorded order', async function () {
        let n = 0;
        const readTwice = (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(
                        function cmdRead() {
                            return ++n;
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                (/** @type {any} */ first) =>
                    Command(
                        function cmdRead() {
                            return ++n;
                        },
                        (/** @type {any} */ second) => Success([first, second])
                    )
            )(input);

        const { trace } = await recordEffect(readTwice, null);
        assert.deepEqual(
            trace.trace.map((e) => e.result),
            [1, 2]
        );

        n = 100;
        const { result: replayed } = await replayEffect(readTwice(null), trace);
        assert.deepEqual(valueOf(replayed), [1, 2], 'each call got its own recorded value');
        assert.equal(n, 100, 'the real command never ran');
    });

    it('should restore the recorded context so Ask replays faithfully', async function () {
        const flow = (/** @type {any} */ id) =>
            Ask((/** @type {any} */ ctx) =>
                Command(
                    function cmdFindProduct() {
                        return { id, tenant: ctx.tenant };
                    },
                    (/** @type {any} */ p) => Success(p)
                )
            );

        const { trace } = await recordEffect(flow, 'sku-1', { context: { tenant: 'acme', flowName: 'lookup' } });
        assert.equal(/** @type {any} */ (trace.context).tenant, 'acme');

        const { result: replayed } = await replayEffect(flow('sku-1'), trace, { context: trace.context });
        assert.deepEqual(valueOf(replayed), { id: 'sku-1', tenant: 'acme' });
    });

    it('should replay recorded Retry attempts without waiting out the backoff', async function () {
        this.timeout(2000);
        let attempt = 0;
        const flow = () =>
            Retry(
                Command(
                    function cmdFetch() {
                        if (++attempt < 3) throw new Error(`transient ${attempt}`);
                        return { tempC: 21 };
                    },
                    (/** @type {any} */ d) => Success(d)
                ),
                { attempts: 3, delay: 200, backoff: 2 }
            );

        const { result, trace } = await recordEffect(flow, null);
        assert.equal(result.type, 'Success');
        assert.equal(trace.trace.length, 3, 'every attempt is a recorded step');

        attempt = 0;
        const start = Date.now();
        const { result: replayed } = await replayEffect(flow(), trace);
        const elapsed = Date.now() - start;
        assert.deepEqual(valueOf(replayed), { tempC: 21 });
        assert.equal(attempt, 0, 'no attempt was re-executed');
        assert.ok(elapsed < 100, `replay skipped 200 ms + 400 ms of backoff (took ${elapsed} ms)`);
    });

    it('should wait out the backoff when a replay passes fastRetry: false', async function () {
        let calls = 0;
        const flow = () =>
            Retry(
                Command(function cmdFlaky() {
                    if (++calls === 1) throw new Error('once');
                    return 'ok';
                }),
                { attempts: 1, delay: 120 }
            );
        const { trace } = await recordEffect(flow, null);
        const start = Date.now();
        const { result } = await replayEffect(flow(), trace, { fastRetry: false });
        const elapsed = Date.now() - start;
        assert.equal(valueOf(result), 'ok');
        assert.ok(elapsed >= 100, `the replay waited the recorded delay (took ${elapsed} ms)`);
    });

    it('should strip Retry delays inside a Parallel branch during replay', async function () {
        this.timeout(3000);
        let calls = 0;
        const flow = () =>
            Parallel([
                Retry(
                    Command(function cmdFlaky() {
                        if (++calls === 1) throw new Error('once');
                        return 'ok';
                    }),
                    { attempts: 1, delay: 300 }
                )
            ]);
        const { trace } = await recordEffect(flow, null);
        const start = Date.now();
        const { result } = await replayEffect(flow(), trace);
        assert.deepEqual(result, Success(['ok']));
        assert.ok(Date.now() - start < 150, 'the replay did not wait out the production delay');
    });

    it('should replay retry exhaustion as the same structured Failure', async function () {
        let calls = 0;
        const flow = () =>
            Retry(
                Command(
                    function cmdFlaky() {
                        calls++;
                        throw new Error('down');
                    },
                    (/** @type {any} */ v) => Success(v)
                ),
                { attempts: 2, delay: 0 }
            );

        const { result, trace } = await recordEffect(flow, null);
        assert.equal(result.type, 'Failure');

        const during = calls;
        const { result: replayed } = await replayEffect(flow(), trace);
        assert.equal(calls, during, 'the replay executes nothing');
        assert.equal(replayed.type, 'Failure', 'a recorded error still replays as an I/O fault, so it is retried');
        const error = /** @type {import('../index.js').RetryExhaustedError<Error>} */ (errorOf(replayed));
        assert.equal(error.retryExhausted, true);
        assert.equal(error.attempts, 2);
        assert.equal(error.lastError.message, 'down');
    });

    it('should replay a Parallel flow whose branches finish out of order', async function () {
        const flow = (/** @type {any} */ id) =>
            Parallel(
                [
                    Command(
                        function cmdSlow() {
                            return new Promise((r) => setTimeout(() => r({ id }), 20));
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                    Command(
                        function cmdFast() {
                            return Promise.resolve('fast');
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
                ],
                ([slow, fast]) => Success({ slow, fast })
            );

        const { result, trace } = await recordEffect(flow, 'u1');
        assert.deepEqual(
            trace.trace.map((e) => e.command),
            ['cmdFast', 'cmdSlow', 'Parallel'],
            'recording order follows completion, not the effects array, and the decision follows its branches'
        );
        assert.deepEqual(
            trace.trace.map((e) => e.path),
            ['0p1/0', '0p0/0', '0p'],
            'each entry is labelled by its branch, so completion order does not matter'
        );

        // Paths are order-independent, so the trace replays correctly whatever order the branches finished in.
        const { result: replayed } = await replayEffect(flow('u1'), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    it('should keep two Parallel branches that call the same Command apart', async function () {
        // The failure this pins is silent: per-Command queues pair branches by completion order, so
        // reversing the branch latencies between recording and replay swapped one branch's result
        // onto the other and the replay still reported Success.
        const flow = (/** @type {[number, number]} */ delays) =>
            Parallel(
                [
                    Command(
                        function cmdFetch() {
                            return new Promise((r) => setTimeout(() => r('A'), delays[0]));
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                    Command(
                        function cmdFetch() {
                            return new Promise((r) => setTimeout(() => r('B'), delays[1]));
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
                ],
                (/** @type {any} */ vals) => Success(vals)
            );

        const { result, trace } = await recordEffect(flow, [40, 5]);
        assert.deepEqual(valueOf(result), ['A', 'B']);

        // B finished first in the recording, while a replay asks for the steps in array order, A first:
        // it runs no Commands, so the latencies play no part. Pairing steps by name in completion order
        // would hand A the result B recorded.
        const { result: replayed } = await replayEffect(flow([40, 5]), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), ['A', 'B'], 'branch results were not swapped');
    });

    it('should number the steps after a Retry and a Parallel the way stored traces expect', async function () {
        // Paths are the trace format. A change to their numbering still records and replays against itself,
        // so only pinning them catches it, and it would break replay of every trace already stored.
        const flow = () =>
            effectPipe(
                () =>
                    Retry(
                        Command(function cmdA() {
                            return 1;
                        }),
                        { attempts: 1, delay: 0 }
                    ),
                () =>
                    Parallel([
                        Command(function cmdB() {
                            return 2;
                        })
                    ]),
                () =>
                    Command(function cmdC() {
                        return 3;
                    })
            )(null);
        const { trace } = await recordEffect(flow, null);
        assert.deepEqual(
            trace.trace.map((e) => `${e.path} ${e.command}`),
            ['0r0/0 cmdA', '1p0/0 cmdB', '1p Parallel', '2 cmdC']
        );
    });

    it('should still resolve a legacy trace that carries no paths', async function () {
        const a = makeFlow();
        const { result, trace } = await recordEffect(a.flow, { id: 'legacy' });
        const legacy = {
            ...trace,
            trace: trace.trace.map(({ path, ...rest }) => rest)
        };
        assert.ok(
            legacy.trace.every((e) => !('path' in e)),
            'the fixture really has no paths'
        );

        const b = makeFlow();
        const { result: replayed } = await replayEffect(b.flow(trace.initialInput), legacy);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
        assert.deepEqual(b.calls, { read: 0, write: 0 }, 'a legacy trace still performs no I/O');
    });

    it('should raise a TimeParadox naming the path when a flow diverges', async function () {
        const original = (/** @type {any} */ id) =>
            effectPipe(
                () =>
                    Command(
                        function cmdRead() {
                            return id;
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                (/** @type {any} */ v) =>
                    Command(
                        function cmdWrite() {
                            return v;
                        },
                        (/** @type {any} */ w) => Success(w)
                    )
            )(id);
        const { trace } = await recordEffect(original, 'x1');

        // The second step is a different Command than the trace recorded at that path.
        const diverged = (/** @type {any} */ id) =>
            effectPipe(
                () =>
                    Command(
                        function cmdRead() {
                            return id;
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                (/** @type {any} */ v) =>
                    Command(
                        function cmdAudit() {
                            return v;
                        },
                        (/** @type {any} */ w) => Success(w)
                    )
            )(id);

        const { result: replayed } = await replayEffect(diverged('x1'), trace);
        assert.equal(replayed.type, 'Failure');
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.name, 'TimeParadox');
        assert.equal(error.path, '1');
        assert.equal(error.expected, 'cmdWrite');
        assert.equal(error.actual, 'cmdAudit');
    });

    describe('a flow that changed shape', function () {
        /** @param {string} name */
        const step = (name) => Command(() => name, undefined, { name });
        const retried = (/** @type {string} */ name) => Retry(step(name), { attempts: 1, delay: 0 });
        /** effectPipe over a list of steps, which its typed overloads cannot take as a spread. */
        const flowOf = (/** @type {((v: any) => any)[]} */ ...steps) => /** @type {any} */ (effectPipe)(...steps);
        /** A paradox's location and what each side had there. */
        const paradox = (/** @type {any} */ result) => {
            const error = /** @type {any} */ (errorOf(result));
            return { name: error.name, path: error.path, expected: error.expected, actual: error.actual };
        };

        it('should raise a TimeParadox for a Command added where the trace recorded a Retry', async function () {
            // The added step asked for path '1', which the trace never had, so it was reported as missing rather
            // than as the divergence it is.
            const { trace } = await recordEffect(
                flowOf(
                    () => step('cmdA'),
                    () => retried('cmdB')
                ),
                'in'
            );
            const added = flowOf(
                () => step('cmdA'),
                () => step('cmdX'),
                () => retried('cmdB')
            );
            const { result } = await replayEffect(added('in'), trace);
            assert.deepEqual(paradox(result), { name: 'TimeParadox', path: '1', expected: 'Retry', actual: 'cmdX' });
            assert.match(
                /** @type {any} */ (errorOf(result)).message,
                /trace recorded a Retry there, with 'cmdB' at path '1r0\/0'/
            );
        });

        it('should raise a TimeParadox for a step removed in front of a Retry', async function () {
            const { trace } = await recordEffect(
                flowOf(
                    () => step('cmdA'),
                    () => retried('cmdB'),
                    () => step('cmdC')
                ),
                'in'
            );
            const removed = flowOf(
                () => retried('cmdB'),
                () => step('cmdC')
            );
            const { result } = await replayEffect(removed('in'), trace);
            assert.deepEqual(paradox(result), { name: 'TimeParadox', path: '0', expected: 'cmdA', actual: 'Retry' });
            assert.match(
                /** @type {any} */ (errorOf(result)).message,
                /Time paradox at path '0': flow has a Retry there, trace recorded 'cmdA'$/
            );
        });

        it('should raise a TimeParadox for a Command newly wrapped in Retry, even under onMissing: execute', async function () {
            let calls = 0;
            const charge = () =>
                Command(function cmdCharge() {
                    calls++;
                    return 'ch_1';
                });
            const { trace } = await recordEffect(flowOf(charge), 'in');
            calls = 0;
            const wrapped = flowOf(() => Retry(charge(), { attempts: 2, delay: 0 }));
            const { result } = await replayEffect(wrapped('in'), trace, { onMissing: 'execute' });
            assert.deepEqual(paradox(result), {
                name: 'TimeParadox',
                path: '0',
                expected: 'cmdCharge',
                actual: 'Retry'
            });
            assert.equal(calls, 0, 'a reshaped flow runs nothing live');
        });

        it('should raise a TimeParadox for a Parallel where the trace recorded a Command', async function () {
            const { trace } = await recordEffect(
                flowOf(
                    () => step('cmdA'),
                    () => step('cmdB')
                ),
                'in'
            );
            const parallel = flowOf(
                () => step('cmdA'),
                () => Parallel([step('cmdB'), step('cmdC')])
            );
            const { result } = await replayEffect(parallel('in'), trace);
            assert.deepEqual(paradox(result), {
                name: 'TimeParadox',
                path: '1',
                expected: 'cmdB',
                actual: 'Parallel'
            });
        });

        it('should raise a TimeParadox for a Parallel that runs no Commands where the trace recorded one', async function () {
            // Its branches ask for no step, so only the Parallel's own step can see the change: without that check, the
            // step after it matches the trace and the reshaped flow replays as a Success.
            const { trace } = await recordEffect(
                flowOf(
                    () => step('cmdA'),
                    () => step('cmdB')
                ),
                'in'
            );
            const parallel = flowOf(
                () => Parallel([Success(1), Success(2)]),
                () => step('cmdB')
            );
            const { result } = await replayEffect(parallel('in'), trace);
            assert.deepEqual(paradox(result), {
                name: 'TimeParadox',
                path: '0',
                expected: 'cmdA',
                actual: 'Parallel'
            });
        });

        it('should raise a TimeParadox for a Retry where the trace recorded a Parallel', async function () {
            const { trace } = await recordEffect(
                flowOf(() => Parallel([step('cmdA')])),
                'in'
            );
            const { result } = await replayEffect(flowOf(() => retried('cmdA'))('in'), trace);
            assert.deepEqual(paradox(result), {
                name: 'TimeParadox',
                path: '0',
                expected: 'Parallel',
                actual: 'Retry'
            });
            assert.match(
                /** @type {any} */ (errorOf(result)).message,
                /flow has a Retry there, trace recorded a Parallel there, with 'cmdA' at path '0p0\/0'$/
            );
        });

        it('should raise a TimeParadox for a step moved into a new Parallel branch, even under onMissing: execute', async function () {
            // The new branch's paths were ones the trace never had, so its step was reported as missing and ran live
            // under 'execute' before the step after the Parallel showed the change.
            let calls = 0;
            const reserve = () =>
                Retry(
                    Command(function cmdReserve() {
                        calls++;
                        return 'held';
                    }),
                    { attempts: 1, delay: 0 }
                );
            const { trace } = await recordEffect(
                flowOf(
                    () => Parallel([step('cmdA'), step('cmdB')]),
                    reserve,
                    () => step('cmdShip')
                ),
                'in'
            );
            calls = 0;
            const moved = flowOf(
                () => Parallel([step('cmdA'), step('cmdB'), reserve()]),
                () => step('cmdShip')
            );
            const { result } = await replayEffect(moved('in'), trace, { onMissing: 'execute' });
            assert.deepEqual(paradox(result), { name: 'TimeParadox', path: '0p', expected: 2, actual: 3 });
            assert.match(
                /** @type {any} */ (errorOf(result)).message,
                /Time paradox at path '0p': this Parallel has 3 branches, and the trace recorded 2\.$/
            );
            assert.equal(calls, 0, 'a reshaped flow runs nothing live');
        });

        it('should raise a TimeParadox for a Parallel that lost a branch', async function () {
            // The branches left still match their recordings, so the replay was a Success with the lost branch's step
            // unreached.
            const { trace } = await recordEffect(
                flowOf(() => Parallel([step('cmdA'), step('cmdB'), step('cmdC')])),
                'in'
            );
            const fewer = flowOf(() => Parallel([step('cmdA'), step('cmdB')]));
            const { result } = await replayEffect(fewer('in'), trace);
            assert.equal(result.type, 'Failure');
            assert.deepEqual(paradox(result), { name: 'TimeParadox', path: '0p', expected: 3, actual: 2 });
        });

        it('should not judge a decision recorded without a branch count by the number of branches', async function () {
            // A trace recorded before decisions carried the count still replays; only the paths along a step are checked.
            const { trace } = await recordEffect(
                flowOf(() => Parallel([step('cmdA'), step('cmdB')])),
                'in'
            );
            const uncounted = {
                ...trace,
                trace: trace.trace.map((e) => (e.command === 'Parallel' ? { ...e, result: { cancelled: false } } : e))
            };
            const wider = flowOf(() => Parallel([step('cmdA'), step('cmdB'), Success('c')]));
            const { result } = await replayEffect(wider('in'), uncounted);
            assert.deepEqual(result, Success(['cmdA', 'cmdB', 'c']));
        });

        it('should not judge a hand-written trace by the shape of paths it does not write as the recorder does', async function () {
            const handWritten = { trace: [{ command: 'cmdA', path: 'first', result: 'a' }] };
            const { result } = await replayEffect(flowOf(() => retried('cmdA'))('in'), handWritten);
            assert.equal(/** @type {any} */ (errorOf(result)).name, 'ReplayError');
            assert.equal(/** @type {any} */ (errorOf(result)).path, '0r0/0');
        });

        it('should still report a step past the end of the recording as missing', async function () {
            // Nothing was recorded at or around path '2', so this is a step production never reached.
            const { trace } = await recordEffect(
                flowOf(
                    () => step('cmdA'),
                    () => retried('cmdB')
                ),
                'in'
            );
            const longer = flowOf(
                () => step('cmdA'),
                () => retried('cmdB'),
                () => retried('cmdC')
            );
            const { result } = await replayEffect(longer('in'), trace);
            assert.equal(/** @type {any} */ (errorOf(result)).name, 'ReplayError');
            assert.equal(/** @type {any} */ (errorOf(result)).path, '2r0/0');
        });

        it('should still replay a Retry attempt production did not need when the replay answers it differently', async function () {
            // A later attempt is the same Retry at the same position, so it is missing, not a change of shape.
            const { trace } = await recordEffect(
                flowOf(() => retried('cmdB')),
                'in'
            );
            const { result } = await replayEffect(flowOf(() => retried('cmdB'))('in'), {
                ...trace,
                trace: [{ command: 'cmdB', path: '0r0/0', threw: true, error: 'down' }]
            });
            assert.equal(/** @type {any} */ (errorOf(result)).name, 'ReplayError');
            assert.equal(/** @type {any} */ (errorOf(result)).path, '0r1/0');
        });
    });

    it('should report recorded steps a shortened flow never reached, which no TimeParadox covers', async function () {
        const a = makeFlow();
        const { trace } = await recordEffect(a.flow, { id: 'x1' });
        assert.equal(trace.trace.length, 2);

        // The same flow with its last Command removed: no step mismatches, so replay ends in Success
        // with the recorded write never asked for. That silence is the gap `unreached` closes.
        const shortened = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => (i.id ? Success(i) : Failure('no_id')),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdRead() {
                            return { row: i.id };
                        },
                        (/** @type {any} */ row) => Success({ ...i, ...row })
                    )
            )(input);

        const { result: replayed, unreached } = await replayEffect(shortened(trace.initialInput), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(
            unreached.map((/** @type {any} */ e) => e.command),
            ['cmdWrite']
        );
        assert.equal(unreached[0].path, '1');
        assert.strictEqual(unreached[0], trace.trace[1], 'the recorded entry itself, not a copy');
    });

    it('should report an empty unreached list when every recorded step was replayed', async function () {
        const a = makeFlow();
        const { trace } = await recordEffect(a.flow, { id: 'x1' });
        const b = makeFlow();
        const { unreached } = await replayEffect(b.flow(trace.initialInput), trace);
        assert.deepEqual(unreached, []);
    });

    it('should still report unreached steps when replay halts on a TimeParadox', async function () {
        const a = makeFlow();
        const { trace } = await recordEffect(a.flow, { id: 'x1' });
        const diverged = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => Success(i),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdAudit() {
                            return i;
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )(input);
        const { result: replayed, unreached } = await replayEffect(diverged(trace.initialInput), trace);
        assert.equal(/** @type {any} */ (errorOf(replayed)).name, 'TimeParadox');
        // The paradox fired at the first step, so nothing in the trace was handed out.
        assert.deepEqual(
            unreached.map((/** @type {any} */ e) => e.command),
            ['cmdRead', 'cmdWrite']
        );
    });

    it('should report unreached steps for a legacy trace and for a bare entries array', async function () {
        const a = makeFlow();
        const { trace } = await recordEffect(a.flow, { id: 'legacy' });
        const legacy = trace.trace.map(({ path, ...rest }) => rest);
        const readOnly = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => Success(i),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdRead() {
                            return { row: i.id };
                        },
                        (/** @type {any} */ row) => Success(row)
                    )
            )(input);

        const { result: replayed, unreached } = await replayEffect(readOnly(trace.initialInput), legacy);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(
            unreached.map((/** @type {any} */ e) => e.command),
            ['cmdWrite']
        );
    });

    it('should return no unreached list when a Resolver supplies the outcomes', async function () {
        const a = makeFlow();
        const { trace } = await recordEffect(a.flow, { id: 'x1' });
        const b = makeFlow();
        const replay = await replayEffect(b.flow(trace.initialInput), (step) => ({
            result: trace.trace[step.index].result
        }));
        assert.equal(replay.result.type, 'Success');
        assert.equal('unreached' in replay, false, 'only a trace knows what it holds');
    });

    it('should refuse to match a Parallel step positionally when the trace carries no paths', async function () {
        const flow = (/** @type {any} */ id) =>
            Parallel(
                [
                    Command(function cmdLeft() {
                        return { id };
                    }),
                    Command(function cmdRight() {
                        return 'r';
                    })
                ],
                (/** @type {any} */ v) => Success(v)
            );
        const { trace } = await recordEffect(flow, 'u1');
        const legacy = trace.trace.map(({ path, ...rest }) => rest);

        const { result: replayed } = await replayEffect(flow('u1'), legacy);
        assert.equal(replayed.type, 'Failure');
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.name, 'ReplayError');
        assert.match(error.message, /Parallel/);
    });

    it('should accept a trace directly, without building a Resolver', async function () {
        const a = makeFlow();
        const { result, trace } = await recordEffect(a.flow, { id: 'direct' });

        const b = makeFlow();
        const { result: replayed } = await replayEffect(b.flow(trace.initialInput), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
        assert.deepEqual(b.calls, { read: 0, write: 0 });

        // A bare entries array is a valid trace too, without the surrounding TraceLog.
        const c = makeFlow();
        const { result: fromEntries } = await replayEffect(c.flow(trace.initialInput), trace.trace);
        assert.equal(fromEntries.type, 'Success');
        assert.deepEqual(valueOf(fromEntries), valueOf(result));
    });

    it('should reject a malformed trace as a ReplayError, not a TypeError', async function () {
        const { flow } = makeFlow();
        const cases = /** @type {[any, string][]} */ ([
            [undefined, 'undefined'],
            [null, 'null'],
            [42, 'the number 42'],
            [{}, 'an object with no `trace` array'],
            [{ trace: 'nope' }, 'an object with no `trace` array']
        ]);
        const expects =
            "replayEffect expects a Resolver, a trace from recordEffect or a recorder's toTrace, or its array";
        for (const [bad, got] of cases) {
            await assert.rejects(
                () => replayEffect(flow({ id: 'x' }), bad),
                (/** @type {any} */ e) =>
                    e.name === 'ReplayError' && e.message === `${expects} of entries, got ${got}.`,
                `expected a ReplayError for ${JSON.stringify(bad)}`
            );
        }
    });

    it('should stop at a hand-built entry JSON cannot encode with a ReplayError naming it', async function () {
        // A replay copies each outcome the way a trace is stored, so a BigInt, which no recorded trace holds, threw a
        // bare TypeError naming no step.
        const flow = Command(function cmdCount() {
            return 0;
        });
        const { result } = await replayEffect(flow, [{ command: 'cmdCount', path: '0', result: 1n }]);
        const error = /** @type {any} */ (errorOf(result));
        assert.equal(error.name, 'ReplayError');
        assert.match(error.message, /'cmdCount' at path '0' holds a value JSON cannot encode/);
        assert.deepEqual([error.command, error.path], ['cmdCount', '0']);
    });

    it('should detect a trace recorded from a different flow', async function () {
        const flowA = () =>
            Command(
                function cmdAlpha() {
                    return 1;
                },
                (/** @type {any} */ v) => Success(v)
            );
        const flowB = () =>
            Command(
                function cmdBeta() {
                    return 2;
                },
                (/** @type {any} */ v) => Success(v)
            );

        const { trace } = await recordEffect(flowA, null);
        const { result: replayed } = await replayEffect(flowB(), trace);
        assert.equal(replayed.type, 'Failure');
        assert.equal(/** @type {Error} */ (errorOf(replayed)).name, 'TimeParadox');
        assert.match(
            /** @type {Error} */ (errorOf(replayed)).message,
            /asked for 'cmdBeta', trace recorded 'cmdAlpha'/
        );
    });

    it('should detect a different Command in a trace without paths', async function () {
        const { flow, calls } = makeFlow();
        const legacy = { trace: [{ command: 'cmdSomethingElse', result: { row: 'x' } }] };
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), legacy);
        assert.equal(/** @type {Error} */ (errorOf(replayed)).name, 'TimeParadox');
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should refuse a trace with two steps at the same path', async function () {
        const { flow } = makeFlow();
        const entry = { command: 'cmdRead', path: '0', result: {} };
        await assert.rejects(
            replayEffect(flow({ id: 'x' }), { trace: [entry, { ...entry }] }),
            (/** @type {any} */ e) => e.name === 'ReplayError' && /duplicate step paths/.test(e.message)
        );
    });

    it('should report an exhausted trace rather than silently succeeding', async function () {
        const { flow } = makeFlow();
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), { trace: [] });
        assert.equal(replayed.type, 'Failure');
        assert.match(/** @type {Error} */ (errorOf(replayed)).message, /Trace exhausted/);
    });

    it('should refuse to run an unrecorded Command by default', async function () {
        const { flow, calls } = makeFlow();
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), () => undefined);
        assert.equal(replayed.type, 'Failure');
        assert.match(/** @type {Error} */ (errorOf(replayed)).message, /refusing to run the real Command/);
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should allow a recorded prefix and a live tail when onMissing is execute', async function () {
        const { flow, calls } = makeFlow();
        const recorded = [{ command: 'cmdRead', result: { row: 'FROM_TRACE' } }];
        /** @type {import('../index.js').Resolver} */
        const resolve = (step) => (step.index === 0 ? { result: recorded[0].result } : undefined);

        const { result: replayed } = await replayEffect(flow({ id: 'x' }), resolve, { onMissing: 'execute' });
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), { written: 'FROM_TRACE' });
        assert.deepEqual(calls, { read: 0, write: 1 }, 'only the unrecorded step performed I/O');
    });

    it('should give a trace a recorded prefix and a live tail under onMissing: execute', async function () {
        // The option used to work only with a Resolver: a trace answered a missing step with a
        // ReplayError of its own before onMissing was consulted, so the README's live tail never ran.
        const recorded = makeFlow();
        const { trace } = await recordEffect(recorded.flow, { id: 'FROM_TRACE' });
        const prefix = { ...trace, trace: trace.trace.slice(0, 1) }; // as recorded before the flow gained its write

        const { flow, calls } = makeFlow();
        const { result: replayed } = await replayEffect(flow({ id: 'FROM_TRACE' }), prefix, { onMissing: 'execute' });
        assert.deepEqual(replayed, Success({ written: 'FROM_TRACE' }));
        assert.deepEqual(calls, { read: 0, write: 1 }, 'only the step the trace does not hold performed I/O');
    });

    it('should refuse a step a trace does not hold by default, and name the option', async function () {
        const recorded = makeFlow();
        const { trace } = await recordEffect(recorded.flow, { id: 'x' });
        const { flow, calls } = makeFlow();
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), {
            ...trace,
            trace: trace.trace.slice(0, 1)
        });
        const error = /** @type {Error} */ (errorOf(replayed));
        assert.equal(error.name, 'ReplayError');
        assert.match(error.message, /Trace has no step at path '1' for 'cmdWrite'/);
        assert.match(error.message, /onMissing: 'execute'/, 'the message says how to allow it');
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should warn that a step a trace does not hold may be one production vetoed', async function () {
        // A Command an onBeforeCommand hook vetoed never reaches onStep, so the trace holds nothing for it.
        // The message once said only to pass onMissing: 'execute', which runs the I/O production refused.
        configureEffect({
            onBeforeCommand: () => {
                throw new Error('Rate limit exceeded');
            }
        });
        const recorded = makeFlow();
        const { result, trace } = await recordEffect(recorded.flow, { id: 'x' });
        configureEffect();
        assert.equal(result.type, 'Failure');
        assert.deepEqual(trace.trace, []);

        const { flow, calls } = makeFlow();
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), trace);
        const error = /** @type {Error} */ (errorOf(replayed));
        assert.match(error.message, /onBeforeCommand hook vetoed/);
        assert.match(error.message, /only where every Command the flow can still reach goes to a test double/);
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it("should warn that onMissing: 'execute' runs every later step the trace lacks too", async function () {
        // The message advised 'execute' where the Commands only read, so a replay that met a newly added lookup ran it
        // with 'execute', and the steps after it ran live as well: a receipt was sent and the event marked
        // processed. A step added where the trace recorded another now ends in a TimeParadox; one added past the end
        // of the recording, as here, still runs live, and so does everything after it.
        const calls = { read: 0, check: 0, write: 0 };
        const read = () =>
            Command(function cmdRead() {
                calls.read++;
                return { row: 'x' };
            });
        const check = (/** @type {any} */ row) =>
            Command(
                function cmdCheck() {
                    calls.check++;
                    return true;
                },
                () => Success(row)
            );
        const write = () =>
            Retry(
                Command(function cmdWrite() {
                    calls.write++;
                    return 'written';
                }),
                { delay: 0 }
            );
        const before = effectPipe(read);
        const after = effectPipe(read, check, write);
        const { trace } = await recordEffect(before, { id: 'x' });
        Object.assign(calls, { read: 0, check: 0, write: 0 });

        const { result } = await replayEffect(after({ id: 'x' }), trace);
        const error = /** @type {Error} */ (errorOf(result));
        assert.match(error.message, /no step at path '1' for 'cmdCheck'/);
        assert.match(error.message, /and every step after it that the trace also lacks/);
        assert.deepEqual(calls, { read: 0, check: 0, write: 0 });

        // What the message warns of: the added lookup runs, and so does the write after it.
        const { result: executed } = await replayEffect(after({ id: 'x' }), trace, { onMissing: 'execute' });
        assert.deepEqual(executed, Success('written'));
        assert.deepEqual(calls, { read: 0, check: 1, write: 1 });
    });

    it('should refuse an option name recording or replay does not read', async function () {
        // A misspelt option ran with its default: `onMising: 'execute'` stopped at the first missing step, and a
        // `verison` passed to timeTravel never warned about a stale trace.
        const { flow, calls } = makeFlow();
        assert.throws(() => recorder(/** @type {any} */ ({ maxEntry: 10 })), {
            name: 'TypeError',
            message: /recorder has no option named 'maxEntry'; its options are redact, maxEntries and stack\./
        });
        await assert.rejects(recordEffect(flow, { id: 'x' }, /** @type {any} */ ({ ctx: {} })), {
            name: 'TypeError',
            message:
                /recordEffect has no option named 'ctx'; its options are context, version, redact, maxEntries and stack\./
        });
        assert.deepEqual(calls, { read: 0, write: 0 }, 'refused before the flow runs');

        const { trace } = await recordEffect(flow, { id: 'x' });
        await assert.rejects(replayEffect(flow({ id: 'x' }), trace, /** @type {any} */ ({ onMising: 'execute' })), {
            name: 'TypeError',
            message:
                /replayEffect has no option named 'onMising'; its options are context, fastRetry, hooks, onMissing and onResolved\./
        });
        const log = () => {};
        await assert.rejects(timeTravel(flow, trace, /** @type {any} */ ({ log, verison: 'b2' })), {
            name: 'TypeError',
            message: /timeTravel has no option named 'verison'; its options are log, context and version\./
        });
    });

    it('should refuse an option value recording or replay cannot use', async function () {
        // A name was checked and its value was not: `maxEntries: null` recorded nothing, `stack: 'no'` recorded
        // stacks, `fastRetry: 'false'` waited no time, and `hooks: 'false'` was refused as `callConfig.inherit`, a
        // name the caller never wrote.
        const { flow, calls } = makeFlow();
        for (const [options, refusal] of /** @type {const} */ ([
            [{ maxEntries: null }, `'maxEntries' must be a positive integer or Infinity, received null.`],
            [{ maxEntries: 0 }, `'maxEntries' must be a positive integer or Infinity, received the number 0.`],
            [{ maxEntries: '500' }, `'maxEntries' must be a positive integer or Infinity, received the string "500".`],
            [{ stack: 'no' }, `'stack' must be true or false, received the string "no".`],
            [{ redact: 'email' }, `'redact' must be a function, received the string "email".`]
        ])) {
            // Each names the function the caller called.
            assert.throws(() => recorder(/** @type {any} */ (options)), {
                name: 'TypeError',
                message: `recorder ${refusal}`
            });
            await assert.rejects(recordEffect(flow, { id: 'x' }, /** @type {any} */ (options)), {
                name: 'TypeError',
                message: `recordEffect ${refusal}`
            });
        }
        assert.doesNotThrow(() => recorder({ maxEntries: Infinity, stack: undefined }));
        assert.deepEqual(calls, { read: 0, write: 0 }, 'refused before the flow runs');

        const { trace } = await recordEffect(flow, { id: 'x' });
        Object.assign(calls, { read: 0, write: 0 });
        for (const [options, message] of /** @type {const} */ ([
            [{ hooks: 'false' }, /replayEffect 'hooks' must be true or false, received the string "false"/],
            [{ fastRetry: 0 }, /replayEffect 'fastRetry' must be true or false/],
            [
                { onMissing: 'Execute' },
                /replayEffect 'onMissing' must be 'throw' or 'execute', received the string "Execute"/
            ],
            [{ onResolved: true }, /replayEffect 'onResolved' must be a function/]
        ])) {
            await assert.rejects(replayEffect(flow({ id: 'x' }), trace, /** @type {any} */ (options)), {
                name: 'TypeError',
                message
            });
        }
        await assert.rejects(timeTravel(flow, trace, /** @type {any} */ ({ log: 'console' })), {
            name: 'TypeError',
            message: /timeTravel 'log' must be a function/
        });
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should refuse an options argument that is not an object, and take null as none', async function () {
        // Only the options inside were checked, so `recorder(42)` ran with every default, and `null` threw a bare
        // TypeError reading the first option.
        const { flow, calls } = makeFlow();
        const { trace } = await recordEffect(flow, { id: 'x' });
        Object.assign(calls, { read: 0, write: 0 });
        assert.throws(() => recorder(/** @type {any} */ (42)), {
            name: 'TypeError',
            message: "recorder's options must be an object, got the number 42."
        });
        for (const options of [42, 'stack', [], true]) {
            const given = /** @type {any} */ (options);
            assert.throws(() => recorder(given), {
                name: 'TypeError',
                message: /^recorder's options must be an object/
            });
            await assert.rejects(recordEffect(flow, { id: 'x' }, given), {
                name: 'TypeError',
                message: /^recordEffect's options must be an object/
            });
            await assert.rejects(replayEffect(flow({ id: 'x' }), trace, given), {
                name: 'TypeError',
                message: /^replayEffect's options must be an object/
            });
            await assert.rejects(timeTravel(flow, trace, given), {
                name: 'TypeError',
                message: /^timeTravel's options must be an object/
            });
        }
        assert.deepEqual(calls, { read: 0, write: 0 }, 'refused before any flow runs');

        // `null` is no options, as it is for Retry and Parallel.
        const none = /** @type {any} */ (null);
        assert.doesNotThrow(() => recorder(none));
        assert.equal((await recordEffect(flow, { id: 'x' }, none)).result.type, 'Success');
        assert.equal((await replayEffect(flow({ id: 'x' }), trace, none)).result.type, 'Success');
        const consoleLog = console.log;
        console.log = () => {};
        try {
            assert.equal((await timeTravel(flow, trace, none)).type, 'Success');
        } finally {
            console.log = consoleLog;
        }
    });

    it('should reject a trace a replay cannot read with a ReplayError that names what is wrong', async function () {
        // replayEffect checked only for a `trace` array, and nothing checked its entries: a null entry threw a bare
        // TypeError reading its path, and 42 replayed as a TimeParadox saying the trace recorded undefined.
        const { flow, calls } = makeFlow();
        const { trace } = await recordEffect(flow, { id: 'x' });
        Object.assign(calls, { read: 0, write: 0 });
        /** @param {() => Promise<unknown>} replay @param {RegExp} named */
        const refused = (replay, named) =>
            assert.rejects(replay(), (/** @type {any} */ e) =>
                e.name === 'ReplayError' && named.test(e.message) ? true : assert.fail(`${e.name}: ${e.message}`)
            );
        const cases = /** @type {[any, string][]} */ ([
            [null, 'is null'],
            [42, 'is the number 42'],
            [{ path: '1', result: { written: 'x' } }, 'has no string command']
        ]);
        for (const [entry, what] of cases) {
            const broken = { ...trace, trace: [trace.trace[0], entry] };
            const named = new RegExp(`trace entry 1 ${what}; an entry is an object with a string command\\.$`);
            await refused(() => replayEffect(flow({ id: 'x' }), broken), new RegExp(`^replayEffect's ${named.source}`));
            await refused(
                () => replayEffect(flow({ id: 'x' }), broken.trace),
                new RegExp(`^replayEffect's ${named.source}`)
            );
            await refused(
                () => timeTravel(flow, broken, { log: () => {} }),
                new RegExp(`^timeTravel's ${named.source}`)
            );
        }
        const expects =
            /^replayEffect expects a Resolver, a trace from recordEffect or a recorder's toTrace, or its array/;
        await refused(() => replayEffect(flow({ id: 'x' }), /** @type {any} */ (42)), expects);
        await refused(() => replayEffect(flow({ id: 'x' }), /** @type {any} */ ({})), expects);
        assert.deepEqual(calls, { read: 0, write: 0 }, 'refused before anything replays');
    });

    it('should refuse a flow that is not a function in recordEffect and timeTravel', async function () {
        // Each called what it was given, so a number failed with "flowFn is not a function", naming a parameter the
        // caller never wrote.
        const { flow } = makeFlow();
        const { trace } = await recordEffect(flow, { id: 'x' });
        await assert.rejects(recordEffect(/** @type {any} */ (42), { id: 'x' }), {
            name: 'TypeError',
            message: 'recordEffect expects the function that builds the flow from its input, got the number 42.'
        });
        // The likely mistake: the flow called with its input, where timeTravel calls it with the recorded one.
        await assert.rejects(timeTravel(/** @type {any} */ (flow({ id: 'x' })), trace, { log: () => {} }), {
            name: 'TypeError',
            message:
                "timeTravel expects the function that builds the flow from its input, got an Effect of type 'Command'."
        });
    });

    it('should give a trace without paths a live tail under onMissing: execute', async function () {
        const { flow, calls } = makeFlow();
        const legacy = { trace: [{ command: 'cmdRead', result: { row: 'FROM_TRACE' } }] };
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), legacy, { onMissing: 'execute' });
        assert.deepEqual(replayed, Success({ written: 'FROM_TRACE' }));
        assert.deepEqual(calls, { read: 0, write: 1 });
    });

    it('should still raise a TimeParadox under onMissing: execute', async function () {
        // Only a missing step may run live. A step recorded under another name is a divergence.
        const { flow, calls } = makeFlow();
        const diverged = { trace: [{ command: 'cmdSomethingElse', path: '0', result: {} }] };
        const { result: replayed } = await replayEffect(flow({ id: 'x' }), diverged, { onMissing: 'execute' });
        assert.equal(/** @type {Error} */ (errorOf(replayed)).name, 'TimeParadox');
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should refuse onMissing: execute on a trace maxEntries cut short, before any I/O', async function () {
        // The steps a capped trace lacks are steps production ran, so running them live repeats production's
        // I/O. The README and this message once advised exactly that for such a trace, and a billing batch
        // replayed that way charged and invoiced subscriptions production had already billed.
        const recorded = makeFlow();
        const { trace } = await recordEffect(recorded.flow, { id: 'x' }, { maxEntries: 1 });
        assert.equal(trace.dropped, 1);
        const { flow, calls } = makeFlow();
        for (const stored of [trace, JSON.parse(JSON.stringify(trace))]) {
            await assert.rejects(
                replayEffect(flow({ id: 'x' }), stored, { onMissing: 'execute' }),
                (/** @type {any} */ e) => {
                    assert.equal(e.name, 'ReplayError');
                    assert.match(e.message, /dropped 1 entries under maxEntries/);
                    assert.match(e.message, /would run it again/);
                    assert.match(
                        e.message,
                        /stop at the first missing step, or record the flow with a higher maxEntries/
                    );
                    return true;
                }
            );
        }
        assert.deepEqual(calls, { read: 0, write: 0 }, 'nothing ran, not even the recorded prefix');
    });

    it('should say a capped trace may lack steps production ran, and not offer onMissing: execute', async function () {
        const recorded = makeFlow();
        const { trace } = await recordEffect(recorded.flow, { id: 'x' }, { maxEntries: 1 });
        const { flow, calls } = makeFlow();
        const { result: replayed, unreached } = await replayEffect(flow({ id: 'x' }), trace);
        const error = /** @type {Error} */ (errorOf(replayed));
        assert.equal(error.name, 'ReplayError');
        assert.match(error.message, /Trace has no step at path '1' for 'cmdWrite'/);
        assert.match(error.message, /production may have run this step/);
        assert.match(error.message, /record the flow with a higher maxEntries to replay past it/);
        assert.doesNotMatch(error.message, /onMissing/);
        assert.deepEqual(unreached, [], 'the recorded prefix replayed');
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should narrate a replay and flag a flow that diverged', async function () {
        /** @type {string[]} */
        const lines = [];
        const traceLog = {
            flowName: 'checkout',
            version: 'deadbee',
            initialInput: { id: 1 },
            trace: [
                { command: 'cmdRead', result: { row: 1 } },
                { command: 'cmdWrite', result: { written: 1 } }
            ]
        };
        // This flow stops after one Command, so the second recorded step is unreachable.
        const shortFlow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(
                    function cmdRead() {
                        return { row: 1 };
                    },
                    () => Success('stopped early')
                )
            )(input);

        const result = await timeTravel(shortFlow, traceLog, { log: (l) => lines.push(l), version: 'cafe123' });
        assert.equal(result.type, 'Success');
        const out = lines.join('\n');
        assert.match(out, /trace was recorded at deadbee, replaying against cafe123/);
        assert.match(out, /Replaying 'checkout' \(2 recorded steps\)/);
        assert.match(out, /Step 1: cmdRead returned/);
        assert.doesNotMatch(out, / in \d/, 'a hand-written trace has no timings to narrate');
        assert.match(out, /1 recorded step was never reached: cmdWrite\. The flow diverged/);
    });

    it("should name an unreached step's path when the trace carries paths", async function () {
        const read = () =>
            Command(function cmdRead() {
                return { row: 1 };
            });
        const write = () =>
            Command(function cmdWrite() {
                return { written: 1 };
            });
        const { trace } = await recordEffect((/** @type {any} */ input) => effectPipe(read, write)(input), { id: 1 });
        /** @type {string[]} */
        const lines = [];
        await timeTravel((/** @type {any} */ input) => effectPipe(read)(input), trace, { log: (l) => lines.push(l) });
        assert.match(lines.join('\n'), /1 recorded step was never reached: cmdWrite \(path '1'\)\. The flow diverged/);
    });

    it('should not warn about unreached steps when a TimeParadox already named the divergence', async function () {
        const a = makeFlow();
        const { trace } = await recordEffect(a.flow, { id: 'x1' });
        const diverged = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => Success(i),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdAudit() {
                            return i;
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )(input);
        /** @type {string[]} */
        const lines = [];
        const result = await timeTravel(diverged, trace, { log: (l) => lines.push(l) });
        assert.equal(/** @type {any} */ (errorOf(result)).name, 'TimeParadox');
        const out = lines.join('\n');
        assert.match(out, /Time paradox at path '0'/);
        assert.doesNotMatch(out, /never reached/, 'the paradox is the news; the steps behind it are not');
    });

    it("should warn about unreached steps when the flow's own error only shares a replay error's name", async function () {
        const read = () =>
            Command(function cmdRead() {
                return { row: 1 };
            });
        const write = () =>
            Command(function cmdWrite() {
                return { written: 1 };
            });
        const { trace } = await recordEffect((/** @type {any} */ input) => effectPipe(read, write)(input), { id: 1 });
        // A domain error that happens to be named like a replay fault, returned where the write used to be.
        const refuse = () => Failure(Object.assign(new Error('Refused.'), { name: 'ReplayError' }));
        /** @type {string[]} */
        const lines = [];
        const result = await timeTravel((/** @type {any} */ input) => effectPipe(read, refuse)(input), trace, {
            log: (l) => lines.push(l)
        });
        assert.equal(/** @type {any} */ (errorOf(result)).name, 'ReplayError');
        assert.match(lines.join('\n'), /1 recorded step was never reached: cmdWrite/);
    });

    it('should warn in timeTravel only when the trace was recorded at a different version', async function () {
        const { flow } = makeFlow();
        const { trace } = await recordEffect(flow, { id: 'v' }, { version: 'build-1' });
        const cases = /** @type {{ version?: string, warned: boolean }[]} */ ([
            { version: 'build-2', warned: true },
            { version: 'build-1', warned: false },
            { warned: false }
        ]);
        for (const { version, warned } of cases) {
            /** @type {string[]} */
            const lines = [];
            await timeTravel(flow, trace, { version, log: (/** @type {string} */ line) => void lines.push(line) });
            const saw = lines.some((l) => /^Warning: trace was recorded at/.test(l));
            assert.equal(saw, warned, `replaying against ${version}`);
        }
    });

    it('should warn in timeTravel when the trace holds no initial input', async function () {
        // timeTravel rebuilds the flow from the recorded input, and a hook-based recorder finds one only on a
        // flow built with effectPipe, so a bare Command's trace is rebuilt from undefined.
        const bare = () =>
            Command(function cmdRead() {
                return 1;
            });
        /** @type {string[]} */
        const lines = [];
        const log = (/** @type {string} */ line) => void lines.push(line);
        await timeTravel(bare, (await recordEffect(bare, undefined)).trace, { log });
        assert.ok(lines.some((l) => /^Warning: the trace holds no initial input/.test(l)));

        lines.length = 0;
        const { flow } = makeFlow();
        await timeTravel(flow, (await recordEffect(flow, { id: 'in' })).trace, { log });
        assert.ok(!lines.some((l) => /no initial input/.test(l)));
    });

    it('should reject a trace timeTravel cannot read with a ReplayError, as replayEffect does', async function () {
        // timeTravel read the trace's own fields before replayEffect checked its shape, so a malformed trace failed
        // with a bare TypeError from inside timeTravel.
        const { flow } = makeFlow();
        const cases = /** @type {[any, RegExp][]} */ ([
            [{}, /got an object with no `trace` array\.$/],
            [[], /got an array of entries, which holds no initialInput.*replay the entries with replayEffect\.$/],
            [null, /got null\.$/]
        ]);
        for (const [traceLog, named] of cases) {
            await assert.rejects(timeTravel(flow, traceLog, { log: () => {} }), (/** @type {any} */ e) =>
                e.name === 'ReplayError' && /^timeTravel expects a trace from recordEffect/.test(e.message)
                    ? named.test(e.message) || assert.fail(e.message)
                    : assert.fail(`${e.name}: ${e.message}`)
            );
        }
    });

    it('should record and replay a run whose context is null, as runEffect runs one', async function () {
        // recordEffect read the context's flowName and threw a bare TypeError on null, which runEffect accepts; and a
        // replay defaulted a recorded null to {}, so Ask got a context production never had.
        const flow = () =>
            Ask((/** @type {any} */ ctx) =>
                Command(
                    function cmdLoad() {
                        return 1;
                    },
                    () => Success(ctx)
                )
            );
        const { result, trace } = await recordEffect(flow, undefined, { context: null });
        assert.deepEqual(result, Success(null));
        assert.equal(trace.context, null);
        assert.deepEqual((await replayEffect(flow(), trace)).result, Success(null));
    });

    it('should give Ask the recorded context in timeTravel, or the one it is handed', async function () {
        const flow = (/** @type {any} */ input) =>
            Ask((/** @type {any} */ ctx) =>
                Command(
                    function cmdLoad() {
                        return { id: input.id };
                    },
                    (/** @type {any} */ row) => Success({ ...row, tenant: ctx.tenant })
                )
            );
        const { trace } = await recordEffect(flow, { id: 1 }, { context: { tenant: 'acme' } });
        const quiet = { log: () => {} };
        assert.deepEqual(await timeTravel(flow, trace, quiet), Success({ id: 1, tenant: 'acme' }));
        assert.deepEqual(
            await timeTravel(flow, trace, { ...quiet, context: { tenant: 'globex' } }),
            Success({ id: 1, tenant: 'globex' })
        );
    });

    it('should narrate a Parallel flow', async function () {
        const flow = (/** @type {any} */ id) =>
            Parallel(
                [
                    Command(
                        function cmdSlow() {
                            return new Promise((r) => setTimeout(() => r({ id }), 20));
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                    Command(
                        function cmdFast() {
                            return Promise.resolve('fast');
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
                ],
                ([slow, fast]) => Success({ slow, fast })
            );

        const { trace } = await recordEffect(flow, 'u1');
        /** @type {string[]} */
        const lines = [];
        const result = await timeTravel(flow, trace, { log: (l) => lines.push(l) });

        assert.equal(result.type, 'Success');
        const out = lines.join('\n');
        assert.match(out, /cmdSlow returned/);
        assert.match(out, /cmdFast returned/);
        assert.doesNotMatch(out, /never reached/, 'both recorded steps were consumed');
    });

    it('should replay Ask with the context the trace recorded when none is passed', async function () {
        // The README's replays pass only the flow and the trace. The replay used an empty context, so an Ask gate
        // went the other way and a run that succeeded replayed as a Failure, with no paradox to flag it.
        const approve = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) =>
                    Ask((/** @type {any} */ ctx) => (ctx.role === 'admin' ? Success(i) : Failure('forbidden'))),
                (/** @type {any} */ i) =>
                    Command(function cmdApprove() {
                        return { approved: i.invoiceId };
                    })
            )(input);
        const { result, trace } = await recordEffect(approve, { invoiceId: 'inv_1' }, { context: { role: 'admin' } });
        const stored = JSON.parse(JSON.stringify(trace));

        const { result: replayed, unreached } = await replayEffect(approve(stored.initialInput), stored);
        assert.deepEqual(replayed, result);
        assert.deepEqual(unreached, []);

        const { result: asViewer } = await replayEffect(approve(stored.initialInput), stored, {
            context: { role: 'viewer' }
        });
        assert.deepEqual(asViewer, Failure('forbidden'), 'a context passed in still wins');
    });

    it('should reject a replay whose onResolved throws, without asking for the step again', async function () {
        // A throw from the observer happened before the replayed result was handed back, so it counted as the
        // Command failing: the Retry asked for an attempt production never made, and the replay came back as a
        // retry exhaustion instead of the observer's error.
        const flow = () =>
            Retry(
                Command(function cmdFindOrder() {
                    return { total: 100 };
                }),
                { attempts: 2, delay: 0 }
            );
        const { trace } = await recordEffect(flow, null);
        /** @type {(string | undefined)[]} */
        const asked = [];
        await assert.rejects(
            replayEffect(flow(), trace, {
                onResolved: (step) => {
                    asked.push(step.path);
                    throw new Error('logger down');
                }
            }),
            /logger down/
        );
        assert.deepEqual(asked, ['0r0/0'], 'the recorded step was replayed once');
    });

    it('should reject a replay whose Resolver throws, without retrying the step or running its fallback', async function () {
        // A throw from a Resolver counted as the Command failing, so the Retry asked again for attempts production
        // never made, ran the fallback, and the replay reported a Success production never had.
        let fallbacks = 0;
        const flow = () =>
            Retry(
                Command(function cmdFindOrder() {
                    return { total: 100 };
                }),
                {
                    attempts: 2,
                    delay: 0,
                    onExhausted: () => {
                        fallbacks++;
                        return Success({ total: 0 });
                    }
                }
            );
        /** @type {string[]} */
        const asked = [];
        const resolve = (/** @type {any} */ step) => {
            asked.push(step.path);
            throw new Error('lookup bug');
        };
        await assert.rejects(replayEffect(flow(), resolve), /lookup bug/);
        assert.deepEqual(asked, ['0r0/0'], 'the step was asked for once');
        assert.equal(fallbacks, 0);
        // The same holds for a Parallel's step, which always rejected.
        await assert.rejects(replayEffect(Parallel([Success(1)]), resolve), /lookup bug/);
    });

    it('should reject a replay whose Resolver answers with anything but an outcome or undefined', async function () {
        // `null` made the interpreter throw a TypeError that counted as the Command failing, so a Retry asked again
        // and fell back; `{}` replayed as a Command that returned undefined. Only undefined means not recorded.
        const flow = () =>
            Retry(
                Command(function cmdFindOrder() {
                    return { total: 100 };
                }),
                { attempts: 2, delay: 0, onExhausted: () => Success({ total: 0 }) }
            );
        for (const answer of [null, {}, [], 'not recorded', 0]) {
            let asked = 0;
            const resolve = () => {
                asked++;
                return /** @type {any} */ (answer);
            };
            await assert.rejects(replayEffect(flow(), resolve), (/** @type {any} */ e) => {
                assert.equal(e.name, 'TypeError');
                assert.match(e.message, /A Resolver answers with \{ result \}, \{ error \}, or undefined/);
                assert.match(e.message, /'cmdFindOrder' at path '0r0\/0'/);
                return true;
            });
            assert.equal(asked, 1, `asked once when it answered ${JSON.stringify(answer)}`);
        }
        // A Parallel's step is held to the same rule, and an outcome that holds no decision still replays by timing.
        await assert.rejects(
            replayEffect(Parallel([Success(1)]), () => /** @type {any} */ (null)),
            /'Parallel' at path '0p'/
        );
        const { result } = await replayEffect(Parallel([Success(1)]), () => ({ result: 'no decision' }));
        assert.deepEqual(result, Success([1]));
    });

    it('should not execute any Command across every primitive during replay', async function () {
        let invocations = 0;
        const trap = (/** @type {string} */ name, /** @type {any} */ value) => {
            const thunk = () => {
                invocations++;
                return value;
            };
            Object.defineProperty(thunk, 'name', { value: name });
            return Command(thunk, (/** @type {any} */ v) => Success(v));
        };

        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => Success(i),
                (/** @type {any} */ i) =>
                    Ask((/** @type {any} */ ctx) =>
                        Parallel(
                            [trap('cmdLoadUser', { tenant: ctx.tenant }), Retry(trap('cmdLoadQuota', { quota: 10 }))],
                            ([user, quota]) => Success({ ...i, user, quota })
                        )
                    ),
                (/** @type {any} */ acc) => trap('cmdWriteAudit', { audited: acc.user.tenant })
            )(input);

        const { result, trace } = await recordEffect(flow, { id: 1 }, { context: { tenant: 'acme' } });
        assert.equal(result.type, 'Success');
        assert.equal(invocations, 3);

        invocations = 0;
        const { result: replayed } = await replayEffect(flow({ id: 1 }), trace, { context: trace.context });
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
        assert.equal(invocations, 0, 'no Command thunk was applied');
    });
});

describe('Replaying a cancelled Parallel', function () {
    beforeEach(() => configureEffect());

    // Which branch cancels a Parallel is decided by timing, and a replay runs at its own pace. The
    // decision used to go unrecorded, so a replay could let a cancelled branch's AbortError win, or let
    // a branch run past the point production stopped it and ask for a step that was never recorded.
    // Each Parallel now records its decision, and a replay reproduces it rather than recomputing it.

    /** Waits, and rejects with an AbortError when the signal fires, as fetch does. */
    const sleep = (/** @type {number} */ ms, /** @type {AbortSignal | undefined} */ signal) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    reject(new DOMException('This operation was aborted', 'AbortError'));
                },
                { once: true }
            );
        });

    /** Counts live executions, so each test can assert that a replay performed none. */
    const io = { calls: 0 };
    /** @param {string} name @param {(signal: AbortSignal | undefined) => any} fn */
    const step = (name, fn) =>
        Command(
            async (/** @type {AbortSignal | undefined} */ signal) => {
                io.calls++;
                return fn(signal);
            },
            undefined,
            { name }
        );

    const declined = () => Object.assign(new Error('Your card was declined.'), { code: 'card_declined' });
    // Looks the customer up, then the charge is declined: the cancelling branch takes two steps.
    const chargeBranch = () =>
        effectPipe(
            () => step('findCustomer', (s) => sleep(5, s).then(() => ({ id: 'cu_1' }))),
            () =>
                step('charge', async (s) => {
                    await sleep(5, s);
                    throw declined();
                })
        )(null);
    // One slow step that accepts the signal, so it is cancelled with an AbortError.
    const reserveBranch = (/** @type {string} */ name = 'reserveStock') =>
        step(name, async (s) => {
            await sleep(200, s);
            return { reserved: true };
        });

    /** Records a run, then replays it from memory and from JSON, asserting neither replay did I/O. */
    const recordAndReplay = async (/** @type {(input: any) => any} */ flow, /** @type {any} */ input = null) => {
        const { result, trace } = await recordEffect(flow, input);
        const before = io.calls;
        const memory = await replayEffect(flow(input), trace);
        const json = await replayEffect(flow(input), JSON.parse(JSON.stringify(trace)));
        assert.equal(io.calls, before, 'a replay executes nothing');
        return { result, trace, replays: [memory, json] };
    };

    /** @param {any} replay */
    const assertDeclined = (replay) => {
        assert.equal(replay.result.type, 'Failure');
        assert.equal(replay.result.error.code, 'card_declined', 'the failure that cancelled the others');
        assert.deepEqual(replay.unreached, [], 'every recorded step was replayed');
    };

    it('should replay the failure that cancelled the others, not the cancelled branch', async function () {
        const { result, replays } = await recordAndReplay(() => Parallel([chargeBranch(), reserveBranch()]));
        assert.equal(/** @type {any} */ (result).error.code, 'card_declined', 'production');
        replays.forEach(assertDeclined);
    });

    it('should replay it when the cancelling branch comes later in the array', async function () {
        const { result, replays } = await recordAndReplay(() => Parallel([reserveBranch(), chargeBranch()]));
        assert.equal(/** @type {any} */ (result).error.code, 'card_declined', 'production');
        replays.forEach(assertDeclined);
    });

    it('should record each Parallel decision, and how many branches it had, at the Parallel path', async function () {
        const { trace } = await recordEffect(() => Parallel([chargeBranch(), reserveBranch()]), null);
        const decision = trace.trace.find((e) => e.path === '0p');
        assert.deepEqual(
            { command: decision?.command, result: decision?.result },
            { command: 'Parallel', result: { cancelled: true, branch: 0, branches: 2 } }
        );
        const { trace: calm } = await recordEffect(() => Parallel([step('a', () => 1), step('b', () => 2)]), null);
        assert.deepEqual(calm.trace.find((e) => e.path === '0p')?.result, { cancelled: false, branches: 2 });
    });

    it('should stop a branch where production stopped it during a retry backoff', async function () {
        // The backoff was cut short by the cancellation, so the second attempt was never recorded.
        const retried = Retry(
            step('flakyLookup', () => {
                throw new Error('ECONNRESET');
            }),
            { attempts: 2, delay: 50 }
        );
        const { replays } = await recordAndReplay(() => Parallel([chargeBranch(), retried]));
        replays.forEach(assertDeclined);
    });

    it('should stop a branch whose in-flight step ignored the signal and finished late', async function () {
        const ignoresSignal = effectPipe(
            () => step('slowIgnoresSignal', () => new Promise((r) => setTimeout(() => r('late'), 30))),
            () => step('afterSlow', () => 'never reached in production')
        )(null);
        const { replays } = await recordAndReplay(() => Parallel([chargeBranch(), ignoresSignal]));
        replays.forEach(assertDeclined);
    });

    it('should replay a nested Parallel cancelled by its enclosing one', async function () {
        const flow = () => Parallel([chargeBranch(), Parallel([reserveBranch('reserveA'), reserveBranch('reserveB')])]);
        const { trace, replays } = await recordAndReplay(flow);
        assert.deepEqual(trace.trace.find((e) => e.path === '0p1/0p')?.result, {
            cancelled: true,
            branch: null,
            branches: 2
        });
        replays.forEach(assertDeclined);
    });

    it('should stop queued branches that production never started under limit', async function () {
        // Twelve branches, so the queued ones reach two-digit indexes in their paths.
        const flow = () =>
            Parallel([chargeBranch(), ...Array.from({ length: 11 }, (_, i) => reserveBranch(`r${i + 1}`))], {
                limit: 2
            });
        const { replays } = await recordAndReplay(flow);
        replays.forEach(assertDeclined);
    });

    it('should not start a Retry fallback that production never started', async function () {
        let attempts = 0;
        const withFallback = Retry(
            step('fetchLivePrice', async (s) => {
                if (attempts++ === 0) throw new Error('ECONNRESET');
                await sleep(200, s);
                return { amount: 1 };
            }),
            { attempts: 1, delay: 1, onExhausted: () => step('fetchCachedPrice', () => ({ amount: 0 })) }
        );
        const { replays } = await recordAndReplay(() => Parallel([chargeBranch(), withFallback]));
        replays.forEach(assertDeclined);
    });

    it('should raise a TimeParadox when the recorded cancelling branch no longer fails', async function () {
        let skipCharge = false;
        const branch = () =>
            effectPipe(
                () => step('findCustomer', (s) => sleep(5, s).then(() => ({ id: 'cu_1' }))),
                () =>
                    skipCharge
                        ? Success('charge skipped')
                        : step('charge', async (s) => {
                              await sleep(5, s);
                              throw declined();
                          })
            )(null);
        const flow = () => Parallel([branch(), reserveBranch()]);
        const { trace } = await recordEffect(flow, null);
        skipCharge = true;
        const { result } = await replayEffect(flow(), trace);
        assert.equal(result.type, 'Failure');
        assert.equal(/** @type {any} */ (result).error.name, 'TimeParadox');
        assert.match(/** @type {any} */ (result).error.message, /'0p'.*branch 0/);
    });

    it('should stop a branch before a nested Parallel that production never started', async function () {
        const lateThenParallel = effectPipe(
            () => step('slowIgnoresSignal', () => new Promise((r) => setTimeout(() => r('late'), 30))),
            () => Parallel([step('neverA', () => 1), step('neverB', () => 2)])
        )(null);
        const { trace, replays } = await recordAndReplay(() => Parallel([chargeBranch(), lateThenParallel]));
        assert.equal(
            trace.trace.some((e) => e.path === '0p1/1p'),
            false,
            'production never reached it'
        );
        replays.forEach(assertDeclined);
    });

    it('should not run a nested Parallel that production never started, as a hook watching the replay sees', async function () {
        // The outcome is the recorded trigger's failure either way, so only a hook can tell whether the replay ran the
        // nested Parallel. Running it would show the hook a step production never took.
        const lateThenParallel = effectPipe(
            () => step('slowIgnoresSignal', () => new Promise((r) => setTimeout(() => r('late'), 30))),
            () => Parallel([step('neverA', () => 1), step('neverB', () => 2)])
        )(null);
        const flow = () => Parallel([chargeBranch(), lateThenParallel]);
        const { trace } = await recordEffect(flow, null);
        /** @type {string[]} */
        const ran = [];
        configureEffect({
            onStep: async (name, type, op, path) => {
                const result = await op();
                if (type === 'Parallel') ran.push(/** @type {string} */ (path));
                return result;
            }
        });
        const before = io.calls;
        const replay = await replayEffect(flow(), trace, { hooks: true });
        assert.equal(io.calls, before, 'a replay executes nothing');
        assertDeclined(replay);
        assert.deepEqual(ran, ['0p'], 'only the Parallel production ran');
    });

    it('should not run the next of a nested Parallel cancelled from outside', async function () {
        // Its branches failed because they were cancelled, so its next never ran in production. Running it
        // on a replay would hand it values the branches never produced.
        const inner = Parallel([reserveBranch('reserveA'), reserveBranch('reserveB')], (/** @type {any} */ values) =>
            Success(values[0].reserved && values[1].reserved)
        );
        const { result, replays } = await recordAndReplay(() => Parallel([chargeBranch(), inner]));
        assert.equal(/** @type {any} */ (result).error.code, 'card_declined', 'production');
        replays.forEach(assertDeclined);
    });

    it('should still report a step missing from a Parallel that was not cancelled', async function () {
        const flow = () => Parallel([step('a', () => 1), step('b', () => 2)]);
        const { trace } = await recordEffect(flow, null);
        const lost = { ...trace, trace: trace.trace.filter((e) => e.path !== '0p1/0') };
        const { result } = await replayEffect(flow(), lost);
        assert.equal(/** @type {any} */ (result).error.name, 'ReplayError');
        assert.match(/** @type {any} */ (result).error.message, /no step at path '0p1\/0'/);
    });

    it('should still report a step missing from the branch that cancelled the others', async function () {
        const flow = () => Parallel([chargeBranch(), reserveBranch()]);
        const { trace } = await recordEffect(flow, null);
        const lost = { ...trace, trace: trace.trace.filter((e) => e.path !== '0p0/1') };
        const { result } = await replayEffect(flow(), lost);
        assert.equal(/** @type {any} */ (result).error.name, 'ReplayError');
        assert.match(/** @type {any} */ (result).error.message, /no step at path '0p0\/1'/);
    });

    it('should raise a TimeParadox when the recorded cancelling branch no longer exists', async function () {
        // Recorded with the charge as the third branch, which cancelled the other two; the code has since
        // dropped it. The two remaining branches still match their recordings, so only the decision can
        // tell: it names a branch this Parallel no longer has. Falling back to timing let the first
        // reservation's AbortError become the replay's answer.
        let withCharge = true;
        const flow = () =>
            Parallel([reserveBranch('r0'), reserveBranch('r1'), ...(withCharge ? [chargeBranch()] : [])]);
        const { trace } = await recordEffect(flow, null);
        assert.deepEqual(trace.trace.find((e) => e.path === '0p')?.result, { cancelled: true, branch: 2, branches: 3 });
        withCharge = false;
        const before = io.calls;
        const { result } = await replayEffect(flow(), trace);
        assert.equal(io.calls, before);
        assert.equal(/** @type {any} */ (result).error.name, 'TimeParadox');
        assert.match(/** @type {any} */ (result).error.message, /branch 2.*2 branches/);
    });

    it('should replay a trace without Parallel decisions as before', async function () {
        const flow = () => Parallel([step('a', () => 1), step('b', () => 2)]);
        const { trace } = await recordEffect(flow, null);
        const legacy = { ...trace, trace: trace.trace.filter((e) => e.command !== 'Parallel') };
        const { result, unreached } = await replayEffect(flow(), legacy);
        assert.deepEqual(result, Success([1, 2]));
        assert.deepEqual(unreached, []);
    });

    it('should reject when a hook returns without calling op for a Parallel', async function () {
        configureEffect({
            onStep: async (name, type, op) => (type === 'Parallel' ? 'skipped' : op())
        });
        await assert.rejects(
            runEffect(Parallel([Success(1)])),
            (e) => e instanceof TypeError && /onStep hook returned without/.test(e.message)
        );
    });

    it('should reject when a hook swallows what op threw for a Parallel, rather than continue with no results', async function () {
        // A decision naming a branch the Parallel does not have makes `op` throw a TimeParadox.
        /** @type {import('../index.js').StepRunner} */
        const swallowing = async (name, type, op) => {
            if (type !== 'Parallel') return op();
            try {
                return await op({ cancelled: true, branch: 5 });
            } catch {
                return 'swallowed';
            }
        };
        await assert.rejects(
            runEffect(Parallel([Success(1), Success(2)]), {}, { onStep: swallowing }),
            (e) => e instanceof TypeError && /onStep hook returned without/.test(e.message)
        );
    });

    it('should let a Resolver supply the decision, and ignore one that is not a decision', async function () {
        const flow = () => Parallel([chargeBranch(), reserveBranch()]);
        const { trace } = await recordEffect(flow, null);
        const byPath = new Map(trace.trace.map((e) => [e.path, e]));
        /** @type {number[]} */
        const commandIndexes = [];
        const fromStore = (/** @type {any} */ s) => {
            if (s.type !== 'Parallel') commandIndexes.push(s.index);
            const e = /** @type {any} */ (byPath.get(s.path));
            if (!e) return undefined;
            return 'error' in e ? { error: e.error } : { result: e.result };
        };
        const { result } = await replayEffect(flow(), fromStore);
        assert.equal(/** @type {any} */ (result).error.message, 'Your card was declined.');
        assert.deepEqual(commandIndexes, [0, 1, 2], 'a Parallel step does not advance step.index');

        const notADecision = (/** @type {any} */ s) => ({ result: s.type === 'Parallel' ? 'no decision' : s.name });
        const { result: plain } = await replayEffect(Parallel([step('a', () => 1), step('b', () => 2)]), notADecision);
        assert.deepEqual(plain, Success(['a', 'b']));

        // A branch that is not an index into the Parallel, such as a string from a trace edited by hand or a negative
        // number, which is never recorded, is not a decision either.
        for (const branch of ['0', -1]) {
            const notAnIndex = (/** @type {any} */ s) => ({
                result: s.type === 'Parallel' ? { cancelled: true, branch } : s.name
            });
            const { result: timed } = await replayEffect(
                Parallel([step('a', () => 1), step('b', () => 2)]),
                notAnIndex
            );
            assert.deepEqual(timed, Success(['a', 'b']), `branch ${JSON.stringify(branch)} is not a decision`);
        }
    });

    it('should not redact a Parallel decision', async function () {
        const { trace } = await recordEffect(() => Parallel([step('a', () => 1)]), null, {
            redact: () => '[redacted]'
        });
        assert.deepEqual(trace.trace.find((e) => e.command === 'Parallel')?.result, { cancelled: false, branches: 1 });
        assert.equal(trace.trace.find((e) => e.command === 'a')?.result, '[redacted]');
    });

    it('should stop a cancelled branch rather than run it live under onMissing: execute', async function () {
        // The queued branches never started in production, so their first steps are missing. A decision
        // explains the gap, and running them live would do I/O production never did.
        const flow = () =>
            Parallel([chargeBranch(), reserveBranch('r1'), reserveBranch('r2'), reserveBranch('r3')], { limit: 2 });
        const { trace } = await recordEffect(flow, null);
        const before = io.calls;
        const replay = await replayEffect(flow(), trace, { onMissing: 'execute' });
        assert.equal(io.calls, before, 'a step production never ran is not run live either');
        assertDeclined(replay);
    });

    // A branch whose own code throws, a pure step reading a field the API stopped sending, cancels the other
    // branches just as a failing one does, and the run rejects with the throw. The Parallel used to throw it
    // from inside its step, so the trace recorded the error where the decision belonged, and a replay raced the
    // branches at its own pace: the throw it exists to reproduce went missing, or was hidden behind a
    // ReplayError for a step production never reached, which onMissing: 'execute' then ran live.

    /** Records a run that rejects, as the recording wiring does, since `recordEffect` keeps no trace for one. */
    const recordCrash = async (/** @type {() => any} */ flow) => {
        const rec = recorder();
        /** @type {any} */
        let crash;
        await assert.rejects(runEffect(flow(), {}, { onStep: rec.onStep }), (e) => ((crash = e), true));
        return { crash, trace: rec.toTrace() };
    };

    /** Replays from memory and from JSON, letting unrecorded steps run live, and expects the same throw. */
    const assertCrashReplays = async (
        /** @type {() => any} */ flow,
        /** @type {any} */ trace,
        /** @type {any} */ crash
    ) => {
        const before = io.calls;
        for (const recorded of [trace, JSON.parse(JSON.stringify(trace))]) {
            await assert.rejects(replayEffect(flow(), recorded, { onMissing: 'execute' }), (/** @type {any} */ e) => {
                assert.equal(`${e.name}: ${e.message}`, `${crash.name}: ${crash.message}`);
                return true;
            });
        }
        assert.equal(io.calls, before, 'a replay executes nothing, including a step production never ran');
    };

    // Answers, then the next step reads a field that is not there.
    const crashingBranch = (/** @type {() => boolean} */ fixed = () => false) =>
        effectPipe(
            () => step('fetchCart', (s) => sleep(1, s).then(() => ({ lines: [] }))),
            (/** @type {any} */ cart) => Success(fixed() ? 0 : cart.items.length)
        )(null);
    // A slow step that ignores the signal, then a step production never reached.
    const slowBranch = () =>
        effectPipe(
            () => step('slowIgnoresSignal', () => new Promise((r) => setTimeout(() => r('late'), 30))),
            () => step('afterSlow', () => 'never reached in production')
        )(null);

    it('should replay a Parallel cancelled by a branch whose own code threw', async function () {
        const flow = () => Parallel([slowBranch(), crashingBranch()]);
        const { crash, trace } = await recordCrash(flow);
        assert.ok(crash instanceof TypeError, 'production rejects with the throw');
        assert.deepEqual(trace.trace.find((e) => e.path === '0p')?.result, { cancelled: true, branch: 1, branches: 2 });
        await assertCrashReplays(flow, trace, crash);
    });

    it('should replay a throw in a branch still running after another branch cancelled the Parallel', async function () {
        // The decline cancelled first, so it is the decision; the confirmation ignored the signal, finished,
        // and the step after it threw, which is what the run rejected with. The decline takes one step, so a
        // replay racing at its own pace cancels the confirmation before it is asked for, and the throw is lost.
        const decline = step('charge', async (s) => {
            await sleep(3, s);
            throw declined();
        });
        const confirming = effectPipe(
            () => step('reserve', (s) => sleep(1, s).then(() => 'held')),
            () => step('confirmIgnoresSignal', () => new Promise((r) => setTimeout(() => r({ lines: [] }), 30))),
            (/** @type {any} */ order) => Success(order.items.length)
        )(null);
        const flow = () => Parallel([decline, confirming]);
        const { crash, trace } = await recordCrash(flow);
        assert.ok(crash instanceof TypeError, 'production rejects with the throw, not the decline');
        assert.deepEqual(trace.trace.find((e) => e.path === '0p')?.result, { cancelled: true, branch: 0, branches: 2 });
        await assertCrashReplays(flow, trace, crash);
    });

    it('should replay a settled Parallel cancelled by a branch whose own code threw', async function () {
        // Under settled no failing branch cancels the others, but a throw still does, since the run is
        // rejecting either way.
        const flow = () => Parallel([slowBranch(), crashingBranch()], { settled: true });
        const { crash, trace } = await recordCrash(flow);
        assert.deepEqual(trace.trace.find((e) => e.path === '0p')?.result, { cancelled: true, branch: 1, branches: 2 });
        await assertCrashReplays(flow, trace, crash);
    });

    it('should rethrow the throw production rethrew when two branches threw', async function () {
        // The later branch threw first and cancelled the other, which was four steps in; its slow fifth step
        // ignored the signal, finished, and the step after it threw too. Production rethrows the first by
        // array order, the earlier branch's. A replay that let the first throw abort again would stop that
        // branch a few steps in, since the other reaches its throw after one, and rethrow the wrong error.
        const quick = (/** @type {string} */ name) => () => step(name, (s) => sleep(1, s).then(() => name));
        const lateCrash = effectPipe(
            quick('lookup'),
            quick('price'),
            quick('tax'),
            quick('shipping'),
            () => step('slowIgnoresSignal', () => new Promise((r) => setTimeout(() => r({ lines: [] }), 80))),
            (/** @type {any} */ order) => Success(order.total.toFixed(2))
        )(null);
        const earlyCrash = effectPipe(
            () => step('fetchCart', (s) => sleep(40, s).then(() => ({ lines: [] }))),
            (/** @type {any} */ cart) => Success(cart.items.length)
        )(null);
        const flow = () => Parallel([lateCrash, earlyCrash]);
        const { crash, trace } = await recordCrash(flow);
        assert.match(crash.message, /toFixed/, "production rethrows the earlier branch's throw");
        assert.deepEqual(trace.trace.find((e) => e.path === '0p')?.result, { cancelled: true, branch: 1, branches: 2 });
        await assertCrashReplays(flow, trace, crash);
    });

    it('should keep the failure that cancelled first as the decision when a running branch threw later', async function () {
        // So once the throw is fixed, the replay returns the decline that really cancelled the Parallel,
        // rather than a TimeParadox about a branch that never cancelled anything.
        let fixed = false;
        const confirming = effectPipe(
            () => step('confirmIgnoresSignal', () => new Promise((r) => setTimeout(() => r({ lines: [] }), 30))),
            (/** @type {any} */ order) => Success(fixed ? 0 : order.items.length)
        )(null);
        const decline = step('charge', async (s) => {
            await sleep(3, s);
            throw declined();
        });
        const flow = () => Parallel([confirming, decline]);
        const { trace } = await recordCrash(flow);
        assert.deepEqual(trace.trace.find((e) => e.path === '0p')?.result, { cancelled: true, branch: 1, branches: 2 });
        fixed = true;
        const before = io.calls;
        const { result } = await replayEffect(flow(), trace);
        assert.equal(io.calls, before);
        assert.equal(/** @type {any} */ (result).error.code, 'card_declined');
    });

    it('should raise a TimeParadox when the recorded throw no longer happens', async function () {
        // Once the bug is fixed nothing cancels the slow branch, so it would run on to a step the trace does
        // not hold; the trace cannot say what the fixed flow does, and the decision is how the replay knows.
        let fixed = false;
        const flow = () => Parallel([slowBranch(), crashingBranch(() => fixed)]);
        const { trace } = await recordCrash(flow);
        fixed = true;
        const before = io.calls;
        const { result } = await replayEffect(flow(), trace);
        assert.equal(io.calls, before);
        assert.equal(/** @type {any} */ (result).error.name, 'TimeParadox');
        assert.match(/** @type {any} */ (result).error.message, /'0p'.*branch 1/);
    });
});

describe('Replay errors are harness errors', function () {
    beforeEach(function () {
        configureEffect();
    });

    // A trace that cannot answer a step, or that disagrees with the flow, is a problem with the replay
    // rather than an outcome the flow produced. It used to become a domain `Failure` while the flow was
    // still running, so `Retry`'s `onExhausted` caught it and a settled `Parallel` folded it into its
    // outcomes: a truncated trace then replayed as `Success` with every branch carrying the ReplayError
    // as though production had returned it. It is rethrown inside the flow now and becomes a `Failure`
    // only at `replayEffect`'s own boundary, which is the shape this function has always returned.
    const step = (/** @type {number} */ n) =>
        Command(function cmdStep() {
            return Promise.resolve(n);
        });

    const nameOf = (/** @type {any} */ result) => result.error?.name;

    /**
     * Records a flow keeping only its first entry, as a recorder with `maxEntries: 1` does, so the trace
     * still carries paths and every later step is genuinely missing. An emptied trace would not do: with
     * no entries it cannot be matched by path, and a Parallel step is then refused rather than missing.
     */
    const truncatedTrace = async (/** @type {() => any} */ flow) =>
        (await recordEffect(flow, null, { maxEntries: 1 })).trace;

    /** A replay stopped by a step the truncated trace does not hold. */
    const assertMissing = (/** @type {any} */ result) => {
        assert.equal(result.type, 'Failure');
        assert.equal(nameOf(result), 'ReplayError');
        assert.match(result.error.message, /Trace has no step at path/);
    };

    it('should report a missing entry in a plain flow', async function () {
        const flow = () =>
            effectPipe(
                () => step(1),
                () => step(2)
            )(null);
        assertMissing((await replayEffect(flow(), await truncatedTrace(flow))).result);
    });

    it('should report a missing entry in a plain Parallel', async function () {
        const flow = () => Parallel([step(1), step(2)]);
        assertMissing((await replayEffect(flow(), await truncatedTrace(flow))).result);
    });

    it('should not let onExhausted swallow a missing entry', async function () {
        const flaky = () =>
            Command(function cmdFlaky() {
                return Promise.reject(new Error('down'));
            });
        const flow = () => Retry(flaky(), { attempts: 1, delay: 0, onExhausted: () => Success(99) });
        const { result } = await replayEffect(flow(), await truncatedTrace(flow));
        assertMissing(result);
    });

    it('should not let a settled Parallel fold a missing entry into its outcomes', async function () {
        const flow = () => Parallel([step(1), step(2)], { settled: true });
        const { result } = await replayEffect(flow(), await truncatedTrace(flow));
        assertMissing(result);
    });

    const moving = (/** @type {boolean} */ moved) =>
        moved
            ? Command(function cmdMoved() {
                  return Promise.resolve(1);
              })
            : Command(function cmdOriginal() {
                  return Promise.resolve(1);
              });

    it('should not let a settled Parallel fold a TimeParadox', async function () {
        const flow = (/** @type {boolean} */ moved) => Parallel([moving(moved), step(2)], { settled: true });
        const { trace } = await recordEffect(() => flow(false), null);
        const { result } = await replayEffect(flow(true), trace);
        assert.equal(result.type, 'Failure');
        assert.equal(nameOf(result), 'TimeParadox');
    });

    it('should not let onExhausted swallow a TimeParadox', async function () {
        const flow = (/** @type {boolean} */ moved) =>
            Retry(moving(moved), { attempts: 1, delay: 0, onExhausted: () => Success(99) });
        const { trace } = await recordEffect(() => flow(false), null);
        const { result } = await replayEffect(flow(true), trace);
        assert.equal(result.type, 'Failure');
        assert.equal(nameOf(result), 'TimeParadox');
    });

    it('should still execute a missing step under onMissing: execute', async function () {
        let ran = 0;
        const flow = () =>
            Parallel(
                [
                    Command(function cmdCounted() {
                        ran++;
                        return Promise.resolve('live');
                    })
                ],
                { settled: true }
            );
        const { result } = await replayEffect(flow(), () => undefined, { onMissing: 'execute' });
        assert.equal(result.type, 'Success');
        assert.equal(ran, 1, 'the replay was told to run the real Command');
    });

    it('should still fold a real branch failure in a settled Parallel', async function () {
        // The fix must not reach past harness errors into the outcomes settled exists to collect.
        const flow = () =>
            Parallel(
                [
                    step(1),
                    Command(function cmdBoom() {
                        return Promise.reject(new Error('boom'));
                    })
                ],
                { settled: true }
            );
        const { trace } = await recordEffect(flow, null);
        const { result } = await replayEffect(flow(), trace);
        assert.equal(result.type, 'Success');
        assert.deepEqual(
            /** @type {any} */ (result).value.map((/** @type {any} */ o) => o.type),
            ['Success', 'Failure']
        );
    });

    it('should still let onExhausted catch a real failure on replay', async function () {
        const flow = () =>
            Retry(
                Command(function cmdBoom() {
                    return Promise.reject(new Error('boom'));
                }),
                { attempts: 1, delay: 0, onExhausted: () => Success('fallback') }
            );
        const { trace } = await recordEffect(flow, null);
        const { result } = await replayEffect(flow(), trace);
        assert.deepEqual(result, Success('fallback'));
    });

    it('should still let an EffectTypeError escape a replay', async function () {
        // A malformed flow is a bug in the flow, not a problem with the trace, so it keeps propagating
        // rather than coming back as a Failure a caller might read as a business outcome.
        const flow = () =>
            effectPipe(
                () => step(1),
                /** @type {any} */ (
                    function missingReturn() {
                        /* returns undefined */
                    }
                )
            )(null);
        const { trace } = await recordEffect(() => step(1), null);
        await assert.rejects(() => replayEffect(flow(), trace), /missingReturn/);
    });
});
