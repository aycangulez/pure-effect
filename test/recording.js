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
import { valueOf, errorOf, makeFlow, jsTypeErrors, importInProject, consumerFilesTypeErrors } from './helpers.js';
import { enableRecording, recordingHooks } from '../flight-recorder.js';
import ts from 'typescript';

describe('Recording', function () {
    beforeEach(() => configureEffect());

    it('should carry an error cause through a trace and back', async function () {
        const flow = (/** @type {any} */ input) =>
            Command(function cmdCharge() {
                return Promise.reject(new Error('charge declined', { cause: new Error('card expired') }));
            });

        const { result, trace } = await recordEffect(flow({ id: 'cause' }));
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

        const { trace } = await recordEffect(flow({ id: 'chain' }));
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
        const { trace } = await recordEffect(flow({ id: 'loop' }));
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
        const { trace } = await recordEffect(flow({ id: 'twice' }));
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
        const { result, trace } = await recordEffect(flow());
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
        const { result, trace } = await recordEffect(flow(true)({ orderId: 1 }));
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
                { retries: 2, delay: 0 }
            );
        const { result, trace } = await recordEffect(flow());
        const { result: replayed, unreached } = await replayEffect(flow(), JSON.parse(JSON.stringify(trace)));
        assert.deepEqual(replayed, result);
        assert.deepEqual(/** @type {any} */ (replayed).error, {
            retryExhausted: true,
            lastError: undefined,
            retries: 2
        });
        assert.deepEqual(unreached, [], 'every recorded attempt was replayed');
    });

    it('should replay a failure whose error redact removed as a failure, from JSON', async function () {
        // Unlike a result, an error redact returns undefined for is kept as a throw with nothing to show, since the
        // throw is the verdict the flow acts on.
        const flow = () =>
            Command(function cmdVerifyIdentity() {
                return Promise.reject(new Error('SSN does not match'));
            });
        const { trace } = await recordEffect(flow(), {
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

        const { result, trace } = await recordEffect(flow({ id: 'agg' }));
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
            const { result, trace } = await recordEffect(flow({ id: 'val' }));
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

        const { result, trace } = await recordEffect(flow({ id: 'deq' }));
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
        const { trace } = await recordEffect(flow({ id: 'named' }));
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
        const { result, trace } = await recordEffect(flow({ id: 'assigned' }));
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
            const { result, trace } = await recordEffect(flow({ i }));
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
        const { result, trace } = await recordEffect(signup('a@b.c'), { redact });
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
                assert.match(
                    error.message,
                    /: redact threw on it or returned undefined, so the recorder left it out\./
                );
                assert.match(error.message, /make redact handle every value it is given, null included/);
                assert.doesNotMatch(error.message, /production/i);
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

    it('should mark a value redact returned undefined for as unrecorded, as one it threw on', async function () {
        // A redact with a branch missing its return stored the entry with no result and no mark, so a replay handed the
        // flow undefined where production had a user, and a step reading it threw a TypeError.
        const flow = effectPipe(() =>
            Command(
                function cmdFindUser() {
                    return { id: 7 };
                },
                (/** @type {any} */ user) => Success(user.id)
            )
        );
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
            if (kind !== 'result') return value;
        };
        const { result, trace } = await recordEffect(flow('a@b.c'), { redact });
        assert.deepEqual(result, Success(7));
        const [{ durationMs, ...entry }] = trace.trace;
        assert.deepEqual(entry, { command: 'cmdFindUser', path: '0', unrecorded: 'redact' });
        const { result: replayed } = await replayEffect(flow('a@b.c'), trace);
        const error = /** @type {any} */ (errorOf(replayed));
        assert.equal(error.name, 'ReplayError');
        assert.match(error.message, /: redact threw on it or returned undefined, so the recorder left it out\./);
        assert.match(error.message, /null included, and return a value for each/);

        // A Command that returned undefined is still recorded as one, whatever redact returns for it.
        const quiet = effectPipe(() => Command(function cmdNotify() {}));
        const { trace: quietTrace } = await recordEffect(quiet('a@b.c'), {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
                kind === 'result' ? undefined : value
        });
        assert.equal(quietTrace.trace[0].unrecorded, undefined);
        assert.deepEqual((await replayEffect(quiet('a@b.c'), quietTrace)).result, Success(undefined));
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
        const { trace } = await recordEffect(flow(), { redact });
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
        const { trace: rebuilt } = await recordEffect(flow(), {
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
                { retries: 1, delay: 0 }
            );
        const { result, trace } = await recordEffect(flow());
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
            Command(function cmdLoad() {
                return unlisted;
            })
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
                    { retries: 1, delay: 0 }
                );
            const { result, trace } = await recordEffect(flow());
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
        const { result, trace } = await recordEffect(flow(unlisted), { context: unlisted });
        assert.deepEqual(result, Success(1));
        assert.equal(calls, 1);
        assert.equal(trace.initialInput, undefined);
        assert.equal(trace.context, undefined);
        assert.deepEqual(trace.unrecorded, { initialInput: 'copy', context: 'copy' });
    });

    it('should record the empty context of a run given none without passing it to redact', async function () {
        // recordEffect passed redact the {} a run without a context gets, so a redact that threw on it marked the
        // context unrecorded, and the replay of a flow that never read one was refused for want of it.
        const flow = effectPipe(() =>
            Command(function cmdLoad() {
                return { id: 1 };
            })
        );
        /** @type {string[]} */
        const kinds = [];
        const redact = (/** @type {any} */ value, /** @type {any} */ name, /** @type {string} */ kind) => {
            kinds.push(kind);
            if (kind === 'context') throw new Error('redact bug');
            return value;
        };
        const { trace } = await recordEffect(flow('in'), { redact });
        assert.deepEqual(trace.context, {});
        assert.equal(trace.unrecorded, undefined);
        assert.ok(!kinds.includes('context'), 'redact is not handed a context nobody passed');
        assert.deepEqual((await replayEffect(flow('in'), trace)).result, Success({ id: 1 }));
        // A context the caller passed still goes through redact.
        const { trace: given } = await recordEffect(flow('in'), { context: { tenant: 'acme' }, redact });
        assert.deepEqual(given.unrecorded, { context: 'redact' });
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
        const { result, trace } = await recordEffect(flow({ id: 1 }), {
            context,
            redact: throwsOn(['initialInput', 'context'])
        });
        assert.deepEqual(result, Success({ id: 1, tenant: 'acme' }));
        assert.equal(trace.initialInput, undefined);
        assert.equal(trace.context, undefined);
        assert.deepEqual(trace.unrecorded, { initialInput: 'redact', context: 'redact' });
        const stored = JSON.parse(JSON.stringify(trace));

        await assert.rejects(timeTravel(flow, stored, { log: () => {} }), (/** @type {any} */ e) => {
            assert.equal(e.name, 'ReplayError');
            assert.match(
                e.message,
                /holds no initialInput: redact threw on it or returned undefined, so the recorder left it out/
            );
            assert.equal(e.field, 'initialInput');
            return true;
        });
        await assert.rejects(replayEffect(flow({ id: 1 }), stored), (/** @type {any} */ e) => {
            assert.equal(e.name, 'ReplayError');
            assert.match(
                e.message,
                /holds no context: redact threw on it or returned undefined, so the recorder left it out/
            );
            assert.match(e.message, /pass options\.context/);
            assert.equal(e.field, 'context');
            return true;
        });
        const { result: replayed } = await replayEffect(flow({ id: 1 }), stored, { context });
        assert.deepEqual(replayed, result, 'a context passed in replays it');

        // A trace whose redact succeeded carries no such field.
        const { trace: clean } = await recordEffect(flow({ id: 1 }), { context });
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

        // The flow returns the user, and the outcome reaches redact named 'outcome', so a redact that masks by name
        // masks both.
        const { trace } = await recordEffect(flow(), {
            redact: (result, name) =>
                name === 'cmdLoadUser' || name === 'outcome'
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

        const { trace } = await recordEffect(flow({ email: 'user@test.com', password: 'hunter2' }), {
            context: { authToken: 'bearer-abc123' },
            flowName: 'register',
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                seen.push([kind, name]);
                if (kind === 'initialInput') return { ...value, password: '[redacted]' };
                if (kind === 'context') return { ...value, authToken: '[redacted]' };
                if (kind === 'error') return { ...value, attempted: '[redacted]' };
                return value;
            }
        });

        assert.deepEqual(
            seen,
            [
                ['initialInput', 'initialInput'],
                ['context', 'context'],
                ['result', 'cmdRead'],
                ['error', 'cmdSave'],
                ['error', 'outcome']
            ],
            'every value a trace holds passes through redact, each as it enters the trace: the input and context ' +
                'before the run, and how it ended after'
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
        const { result, trace } = await recordEffect(flow('in'), { redact });
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

    it('should replay an error redact rebuilt without its name as an Error named Error, not undefined', async function () {
        // The name was restored even when redact had left it out, as an own property holding undefined, which hid
        // Error.prototype.name, so a flow branching on error.name read undefined in the replay.
        const flow = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(function cmdPost() {
                    throw new TypeError('boom');
                })
            )(input);
        const redact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
            kind === 'error' ? { message: value.message } : value;
        const { trace } = await recordEffect(flow('in'), { redact });
        for (const stored of [trace, JSON.parse(JSON.stringify(trace))]) {
            const error = /** @type {any} */ (errorOf((await replayEffect(flow('in'), stored)).result));
            assert.ok(error instanceof Error);
            assert.equal(error.name, 'Error');
            assert.ok(!Object.hasOwn(error, 'name'), 'no own name hides the inherited one');
            assert.equal(error.message, 'boom');
        }
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
        const { result, trace } = await recordEffect(flow('in'), { redact });
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
        const { trace } = await recordEffect(flow('in'));
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
        const { trace } = await recordEffect(flow('in'), { redact });
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
        const { result, trace } = await recordEffect(flow('in'), {
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

        const { result, trace } = await recordEffect(flow({ email: 'a@b.c', password: 'hunter2' }), {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) =>
                kind === 'initialInput' ? { ...value, password: '[redacted]' } : value
        });
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
        const plain = await recordEffect(flow());
        const withStack = await recordEffect(flow(), { stack: true });
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
        const { result, trace } = await recordEffect(flow(null));
        assert.deepEqual(result, Success(100), 'recording does not change the run');
        assert.equal(trace.trace[0].unrecorded, 'copy', 'a BigInt cannot be stored');
        assert.deepEqual(trace.trace[1].result, { total: 100 }, 'the loop back is cut');
        const { result: replayed } = await replayEffect(flow(null), trace);
        assert.equal(/** @type {any} */ (errorOf(replayed)).name, 'ReplayError');
    });
});

describe('Recording how a run ended', function () {
    beforeEach(() => configureEffect());

    /** A flow that reads a user and returns what it decided. */
    const flow = (/** @type {any} */ input) =>
        effectPipe((/** @type {any} */ i) =>
            Command(
                function cmdLoadUser() {
                    return { id: i.id, email: 'ada@example.com' };
                },
                (/** @type {any} */ user) => (user.id > 0 ? Success({ user, plan: 'pro' }) : Failure('no_user'))
            )
        )(input);

    it('should record the outcome by default, and none under recordOutcome: false, which redact then never meets', async function () {
        assert.deepEqual((await recordEffect(flow({ id: 1 }))).trace.outcome?.type, 'Success');
        /** @type {string[]} */
        const names = [];
        const { trace } = await recordEffect(flow({ id: 1 }), {
            recordOutcome: false,
            redact: (value, name) => (names.push(name), value)
        });
        assert.equal('outcome' in trace, false);
        assert.ok(!names.includes('outcome'));
    });

    it("should record a Success's value through redact as a result named 'outcome'", async function () {
        /** @type {any[]} */
        const seen = [];
        const { result, trace } = await recordEffect(flow({ id: 1 }), {
            redact: (/** @type {any} */ value, name, kind) => {
                if (name !== 'outcome') return value;
                seen.push([kind, value]);
                return { ...value, user: { ...value.user, email: '[redacted]' } };
            }
        });
        assert.deepEqual(seen, [['result', { user: { id: 1, email: 'ada@example.com' }, plan: 'pro' }]]);
        assert.deepEqual(trace.outcome, {
            type: 'Success',
            value: { user: { id: 1, email: '[redacted]' }, plan: 'pro' }
        });
        assert.deepEqual(
            result,
            Success({ user: { id: 1, email: 'ada@example.com' }, plan: 'pro' }),
            'the run is untouched'
        );
    });

    it("should record a Failure's error as an error named 'outcome', and an Error with no stack", async function () {
        const domain = await recordEffect(flow({ id: 0 }));
        assert.deepEqual(domain.trace.outcome, { type: 'Failure', error: 'no_user' });

        const throwing = effectPipe(() =>
            Command(function cmdCharge() {
                throw Object.assign(new Error('declined'), { code: 'card_declined' });
            })
        );
        /** @type {any[]} */
        const named = [];
        const { trace } = await recordEffect(throwing(1), {
            stack: true,
            // A fresh object loses the mark that says it was an Error, and the trace marks it again.
            redact: (/** @type {any} */ value, name, kind) => {
                if (kind === 'error') named.push(name);
                return name === 'outcome' ? { name: value.name, message: value.message } : value;
            }
        });
        assert.deepEqual(named, ['cmdCharge', 'outcome']);
        assert.deepEqual(trace.outcome, {
            type: 'Failure',
            error: { __error: true, name: 'Error', message: 'declined' }
        });
        assert.equal(typeof (/** @type {any} */ (trace.trace[0].error).stack), 'string', 'the step keeps its stack');
    });

    it('should mark an outcome it could not record, and leave it out', async function () {
        const thrown = await recordEffect(flow({ id: 1 }), {
            redact: (value, name) => {
                if (name === 'outcome') throw new Error('redact bug');
                return value;
            }
        });
        assert.equal('outcome' in thrown.trace, false);
        assert.deepEqual(thrown.trace.unrecorded, { outcome: 'redact' });
        const dropped = await recordEffect(flow({ id: 1 }), {
            redact: (value, name) => (name === 'outcome' ? undefined : value)
        });
        assert.deepEqual(dropped.trace.unrecorded, { outcome: 'redact' });
        const big = effectPipe(() =>
            Command(
                function cmdCount() {
                    return 1;
                },
                () => Success(10n)
            )
        );
        const uncopied = await recordEffect(big(1));
        assert.deepEqual(uncopied.trace.unrecorded, { outcome: 'copy' });
        assert.deepEqual(uncopied.result, Success(10n), 'the run keeps its own outcome');
    });

    it("should keep what the input and context could not record beside the outcome's", async function () {
        const { trace } = await recordEffect(flow({ id: 1 }), {
            context: { tenant: 't' },
            redact: (value, name, kind) => {
                if (kind === 'context' || name === 'outcome') throw new Error('no');
                return value;
            }
        });
        assert.deepEqual(trace.unrecorded, { context: 'redact', outcome: 'redact' });
    });

    it("should record the outcome a recorder's toTrace is given", async function () {
        const rec = recorder();
        const result = await runEffect(flow({ id: 1 }), undefined, { onStep: rec.onStep });
        assert.deepEqual(rec.toTrace({ outcome: result }).outcome, { type: 'Success', value: valueOf(result) });
        assert.equal('outcome' in rec.toTrace(), false);
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

        const { trace } = await recordEffect(flow({ cartId: 1 }));
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
        const { result, trace } = await recordEffect(flow(), {
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

    it('should record the same trace with no redact as with one that returns what it is given', async function () {
        // With no redact a value is copied once, and a caller's redact has its return copied again. Both leave the
        // form JSON stores, for a value with a loop and for one without.
        /** @type {any} */
        const order = { id: 7, placedAt: new Date(0), seen: new Map([[1, 2]]), ratio: NaN, lines: [undefined, 1] };
        order.self = order;
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(function cmdLoadOrder() {
                        return order;
                    }),
                () =>
                    Command(function cmdCharge() {
                        throw Object.assign(new Error('declined'), { order: { id: 7 } });
                    })
            )(input);
        const entriesOf = async (/** @type {any} */ options) => {
            const { trace } = await recordEffect(flow({ cart: 'c1' }), options);
            return { ...trace, trace: trace.trace.map(({ durationMs, ...entry }) => entry) };
        };
        const plain = await entriesOf({});
        const returned = await entriesOf({ redact: (/** @type {any} */ value) => value });
        assert.deepEqual(plain, returned);
        assert.deepEqual(plain.trace[0].result, {
            id: 7,
            placedAt: '1970-01-01T00:00:00.000Z',
            seen: {},
            ratio: null,
            lines: [null, 1]
        });
        assert.notEqual(plain.trace[0].result, order, 'the trace holds a copy, not the value the flow got');
        assert.deepEqual(plain.outcome, {
            type: 'Failure',
            error: { __error: true, name: 'Error', message: 'declined', order: { id: 7 } }
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
        const { trace } = await recordEffect(flow('in'), { redact });
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
        const { trace } = await recordEffect(flow());
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
        const { result, trace } = await recordEffect(login({ password: 'secret123' }), {
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'result') delete value.passwordHash;
                return value;
            }
        });
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
        const { result, trace } = await recordEffect(flow(), {
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
        const { trace } = await recordEffect(register({ email: 'new@x.io', password: 'secret123' }), {
            context: { apiToken: 'tok_live', log },
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'initialInput') delete value.password;
                if (kind === 'context') delete value.apiToken;
                return value;
            }
        });
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
        const { trace } = await recordEffect(flow());
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
        const { trace } = await recordEffect(flow());
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
        const { trace } = await recordEffect(flow());

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
        // Built with effectPipe, which is what records a flow's input.
        const upsert = effectPipe((/** @type {any} */ user) =>
            user.id
                ? Command(function cmdUpdateUser() {
                      return orm.save(user);
                  })
                : Command(
                      function cmdInsertUser() {
                          return orm.save(user);
                      },
                      (/** @type {any} */ saved) => Success(saved.id)
                  )
        );
        const { result, trace } = await recordEffect(upsert({ email: 'a@b.com' }));
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
        const { result, trace } = await recordEffect(flow({ email: 'a@b.com' }), { context: {} });
        assert.deepEqual(trace.context, {}, 'the trace holds the context Ask saw');
        const replayed = await timeTravel(flow, trace, { log: () => {} });
        assert.deepEqual(replayed, { result, unreached: [], changed: null });
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
        const { result, trace } = await recordEffect(flow({ id: 1 }));
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

describe('pure-effect/flight-recorder', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

    it('should load through the package exports and record into the core the application imports', async function () {
        // An application imports the core as 'pure-effect', so enableRecording must install into that same instance.
        const main = await importInProject(
            [
                "import { enableRecording } from 'pure-effect/flight-recorder';",
                "import { Command, Success, effectPipe, runEffect } from 'pure-effect';",
                'export const written = [];',
                'export const remove = enableRecording({ keep: () => true, sink: (t) => void written.push(t) });',
                'const flow = effectPipe(() => Command(function cmdOne() { return 1; }, (r) => Success(r)));',
                "export const result = await runEffect(flow(1), undefined, { flowName: 'installed' });"
            ].join('\n')
        );
        main.remove();
        assert.deepEqual(main.result, Success(1));
        assert.equal(main.written.length, 1, 'enableRecording installed into the same configureEffect as pure-effect');
        assert.equal(main.written[0].flowName, 'installed');
    });

    it('should load through require, sharing the core that require gives', async function () {
        const main = await importInProject(
            [
                "import { createRequire } from 'node:module';",
                'const require = createRequire(import.meta.url);',
                "export const core = require('pure-effect');",
                "export const recording = require('pure-effect/flight-recorder');"
            ].join('\n')
        );
        assert.equal(typeof main.recording.enableRecording, 'function');
        assert.equal(main.core.configureEffect, configureEffect, 'one instance of the core');
    });

    it('should type-check in a project with exactOptionalPropertyTypes', function () {
        // It passes `redact` and `stack` on as it got them, possibly undefined, which RecorderOptions refused under
        // that flag, so a TypeScript project failed to compile until the types took it.
        this.timeout(20000);
        assert.deepEqual(jsTypeErrors('flight-recorder.js'), []);
    });

    it('should type its import for nodenext and bundler projects, exporting only its API', function () {
        // Its redact once declared kind as any string, so a redact typed as recorder declares it could not be passed.
        this.timeout(20000);
        const source = [
            "import { recordingHooks, enableRecording, type RecordingOptions } from 'pure-effect/flight-recorder';",
            "type Kind = 'result' | 'error' | 'initialInput' | 'context';",
            "const redact = (value: unknown, name: string, kind: Kind) => (kind === 'initialInput' ? null : value);",
            'const options: RecordingOptions = { redact };',
            'recordingHooks(options);',
            'enableRecording()();',
            '// @ts-expect-error RecordingStore is internal',
            "import type { RecordingStore } from 'pure-effect/flight-recorder';"
        ].join('\n');
        const files = { 'consumer.ts': source };
        assert.deepEqual(consumerFilesTypeErrors(files, { allowJs: false, checkJs: false }), []);
        const bundler = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
        assert.deepEqual(consumerFilesTypeErrors(files, { allowJs: false, checkJs: false, ...bundler }), []);
    });

    const failing = (/** @type {any} */ input) =>
        effectPipe(
            (/** @type {any} */ i) =>
                Command(
                    function cmdRead() {
                        return { row: i.id };
                    },
                    (/** @type {any} */ r) => Success(r)
                ),
            () =>
                Command(
                    function cmdWrite() {
                        throw new Error('write failed');
                    },
                    (/** @type {any} */ r) => Success(r)
                )
        )(input);

    it('should send a trace to the sink when a flow fails', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ trace) => void written.push(trace) });
        const result = await runEffect(failing({ id: 1 }), { tenant: 'acme' }, { flowName: 'writer' });
        assert.equal(result.type, 'Failure');
        assert.equal(written.length, 1);
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdRead', 'cmdWrite']
        );
        assert.equal(written[0].flowName, 'writer');
        assert.deepEqual(written[0].context, { tenant: 'acme' }, 'context captured for Ask replay');
        assert.deepEqual(written[0].initialInput, { id: 1 });
    });

    it('should attach the version to each trace, so timeTravel can warn about a trace from another build', async function () {
        // The README told readers to record each run with a version, but the example took none, so a production trace
        // carried no version and timeTravel's check against the current build never fired.
        /** @type {any[]} */
        const written = [];
        enableRecording({ version: 'build-41', sink: (t) => void written.push(t) });
        await runEffect(failing({ id: 1 }), undefined, { flowName: 'writer' });
        assert.equal(written[0].version, 'build-41');
        /** @type {string[]} */
        const lines = [];
        await timeTravel(failing, written[0], { version: 'build-42', log: (line) => void lines.push(line) });
        assert.ok(lines.includes('Warning: trace was recorded at build-41, replaying against build-42.'));
    });

    it('should store the input of a run that fails before its first Command', async function () {
        // A failed validation stops at the flow's root, and it is a run `keep` keeps by default. Its trace needs the
        // input as much as any, or a replay rebuilds the flow from undefined.
        /** @type {any[]} */
        const written = [];
        /** @type {string[]} */
        const warnings = [];
        enableRecording({ sink: (t) => void written.push(t), onWarning: (message) => void warnings.push(message) });
        const register = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => (i.email.includes('@') ? Success(i) : Failure('Invalid email.')),
                (/** @type {any} */ i) =>
                    Command(function cmdSaveUser() {
                        return i;
                    })
            )(input);
        const result = await runEffect(register({ email: 'bad' }), undefined, { flowName: 'register' });
        assert.deepEqual(result, Failure('Invalid email.'));
        assert.deepEqual(written[0].initialInput, { email: 'bad' });
        assert.deepEqual(warnings, [], 'the flow carries its input, so there is nothing to warn about');
        const { result: replayed } = await replayEffect(register(written[0].initialInput), written[0]);
        assert.deepEqual(replayed, result);
    });

    it('should store the context of a run refused before its first Command, so it replays', async function () {
        // The context was copied at the first Command, so a run a permission check refused, reading the context with
        // Ask before any write as the README advises, kept no context, and its replay stopped asking for one.
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: (t) => void written.push(t) });
        const provision = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) =>
                    Ask((/** @type {any} */ ctx) => (ctx.role === 'admin' ? Success(i) : Failure('Forbidden.'))),
                (/** @type {any} */ i) =>
                    Command(function cmdCreateTenant() {
                        return i;
                    })
            )(input);
        const result = await runEffect(provision({ name: 'acme' }), { role: 'intern' }, { flowName: 'provision' });
        assert.deepEqual(result, Failure('Forbidden.'));
        assert.deepEqual(written[0].context, { role: 'intern' });
        const { result: replayed } = await replayEffect(provision(written[0].initialInput), written[0]);
        assert.deepEqual(replayed, result);
    });

    it('should not let an input or a context it cannot copy decide the run, and mark it on the trace', async function () {
        // The wiring copied the context in `onBeforeCommand`, where a throw vetoes the Command, so a context that
        // could not be copied stopped the charge and failed the run, and `onSinkError` never heard of it. The input
        // was copied in `onRun` ahead of the run, where a throw rejected the run before it started. Caught and reported,
        // such a field was then left out with nothing on the trace to say so, and a replay ran with an empty context.
        // The recorder now marks it, as it marks a value redact throws on.
        const uncopyable = (/** @type {object} */ target) =>
            new Proxy(target, {
                ownKeys() {
                    throw new Error('cannot list keys');
                }
            });
        /** @type {unknown[]} */
        const errors = [];
        /** @type {string[]} */
        const warnings = [];
        /** @type {any[]} */
        const written = [];
        enableRecording({
            keep: () => true,
            sink: (/** @type {any} */ t) => void written.push(t),
            onSinkError: (error) => void errors.push(error),
            onWarning: (message) => void warnings.push(message)
        });
        let calls = 0;
        const charge = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Command(function cmdCharge() {
                    calls++;
                    return i.amount;
                })
            )(input);

        const withContext = await runEffect(charge({ amount: 5 }), uncopyable({ tenant: 'acme' }));
        assert.deepEqual(withContext, Success(5));
        assert.equal(calls, 1, 'the Command ran');
        assert.equal(written.length, 1, 'the trace was still kept');
        assert.equal(written[0].context, undefined);
        assert.deepEqual(written[0].unrecorded, { context: 'copy' });

        const withInput = await runEffect(charge(uncopyable({ amount: 7 })), { tenant: 'acme' });
        assert.deepEqual(withInput, Success(7));
        assert.equal(calls, 2, 'the run started');
        assert.equal(written.length, 2);
        assert.equal(written[1].initialInput, undefined);
        assert.deepEqual(written[1].unrecorded, { initialInput: 'copy' });
        assert.deepEqual(errors, [], 'nothing failed: the trace says what it lacks');
        assert.equal(warnings.length, 1, 'the flow is warned about once');
        assert.match(warnings[0], /could not be recorded/);
    });

    it('should send the trace of a run whose own code throws, and still reject', async function () {
        // Since a throw in a pure step rejects the run, the wiring awaited the run outside its try block, and a
        // rejection skipped keep and the sink. That is the run most worth replaying: the payment provider renamed
        // a field and the step after the charge crashed, and the recorded charge reproduces it offline.
        /** @type {any[]} */
        const written = [];
        /** @type {any[]} */
        const offered = [];
        enableRecording({
            keep: (/** @type {any} */ result) => (offered.push(result), result.type === 'Failure'),
            sink: (/** @type {any} */ t) => void written.push(t)
        });
        const checkout = (/** @type {any} */ order) =>
            effectPipe(
                () =>
                    Command(function cmdCharge() {
                        return { id: 'ch_1', amount_cents: order.total * 100 };
                    }),
                (/** @type {any} */ charge) => Success(`Charged ${charge.amount.toFixed(2)}`)
            )(order);

        await assert.rejects(runEffect(checkout({ total: 12 })), TypeError, 'the run still rejects with its own error');
        assert.equal(offered.length, 1, 'keep is offered the run that crashed');
        assert.equal(offered[0].type, 'Failure', 'as a Failure');
        assert.ok(offered[0].error instanceof TypeError);
        assert.equal(written.length, 1, 'and the default keep sends it to the sink');
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdCharge']
        );
        configureEffect();
        await assert.rejects(replayEffect(checkout(written[0].initialInput), written[0]), TypeError);
    });

    it('should send the input and context as the run received them', async function () {
        // Both were held by reference and copied only when the trace was packaged, so a Command that wrote to
        // either rewrote what the trace said production received.
        /** @type {any[]} */
        const written = [];
        enableRecording({ keep: () => true, sink: (/** @type {any} */ t) => void written.push(t) });
        const flow = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Ask((/** @type {any} */ ctx) =>
                    Command(function cmdSave() {
                        i.id = 'u_1';
                        ctx.user = { id: 7 };
                        return i.id;
                    })
                )
            )(input);
        await runEffect(flow({ email: 'a@b.com' }), { tenant: 'acme' });
        assert.deepEqual(written[0].initialInput, { email: 'a@b.com' });
        assert.deepEqual(written[0].context, { tenant: 'acme' });
    });

    it('should not let an in-place redact change the run it records', async function () {
        // The wiring redacts the input and the context as the run starts, before any Command reads them, so a redact that deleted fields in place saved a user with no password and called
        // the API with no token, but only while recording was installed.
        /** @type {any[]} */
        const written = [];
        /** @type {any[]} */
        const seen = [];
        enableRecording({
            keep: () => true,
            sink: (/** @type {any} */ t) => void written.push(t),
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'initialInput') delete value.password;
                if (kind === 'context') delete value.apiToken;
                return value;
            }
        });
        const register = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Ask((/** @type {any} */ ctx) =>
                    Command(function cmdSaveUser() {
                        seen.push([i.password, ctx.apiToken]);
                        return { id: 2 };
                    })
                )
            )(input);
        const result = await runEffect(register({ email: 'new@x.io', password: 'secret123' }), {
            apiToken: 'tok_live'
        });
        assert.equal(result.type, 'Success');
        assert.deepEqual(seen, [['secret123', 'tok_live']], 'the Command saw what the caller passed');
        assert.deepEqual(written[0].initialInput, { email: 'new@x.io' });
        assert.deepEqual(written[0].context, {});
    });

    it('should leave out an input or context redact throws on, and name both on the trace', async function () {
        // Both are packaged as the run starts, and each one redact throws on is named on the trace.
        /** @type {any[]} */
        const written = [];
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            sink: (/** @type {any} */ t) => void written.push(t),
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'initialInput' || kind === 'context') throw new Error('redact bug');
                return value;
            },
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const result = await runEffect(failing({ id: 5 }), { tenant: 'acme' }, { flowName: 'writer' });
        assert.equal(result.type, 'Failure', 'the run keeps its own outcome');
        assert.equal(written[0].initialInput, undefined);
        assert.equal(written[0].context, undefined);
        assert.deepEqual(written[0].unrecorded, { initialInput: 'redact', context: 'redact' });
        assert.equal(warnings.length, 1, 'one warning for the flow');
        assert.match(warnings[0][0], /^Recording 'writer': 2 of the values a kept trace holds could not be recorded/);
        assert.equal(warnings[0][1], 'writer');
    });

    it('should not let a failing sink change the outcome, and report the failure', async function () {
        // The README's sink calls JSON.stringify, which throws on a circular value such as an HTTP client's
        // error. The sink was awaited inside onRun, so that throw replaced the run's own outcome.
        /** @type {any[]} */
        const reported = [];
        const circular = () => {
            throw new TypeError('Converting circular structure to JSON');
        };
        const remove = enableRecording({
            sink: circular,
            onSinkError: (/** @type {any} */ error, /** @type {any} */ flowName) =>
                void reported.push([error.message, flowName])
        });
        const result = await runEffect(failing({ id: 1 }), undefined, { flowName: 'checkout' });
        assert.equal(/** @type {any} */ (result).error.message, 'write failed', 'the run keeps its own outcome');
        assert.deepEqual(reported, [['Converting circular structure to JSON', 'checkout']]);
        remove();

        // Reporting is the caller's code too, so a reporter that throws changes nothing either.
        enableRecording({
            sink: circular,
            onSinkError: () => {
                throw new Error('reporter failed');
            }
        });
        const again = await runEffect(failing({ id: 1 }), undefined, { flowName: 'checkout' });
        assert.equal(/** @type {any} */ (again).error.message, 'write failed');
    });

    it('should report a failing keep or sink to console.error by default', async function () {
        const errorLog = console.error;
        /** @type {any[][]} */
        const logged = [];
        console.error = (/** @type {any[]} */ ...args) => void logged.push(args);
        try {
            enableRecording({
                keep: () => {
                    throw new Error('keep failed');
                }
            });
            const result = await runEffect(failing({ id: 1 }), undefined, { flowName: 'checkout' });
            assert.equal(result.type, 'Failure');
            assert.equal(logged.length, 1);
            assert.match(String(logged[0][0]), /Recording failed for 'checkout'/);
            assert.equal(logged[0][1].message, 'keep failed');
        } finally {
            console.error = errorLog;
        }
    });

    it('should keep successful runs out of the sink by default', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t) });
        const ok = (/** @type {any} */ i) =>
            Command(
                function cmdOk() {
                    return i;
                },
                (/** @type {any} */ v) => Success(v)
            );
        assert.equal((await runEffect(ok({ id: 2 }))).type, 'Success');
        assert.deepEqual(written, []);
    });

    it('should keep by default a run that succeeded after a Command threw', async function () {
        // The default kept only runs that ended in a Failure, so a delivery that went to its dead-letter fallback, or
        // a charge that went through on its third attempt, ended in a Success and was never recorded.
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t) });
        let calls = 0;
        const flaky = Retry(
            Command(function cmdCharge() {
                if (++calls < 2) throw new Error('503');
                return 'charged';
            }),
            { retries: 2, delay: 0 }
        );
        const deadLettered = Retry(
            Command(function cmdDeliver() {
                throw new Error('503');
            }),
            {
                retries: 1,
                delay: 0,
                onExhausted: () =>
                    Command(function cmdDeadLetter() {
                        return 'parked';
                    })
            }
        );
        assert.deepEqual(await runEffect(effectPipe(() => flaky)('a')), Success('charged'));
        assert.deepEqual(await runEffect(effectPipe(() => deadLettered)('b')), Success('parked'));
        assert.deepEqual(
            written.map((t) => t.initialInput),
            ['a', 'b']
        );
    });

    it('should hand keep the trace entries, so a settled batch whose items failed can be kept', async function () {
        // A settled Parallel's failures reach next as outcomes, so the run succeeds and no Command threw; only a keep
        // that reads the result can tell.
        /** @type {any[]} */
        const written = [];
        /** @type {any[]} */
        const seen = [];
        const item = (/** @type {boolean} */ ok) =>
            Command(
                function cmdImport() {
                    return ok;
                },
                (/** @type {boolean} */ fine) => (fine ? Success('ok') : Failure('bad row'))
            );
        const batch = effectPipe(
            () => Parallel([item(true), item(false)], { settled: true }),
            (/** @type {any[]} */ outcomes) => Success({ failed: outcomes.filter((o) => o.type === 'Failure').length })
        );
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t) });
        await runEffect(batch('by-default'));
        assert.equal(written.length, 0, 'the default sees no Failure and no throw');
        configureEffect();
        enableRecording({
            sink: async (/** @type {any} */ t) => void written.push(t),
            keep: (result, entries) => {
                seen.push(entries.map((e) => e.command));
                return result.type === 'Failure' || /** @type {any} */ (result).value.failed > 0;
            }
        });
        await runEffect(batch('read-the-result'));
        assert.deepEqual(
            written.map((t) => t.initialInput),
            ['read-the-result']
        );
        assert.deepEqual(seen, [['cmdImport', 'cmdImport', 'Parallel']]);
    });

    it('should warn once per flow when it keeps a trace whose flow carried no input', async function () {
        // Only effectPipe puts the input on a flow, so a bare Command's traces hold none and timeTravel would
        // rebuild the flow from undefined. Warning at the first kept trace says so before an incident needs it.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const read = () =>
            Command(function cmdRead() {
                return 1;
            });
        await runEffect(read(), undefined, { flowName: 'bare' });
        await runEffect(read(), undefined, { flowName: 'bare' });
        await runEffect(effectPipe(read)({ id: 1 }), undefined, { flowName: 'piped' });
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'bare');
        assert.match(warnings[0][0], /If the flow takes an input, build its outermost flow with effectPipe/);
    });

    it('should warn once per flow when it keeps a trace maxEntries cut short', async function () {
        // A capped trace lacks steps production ran, so it replays only up to the first of them. The default
        // cap is 500, so a long batch run is cut short without anyone having chosen to.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        /** @type {any[]} */
        const written = [];
        enableRecording({
            keep: () => true,
            maxEntries: 2,
            sink: (/** @type {any} */ t) => void written.push(t),
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const read = (/** @type {number} */ n) =>
            Command(function cmdRead() {
                return n;
            });
        const long = effectPipe(
            () => read(1),
            () => read(2),
            () => read(3)
        );
        const short = effectPipe(() => read(1));
        await runEffect(long({ id: 1 }), undefined, { flowName: 'long' });
        await runEffect(long({ id: 2 }), undefined, { flowName: 'long' });
        await runEffect(short({ id: 3 }), undefined, { flowName: 'short' });
        assert.deepEqual(
            written.map((t) => t.dropped),
            [1, 1, 0],
            'every capped trace still reaches the sink'
        );
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'long');
        assert.match(warnings[0][0], /dropped 1 entries under maxEntries \(2\)/);
    });

    it('should warn once per flow when it keeps a trace redact left values out of', async function () {
        // A value redact throws on is left out of the trace, which replays only up to it. Nothing else says so until
        // someone replays an incident.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            sink: () => {},
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'context' || name === 'cmdRead') throw new Error('redact bug');
                return value;
            },
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const flow = effectPipe(
            () =>
                Command(function cmdRead() {
                    return 1;
                }),
            () =>
                Command(function cmdWrite() {
                    return 2;
                })
        );
        await runEffect(flow({ id: 1 }), undefined, { flowName: 'writer' });
        await runEffect(flow({ id: 2 }), undefined, { flowName: 'writer' });
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'writer');
        assert.match(warnings[0][0], /2 of the values a kept trace holds could not be recorded/);
        assert.match(warnings[0][0], /replays only up to the first of them/);
    });

    it('should warn once per flow when it keeps a trace with anonymous steps', async function () {
        // A replay tells steps apart by name, and inline arrow Commands are all 'anonymous', so a refactor that swapped
        // two of them replayed as a Success with each handed the other's recorded result, and nothing flagged it.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const inline = effectPipe(
            () => Command(() => 1),
            () => Command(() => 2)
        );
        const named = effectPipe(() =>
            Command(function cmdNamed() {
                return 1;
            })
        );
        await runEffect(inline({ id: 1 }), undefined, { flowName: 'inline' });
        await runEffect(inline({ id: 2 }), undefined, { flowName: 'inline' });
        await runEffect(named({ id: 3 }), undefined, { flowName: 'named' });
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'inline');
        assert.match(warnings[0][0], /2 of its steps are named 'anonymous'/);
        assert.match(warnings[0][0], /meta\.name/);
    });

    it('should give concurrent runs separate traces', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t) });
        const slowFail = (/** @type {any} */ label) => (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(
                        function cmdSlow() {
                            return new Promise((r) => setTimeout(() => r(label), label === 'A' ? 20 : 5));
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                () =>
                    Command(
                        function cmdFail() {
                            throw new Error(`${label} failed`);
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )(input);
        await Promise.all([
            runEffect(slowFail('A')({ id: 'A' }), undefined, { flowName: 'A' }),
            runEffect(slowFail('B')({ id: 'B' }), undefined, { flowName: 'B' })
        ]);
        assert.equal(written.length, 2);
        for (const trace of written) {
            assert.deepEqual(
                trace.trace.map((/** @type {any} */ e) => e.command),
                ['cmdSlow', 'cmdFail'],
                'each trace holds only its own run'
            );
            assert.equal(trace.trace[0].result, trace.flowName);
        }
    });

    it('should compose with a telemetry hook in one configureEffect call', async function () {
        /** @type {string[]} */
        const spans = [];
        /** @type {any[]} */
        const written = [];
        configureEffect(
            {
                onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                    spans.push(n),
                    await op()
                )
            },
            recordingHooks({ sink: async (/** @type {any} */ t) => void written.push(t) })
        );
        const result = await runEffect(failing({ id: 3 }), undefined, { flowName: 'both' });
        assert.equal(result.type, 'Failure');
        assert.deepEqual(spans, ['cmdRead', 'cmdWrite'], 'telemetry still saw every step');
        assert.equal(written.length, 1, 'and the trace was still written');
    });

    it('should redact recorded results before they reach the sink', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({
            sink: async (/** @type {any} */ t) => void written.push(t),
            redact: (/** @type {any} */ result) => (result && result.row ? { row: '[redacted]' } : result)
        });
        await runEffect(failing({ id: 4 }));
        assert.deepEqual(written[0].trace[0].result, { row: '[redacted]' });
    });

    it('should record paths so a Parallel flow replays from the trace it ships', async function () {
        // A hand-rolled `onStep` wrapper that calls the inner hook with three arguments drops the fourth,
        // `path`, and the trace it ships carries none. Such a trace replays positionally, which cannot
        // tell Parallel branches apart, so the positional resolver refuses it. This is the hazard the
        // hook contract in CLAUDE.md names, and the reference wiring is the first place it has to be right.
        /** @type {any[]} */
        const written = [];
        const calls = { a: 0, b: 0 };
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t), keep: () => true });
        const flow = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ x) =>
                Parallel([
                    Command(function cmdA() {
                        calls.a++;
                        return x + 1;
                    }),
                    Command(function cmdB() {
                        calls.b++;
                        return x + 2;
                    })
                ])
            )(input);
        const result = await runEffect(flow(1), undefined, { flowName: 'fanout' });
        assert.deepEqual(result, Success([2, 3]));
        assert.equal(written.length, 1);
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.path).sort(),
            ['0p', '0p0/0', '0p1/0'],
            'every entry carries its path, the Parallel decision included'
        );
        configureEffect();
        const replayed = await replayEffect(flow(1), written[0]);
        assert.deepEqual(replayed.result, Success([2, 3]));
        assert.deepEqual(replayed.unreached, []);
        assert.deepEqual(calls, { a: 1, b: 1 }, 'the replay executed nothing');
    });

    it('should store how each run ended unless recordOutcome is false, a run that threw as a Failure', async function () {
        const flow = effectPipe((/** @type {number} */ n) =>
            Command(
                function cmdDouble() {
                    if (n < 0) throw new Error('negative');
                    return n * 2;
                },
                (/** @type {number} */ doubled) => Success({ doubled })
            )
        );
        /** @type {any[]} */
        const stored = [];
        const off = enableRecording({ keep: () => true, sink: (t) => void stored.push(t) });
        await runEffect(flow(2));
        await runEffect(flow(-1));
        off();
        assert.deepEqual(stored[0].outcome, { type: 'Success', value: { doubled: 4 } });
        assert.equal('unrecorded' in stored[0], false, 'nothing went unrecorded');
        assert.equal(stored[1].outcome.type, 'Failure');
        assert.equal(stored[1].outcome.error.message, 'negative');
        assert.equal('stack' in stored[1].outcome.error, false);
        const replay = await replayEffect(flow(stored[0].initialInput), stored[0]);
        assert.equal(replay.changed, null);

        const offAgain = enableRecording({ keep: () => true, recordOutcome: false, sink: (t) => void stored.push(t) });
        await runEffect(flow(2));
        offAgain();
        assert.equal('outcome' in stored[2], false);
    });

    it('should warn once per flow when a kept trace could not record its outcome, and still store the trace', async function () {
        /** @type {string[]} */
        const warnings = [];
        /** @type {any[]} */
        const stored = [];
        const flow = effectPipe((/** @type {number} */ n) =>
            Command(function cmdRead() {
                return n;
            })
        );
        const off = enableRecording({
            keep: () => true,
            redact: (value, name) => (name === 'outcome' ? undefined : value),
            sink: (t) => void stored.push(t),
            onWarning: (message) => void warnings.push(message)
        });
        await runEffect(flow(1), undefined, { flowName: 'reads' });
        await runEffect(flow(2), undefined, { flowName: 'reads' });
        off();
        assert.equal(stored.length, 2);
        assert.deepEqual(stored[0].unrecorded, { outcome: 'redact' });
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /^Recording 'reads': a kept trace holds no outcome/);
    });

    /**
     * Three flows for the sampling tests: one that succeeds, one a step fails, and one whose Command throws.
     * @param {any} input
     */
    const sampledOk = (input) =>
        effectPipe(() =>
            Command(function cmdOk() {
                return input;
            })
        )(input);
    /** @param {any} input */
    const sampledRejected = (input) =>
        effectPipe(() =>
            Command(
                function cmdCheck() {
                    return false;
                },
                () => Failure('rejected')
            )
        )(input);
    /** @param {any} input */
    const sampledBroken = (input) =>
        effectPipe(() =>
            Command(function cmdCall() {
                throw new Error('timeout');
            })
        )(input);

    /**
     * Runs a flow `times` times under one name, with the run's number as its input.
     * @param {(input: any) => any} flow
     * @param {number} times
     * @param {string} flowName
     */
    const runTimes = async (flow, times, flowName) => {
        for (let i = 0; i < times; i++) await runEffect(flow(i), {}, { flowName });
    };

    it('should keep a counted share of each kind of run under sample, starting with the first', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({
            sink: (t) => void written.push(t),
            sample: { failed: 0.1, succeeded: 0.25 }
        });
        await runTimes(sampledRejected, 25, 'signup');
        await runTimes(sampledOk, 9, 'signup');
        await runTimes(sampledBroken, 3, 'signup');
        const inputsOf = (/** @type {string} */ command) =>
            written.filter((t) => t.trace[0].command === command).map((t) => t.initialInput);
        assert.deepEqual(inputsOf('cmdCheck'), [0, 10, 20], 'one returned Failure in ten');
        assert.deepEqual(inputsOf('cmdOk'), [0, 4, 8], 'one success in four');
        assert.deepEqual(inputsOf('cmdCall'), [0, 1, 2], 'every run in which a Command threw, by default');
    });

    it('should keep under sample what the default keep keeps when no share is given', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: (t) => void written.push(t), sample: {} });
        await runTimes(sampledOk, 3, 'signup');
        await runTimes(sampledRejected, 3, 'signup');
        await runTimes(sampledBroken, 3, 'signup');
        assert.deepEqual(
            written.map((t) => t.trace[0].command),
            ['cmdCheck', 'cmdCheck', 'cmdCheck', 'cmdCall', 'cmdCall', 'cmdCall']
        );
    });

    it('should count a run as one that threw when a Retry rescued it or its own code threw', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({
            sink: (t) => void written.push(t),
            sample: { threw: 1, failed: 0, succeeded: 0 }
        });
        let calls = 0;
        const rescued = (/** @type {any} */ input) =>
            effectPipe(() =>
                Retry(
                    Command(function cmdCharge() {
                        if (++calls % 2 === 1) throw new Error('503');
                        return 'charged';
                    }),
                    { retries: 1, delay: 0 }
                )
            )(input);
        const crashes = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(
                    function cmdFetch() {
                        return {};
                    },
                    (/** @type {any} */ r) => Success(r.items.length)
                )
            )(input);
        assert.deepEqual(await runEffect(rescued('rescued')), Success('charged'));
        await assert.rejects(runEffect(crashes('crashed')), TypeError);
        await runEffect(sampledRejected('rejected'));
        await runEffect(sampledOk('fine'));
        assert.deepEqual(
            written.map((t) => t.initialInput),
            ['rescued', 'crashed']
        );
    });

    it("should let a flow's entry under sample.flows replace only the keys it names", async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({
            sink: (t) => void written.push(t),
            sample: {
                failed: 0.5,
                succeeded: 0,
                // `undefined` keeps the share every flow has, as an option set to undefined keeps its default.
                flows: { checkout: { succeeded: 1, failed: undefined }, search: { failed: 0 } }
            }
        });
        for (const flowName of ['checkout', 'search', 'signup', 'constructor']) {
            await runTimes(sampledRejected, 4, flowName);
            await runTimes(sampledOk, 2, flowName);
        }
        const kept = (/** @type {string} */ flowName, /** @type {string} */ command) =>
            written.filter((t) => t.flowName === flowName && t.trace[0].command === command).length;
        assert.deepEqual([kept('checkout', 'cmdCheck'), kept('checkout', 'cmdOk')], [2, 2]);
        assert.deepEqual([kept('search', 'cmdCheck'), kept('search', 'cmdOk')], [0, 0]);
        assert.deepEqual([kept('signup', 'cmdCheck'), kept('signup', 'cmdOk')], [2, 0]);
        assert.deepEqual(
            [kept('constructor', 'cmdCheck'), kept('constructor', 'cmdOk')],
            [2, 0],
            'a flow named as a property every object has gets the shares every flow has'
        );
    });

    it('should store at most perMinute traces of a flow in a minute, whatever their kind', async function () {
        /** @type {any[]} */
        const written = [];
        const realNow = Date.now;
        let now = 1_000_000;
        Date.now = () => now;
        try {
            enableRecording({
                sink: (t) => void written.push(t),
                sample: { succeeded: 1, perMinute: 3, flows: { search: { perMinute: 1 } } }
            });
            await runTimes(sampledBroken, 2, 'checkout');
            await runTimes(sampledRejected, 2, 'checkout');
            await runTimes(sampledOk, 2, 'checkout');
            await runTimes(sampledBroken, 2, 'search');
            const inputsOf = (/** @type {string} */ flowName) =>
                written.filter((t) => t.flowName === flowName).map((t) => `${t.trace[0].command}:${t.initialInput}`);
            assert.deepEqual(inputsOf('checkout'), ['cmdCall:0', 'cmdCall:1', 'cmdCheck:0'], 'the first three');
            assert.deepEqual(inputsOf('search'), ['cmdCall:0'], 'a flow has its own cap and its own count');
            now += 59_999;
            await runEffect(sampledBroken('late'), {}, { flowName: 'checkout' });
            assert.equal(inputsOf('checkout').length, 3, 'still inside the minute the first trace opened');
            now += 1;
            await runTimes(sampledBroken, 4, 'checkout');
            assert.deepEqual(
                inputsOf('checkout').slice(3),
                ['cmdCall:0', 'cmdCall:1', 'cmdCall:2'],
                'a new minute stores three more'
            );
        } finally {
            Date.now = realNow;
        }
    });

    it('should refuse a sample it cannot use as the hooks are built, naming the key', function () {
        const refused = (/** @type {any} */ options, /** @type {RegExp} */ message) =>
            assert.throws(() => recordingHooks(options), { name: 'TypeError', message });
        refused({ sample: 0.1 }, /sample must be an object, got the number 0\.1\./);
        refused({ sample: { failed: 10 } }, /sample\.failed must be a number from 0 to 1, got the number 10\./);
        refused({ sample: { succeeded: '0.5' } }, /sample\.succeeded must be a number from 0 to 1, got "0\.5"\./);
        refused({ sample: { threw: NaN } }, /sample\.threw must be a number from 0 to 1/);
        refused({ sample: { perMinute: 0 } }, /sample\.perMinute must be a positive integer, got the number 0\./);
        refused(
            { sample: { success: 1 } },
            /sample has no key named 'success'; its keys are threw, failed, succeeded, perMinute, flows\./
        );
        refused({ sample: { flows: [] } }, /sample\.flows must be an object, got an array\./);
        refused(
            { sample: { flows: { checkout: 1 } } },
            /sample\.flows\.checkout must be an object, got the number 1\./
        );
        refused(
            { sample: { flows: { checkout: { failed: -1 } } } },
            /sample\.flows\.checkout\.failed must be a number from 0 to 1/
        );
        refused({ sample: { flows: { checkout: { flows: {} } } } }, /sample\.flows\.checkout has no key named 'flows'/);
        refused({ sample: null }, /sample must be an object, got null\./);
        refused({ sample: { flows: null } }, /sample\.flows must be an object, got null\./);
        refused({ sample: { failed: {} } }, /sample\.failed must be a number from 0 to 1, got an object\./);
        refused({ sample: { perMinute: () => 1 } }, /sample\.perMinute must be a positive integer, got a function\./);
        refused({ sample: {}, keep: () => true }, /takes sample or keep, not both/);
        // `undefined` is a key left out, so a sample read from configuration can sit beside no keep.
        assert.doesNotThrow(() => recordingHooks({ sample: undefined, keep: () => true }));
        assert.doesNotThrow(() =>
            recordingHooks({ sample: { failed: undefined, perMinute: undefined }, keep: undefined })
        );
    });

    it("should hand keep the run's name, so a keep written by hand can vary by flow", async function () {
        /** @type {any[]} */
        const written = [];
        /** @type {any[]} */
        const names = [];
        enableRecording({
            sink: (t) => void written.push(t),
            keep: (result, entries, flowName) => {
                names.push(flowName);
                return flowName === 'checkout';
            }
        });
        await runEffect(sampledOk('a'), {}, { flowName: 'checkout' });
        await runEffect(sampledOk('b'), {}, { flowName: 'search' });
        await runEffect(sampledOk('c'));
        assert.deepEqual(names, ['checkout', 'search', '']);
        assert.deepEqual(
            written.map((t) => t.initialInput),
            ['a']
        );
    });
});
