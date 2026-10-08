// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Ask,
    Retry,
    effectPipe,
    runEffect,
    configureEffect,
    recorder,
    recordEffect,
    replayEffect,
    timeTravel
} from '../index.js';
import { valueOf, errorOf, makeFlow } from './helpers.js';

describe('Recording', function () {
    beforeEach(() => configureEffect());

    it('should carry an error cause through a trace and back', async function () {
        const flow = (/** @type {any} */ input) =>
            Command(function cmdCharge() {
                return Promise.reject(new Error('charge declined', { cause: new Error('card expired') }));
            });

        const { result, trace } = await recordEffect(flow, { id: 'cause' });
        assert.equal(result.type, 'Failure');

        // The trace must survive JSON, which is where a non-enumerable cause would silently vanish.
        const stored = JSON.parse(JSON.stringify(trace));
        const { result: replayed } = await replayEffect(flow(stored.initialInput), stored);
        assert.equal(replayed.type, 'Failure');
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.message, 'charge declined');
        assert.ok(error.cause instanceof Error, 'the revived error must keep its cause');
        assert.equal(error.cause.message, 'card expired');
    });

    it('should carry a nested cause chain and a non-Error cause', async function () {
        const flow = (/** @type {any} */ input) =>
            Command(function cmdFetch() {
                return Promise.reject(
                    new Error('fetch failed', { cause: new Error('socket closed', { cause: 'ECONNRESET' }) })
                );
            });

        const { trace } = await recordEffect(flow, { id: 'chain' });
        const stored = JSON.parse(JSON.stringify(trace));
        const { result: replayed } = await replayEffect(flow(stored.initialInput), stored);
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.cause.message, 'socket closed');
        assert.equal(error.cause.cause, 'ECONNRESET', 'a non-Error cause must pass through unchanged');
    });

    it('should record an error whose cause chain loops back, cutting the loop where it returns', async function () {
        // Serializing followed the cause forever, and the stack overflow was dropped with the recorder's other
        // failures, so the step vanished from the trace and its replay reported a missing entry.
        const inner = new Error('socket hang up');
        const outer = new Error('request failed', { cause: inner });
        inner.cause = outer;
        const flow = (/** @type {any} */ input) =>
            Command(function cmdRequest() {
                return Promise.reject(outer);
            });
        const { trace } = await recordEffect(flow, { id: 'loop' });
        assert.equal(trace.trace.length, 1, 'the step is recorded');
        const { result: replayed } = await replayEffect(flow({ id: 'loop' }), JSON.parse(JSON.stringify(trace)));
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.message, 'request failed');
        assert.equal(error.cause.message, 'socket hang up');
        assert.equal(error.cause.cause.message, 'request failed');
        assert.equal(error.cause.cause.cause, undefined, 'the loop is cut where it comes back');
    });

    it('should carry an error that appears twice without a loop in full both times', async function () {
        // Only an error's own ancestors cut the chain, so an error shared by two branches of an AggregateError
        // keeps its cause in each.
        const shared = new Error('shared', { cause: new Error('root') });
        const flow = (/** @type {any} */ input) =>
            Command(function cmdBoth() {
                return Promise.reject(new AggregateError([shared, shared], 'both failed'));
            });
        const { trace } = await recordEffect(flow, { id: 'twice' });
        const { result: replayed } = await replayEffect(flow({ id: 'twice' }), JSON.parse(JSON.stringify(trace)));
        const errors = /** @type {any} */ (errorOf(replayed)).errors;
        assert.deepEqual(
            errors.map((/** @type {any} */ e) => e.cause.message),
            ['root', 'root']
        );
    });

    it('should replay a thrown plain object as the same plain object', async function () {
        // Some clients reject with a plain object. It is not an Error, so it is stored and revived as it is.
        const flow = () =>
            Command(function cmdCall() {
                return Promise.reject({ code: 'E_TIMEOUT', retryable: true });
            });
        const { result, trace } = await recordEffect(flow, null);
        for (const stored of [trace, JSON.parse(JSON.stringify(trace))]) {
            const { result: replayed } = await replayEffect(flow(), stored);
            assert.ok(!(errorOf(replayed) instanceof Error), 'not turned into an Error');
            assert.deepEqual(replayed, result);
        }
    });

    it('should replay a Command that rejected with no reason as a failure, from JSON too', async function () {
        // An entry said it threw by having an `error` key, and JSON drops a key whose value is undefined, so
        // `reject()` with no argument, which callback wrappers often do, came back from storage as a step that
        // returned undefined. The replay reported Success, and with onMissing: 'execute' ran the next step live.
        let shipped = 0;
        const flow = (/** @type {boolean} */ live) =>
            effectPipe(
                () =>
                    Command(function cmdCharge() {
                        return live ? Promise.reject() : undefined;
                    }),
                () =>
                    Command(function cmdShip() {
                        shipped++;
                        return 'shipped';
                    })
            );
        const { result, trace } = await recordEffect(flow(true), { orderId: 1 });
        assert.deepEqual(result, Failure(undefined));
        shipped = 0;
        for (const stored of [trace, JSON.parse(JSON.stringify(trace))]) {
            const { result: replayed } = await replayEffect(flow(false)(stored.initialInput), stored, {
                onMissing: 'execute'
            });
            assert.deepEqual(replayed, result);
        }
        assert.equal(shipped, 0, 'the step production never reached is not run live');
    });

    it('should replay a Retry that ran out of attempts on rejections with no reason', async function () {
        const flow = () =>
            Retry(
                Command(function cmdFlaky() {
                    return Promise.reject();
                }),
                { attempts: 2, delay: 0 }
            );
        const { result, trace } = await recordEffect(flow, null);
        const { result: replayed, unreached } = await replayEffect(flow(), JSON.parse(JSON.stringify(trace)));
        assert.deepEqual(replayed, result);
        assert.deepEqual(/** @type {any} */ (replayed).error, {
            retryExhausted: true,
            lastError: undefined,
            attempts: 2
        });
        assert.deepEqual(unreached, [], 'every recorded attempt was replayed');
    });

    it('should replay a failure whose error redact removed as a failure, from JSON', async function () {
        const flow = () =>
            Command(function cmdVerifyIdentity() {
                return Promise.reject(new Error('SSN does not match'));
            });
        const { trace } = await recordEffect(flow, null, {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
                kind === 'error' ? undefined : value
        });
        const { result } = await replayEffect(flow(), JSON.parse(JSON.stringify(trace)));
        assert.deepEqual(result, Failure(undefined), 'a failure with nothing to show, rather than a success');
    });

    it('should still replay an error entry recorded before entries said they threw', async function () {
        // What 0.13 recorded, and what a trace written by hand looks like: an `error` and no `threw`.
        const flow = () =>
            Command(function cmdCharge() {
                return 'never called';
            });
        const legacy = { trace: [{ command: 'cmdCharge', path: '0', error: 'card_declined' }] };
        const { result } = await replayEffect(flow(), legacy);
        assert.deepEqual(result, Failure('card_declined'));
    });

    it('should carry the errors of an AggregateError through a trace and back', async function () {
        // What Node rejects with when nothing listens on localhost: an empty message, and one entry per
        // address it tried. `errors` is non-enumerable, like `cause`, so JSON alone would drop it.
        const refused = (/** @type {string} */ address) =>
            Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), { code: 'ECONNREFUSED', address });
        const flow = (/** @type {any} */ input) =>
            Command(function cmdConnectDb() {
                return Promise.reject(
                    Object.assign(new AggregateError([refused('::1'), refused('127.0.0.1'), 'timeout'], ''), {
                        code: 'ECONNREFUSED'
                    })
                );
            });

        const { result, trace } = await recordEffect(flow, { id: 'agg' });
        const stored = JSON.parse(JSON.stringify(trace));
        const { result: replayed } = await replayEffect(flow(stored.initialInput), stored);
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.name, 'AggregateError');
        assert.equal(error.errors.length, 3);
        assert.ok(error.errors[0] instanceof Error, 'each entry is revived as an error');
        assert.equal(error.errors[1].message, 'connect ECONNREFUSED 127.0.0.1:5432');
        assert.equal(error.errors[1].code, 'ECONNREFUSED');
        assert.equal(error.errors[2], 'timeout', 'a non-Error entry passes through unchanged');
        assert.deepEqual(Object.keys(error), ['code'], 'errors stays non-enumerable, as on a native AggregateError');
        // Not deep-equal to the original: like any error class, it revives as a plain Error with its name.
        assert.deepEqual(error.errors, /** @type {any} */ (result).error.errors);
    });

    it('should leave an enumerable errors property as it is', async function () {
        // A validation library's error carries its own `errors`, visible like any custom property: an object
        // keyed by field, or an array of problems, which is the shape an AggregateError's hidden one has.
        for (const errors of [{ email: 'is invalid' }, [{ field: 'email', message: 'is invalid' }]]) {
            const flow = (/** @type {any} */ input) =>
                Command(function cmdSave() {
                    return Promise.reject(Object.assign(new Error('validation failed'), { errors }));
                });
            const { result, trace } = await recordEffect(flow, { id: 'val' });
            const stored = JSON.parse(JSON.stringify(trace));
            const { result: replayed } = await replayEffect(flow(stored.initialInput), stored);
            const error = /** @type {any} */ (errorOf(replayed));
            assert.deepEqual(error.errors, errors);
            assert.deepEqual(Object.keys(error), ['errors'], 'still an own enumerable key');
            assert.deepEqual(replayed, result);
        }
    });

    it('should revive an error that compares deep-equal to the one the Command threw', async function () {
        // The README's determinism check is `assert.deepEqual(replayed, result)`, so it has to hold for a
        // Failure too. `name` and `cause` are non-enumerable on a native Error; a revived error that carried
        // them as own enumerable keys would never compare equal, whatever its message said.
        const flow = (/** @type {any} */ input) =>
            Command(function cmdCharge() {
                const e = Object.assign(new Error('declined', { cause: new Error('expired') }), {
                    code: 'card_declined'
                });
                return Promise.reject(e);
            });

        const { result, trace } = await recordEffect(flow, { id: 'deq' });
        const stored = JSON.parse(JSON.stringify(trace));
        const { result: replayed } = await replayEffect(flow({ id: 'deq' }), stored);
        assert.deepEqual(replayed, result);

        const error = /** @type {any} */ (errorOf(replayed));
        assert.deepEqual(Object.keys(error), ['code'], 'only the custom property is an own enumerable key');
        assert.equal(error.name, 'Error');
        assert.equal(error.cause.message, 'expired');
    });

    it('should keep a custom error name readable after revival', async function () {
        const flow = (/** @type {any} */ input) =>
            Command(function cmdCharge() {
                return Promise.reject(Object.assign(new Error('nope'), { name: 'GatewayError' }));
            });
        const { trace } = await recordEffect(flow, { id: 'named' });
        const { result: replayed } = await replayEffect(flow({ id: 'named' }), JSON.parse(JSON.stringify(trace)));
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.name, 'GatewayError');
        assert.match(String(error), /^GatewayError: nope/);
        // Object.assign made the original's name an own enumerable property, so the revived one is too.
        assert.deepEqual(Object.keys(error), ['name']);
    });

    it('should revive a name or cause set as a property so the replay deep-equals the run', async function () {
        // `e.name = 'TimeoutError'`, and `e.cause = inner` from before the cause option, make own enumerable
        // properties. Revival made the name non-enumerable, so the README's deepEqual check failed on a plain
        // Error, and the cause was copied as the raw Error, which JSON stored as {}.
        const flow = (/** @type {any} */ input) =>
            Command(function cmdUpstream() {
                const e = new Error('upstream timed out');
                e.name = 'TimeoutError';
                e.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
                return Promise.reject(e);
            });
        const { result, trace } = await recordEffect(flow, { id: 'assigned' });
        const { result: replayed } = await replayEffect(flow({ id: 'assigned' }), JSON.parse(JSON.stringify(trace)));
        assert.deepEqual(replayed, result);

        const error = /** @type {any} */ (errorOf(replayed));
        assert.deepEqual(Object.keys(error).sort(), Object.keys(/** @type {any} */ (errorOf(result))).sort());
        assert.equal(error.cause.message, 'socket hang up');
        assert.equal(error.cause.code, 'ECONNRESET');
    });

    it('should revive an assigned message as enumerable, and list nothing for a plain Error', async function () {
        // `Object.assign(new Error(), { message })` makes the message an own enumerable property. A plain Error
        // has none, so its stored form carries no list of them.
        const thrown = [Object.assign(new Error(), { message: 'Not found', status: 404 }), new Error('plain')];
        const flow = (/** @type {any} */ input) =>
            Command(function cmdLookup() {
                return Promise.reject(thrown[input.i]);
            });
        for (const i of [0, 1]) {
            const { result, trace } = await recordEffect(flow, { i });
            const stored = JSON.parse(JSON.stringify(trace));
            const { result: replayed } = await replayEffect(flow({ i }), stored);
            assert.deepEqual(replayed, result);
            const keys = (/** @type {any} */ outcome) => Object.keys(errorOf(outcome)).sort();
            assert.deepEqual(keys(replayed), keys(result));
            assert.equal('__enumerable' in stored.trace[0].error, i === 0);
        }
    });

    it('should not let a throwing redact fail the run or corrupt the trace', async function () {
        const rec = recorder({
            redact: () => {
                throw new Error('redact blew up');
            }
        });
        const result = await runEffect(
            Command(
                function cmdWork() {
                    return 'ok';
                },
                (/** @type {any} */ v) => Success(v)
            ),
            {},
            { onStep: rec.onStep }
        );
        assert.equal(result.type, 'Success', "a redaction bug is not the flow's problem");
        assert.equal(valueOf(result), 'ok');
        // Nothing is stored for the value, and the entry says why.
        const [{ durationMs, ...entry }] = rec.entries;
        assert.deepEqual(entry, { command: 'cmdWork', path: '0', unrecorded: 'redact' });
    });

    it('should stop a replay at a step redact threw on, rather than hand the flow a stand-in', async function () {
        // The recorder stored '[redaction failed]' as the step's result, and a replay handed that string to the flow
        // as what the Command returned: a lookup that found nothing replayed as one that found a user.
        let lookups = 0;
        const signup = (/** @type {string} */ email) =>
            effectPipe(() =>
                Command(
                    function cmdFindUser() {
                        lookups++;
                        return null;
                    },
                    (found) => (found ? Failure('taken') : Success('created'))
                )
            )(email);
        // The README's warning: reading a field of a lookup that found nothing.
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
            kind === 'result' ? { ...value, email: value.email.toLowerCase() } : value;
        const { result, trace } = await recordEffect(signup, 'a@b.c', { redact });
        assert.deepEqual(result, Success('created'));
        assert.equal(lookups, 1);
        const [{ durationMs, ...entry }] = trace.trace;
        assert.deepEqual(entry, { command: 'cmdFindUser', path: '0', unrecorded: 'redact' });

        for (const stored of [trace, JSON.parse(JSON.stringify(trace))]) {
            for (const onMissing of /** @type {const} */ (['throw', 'execute'])) {
                const { result: replayed, unreached } = await replayEffect(signup('a@b.c'), stored, { onMissing });
                const error = /** @type {any} */ (errorOf(replayed));
                assert.equal(error.name, 'ReplayError');
                assert.match(error.message, /no outcome for 'cmdFindUser' at path '0'/);
                assert.match(error.message, /: redact threw on it, so the recorder left it out\./);
                assert.match(error.message, /make redact handle every value it is given, null included/);
                assert.equal(error.path, '0');
                assert.deepEqual(unreached, []);
            }
        }
        assert.equal(lookups, 1, 'the step production ran is not run again, even under execute');

        // A trace without paths, matched by position, stops there too.
        const legacy = { trace: [{ command: 'cmdFindUser', unrecorded: 'redact' }] };
        const { result: positional } = await replayEffect(signup('a@b.c'), legacy);
        assert.match(/** @type {any} */ (errorOf(positional)).message, /no outcome for 'cmdFindUser' at path '0':/);

        // A cause the library does not write, as a hand-built trace may hold, still stops, and is not guessed at.
        const handBuilt = { trace: [{ command: 'cmdFindUser', path: '0', unrecorded: /** @type {any} */ (true) }] };
        const { result: unknown } = await replayEffect(signup('a@b.c'), handBuilt);
        assert.match(/** @type {any} */ (errorOf(unknown)).message, /: it could not be recorded, so the recorder/);
    });

    it('should mark a thrown error redact threw on as a throw that holds no error', async function () {
        const flow = () =>
            Command(function cmdCharge() {
                throw Object.assign(new Error('declined'), { card: '4111111111111111' });
            });
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
            if (kind === 'error') throw new Error('redact bug');
            return value;
        };
        const { trace } = await recordEffect(flow, null, { redact });
        const [{ durationMs, ...entry }] = trace.trace;
        assert.deepEqual(entry, { command: 'cmdCharge', path: '0', threw: true, unrecorded: 'redact' });
        assert.ok(!JSON.stringify(trace).includes('4111'));
        const { result } = await replayEffect(flow(), trace);
        assert.match(/** @type {any} */ (errorOf(result)).message, /no outcome for 'cmdCharge'/);

        // What redact returns is its own: one the recorder cannot read while keeping it an Error is blamed on redact.
        const unreadable = new Proxy(
            {},
            {
                ownKeys() {
                    throw new Error('cannot list keys');
                }
            }
        );
        const { trace: rebuilt } = await recordEffect(flow, null, {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
                kind === 'error' ? unreadable : value
        });
        assert.equal(rebuilt.trace[0].unrecorded, 'redact');
    });

    it('should mark a step whose value the recorder cannot copy, rather than drop it', async function () {
        // A thrown error whose `cause` getter throws made the recorder's own copy throw, and the observer swallowed that
        // along with the entry: the trace held nothing for two attempts that charged a card, `dropped` stayed 0, and a
        // replay under onMissing: 'execute' charged the card twice more.
        const unreadable = () =>
            Object.defineProperty(new Error('declined'), 'cause', {
                get() {
                    throw new Error('getter');
                }
            });
        let charges = 0;
        const flow = () =>
            Retry(
                Command(function cmdCharge() {
                    charges++;
                    throw unreadable();
                }),
                { attempts: 1, delay: 0 }
            );
        const { result, trace } = await recordEffect(flow, null);
        assert.equal(result.type, 'Failure', 'the run keeps its own outcome');
        assert.equal(charges, 2);
        assert.deepEqual(
            trace.trace.map(({ durationMs, ...entry }) => entry),
            [
                { command: 'cmdCharge', path: '0r0/0', threw: true, unrecorded: 'copy' },
                { command: 'cmdCharge', path: '0r1/0', threw: true, unrecorded: 'copy' }
            ]
        );
        const { result: replayed } = await replayEffect(flow(), trace, { onMissing: 'execute' });
        assert.match(
            /** @type {any} */ (errorOf(replayed)).message,
            /no outcome for 'cmdCharge' at path '0r0\/0': it could not be copied, as when it holds a BigInt or a getter that throws/
        );
        assert.equal(charges, 2, 'the replay charged nothing');

        // A result it cannot copy is marked the same way.
        const unlisted = new Proxy(
            { id: 1 },
            {
                ownKeys() {
                    throw new Error('cannot list keys');
                }
            }
        );
        const { result: loaded, trace: loadedTrace } = await recordEffect(
            () =>
                Command(function cmdLoad() {
                    return unlisted;
                }),
            null
        );
        assert.equal(loaded.type, 'Success');
        const [{ durationMs, ...entry }] = loadedTrace.trace;
        assert.deepEqual(entry, { command: 'cmdLoad', path: '0', unrecorded: 'copy' });
    });

    it('should never let recording a thrown value replace it or lose its entry', async function () {
        // The recorder read a property of the thrown value's copy outside the part that catches, and the copy of an
        // instance it could not clone was the live value, so a getter that throws there escaped the recorder: the
        // trace lost both attempts, and the recorder's error replaced the Command's own, retried as an I/O fault.
        const proxied = new Proxy(new (class Thrown {})(), {
            get(target, key) {
                if (key === '__error') throw new Error('getter');
                return Reflect.get(target, key);
            }
        });
        // The copy keeps a getter that throws as it is, so reading the copy runs it.
        const withGetter = {
            get __error() {
                throw new Error('getter');
            }
        };
        for (const hostile of [proxied, withGetter]) {
            let calls = 0;
            const flow = () =>
                Retry(
                    Command(function cmdCharge() {
                        calls++;
                        throw hostile;
                    }),
                    { attempts: 1, delay: 0 }
                );
            const { result, trace } = await recordEffect(flow, null);
            assert.equal(/** @type {any} */ (errorOf(result)).lastError, hostile, "the Command's own error");
            assert.equal(calls, 2);
            assert.deepEqual(
                trace.trace.map((e) => e.path),
                ['0r0/0', '0r1/0'],
                'both attempts are recorded'
            );
        }
    });

    it('should mark an input or context the recorder cannot copy, and still run the flow', async function () {
        // `toTrace` threw, so `recordEffect` rejected before the flow ran.
        const unlisted = new Proxy(
            { id: 1 },
            {
                ownKeys() {
                    throw new Error('cannot list keys');
                }
            }
        );
        let calls = 0;
        const flow = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Command(function cmdLoad() {
                    calls++;
                    return i.id;
                })
            )(input);
        const { result, trace } = await recordEffect(flow, unlisted, { context: unlisted });
        assert.deepEqual(result, Success(1));
        assert.equal(calls, 1);
        assert.equal(trace.initialInput, undefined);
        assert.equal(trace.context, undefined);
        assert.deepEqual(trace.unrecorded, { initialInput: 'copy', context: 'copy' });
    });

    it('should leave out an input or context redact threw on, and refuse a replay that needs it', async function () {
        // Both were stored as '[redaction failed]', so timeTravel rebuilt the flow from that string, and an Ask read
        // it as the context.
        const flow = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Ask((/** @type {any} */ ctx) =>
                    Command(
                        function cmdLoad() {
                            return { id: i.id };
                        },
                        (/** @type {any} */ row) => Success({ ...row, tenant: ctx.tenant })
                    )
                )
            )(input);
        const throwsOn =
            (/** @type {string[]} */ kinds) =>
            (/** @type {any} */ value, /** @type {any} */ name, /** @type {string} */ kind) => {
                if (kinds.includes(kind)) throw new Error('redact bug');
                return value;
            };
        const context = { tenant: 'acme' };
        const { result, trace } = await recordEffect(
            flow,
            { id: 1 },
            { context, redact: throwsOn(['initialInput', 'context']) }
        );
        assert.deepEqual(result, Success({ id: 1, tenant: 'acme' }));
        assert.equal(trace.initialInput, undefined);
        assert.equal(trace.context, undefined);
        assert.deepEqual(trace.unrecorded, { initialInput: 'redact', context: 'redact' });
        const stored = JSON.parse(JSON.stringify(trace));

        await assert.rejects(timeTravel(flow, stored, { log: () => {} }), (/** @type {any} */ e) => {
            assert.equal(e.name, 'ReplayError');
            assert.match(e.message, /holds no initialInput: redact threw on it, so the recorder left it out/);
            assert.equal(e.field, 'initialInput');
            return true;
        });
        await assert.rejects(replayEffect(flow({ id: 1 }), stored), (/** @type {any} */ e) => {
            assert.equal(e.name, 'ReplayError');
            assert.match(e.message, /holds no context: redact threw on it, so the recorder left it out/);
            assert.match(e.message, /pass options\.context/);
            assert.equal(e.field, 'context');
            return true;
        });
        const { result: replayed } = await replayEffect(flow({ id: 1 }), stored, { context });
        assert.deepEqual(replayed, result, 'a context passed in replays it');

        // A trace whose redact succeeded carries no such field.
        const { trace: clean } = await recordEffect(flow, { id: 1 }, { context });
        assert.equal('unrecorded' in clean, false);
    });

    it('should keep redacted values out of the trace', async function () {
        const flow = () =>
            Command(
                function cmdLoadUser() {
                    return { id: 7, email: 'ada@example.com', card: '4111111111111111' };
                },
                (/** @type {any} */ u) => Success(u)
            );

        const { trace } = await recordEffect(flow, null, {
            redact: (result, name) =>
                name === 'cmdLoadUser'
                    ? { .../** @type {any} */ (result), email: '[redacted]', card: '[redacted]' }
                    : result
        });
        assert.deepEqual(trace.trace[0].result, { id: 7, email: '[redacted]', card: '[redacted]' });
        assert.ok(!JSON.stringify(trace).includes('4111111111111111'));
    });

    it('should offer redact every value a trace holds', async function () {
        /** @type {any[]} */
        const seen = [];
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) =>
                    Command(
                        function cmdRead() {
                            return { id: 1, email: i.email };
                        },
                        (/** @type {any} */ r) => Success({ ...i, ...r })
                    ),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdSave() {
                            throw Object.assign(new Error('duplicate'), { attempted: { password: i.password } });
                        },
                        (/** @type {any} */ r) => Success(r)
                    )
            )(input);

        const { trace } = await recordEffect(
            flow,
            { email: 'user@test.com', password: 'hunter2' },
            {
                context: { flowName: 'register', authToken: 'bearer-abc123' },
                redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                    seen.push([kind, name]);
                    if (kind === 'initialInput') return { ...value, password: '[redacted]' };
                    if (kind === 'context') return { ...value, authToken: '[redacted]' };
                    if (kind === 'error') return { ...value, attempted: '[redacted]' };
                    return value;
                }
            }
        );

        assert.deepEqual(
            seen,
            [
                ['initialInput', 'initialInput'],
                ['context', 'context'],
                ['result', 'cmdRead'],
                ['error', 'cmdSave']
            ],
            'every value a trace holds passes through redact, each as it enters the trace: the input and context before the run'
        );
        const json = JSON.stringify(trace);
        assert.ok(!json.includes('hunter2'), 'no password anywhere in the trace');
        assert.ok(!json.includes('bearer-abc123'), 'no token anywhere in the trace');
    });

    it('should replay an error redact rebuilt as an Error', async function () {
        // A redact that built a fresh object for an error dropped the marker that told replay it was an Error, so
        // production handed the flow an Error and the replay a plain object, and nothing warned.
        const flow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(function cmdCharge() {
                    throw Object.assign(new Error('bad gateway'), { status: 502, token: 'tok_secret' });
                })
            )(input);
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
            kind === 'error' ? { name: value.name, message: value.message, status: value.status } : value;
        const { result, trace } = await recordEffect(flow, 'in', { redact });
        assert.ok(!JSON.stringify(trace).includes('tok_secret'), 'what redact removed stays out');
        for (const stored of [trace, JSON.parse(JSON.stringify(trace))]) {
            const { result: replayed } = await replayEffect(flow('in'), stored);
            const error = /** @type {any} */ (errorOf(replayed));
            assert.equal(error instanceof Error, true, 'an Error, as in production');
            assert.equal(error.message, 'bad gateway');
            assert.equal(error.status, 502);
            assert.equal(error.token, undefined);
        }
        assert.ok(/** @type {any} */ (result).error instanceof Error);
    });

    it('should replay an error redact rebuilt the same from memory as from JSON', async function () {
        // Picking fields the error did not have, as `{ status: value.status }` does, left `status: undefined` on the
        // error replayed from memory, which JSON drops, so the two replays and production disagreed.
        const flow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(function cmdCall() {
                    throw new Error('down');
                })
            )(input);
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
            kind === 'error' ? { name: value.name, message: value.message, status: value.status } : value;
        const { result, trace } = await recordEffect(flow, 'in', { redact });
        const { result: fromMemory } = await replayEffect(flow('in'), trace);
        const { result: fromJson } = await replayEffect(flow('in'), JSON.parse(JSON.stringify(trace)));
        assert.deepEqual(fromMemory, result);
        assert.deepEqual(fromJson, result);
    });

    it('should drop an undefined field on an error as storage does, so memory and storage replay alike', async function () {
        const flow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(function cmdCall() {
                    throw Object.assign(new Error('down'), { code: undefined });
                })
            )(input);
        const { trace } = await recordEffect(flow, 'in');
        const { result: fromMemory } = await replayEffect(flow('in'), trace);
        const { result: fromJson } = await replayEffect(flow('in'), JSON.parse(JSON.stringify(trace)));
        assert.deepEqual(fromMemory, fromJson);
        assert.ok(!Object.hasOwn(/** @type {any} */ (errorOf(fromMemory)), 'code'));
    });

    it('should leave an error redact replaced with a value that is not an object as that value', async function () {
        const flow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(function cmdCharge() {
                    throw new Error('card 4242 declined');
                })
            )(input);
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
            kind === 'error' ? '[redacted]' : value;
        const { trace } = await recordEffect(flow, 'in', { redact });
        const { result: replayed } = await replayEffect(flow('in'), JSON.parse(JSON.stringify(trace)));
        assert.equal(errorOf(replayed), '[redacted]');
    });

    it('should leave out a context whose getter throws, and still run the flow', async function () {
        // JSON cannot read the getter, so the copy fails before redact runs, and the whole context is left out.
        const context = {
            tenant: 'acme',
            services: {
                get client() {
                    throw new Error('client not connected');
                }
            }
        };
        const packaged = recorder().toTrace({ context });
        assert.equal(packaged.context, undefined);
        assert.deepEqual(packaged.unrecorded, { context: 'copy' });
        let calls = 0;
        const flow = effectPipe(() =>
            Command(function cmdCharge() {
                calls++;
                return 'ch_1';
            })
        );
        const { result, trace } = await recordEffect(flow, 'in', {
            context,
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
                kind === 'context' ? { tenant: value.tenant } : value
        });
        assert.deepEqual(result, Success('ch_1'));
        assert.equal(calls, 1);
        assert.deepEqual(trace.unrecorded, { context: 'copy' }, 'a redact that would drop the client cannot rescue it');
    });

    it('should leave an absent initialInput or context undefined rather than redacting nothing into an object', function () {
        const rec = recorder({ redact: (/** @type {any} */ value) => ({ ...value, added: true }) });
        const trace = rec.toTrace({ flowName: 'bare' });
        assert.equal(trace.initialInput, undefined);
        assert.equal(trace.context, undefined);
    });

    it('should still replay after initialInput is redacted, when no step branches on the redacted field', async function () {
        // Replay feeds recorded results rather than running Commands, so stripping a field only matters
        // if the flow's control flow reads it.
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => (i.email ? Success(i) : Failure('no_email')),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdHash() {
                            return { hash: `hashed_${i.password}` };
                        },
                        (/** @type {any} */ r) => Success(r)
                    )
            )(input);

        const { result, trace } = await recordEffect(
            flow,
            { email: 'a@b.c', password: 'hunter2' },
            {
                redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
                    kind === 'initialInput' ? { ...value, password: '[redacted]' } : value
            }
        );
        assert.equal(result.type, 'Success');
        assert.equal(/** @type {any} */ (trace.initialInput).password, '[redacted]');

        const { result: replayed } = await replayEffect(flow(trace.initialInput), trace);
        assert.equal(replayed.type, 'Success', 'the redacted input still rebuilds a matching flow');
        assert.deepEqual(valueOf(replayed), valueOf(result), 'and the recorded hash comes back intact');
    });

    it('should record a stack only when asked to', async function () {
        const flow = () =>
            Command(function cmdBoom() {
                return Promise.reject(new Error('boom'));
            });
        const plain = await recordEffect(flow, null);
        const withStack = await recordEffect(flow, null, { stack: true });
        assert.equal(/** @type {any} */ (plain.trace.trace[0].error).stack, undefined, 'off by default');
        assert.match(/** @type {any} */ (withStack.trace.trace[0].error).stack, /Error: boom/);
    });

    it('should cap a runaway trace and report how many steps were dropped', async function () {
        const { flow } = makeFlow();
        const rec = recorder({ maxEntries: 1 });
        await runEffect(flow({ id: 'x' }), {}, { onStep: rec.onStep });
        const trace = rec.toTrace({ initialInput: { id: 'x' } });
        assert.equal(trace.trace.length, 1);
        assert.equal(trace.dropped, 1);
    });

    it('should give each recorder its own independent trace', async function () {
        const { flow } = makeFlow();
        const first = recorder();
        const second = recorder();
        await Promise.all([
            runEffect(flow({ id: 'a' }), {}, { onStep: first.onStep }),
            runEffect(flow({ id: 'b' }), {}, { onStep: second.onStep })
        ]);
        assert.equal(first.entries.length, 2);
        assert.equal(second.entries.length, 2);
        assert.equal(/** @type {any} */ (first.entries[0].result).row, 'a');
        assert.equal(/** @type {any} */ (second.entries[0].result).row, 'b');
    });

    it('should mark a result JSON cannot encode, and cut a loop in one it can', async function () {
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(function cmdFindOrder() {
                        return { id: 9007199254740993n, total: 100 };
                    }),
                (/** @type {any} */ order) =>
                    Command(
                        function cmdLoadGraph() {
                            /** @type {any} */
                            const node = { total: order.total };
                            node.self = node;
                            return node;
                        },
                        (/** @type {any} */ node) => Success(node.total)
                    )
            )(input);
        const { result, trace } = await recordEffect(flow, null);
        assert.deepEqual(result, Success(100), 'recording does not change the run');
        assert.equal(trace.trace[0].unrecorded, 'copy', 'a BigInt cannot be stored');
        assert.deepEqual(trace.trace[1].result, { total: 100 }, 'the loop back is cut');
        const { result: replayed } = await replayEffect(flow(null), trace);
        assert.equal(/** @type {any} */ (errorOf(replayed)).name, 'ReplayError');
    });
});

describe('Recorded values are snapshots', function () {
    beforeEach(() => configureEffect());

    it('should not let a later mutation rewrite what an earlier step returned', async function () {
        const shared = { total: 100 };
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(
                        function cmdRead() {
                            return shared;
                        },
                        (/** @type {any} */ r) => Success(r)
                    ),
                (/** @type {any} */ r) =>
                    Command(
                        function cmdApplyDiscount() {
                            r.total = 0;
                            return { applied: true };
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )(input);

        const { trace } = await recordEffect(flow, { cartId: 1 });
        assert.deepEqual(trace.trace[0].result, { total: 100 }, 'the trace holds what production saw');
        assert.equal(shared.total, 0, 'while the live object was still mutated by the flow');
    });

    it('should keep the trace stable when the caller mutates the value afterwards', async function () {
        const row = { id: 1, tags: ['a'] };
        const rec = recorder();
        await runEffect(
            Command(
                function cmdRead() {
                    return row;
                },
                (/** @type {any} */ r) => Success(r)
            ),
            {},
            { onStep: rec.onStep }
        );
        row.tags.push('b');
        row.id = 99;
        assert.deepEqual(rec.entries[0].result, { id: 1, tags: ['a'] }, 'nested values are snapshotted too');
    });

    it('should copy a value as storage holds it', async function () {
        const callback = () => 'not cloneable';
        const logger = new (class Logger {
            write = () => {};
        })();
        const options = Object.assign(Object.create(null), { retries: 1, onRetry: () => {} });
        const row = {
            ok: true,
            tags: ['a'],
            handlers: ['a', callback],
            when: new Date('2026-01-01T00:00:00Z'),
            logger,
            options,
            callback
        };
        const rec = recorder();
        const result = await runEffect(
            Command(
                function cmdWithFunction() {
                    return row;
                },
                (/** @type {any} */ r) => Success(r)
            ),
            {},
            { onStep: rec.onStep }
        );
        assert.equal(result.type, 'Success', 'an uncloneable result must not fail the run');
        row.ok = false;
        row.tags.push('b');
        options.retries = 2;
        assert.deepEqual(rec.entries[0].result, {
            ok: true,
            tags: ['a'],
            handlers: ['a', null],
            when: '2026-01-01T00:00:00.000Z',
            logger: {},
            options: { retries: 1 }
        });
    });

    it('should copy an object it cannot clone, so an in-place redact never reaches the run', async function () {
        // A class with an arrow-function field cannot be cloned, and the copy fell back to the live object. So redact
        // was handed the object the run held, and one that deleted the password in place changed what next received:
        // the run returned undefined where it returned the password without recording, the incident DESIGN.md records
        // as fixed for values that can be cloned. The trace held the live object too, so a later change rewrote it.
        class User {
            email = 'a@b.c';
            password = 'secret';
            save = () => {};
        }
        const user = new User();
        const flow = () =>
            Command(
                function cmdLoadUser() {
                    return user;
                },
                (/** @type {any} */ u) => Success(u.password)
            );
        const { result, trace } = await recordEffect(flow, null, {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'result') delete value.password;
                return value;
            }
        });
        assert.deepEqual(result, Success('secret'), 'the run is what it is without recording');
        assert.equal(user.password, 'secret');
        const recorded = /** @type {any} */ (trace.trace[0].result);
        assert.notEqual(recorded, user);
        assert.equal(recorded.password, undefined, 'the trace holds the redacted copy');
        user.email = 'changed@later.io';
        assert.equal(recorded.email, 'a@b.c', 'a later change does not rewrite it');

        // A replay from memory hands the flow a copy as well.
        const { result: replayed } = await replayEffect(
            Command(
                function cmdLoadUser() {
                    return user;
                },
                (/** @type {any} */ u) => {
                    u.email = 'replayed';
                    return Success(u.email);
                }
            ),
            trace
        );
        assert.deepEqual(replayed, Success('replayed'));
        assert.equal(recorded.email, 'a@b.c', 'the replay did not rewrite the trace');
    });

    it('should cut a reference back to an enclosing object, and keep one shared without a loop', async function () {
        // An HTTP client's request and response point at each other. JSON refuses the loop, so the copy cuts it where
        // it returns, as serializeError cuts an error chain, and keeps a value that merely appears twice in full.
        const headers = { accept: 'json' };
        /** @type {any} */
        const request = { method: 'POST', transform: () => {}, headers };
        request.response = { status: 502, request, headers };
        const rec = recorder();
        await runEffect(
            Command(
                function cmdCallGateway() {
                    return request;
                },
                (/** @type {any} */ r) => Success(r.response.status)
            ),
            {},
            { onStep: rec.onStep }
        );
        assert.deepEqual(rec.entries[0].result, {
            method: 'POST',
            headers: { accept: 'json' },
            response: { status: 502, headers: { accept: 'json' } }
        });
    });

    it("should let redact trim an HTTP client's error, whose request and response point at each other", async function () {
        // A plain JSON copy failed on the loop before redact ran, so a redact written to trim the error never could,
        // and the step was left out of the trace.
        const flow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(function cmdCharge() {
                    /** @type {any} */
                    const request = { method: 'POST', transform: () => {} };
                    request.response = { status: 502, request };
                    throw Object.assign(new Error('Request failed with status code 502'), {
                        request,
                        response: request.response
                    });
                })
            )(input);
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
            kind === 'error' ? { name: value.name, message: value.message, status: value.response.status } : value;
        const { trace } = await recordEffect(flow, 'in', { redact });
        const { result } = await replayEffect(flow('in'), JSON.parse(JSON.stringify(trace)));
        assert.ok(errorOf(result) instanceof Error);
        const error = /** @type {any} */ (errorOf(result));
        assert.equal(error.message, 'Request failed with status code 502');
        assert.equal(error.status, 502);
    });

    it('should not let a replayed flow rewrite an uncloneable recorded result', async function () {
        const flow = () =>
            Command(
                function cmdLoadCart() {
                    return { items: ['a'], total: () => 1 };
                },
                (/** @type {any} */ cart) => {
                    cart.items.push('b');
                    return Success(cart.items.length);
                }
            );
        const { trace } = await recordEffect(flow, null);
        const first = await replayEffect(flow(), trace);
        const second = await replayEffect(flow(), trace);
        assert.deepEqual(first.result, Success(2));
        assert.deepEqual(second.result, Success(2), 'a second replay sees what production saw');
    });

    it('should hand redact a copy of a result, so an in-place redact cannot change what next receives', async function () {
        // redact was handed the live result before next ran, so `delete value.passwordHash` in a redact removed
        // the hash from the object the login check was about to read, and recording turned a correct password
        // into a failed login.
        const login = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Command(
                    function cmdFetchUser() {
                        return { id: 1, passwordHash: 'h:secret123' };
                    },
                    (/** @type {any} */ user) =>
                        user.passwordHash === `h:${i.password}` ? Success({ id: user.id }) : Failure('Bad credentials.')
                )
            )(input);
        const { result, trace } = await recordEffect(
            login,
            { password: 'secret123' },
            {
                redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                    if (kind === 'result') delete value.passwordHash;
                    return value;
                }
            }
        );
        assert.deepEqual(result, Success({ id: 1 }), 'the flow saw the hash');
        assert.deepEqual(trace.trace[0].result, { id: 1 }, 'while the trace did not');
    });

    it('should hand redact a copy of a thrown error, so the caller keeps the whole error', async function () {
        const flow = () =>
            Command(function cmdCallGateway() {
                return Promise.reject(
                    Object.assign(new Error('401'), { response: { headers: { authorization: 'Bearer tok' } } })
                );
            });
        const { result, trace } = await recordEffect(flow, null, {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'error') delete value.response.headers.authorization;
                return value;
            }
        });
        assert.equal(/** @type {any} */ (result).error.response.headers.authorization, 'Bearer tok');
        assert.deepEqual(/** @type {any} */ (trace.trace[0].error).response.headers, {});
    });

    it('should hand redact a copy of the input and of a context holding a function', async function () {
        // The input is the object the flow's Commands close over, and the context is the one Ask hands them, so
        // an in-place redact of either reached the run itself. A context holding a logger cannot be cloned, and
        // the copy used to fall back to the live object there, so it needs copying around the function.
        /** @type {any[]} */
        const saved = [];
        /** @type {any[]} */
        const tokens = [];
        const log = () => {};
        const register = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Ask((/** @type {any} */ ctx) =>
                    Command(function cmdSaveUser() {
                        tokens.push(ctx.apiToken);
                        saved.push({ ...i });
                        return { id: 2 };
                    })
                )
            )(input);
        const { trace } = await recordEffect(
            register,
            { email: 'new@x.io', password: 'secret123' },
            {
                context: { apiToken: 'tok_live', log },
                redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                    if (kind === 'initialInput') delete value.password;
                    if (kind === 'context') delete value.apiToken;
                    return value;
                }
            }
        );
        assert.deepEqual(saved, [{ email: 'new@x.io', password: 'secret123' }], 'the database got the password');
        assert.deepEqual(tokens, ['tok_live'], 'and the Command got the token');
        assert.deepEqual(trace.initialInput, { email: 'new@x.io' });
        assert.equal(/** @type {any} */ (trace.context).apiToken, undefined);
        assert.equal(
            /** @type {any} */ (trace.context).log,
            undefined,
            'the function is left out, as storage leaves it'
        );
    });

    it('should replay a Date and a Map from memory as storage does', async function () {
        const flow = () =>
            Command(function cmdLoad() {
                return { when: new Date('2026-01-01T00:00:00Z'), seen: new Map([['a', 1]]) };
            });
        const { trace } = await recordEffect(flow, null);
        const { result: replayed } = await replayEffect(flow(), trace);
        assert.deepEqual(replayed, Success({ when: '2026-01-01T00:00:00.000Z', seen: {} }));
    });

    it('should not let a replayed flow rewrite the trace it replays', async function () {
        const flow = () =>
            Command(
                function cmdFetchCart() {
                    return { items: ['a', 'b'] };
                },
                (/** @type {any} */ cart) => {
                    cart.items.push('c');
                    return Success(cart.items.length);
                }
            );
        const { trace } = await recordEffect(flow, null);
        assert.deepEqual(trace.trace[0].result, { items: ['a', 'b'] }, 'recording snapshots the result');

        const first = await replayEffect(flow(), trace);
        const second = await replayEffect(flow(), trace);
        assert.deepEqual(first.result, Success(3));
        assert.deepEqual(second.result, Success(3), 'a second replay sees what production saw');
        assert.deepEqual(trace.trace[0].result, { items: ['a', 'b'] }, 'and the trace is unchanged');
    });

    it('should not let a caller rewrite a recorded error through a replayed Failure', async function () {
        const flow = () =>
            Command(function cmdCallGateway() {
                return Promise.reject(Object.assign(new Error('503'), { response: { status: 503 } }));
            });
        const { trace } = await recordEffect(flow, null);

        const first = await replayEffect(flow(), trace);
        /** @type {any} */ (first.result).error.response.status = 200;
        const second = await replayEffect(flow(), trace);
        assert.equal(/** @type {any} */ (second.result).error.response.status, 503);
    });

    it('should record the input a run was called with, even when a Command changes it', async function () {
        // An ORM save assigns the new id to the object it is handed, as TypeORM and Mongoose do. The input was
        // copied when the trace was packaged after the run, so the trace claimed production received an id,
        // and the unchanged flow replayed down the update branch as a TimeParadox.
        const orm = {
            async save(/** @type {any} */ entity) {
                entity.id ??= 'u_1';
                return entity;
            }
        };
        const upsert = (/** @type {any} */ user) =>
            user.id
                ? Command(function cmdUpdateUser() {
                      return orm.save(user);
                  })
                : Command(
                      function cmdInsertUser() {
                          return orm.save(user);
                      },
                      (/** @type {any} */ saved) => Success(saved.id)
                  );
        const { result, trace } = await recordEffect(upsert, { email: 'a@b.com' });
        assert.deepEqual(trace.initialInput, { email: 'a@b.com' }, 'the trace holds what production received');
        const { result: replayed } = await replayEffect(upsert(trace.initialInput), trace);
        assert.deepEqual(replayed, result);
    });

    it('should record the context a run was given, even when a Command changes it', async function () {
        // Ask read the context before the sign-in Command wrote to it. A copy taken after the run held what the
        // Command wrote, so the replay took the other branch and reported a Failure with no warning.
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) =>
                    Ask((/** @type {any} */ ctx) => (ctx.user ? Failure('already signed in') : Success(i))),
                () =>
                    Ask((/** @type {any} */ ctx) =>
                        Command(function cmdSignIn() {
                            ctx.user = { id: 7 };
                            return ctx.user;
                        })
                    )
            )(input);
        const { result, trace } = await recordEffect(flow, { email: 'a@b.com' }, { context: {} });
        assert.deepEqual(trace.context, {}, 'the trace holds the context Ask saw');
        const replayed = await timeTravel(flow, trace, { log: () => {} });
        assert.deepEqual(replayed, result);
    });
});

describe('Recorded step timings', function () {
    beforeEach(() => configureEffect());

    const slow = (/** @type {number} */ ms) =>
        Command(
            function cmdSlow() {
                return new Promise((r) => setTimeout(() => r('done'), ms));
            },
            (/** @type {any} */ v) => Success(v)
        );

    it('should record how long each Command took', async function () {
        const rec = recorder();
        const started = performance.now();
        await runEffect(slow(15), {}, { onStep: rec.onStep });
        const wall = performance.now() - started;
        assert.equal(rec.entries.length, 1);
        const { durationMs } = rec.entries[0];
        assert.equal(typeof durationMs, 'number');
        assert.ok(/** @type {number} */ (durationMs) >= 10, `expected at least 10ms, got ${durationMs}`);
        assert.ok(
            /** @type {number} */ (durationMs) <= wall + 1,
            `no longer than the run (${wall}ms), got ${durationMs}`
        );
        assert.equal(
            durationMs,
            Math.round(/** @type {number} */ (durationMs) * 1000) / 1000,
            'rounded to microseconds'
        );
    });

    it('should record a duration for a Command that threw', async function () {
        const rec = recorder();
        const started = performance.now();
        const result = await runEffect(
            Command(
                function cmdBoom() {
                    throw new Error('boom');
                },
                (/** @type {any} */ v) => Success(v)
            ),
            {},
            { onStep: rec.onStep }
        );
        const wall = performance.now() - started;
        assert.equal(result.type, 'Failure');
        assert.ok('error' in rec.entries[0]);
        const { durationMs } = rec.entries[0];
        assert.equal(typeof durationMs, 'number');
        assert.ok(
            /** @type {number} */ (durationMs) <= wall + 1,
            `no longer than the run (${wall}ms), got ${durationMs}`
        );
    });

    it('should keep timings out of the way of replay', async function () {
        const flow = (/** @type {any} */ input) => effectPipe(() => slow(5))(input);
        const { result, trace } = await recordEffect(flow, { id: 1 });
        assert.equal(typeof trace.trace[0].durationMs, 'number');
        const { result: replayed } = await replayEffect(flow({ id: 1 }), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    it('should not let an observation failure change the outcome', async function () {
        // What the recorder's two catches are for: a redact that throws marks its value and leaves the run alone.
        let ran = 0;
        const rec = recorder({
            redact: () => {
                throw new Error('redact blew up');
            }
        });
        const result = await runEffect(
            Command(
                function cmdWork() {
                    ran++;
                    return 'ok';
                },
                (/** @type {any} */ v) => Success(v)
            ),
            {},
            { onStep: rec.onStep }
        );
        assert.equal(result.type, 'Success');
        assert.equal(valueOf(result), 'ok');
        assert.equal(ran, 1);
    });
});
