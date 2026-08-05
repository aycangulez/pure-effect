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
import { enableTelemetry, telemetryHooks } from '../examples/opentelemetry-example.js';
import { enableRecording, recordingHooks } from '../examples/recording-example.js';

/** @import { CommandInterceptor } from "../index.js" */

/** @typedef {{id?: number, email: string, password: string}} User */

const db = {
    users: new Map(),
    async findUserByEmail(/** @type string */ email) {
        return this.users.get(email) || null;
    },
    async saveUser(/** @type {User} */ user) {
        const u = { ...user, id: Date.now() };
        this.users.set(user.email, u);
        return u;
    }
};

function validateRegistration(/** @type {User} */ input) {
    const { email, password } = input;
    if (!email?.includes('@')) {
        return Failure('Invalid email format.');
    }
    if (password?.length < 8) {
        return Failure('Password must be at least 8 characters long.');
    }
    return Success(input);
}

// The lookup is a guard, so it passes the input along rather than the user it found.
// Every step then accepts and returns the piped value, which keeps the chain checkable.
function ensureEmailIsAvailable(/** @type {User} */ input) {
    const cmdFindUser = () => db.findUserByEmail(input.email);
    const next = (/** @type {User | null} */ foundUser) =>
        foundUser ? Failure('Email already in use.') : Success(input);
    return Command(cmdFindUser, next);
}

function saveUser(/** @type {User} */ input) {
    const { email, password } = input;
    const userToSave = { email, password: `hashed_${password}` };
    // No continuation: the saved user passes straight through.
    const cmdSaveUser = () => db.saveUser(userToSave);
    return Command(cmdSaveUser);
}

const registerUserFlow = (/** @type {User} */ input) =>
    effectPipe(validateRegistration, ensureEmailIsAvailable, saveUser)(input);

async function registerUser(/** @type {User} */ input) {
    return await runEffect(registerUserFlow(input), { flowName: 'registerUser' });
}

describe('Core', function () {
    // Global hooks outlive a suite, so this guards against inheriting another suite's wiring.
    beforeEach(() => configureEffect());

    it('should return Failure when e-mail is invalid', async function () {
        const badInput = { email: 'bad-email', password: '123' };
        const result = registerUserFlow(badInput);
        assert.deepEqual(result, Failure('Invalid email format.', badInput));
    });

    it('should walk through the call tree', async function () {
        const input = { email: 'test@test.com', password: 'password123' };
        const step1 = registerUserFlow(input);
        assert.equal(step1.type, 'Command');
        assert.equal(step1.cmd.name, 'cmdFindUser');

        const step2 = step1.next(null);
        assert.equal(step2.type, 'Command');
        assert.equal(step2.cmd.name, 'cmdSaveUser');
    });

    it('should access context through onBeforeCommand', async function () {
        const input = { email: 'context@test.com', password: 'password123' };
        await runEffect(
            registerUserFlow(input),
            { env: 'test' },
            {
                onBeforeCommand: /** @type CommandInterceptor */ async (command, context) =>
                    assert.equal(context.env, 'test')
            }
        );
    });

    it('should access context through Ask', async function () {
        /** @type {any} */
        let capturedCtx;
        const step = () =>
            Ask((ctx) => {
                capturedCtx = ctx;
                return Success(null);
            });
        await runEffect(step(), { env: 'test' });
        assert.equal(capturedCtx.env, 'test');
    });

    it('should work with Ask at any point in the pipeline', async function () {
        const flow = effectPipe(
            () =>
                Command(
                    () => 'value',
                    (r) => Success(r)
                ),
            (value) => Ask((/** @type {any} */ ctx) => Success({ value, env: ctx.env }))
        );
        const result = await runEffect(flow(null), { env: 'test' });
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { value: 'value', env: 'test' });
    });

    it('should return a Retry data structure', function () {
        const inner = Command(
            () => 'x',
            (r) => Success(r)
        );
        const effect = Retry(inner, { attempts: 5 });
        assert.equal(effect.type, 'Retry');
        assert.deepEqual(effect.options, { attempts: 5 });
        assert.strictEqual(effect.effect, inner);
        assert.equal(typeof effect.next, 'function');
    });

    it('should succeed after transient failures', async function () {
        let calls = 0;
        const effect = Retry(
            Command(
                function flakyCmd() {
                    if (++calls < 3) throw new Error('transient');
                    return 'ok';
                },
                (r) => Success(r)
            ),
            { attempts: 3, delay: 0 }
        );
        const result = await runEffect(effect);
        assert.equal(result.type, 'Success');
        assert.equal(result.value, 'ok');
        assert.equal(calls, 3);
    });

    it('should return rich Failure when retries are exhausted', async function () {
        const effect = Retry(
            Command(
                function alwaysFails() {
                    throw new Error('boom');
                },
                (/** @type {any} */ r) => Success(r)
            ),
            { attempts: 2, delay: 0 }
        );
        const result = await runEffect(effect);
        assert.equal(result.type, 'Failure');
        if (result.type !== 'Failure') throw new Error('expected Failure');
        const error = /** @type {import('../index.js').RetryExhaustedError<Error>} */ (result.error);
        assert.equal(error.retryExhausted, true);
        assert.equal(error.attempts, 2);
        assert.equal(error.lastError.message, 'boom');
    });

    it('should apply delay and backoff between retries', async function () {
        this.timeout(2000);
        let calls = 0;
        const start = Date.now();
        const effect = Retry(
            Command(
                function flakyCmd() {
                    if (++calls < 3) throw new Error('transient');
                    return 'ok';
                },
                (r) => Success(r)
            ),
            { attempts: 3, delay: 30, backoff: 1 }
        );
        const result = await runEffect(effect);
        const elapsed = Date.now() - start;
        assert.equal(result.type, 'Success');
        // 2 retries × 30 ms = at least 55 ms (5 ms margin for timing variance)
        assert.ok(elapsed >= 55, `Expected ≥ 55 ms elapsed, got ${elapsed} ms`);
    });

    it('should merge per-use Retry options with call-level defaults', async function () {
        // Call-level: attempts 1 (would exhaust on 2nd try)
        // Per-use: attempts 3 (overrides call-level, so it should succeed on the 3rd try)
        let calls = 0;
        const effect = Retry(
            Command(
                function flakyCmd() {
                    if (++calls < 3) throw new Error('x');
                    return 'ok';
                },
                (r) => Success(r)
            ),
            { attempts: 3 }
        );
        const result = await runEffect(effect, {}, { retry: { attempts: 1, delay: 0, backoff: 1 } });
        assert.equal(result.type, 'Success');
        assert.equal(calls, 3);
    });

    it('should work at any step inside effectPipe', async function () {
        const flow = effectPipe(
            (input) =>
                Retry(
                    Command(
                        function fetchCmd() {
                            return input.toUpperCase();
                        },
                        (r) => Success(r)
                    ),
                    { attempts: 2, delay: 0 }
                ),
            (upper) => Success(`${upper}!`)
        );
        const result = await runEffect(flow('hello'));
        assert.equal(result.type, 'Success');
        assert.equal(result.value, 'HELLO!');
    });

    it('should return a Parallel data structure', () => {
        const e1 = Success(1);
        const e2 = Success(2);
        const next = (/** @type {any[]} */ values) => Success(values);
        const result = Parallel([e1, e2], next);
        assert.equal(result.type, 'Parallel');
        assert.deepEqual(result.effects, [e1, e2]);
        assert.equal(result.next, next);
    });

    it('should run effects concurrently and pass results to next', async () => {
        const e1 = Command(
            async () => 'a',
            (v) => Success(v)
        );
        const e2 = Command(
            async () => 'b',
            (v) => Success(v)
        );
        const flow = Parallel([e1, e2], ([a, b]) => Success({ a, b }));
        const result = await runEffect(flow);
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { a: 'a', b: 'b' });
    });

    it('should return Failure if any parallel effect fails', async () => {
        const e1 = Success('ok');
        const e2 = Failure('oops');
        const flow = Parallel([e1, e2], ([a, b]) => Success({ a, b }));
        const result = await runEffect(flow);
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'oops');
    });

    it('should work inside effectPipe', async () => {
        const flow = effectPipe((input) =>
            Parallel(
                [
                    Command(
                        async () => input.a,
                        (v) => Success(v)
                    ),
                    Command(
                        async () => input.b,
                        (v) => Success(v)
                    )
                ],
                ([a, b]) => Success({ a, b })
            )
        );
        const result = await runEffect(flow({ a: 1, b: 2 }));
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { a: 1, b: 2 });
    });

    it('should pass context to parallel branches via Ask', async () => {
        const flow = Parallel(
            [Ask((/** @type {any} */ ctx) => Success(ctx.x)), Ask((/** @type {any} */ ctx) => Success(ctx.y))],
            ([x, y]) => Success({ x, y })
        );
        const result = await runEffect(flow, { x: 10, y: 20 });
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { x: 10, y: 20 });
    });

    it('should return Success after runEffect with telemetry disabled', async function () {
        const input = { email: 'test-no-telemetry@test.com', password: 'password123' };
        const result = await registerUser(input);
        assert.equal(result.type, 'Success');
    });
});

/** Reads `.value` off a runEffect result once its type has been asserted. */
const valueOf = (/** @type {any} */ result) => result.value;

/** Reads `.error` off a runEffect result once its type has been asserted. */
const errorOf = (/** @type {any} */ result) => result.error;

describe('Recording and replay', function () {
    beforeEach(() => configureEffect({}));

    it('should record and replay the registration flow end to end', async function () {
        const input = { email: 'replay@test.com', password: 'password123' };
        const { result, trace } = await recordEffect(registerUserFlow, input);
        assert.equal(result.type, 'Success');
        assert.deepEqual(
            trace.trace.map((e) => e.command),
            ['cmdFindUser', 'cmdSaveUser'],
            'every Command in the flow is recorded, including the guard'
        );

        const replayed = await replayEffect(registerUserFlow(/** @type {User} */ (trace.initialInput)), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    /** A flow whose Commands count their own invocations, so tests can assert zero I/O. */
    const makeFlow = () => {
        const calls = { read: 0, write: 0 };
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => (i.id ? Success(i) : Failure('no_id')),
                (/** @type {any} */ i) =>
                    Command(
                        function cmdRead() {
                            calls.read++;
                            return { row: i.id };
                        },
                        (/** @type {any} */ row) => Success({ ...i, ...row })
                    ),
                (/** @type {any} */ acc) =>
                    Command(
                        function cmdWrite() {
                            calls.write++;
                            return { written: acc.row };
                        },
                        (/** @type {any} */ w) => Success(w)
                    )
            )(input);
        return { flow, calls };
    };

    it('should replay a recorded flow without performing any I/O', async function () {
        const a = makeFlow();
        const { result, trace } = await recordEffect(a.flow, { id: 'x1' }, { version: 'abc123' });
        assert.equal(result.type, 'Success');
        assert.deepEqual(a.calls, { read: 1, write: 1 });
        assert.equal(trace.version, 'abc123');

        const b = makeFlow();
        const replayed = await replayEffect(b.flow(trace.initialInput), trace);
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
        const replayed = await replayEffect(readTwice(null), trace);
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

        const replayed = await replayEffect(flow('sku-1'), trace, { context: trace.context });
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
        const replayed = await replayEffect(flow(), trace);
        const elapsed = Date.now() - start;
        assert.deepEqual(valueOf(replayed), { tempC: 21 });
        assert.equal(attempt, 0, 'no attempt was re-executed');
        assert.ok(elapsed < 100, `replay skipped 200 ms + 400 ms of backoff (took ${elapsed} ms)`);
    });

    it('should replay retry exhaustion as the same structured Failure', async function () {
        const flow = () =>
            Retry(
                Command(
                    function cmdFlaky() {
                        throw new Error('down');
                    },
                    (/** @type {any} */ v) => Success(v)
                ),
                { attempts: 2, delay: 0 }
            );

        const { result, trace } = await recordEffect(flow, null);
        assert.equal(result.type, 'Failure');

        const replayed = await replayEffect(flow(), trace);
        assert.equal(replayed.type, 'Failure');
        const error = /** @type {import('../index.js').RetryExhaustedError<Error>} */ (errorOf(replayed));
        assert.equal(error.retryExhausted, true);
        assert.equal(error.attempts, 2);
        assert.equal(error.lastError.message, 'down');
    });

    it('should require name matching for Parallel, whose branches finish out of order', async function () {
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
            ['cmdFast', 'cmdSlow'],
            'recording order follows completion, not the effects array'
        );

        const strictReplay = await replayEffect(flow('u1'), trace);
        assert.equal(strictReplay.type, 'Failure', 'positional matching reports a false paradox');
        assert.equal(/** @type {Error} */ (errorOf(strictReplay)).name, 'TimeParadox');

        const replayed = await replayEffect(flow('u1'), trace, { strict: false });
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    it('should accept a trace directly, without building a Resolver', async function () {
        const a = makeFlow();
        const { result, trace } = await recordEffect(a.flow, { id: 'direct' });

        const b = makeFlow();
        const replayed = await replayEffect(b.flow(trace.initialInput), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
        assert.deepEqual(b.calls, { read: 0, write: 0 });

        // A bare entries array is a valid trace too, without the surrounding TraceLog.
        const c = makeFlow();
        const fromEntries = await replayEffect(c.flow(trace.initialInput), trace.trace);
        assert.equal(fromEntries.type, 'Success');
        assert.deepEqual(valueOf(fromEntries), valueOf(result));
    });

    it('should reject a malformed trace as a ReplayError, not a TypeError', async function () {
        const { flow } = makeFlow();
        for (const bad of [undefined, null, 42, {}, { trace: 'nope' }]) {
            await assert.rejects(
                () => replayEffect(flow({ id: 'x' }), /** @type {any} */ (bad)),
                (/** @type {any} */ e) => e.name === 'ReplayError' && /no `trace` array/.test(e.message),
                `expected a ReplayError for ${JSON.stringify(bad)}`
            );
        }
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
        const replayed = await replayEffect(flowB(), trace);
        assert.equal(replayed.type, 'Failure');
        assert.equal(/** @type {Error} */ (errorOf(replayed)).name, 'TimeParadox');
        assert.match(
            /** @type {Error} */ (errorOf(replayed)).message,
            /asked for 'cmdBeta', trace recorded 'cmdAlpha'/
        );
    });

    it('should report an exhausted trace rather than silently succeeding', async function () {
        const { flow } = makeFlow();
        const replayed = await replayEffect(flow({ id: 'x' }), { trace: [] });
        assert.equal(replayed.type, 'Failure');
        assert.match(/** @type {Error} */ (errorOf(replayed)).message, /Trace exhausted/);
    });

    it('should refuse to run an unrecorded Command by default', async function () {
        const { flow, calls } = makeFlow();
        const replayed = await replayEffect(flow({ id: 'x' }), () => undefined);
        assert.equal(replayed.type, 'Failure');
        assert.match(/** @type {Error} */ (errorOf(replayed)).message, /refusing to run the real Command/);
        assert.deepEqual(calls, { read: 0, write: 0 });
    });

    it('should allow a recorded prefix and a live tail when onMissing is execute', async function () {
        const { flow, calls } = makeFlow();
        const recorded = [{ command: 'cmdRead', result: { row: 'FROM_TRACE' } }];
        /** @type {import('../index.js').Resolver} */
        const resolve = (step) => (step.index === 0 ? { result: recorded[0].result } : undefined);

        const replayed = await replayEffect(flow({ id: 'x' }), resolve, { onMissing: 'execute' });
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), { written: 'FROM_TRACE' });
        assert.deepEqual(calls, { read: 0, write: 1 }, 'only the unrecorded step performed I/O');
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
        assert.deepEqual(
            rec.entries.map(({ command, result }) => ({ command, result })),
            [{ command: 'cmdWork', result: '[redaction failed]' }]
        );
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
                ['result', 'cmdRead'],
                ['error', 'cmdSave'],
                ['initialInput', 'initialInput'],
                ['context', 'context']
            ],
            'results, errors, and the trace-level fields all pass through redact'
        );
        const json = JSON.stringify(trace);
        assert.ok(!json.includes('hunter2'), 'no password anywhere in the trace');
        assert.ok(!json.includes('bearer-abc123'), 'no token anywhere in the trace');
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

        const replayed = await replayEffect(flow(trace.initialInput), trace);
        assert.equal(replayed.type, 'Success', 'the redacted input still rebuilds a matching flow');
        assert.deepEqual(valueOf(replayed), valueOf(result), 'and the recorded hash comes back intact');
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
        assert.match(out, /1 recorded steps were never reached/);
    });

    it('should narrate a Parallel flow when strict is off', async function () {
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
        const result = await timeTravel(flow, trace, { strict: false, log: (l) => lines.push(l) });

        assert.equal(result.type, 'Success', 'strict must reach the trace resolution');
        const out = lines.join('\n');
        assert.match(out, /cmdSlow returned/);
        assert.match(out, /cmdFast returned/);
        assert.doesNotMatch(out, /never reached/, 'both recorded steps were consumed');
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
        const replayed = await replayEffect(flow({ id: 1 }), trace, {
            strict: false,
            context: trace.context
        });
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
        assert.equal(invocations, 0, 'no Command thunk was applied');
    });
});

describe('configureEffect merging', function () {
    beforeEach(() => configureEffect({}));

    /** A Command whose thunk is named, so hooks can be asserted by name. */
    const work = (/** @type {any} */ value = 'ok') =>
        Command(
            function cmdWork() {
                return value;
            },
            (/** @type {any} */ v) => Success(v)
        );

    it('should nest onStep wrappers with the first config outermost', async function () {
        /** @type {string[]} */
        const order = [];
        const outer = async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
            order.push('outer:in');
            const r = await op();
            order.push('outer:out');
            return r;
        };
        const inner = async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
            order.push('inner:in');
            const r = await op();
            order.push('inner:out');
            return r;
        };
        configureEffect({ onStep: outer }, { onStep: inner });
        const result = await runEffect(work('ok'));
        assert.equal(result.type, 'Success');
        assert.deepEqual(order, ['outer:in', 'inner:in', 'inner:out', 'outer:out']);
    });

    it('should let recording and telemetry share the single onStep slot', async function () {
        /** @type {string[]} */
        const spans = [];
        const telemetry = async (/** @type {any} */ name, /** @type {any} */ t, /** @type {any} */ op) => {
            spans.push(name);
            return await op();
        };
        const rec = recorder();
        configureEffect({ onStep: telemetry }, { onStep: rec.onStep });
        const result = await runEffect(work('ok'));
        assert.equal(valueOf(result), 'ok');
        assert.deepEqual(spans, ['cmdWork']);
        assert.deepEqual(
            rec.entries.map(({ command, result }) => ({ command, result })),
            [{ command: 'cmdWork', result: 'ok' }]
        );
    });

    it('should propagate a thrown Command through every wrapper', async function () {
        /** @type {string[]} */
        const saw = [];
        const watcher =
            (/** @type {string} */ label) =>
            async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
                try {
                    return await op();
                } catch (e) {
                    saw.push(label);
                    throw e;
                }
            };
        const rec = recorder();
        configureEffect({ onStep: watcher('a') }, { onStep: rec.onStep }, { onStep: watcher('b') });
        const result = await runEffect(
            Command(
                function cmdBoom() {
                    throw new Error('boom');
                },
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(result.type, 'Failure');
        assert.deepEqual(saw, ['b', 'a'], 'the error unwinds from innermost to outermost');
        assert.equal(rec.entries.length, 1, 'the recorder still captured the failing step');
        assert.ok('error' in rec.entries[0]);
    });

    it('should nest onRun wrappers and preserve flowName and the result', async function () {
        /** @type {any[]} */
        const seen = [];
        const wrap =
            (/** @type {string} */ label) =>
            async (/** @type {any} */ effect, /** @type {any} */ op, /** @type {any} */ flowName) => {
                seen.push([label, flowName]);
                return await op();
            };
        configureEffect({ onRun: wrap('a') }, { onRun: wrap('b') });
        const result = await runEffect(work('ok'), { flowName: 'checkout' });
        assert.equal(valueOf(result), 'ok');
        assert.deepEqual(seen, [
            ['a', 'checkout'],
            ['b', 'checkout']
        ]);
    });

    it('should run every onBeforeCommand interceptor in order', async function () {
        /** @type {string[]} */
        const calls = [];
        configureEffect(
            { onBeforeCommand: async (/** @type {any} */ c) => void calls.push(`a:${c.cmd.name}`) },
            { onBeforeCommand: async (/** @type {any} */ c) => void calls.push(`b:${c.cmd.name}`) }
        );
        await runEffect(work('ok'));
        assert.deepEqual(calls, ['a:cmdWork', 'b:cmdWork']);
    });

    it('should merge retry defaults with later configs winning', async function () {
        // attempts from the first, delay from the second: a slow default would make this test crawl.
        configureEffect({ retry: { attempts: 5, delay: 200 } }, { retry: { delay: 0 } });
        let calls = 0;
        const started = Date.now();
        const result = await runEffect(
            Retry(
                Command(
                    function cmdFlaky() {
                        if (++calls < 5) throw new Error('transient');
                        return 'ok';
                    },
                    (/** @type {any} */ v) => Success(v)
                )
            )
        );
        assert.equal(result.type, 'Success', 'the higher attempts count from the first config applied');
        assert.equal(calls, 5);
        assert.ok(Date.now() - started < 150, 'and the zero delay from the second config won');
    });

    it('should leave slots no config defines at their defaults, and tolerate gaps', async function () {
        /** @type {string[]} */
        const intercepted = [];
        configureEffect({ onBeforeCommand: async (/** @type {any} */ c) => void intercepted.push(c.cmd.name) });

        // Only onStep is named here, so the interceptor above must be gone rather than merged in.
        configureEffect(
            { onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => await op() },
            undefined,
            {}
        );
        assert.equal(valueOf(await runEffect(work('ok'))), 'ok');
        assert.deepEqual(intercepted, [], 'merging is per call and does not accumulate across calls');
    });

    it('should return a restore function that puts the previous wiring back', async function () {
        /** @type {string[]} */
        const first = [];
        /** @type {string[]} */
        const second = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                first.push(n),
                await op()
            )
        });

        const restore = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                second.push(n),
                await op()
            )
        });
        await runEffect(work('ok'));
        assert.deepEqual(second, ['cmdWork'], 'the second wiring took over');
        assert.deepEqual(first, [], 'and displaced the first');

        restore();
        await runEffect(work('ok'));
        assert.deepEqual(first, ['cmdWork'], 'restore brought the first wiring back');
        assert.deepEqual(second, ['cmdWork'], 'without reactivating the second');
    });

    it('should restore back to no hooks when nothing was configured before', async function () {
        /** @type {string[]} */
        const seen = [];
        const restore = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        await runEffect(work('ok'));
        restore();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the second run had no hooks at all');
    });

    it('should restore retry defaults too', async function () {
        configureEffect({ retry: { attempts: 1, delay: 0 } });
        const restore = configureEffect({ retry: { attempts: 4, delay: 0 } });

        const flaky = () => {
            let calls = 0;
            return {
                count: () => calls,
                effect: () =>
                    Retry(
                        Command(
                            function cmdFlaky() {
                                if (++calls < 3) throw new Error('transient');
                                return 'ok';
                            },
                            (/** @type {any} */ v) => Success(v)
                        )
                    )
            };
        };

        const generous = flaky();
        assert.equal((await runEffect(generous.effect())).type, 'Success', 'four attempts are enough');

        restore();
        const stingy = flaky();
        const result = await runEffect(stingy.effect());
        assert.equal(result.type, 'Failure', 'the restored single attempt is not');
        assert.equal(/** @type {any} */ (errorOf(result)).attempts, 1);
    });

    it('should not clobber a newer wiring when restoring out of order', async function () {
        /** @type {string[]} */
        const a = [];
        /** @type {string[]} */
        const b = [];
        const restoreA = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (a.push(n), await op())
        });
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (b.push(n), await op())
        });

        restoreA();
        await runEffect(work('ok'));
        assert.deepEqual(b, ['cmdWork'], "B's wiring survived A's late restore");
        assert.deepEqual(a, [], 'and A did not come back');
    });

    it('should reset every slot when called with nothing', async function () {
        /** @type {string[]} */
        const seen = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        await runEffect(work('ok'));
        configureEffect();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the second run ran with no hooks at all');
    });
});

describe('examples/recording-example.js', function () {
    beforeEach(() => configureEffect({}));
    afterEach(() => configureEffect({}));

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
        const result = await runEffect(failing({ id: 1 }), { flowName: 'writer', tenant: 'acme' });
        assert.equal(result.type, 'Failure');
        assert.equal(written.length, 1);
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdRead', 'cmdWrite']
        );
        assert.equal(written[0].flowName, 'writer');
        assert.deepEqual(written[0].context, { flowName: 'writer', tenant: 'acme' }, 'context captured for Ask replay');
        assert.deepEqual(written[0].initialInput, { id: 1 });
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
            runEffect(slowFail('A')({ id: 'A' }), { flowName: 'A' }),
            runEffect(slowFail('B')({ id: 'B' }), { flowName: 'B' })
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
        const result = await runEffect(failing({ id: 3 }), { flowName: 'both' });
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
});

describe('examples/opentelemetry-example.js', function () {
    beforeEach(() => configureEffect({}));
    afterEach(() => configureEffect({}));

    /** A tracer stub, so the example is testable without standing up an SDK. */
    const fakeTracer = () => {
        /** @type {any[]} */
        const spans = [];
        return {
            spans,
            tracer: /** @type {any} */ ({
                startActiveSpan: (/** @type {string} */ name, /** @type {any} */ fn) => {
                    const span = {
                        name,
                        /** @type {Record<string, any>} */ attributes: {},
                        /** @type {any} */ status: undefined,
                        exceptions: /** @type {any[]} */ ([]),
                        ended: false,
                        setAttribute(/** @type {string} */ k, /** @type {any} */ v) {
                            this.attributes[k] = v;
                        },
                        setStatus(/** @type {any} */ st) {
                            this.status = st;
                        },
                        recordException(/** @type {any} */ e) {
                            this.exceptions.push(e);
                        },
                        end() {
                            this.ended = true;
                        }
                    };
                    spans.push(span);
                    return fn(span);
                }
            })
        };
    };

    const workFlow = (/** @type {any} */ input) =>
        effectPipe((/** @type {any} */ i) =>
            Command(
                function cmdWork() {
                    return 'done';
                },
                (/** @type {any} */ v) => Success(v)
            )
        )(input);

    it('should not let an unserializable input stop the flow', async function () {
        // A request object or database client in the input is ordinary, and both hold cycles.
        // Nothing serializes the input any more, so this guards against reintroducing that.
        /** @type {any} */
        const input = { id: 1 };
        input.self = input;

        const { tracer, spans } = fakeTracer();
        let ran = 0;
        const flow = (/** @type {any} */ i) =>
            effectPipe(() =>
                Command(
                    function cmdWork() {
                        ran++;
                        return 'done';
                    },
                    (/** @type {any} */ v) => Success(v)
                )
            )(i);

        configureEffect(telemetryHooks({ tracer }));
        const result = await runEffect(flow(input));

        assert.equal(result.type, 'Success', 'telemetry must not decide whether the flow runs');
        assert.equal(ran, 1);
        assert.ok(spans.every((/** @type {any} */ sp) => sp.ended));
    });

    it('should never put Command values on spans', async function () {
        const secret = { email: 'user@test.com', password: 'plaintext' };
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        await runEffect(workFlow(secret), { flowName: 'register' });

        const attributes = JSON.stringify(spans.map((/** @type {any} */ sp) => sp.attributes));
        assert.ok(!attributes.includes('plaintext'), 'no input values on spans');
        assert.ok(!attributes.includes('user@test.com'), 'not even harmless-looking ones');
        assert.ok(!attributes.includes('done'), 'no Command output on spans');
        assert.deepEqual(Object.keys(spans[0].attributes), ['effect.flow'], 'the root span carries the flow name');
        assert.deepEqual(Object.keys(spans[1].attributes), ['effect.type'], 'and a step span its type');
    });

    it('should name the root span after the flow and open a child span per Command', async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        await runEffect(workFlow({ id: 1 }), { flowName: 'checkout' });
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => s.name),
            ['checkout', 'cmdWork']
        );
        assert.equal(spans[1].attributes['effect.type'], 'Command');
    });

    it('should mark a Failure on the root span and record a thrown Command', async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        const boom = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(
                    function cmdBoom() {
                        throw new Error('boom');
                    },
                    (/** @type {any} */ v) => Success(v)
                )
            )(input);
        const result = await runEffect(boom({ id: 1 }));
        assert.equal(result.type, 'Failure');
        assert.equal(spans[1].exceptions.length, 1, 'the step span recorded the exception');
        assert.equal(spans[0].status.code, 2, 'and the root span is ERROR');
        assert.ok(spans.every((/** @type {any} */ s) => s.ended));
    });

    it('should still work through enableTelemetry with no SDK started', async function () {
        enableTelemetry();
        const result = await runEffect(workFlow({ id: 1 }), { flowName: 'noop-tracer' });
        assert.equal(result.type, 'Success');
    });

    it('should compose with recording in one configureEffect call', async function () {
        const { tracer, spans } = fakeTracer();
        /** @type {any[]} */
        const written = [];
        configureEffect(
            telemetryHooks({ tracer }),
            recordingHooks({ keep: () => true, sink: async (/** @type {any} */ t) => void written.push(t) })
        );
        const result = await runEffect(workFlow({ id: 1 }), { flowName: 'both' });
        assert.equal(result.type, 'Success');
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => s.name),
            ['both', 'cmdWork']
        );
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdWork']
        );
    });
});

describe('Recorded step timings', function () {
    beforeEach(() => configureEffect({}));

    const slow = (/** @type {number} */ ms) =>
        Command(
            function cmdSlow() {
                return new Promise((r) => setTimeout(() => r('done'), ms));
            },
            (/** @type {any} */ v) => Success(v)
        );

    it('should record how long each Command took', async function () {
        const rec = recorder();
        await runEffect(slow(15), {}, { onStep: rec.onStep });
        assert.equal(rec.entries.length, 1);
        const { durationMs } = rec.entries[0];
        assert.equal(typeof durationMs, 'number');
        assert.ok(/** @type {number} */ (durationMs) >= 10, `expected at least 10ms, got ${durationMs}`);
        assert.equal(
            durationMs,
            Math.round(/** @type {number} */ (durationMs) * 1000) / 1000,
            'rounded to microseconds'
        );
    });

    it('should record a duration for a Command that threw', async function () {
        const rec = recorder();
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
        assert.equal(result.type, 'Failure');
        assert.ok('error' in rec.entries[0]);
        assert.equal(typeof rec.entries[0].durationMs, 'number');
    });

    it('should keep timings out of the way of replay', async function () {
        const flow = (/** @type {any} */ input) => effectPipe(() => slow(5))(input);
        const { result, trace } = await recordEffect(flow, { id: 1 });
        assert.equal(typeof trace.trace[0].durationMs, 'number');
        const replayed = await replayEffect(flow({ id: 1 }), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    it('should not let an observation failure change the outcome', async function () {
        // The guarantee `observeSteps` exists for, reached through its only caller.
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

describe('Command identity', function () {
    beforeEach(() => configureEffect({}));

    /** Captures the name each Command is executed under. */
    const capture = () => {
        /** @type {string[]} */
        const names = [];
        return {
            names,
            onStep: async (/** @type {any} */ name, /** @type {any} */ t, /** @type {any} */ op) => (
                names.push(name),
                await op()
            )
        };
    };

    it('should default next to Success so a result passes straight through', async function () {
        const result = await runEffect(Command(() => 'ok'));
        assert.equal(result.type, 'Success');
        assert.equal(valueOf(result), 'ok');
    });

    it('should prefer meta.name over the thunk name', async function () {
        const { names, onStep } = capture();
        const effect = Command(
            function cmdInternalName() {
                return 'ok';
            },
            (/** @type {any} */ v) => Success(v),
            { name: 'chargeCard' }
        );
        assert.equal(valueOf(await runEffect(effect, {}, { onStep })), 'ok');
        assert.deepEqual(names, ['chargeCard']);
    });

    it('should let an inline thunk be identified through meta.name', async function () {
        const { names, onStep } = capture();
        const effect = Command(
            () => 'ok',
            (/** @type {any} */ v) => Success(v),
            { name: 'cmdInline' }
        );
        await runEffect(effect, {}, { onStep });
        assert.deepEqual(names, ['cmdInline'], 'no longer anonymous');
    });

    it('should fall back to the thunk name when meta carries no name', async function () {
        const { names, onStep } = capture();
        const effect = Command(
            function cmdNamed() {
                return 'ok';
            },
            (/** @type {any} */ v) => Success(v),
            { attempt: 1 }
        );
        await runEffect(effect, {}, { onStep });
        assert.deepEqual(names, ['cmdNamed']);
    });

    it('should fall back to anonymous when neither is available', async function () {
        const { names, onStep } = capture();
        await runEffect(
            Command(
                () => 'ok',
                (/** @type {any} */ v) => Success(v)
            ),
            {},
            { onStep }
        );
        assert.deepEqual(names, ['anonymous']);
    });

    it('should ignore a meta that is not an object or has a non-string name', async function () {
        const { names, onStep } = capture();
        const named = () =>
            Command(
                function cmdFallback() {
                    return 'ok';
                },
                (/** @type {any} */ v) => Success(v)
            );
        for (const meta of ['a string', 42, null, { name: 7 }, { name: '' }]) {
            const effect = Command(named().cmd, (/** @type {any} */ v) => Success(v), meta);
            await runEffect(effect, {}, { onStep });
        }
        assert.deepEqual(names, ['cmdFallback', 'cmdFallback', 'cmdFallback', 'cmdFallback', 'cmdFallback']);
    });

    it('should carry meta.name through effectPipe into a trace and a replay', async function () {
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) =>
                    Command(
                        () => ({ row: i.id }),
                        (/** @type {any} */ r) => Success(r),
                        { name: 'readRow' }
                    ),
                (/** @type {any} */ r) =>
                    Command(
                        () => ({ written: r.row }),
                        (/** @type {any} */ w) => Success(w),
                        { name: 'writeRow' }
                    )
            )(input);

        const { result, trace } = await recordEffect(flow, { id: 'x1' });
        assert.deepEqual(
            trace.trace.map((e) => e.command),
            ['readRow', 'writeRow'],
            'meta.name survives the rebuild chain performs on each pipe step'
        );

        const replayed = await replayEffect(flow({ id: 'x1' }), trace);
        assert.equal(replayed.type, 'Success', 'strict matching lines up on meta.name');
        assert.deepEqual(valueOf(replayed), valueOf(result));
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

    it('should fall back to the reference for values that cannot be cloned', async function () {
        const rec = recorder();
        const result = await runEffect(
            Command(
                function cmdWithFunction() {
                    return { ok: true, callback: () => 'not cloneable' };
                },
                (/** @type {any} */ r) => Success(r)
            ),
            {},
            { onStep: rec.onStep }
        );
        assert.equal(result.type, 'Success', 'an uncloneable result must not fail the run');
        assert.equal(/** @type {any} */ (rec.entries[0].result).ok, true, 'and the entry is still recorded');
    });
});

describe('Documented sharp edges', function () {
    beforeEach(() => configureEffect());

    it('should re-run already-succeeded Commands on every Retry attempt', async function () {
        // Pinned deliberately: `Retry` repeats the whole wrapped tree, which is why the docs say to
        // wrap the one Command that fails transiently rather than a pipeline.
        /** @type {string[]} */
        const charges = [];
        let receiptFailures = 0;
        const effect = Retry(
            effectPipe(
                () =>
                    Command(
                        function cmdCharge() {
                            charges.push('charged');
                            return { id: charges.length };
                        },
                        (/** @type {any} */ r) => Success(r)
                    ),
                () =>
                    Command(
                        function cmdSendReceipt() {
                            if (++receiptFailures < 3) throw new Error('smtp down');
                            return 'sent';
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )({ order: 1 }),
            { attempts: 3, delay: 0 }
        );

        const result = await runEffect(effect);
        assert.equal(result.type, 'Success');
        assert.equal(charges.length, 3, 'one order, three charges: wrap the Command, not the pipeline');
    });

    it('should run every Parallel branch to completion even after one fails', async function () {
        // Pinned deliberately: Promise.all has no cancellation, so a Failure does not stop sibling I/O.
        /** @type {string[]} */
        const written = [];
        const result = await runEffect(
            Parallel(
                [
                    Command(
                        function cmdValidate() {
                            return null;
                        },
                        () => Failure('validation_failed')
                    ),
                    Command(
                        function cmdSlowWrite() {
                            return new Promise((r) =>
                                setTimeout(() => {
                                    written.push('wrote');
                                    r('ok');
                                }, 20)
                            );
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
                ],
                (/** @type {any} */ vals) => Success(vals)
            )
        );
        assert.equal(result.type, 'Failure');
        assert.equal(errorOf(result), 'validation_failed');
        assert.deepEqual(written, ['wrote'], 'the sibling branch still performed its write');
    });

    it('should carry the initial input on every Failure', async function () {
        // Pinned deliberately: convenient for tests, and a PII surface for anything that logs the
        // whole Failure rather than its `error`.
        const input = { email: 'user@test.com', password: 'plaintext' };
        const failing = (/** @type {any} */ i) => effectPipe(() => Failure('invalid'))(i);
        const result = await runEffect(failing(input));
        assert.equal(result.type, 'Failure');
        assert.deepEqual(/** @type {any} */ (result).initialInput, input);
    });
});

describe('Malformed flows', function () {
    beforeEach(() => configureEffect());

    /** @param {() => any} fn */
    const errorFrom = async (fn) => {
        try {
            await fn();
            return null;
        } catch (e) {
            return /** @type {any} */ (e);
        }
    };

    it('should name the step that returned something other than an Effect', async function () {
        function validateRegistration(/** @type {any} */ input) {
            return { ...input, ok: true }; // forgot Success()
        }
        const e = await errorFrom(() =>
            runEffect(effectPipe(validateRegistration, (/** @type {any} */ i) => Success(i))({ id: 1 }))
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /Step 'validateRegistration' returned a plain object/);
        assert.match(e.message, /Success\(value\)/, 'the message says what to do about it');
    });

    it('should call a missing return what it usually is', async function () {
        function ensureEmailAvailable() {}
        const e = await errorFrom(() => runEffect(effectPipe(ensureEmailAvailable)({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /returned undefined, which usually means a missing return/);
    });

    it('should reject a Command continuation that returns a plain value', async function () {
        // This used to resolve to 6, so `result.type === 'Success'` quietly took the else branch.
        const e = await errorFrom(() =>
            runEffect(
                Command(
                    function cmdRead() {
                        return 5;
                    },
                    (/** @type {any} */ r) => r + 1
                )
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /returned the number 6/);
    });

    it('should recognise a flow that was never called with its input', async function () {
        // runEffect(effectPipe(...)) rather than runEffect(effectPipe(...)(input)).
        const e = await errorFrom(() =>
            runEffect(/** @type {any} */ (effectPipe((/** @type {any} */ i) => Success(i))))
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /a function, which usually means a flow was passed without being called/);
    });

    it('should not disguise a malformed flow as a domain Failure', async function () {
        // The interpreter turns a thrown Command into a Failure; a bug in the flow must still throw.
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(
                        function cmdRead() {
                            return { id: 1 };
                        },
                        (/** @type {any} */ r) => Success(r)
                    ),
                function afterRead(/** @type {any} */ r) {
                    return r; // forgot Success()
                }
            )(input);
        const e = await errorFrom(() => runEffect(flow({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError', 'thrown rather than folded into a Failure');
        assert.match(e.message, /Step 'afterRead'/);
    });

    it('should still turn a thrown Command into a Failure', async function () {
        const result = await runEffect(
            Command(
                function cmdBoom() {
                    throw new Error('boom');
                },
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(result.type, 'Failure', 'domain failures are unaffected by the new guard');
        assert.equal(/** @type {Error} */ (errorOf(result)).message, 'boom');
    });
});
