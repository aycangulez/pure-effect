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
import * as lib from '../index.js';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
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

    it('should default next to Success of the values array when omitted', async () => {
        const e1 = Command(async () => 'a');
        const e2 = Command(async () => 'b');
        const result = await runEffect(Parallel([e1, e2]));
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, ['a', 'b']);
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
            { attempts: 0, delay: 0, onExhausted: () => Failure('cache empty') }
        );
        const result = /** @type {any} */ (await runEffect(flow));
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'cache empty', 'the fallback failure must not be wrapped in retryExhausted');
    });

    it('should not run the fallback in a cancelled Parallel branch', async function () {
        let fallbackRuns = 0;
        const slowFailing = Retry(
            Command(async function cmdSlowFail() {
                await new Promise((resolve) => setTimeout(resolve, 30));
                throw new Error('slow branch failed');
            }),
            {
                attempts: 0,
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
                    attempts: 0,
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

/** Reads `.value` off a runEffect result once its type has been asserted. */
const valueOf = (/** @type {any} */ result) => result.value;

/** Reads `.error` off a runEffect result once its type has been asserted. */
const errorOf = (/** @type {any} */ result) => result.error;

describe('Recording and replay', function () {
    beforeEach(() => configureEffect());

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

        const { result: replayed } = await replayEffect(flow(), trace);
        assert.equal(replayed.type, 'Failure');
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
            ['cmdFast', 'cmdSlow'],
            'recording order follows completion, not the effects array'
        );
        assert.deepEqual(
            trace.trace.map((e) => e.path),
            ['0p1/0', '0p0/0'],
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

        // Replay with the latencies reversed, so completion order is the opposite of the recorded run.
        const { result: replayed } = await replayEffect(flow([5, 40]), trace);
        assert.equal(replayed.type, 'Success');
        assert.deepEqual(valueOf(replayed), ['A', 'B'], 'branch results were not swapped');
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
        assert.equal(JSON.stringify(error), '{}', 'name stays non-enumerable, as on a native Error');
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
        const { result: replayed } = await replayEffect(flowB(), trace);
        assert.equal(replayed.type, 'Failure');
        assert.equal(/** @type {Error} */ (errorOf(replayed)).name, 'TimeParadox');
        assert.match(
            /** @type {Error} */ (errorOf(replayed)).message,
            /asked for 'cmdBeta', trace recorded 'cmdAlpha'/
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

        const { result: replayed } = await replayEffect(flow(trace.initialInput), trace);
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
        assert.match(out, /1 recorded step was never reached: cmdWrite\. The flow diverged/);
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

describe('configureEffect merging', function () {
    beforeEach(() => configureEffect());

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

    it('should leave slots no layer defines at their defaults, and tolerate gaps', async function () {
        /** @type {string[]} */
        const intercepted = [];
        configureEffect({ onBeforeCommand: async (/** @type {any} */ c) => void intercepted.push(c.cmd.name) });

        // A second layer naming only onStep adds to the first rather than displacing it, the undefined
        // and empty configurations are ignored, and onRun, which no layer names, stays at its default.
        configureEffect(
            { onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => await op() },
            undefined,
            {}
        );
        assert.equal(valueOf(await runEffect(work('ok'))), 'ok');
        assert.deepEqual(intercepted, ['cmdWork'], 'the earlier layer still runs');
    });

    it('should stack a second call on top of the first, and remove only that layer', async function () {
        // Each call adds a layer. Under the old one-slot rule the second call displaced the first and the
        // returned function restored a snapshot, which needed a guard against interleaved installs.
        /** @type {string[]} */
        const order = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                order.push('first'),
                await op()
            )
        });
        const remove = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                order.push('second'),
                await op()
            )
        });
        await runEffect(work('ok'));
        assert.deepEqual(order, ['first', 'second'], 'both ran, the earlier layer outermost');

        order.length = 0;
        remove();
        await runEffect(work('ok'));
        assert.deepEqual(order, ['first'], 'removing the second layer left the first in place');
    });

    it('should stack separate calls exactly as one call with several configurations', async function () {
        /** @type {string[]} */
        const viaOne = [];
        /** @type {string[]} */
        const viaTwo = [];
        /** @param {string[]} log @param {string} label */
        const tag = (log, label) => ({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
                log.push(`${label}>`);
                const r = await op();
                log.push(`<${label}`);
                return r;
            },
            onBeforeCommand: async () => {
                log.push(`${label}!`);
            }
        });
        configureEffect(tag(viaOne, 'a'), tag(viaOne, 'b'));
        await runEffect(work('ok'));
        configureEffect();
        configureEffect(tag(viaTwo, 'a'));
        configureEffect(tag(viaTwo, 'b'));
        await runEffect(work('ok'));
        assert.deepEqual(viaTwo, viaOne);
        assert.deepEqual(viaOne, ['a!', 'b!', 'a>', 'b>', '<b', '<a']);
    });

    it('should make removing a layer idempotent', async function () {
        /** @type {string[]} */
        const seen = [];
        const removeA = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push('a'),
                await op()
            )
        });
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push('b'),
                await op()
            )
        });
        removeA();
        removeA();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['b'], 'a second removal took nothing else with it');
    });

    it('should remove the only layer back to no hooks', async function () {
        /** @type {string[]} */
        const seen = [];
        const remove = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        await runEffect(work('ok'));
        remove();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the second run had no hooks at all');
    });

    it("should merge retry across layers and drop a layer's share when it is removed", async function () {
        configureEffect({ retry: { attempts: 1, delay: 0 } });
        const remove = configureEffect({ retry: { attempts: 4, delay: 0 } });

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
        assert.equal((await runEffect(generous.effect())).type, 'Success', "the later layer's four attempts win");

        remove();
        const stingy = flaky();
        const result = await runEffect(stingy.effect());
        assert.equal(result.type, 'Failure', "the remaining layer's single attempt is not enough");
        assert.equal(/** @type {any} */ (errorOf(result)).attempts, 1);
    });

    it('should leave a newer layer in place when an older one is removed', async function () {
        /** @type {string[]} */
        const a = [];
        /** @type {string[]} */
        const b = [];
        const removeA = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (a.push(n), await op())
        });
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (b.push(n), await op())
        });

        removeA();
        await runEffect(work('ok'));
        assert.deepEqual(b, ['cmdWork'], "B's layer survived A's removal");
        assert.deepEqual(a, [], 'and A is gone');
    });

    it('should remove every layer when called with nothing', async function () {
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

    it('should install nothing and remove nothing when every argument is absent', async function () {
        // `configureEffect(flag ? hooks : undefined)` is a conditional install, not a reset. Only a call
        // with no arguments at all removes every layer; a call whose arguments are all absent adds no
        // layer, leaves the host's wiring alone, and hands back a remover that has nothing to remove.
        /** @type {string[]} */
        const seen = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        const remove = configureEffect(undefined);
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the host layer survived configureEffect(undefined)');
        remove();
        configureEffect(undefined, undefined);
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork', 'cmdWork'], 'still installed after removing the empty call');
    });
});

describe('Per-call inherit', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

    /** @param {string} name */
    const cmd = (name) =>
        Command(
            () => name,
            (/** @type {any} */ r) => Success(r),
            { name }
        );

    /** @param {string[]} log @param {string} label */
    const tagStep = (log, label) => async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
        log.push(`${label}:before`);
        try {
            return await op();
        } finally {
            log.push(`${label}:after`);
        }
    };

    /** @param {string[]} log */
    const globalWiring = (log) => ({
        onStep: tagStep(log, 'global'),
        onRun: async (/** @type {any} */ e, /** @type {any} */ op) => (log.push('run'), await op()),
        onBeforeCommand: async () => {
            log.push('global-intercept');
        }
    });

    it('should nest per-call hooks inside the global ones by default', async function () {
        // Adding, not replacing: a per-call hook used to switch the global one off for that run, which
        // is how recordEffect inside an instrumented application silently produced runs with no spans.
        /** @type {string[]} */
        const log = [];
        configureEffect(globalWiring(log));
        const result = await runEffect(
            cmd('a'),
            {},
            {
                onStep: tagStep(log, 'local'),
                onBeforeCommand: async () => {
                    log.push('local-intercept');
                }
            }
        );
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, [
            'run',
            'global-intercept',
            'local-intercept',
            'global:before',
            'local:before',
            'local:after',
            'global:after'
        ]);
    });

    it('should behave the same with inherit: true spelled out', async function () {
        /** @type {string[]} */
        const log = [];
        configureEffect(globalWiring(log));
        await runEffect(cmd('a'), {}, { inherit: true, onStep: tagStep(log, 'local') });
        assert.deepEqual(log, [
            'run',
            'global-intercept',
            'global:before',
            'local:before',
            'local:after',
            'global:after'
        ]);
    });

    it('should merge retry with the per-call value winning', async function () {
        let calls = 0;
        const flaky = Command(() => {
            calls++;
            throw new Error('down');
        });
        configureEffect({ retry: { attempts: 1, delay: 5000 } });
        const result = await runEffect(Retry(flaky), {}, { retry: { delay: 0 } });
        assert.equal(result.type, 'Failure');
        assert.equal(calls, 2, 'attempts came from the global, the delay from the call');
    });

    it('should consult nothing global under inherit: false, falling back to library defaults', async function () {
        /** @type {string[]} */
        const log = [];
        let calls = 0;
        const flaky = Command(() => {
            calls++;
            throw new Error('down');
        });
        configureEffect({ ...globalWiring(log), retry: { attempts: 0 } });
        const result = await runEffect(Retry(flaky, { delay: 0 }), {}, { inherit: false });
        assert.equal(result.type, 'Failure');
        assert.deepEqual(log, [], 'no global hook fired');
        assert.equal(calls, 4, 'the library default of three retries applied, not the global zero');
    });

    it('should still apply per-call hooks under inherit: false', async function () {
        /** @type {string[]} */
        const log = [];
        configureEffect(globalWiring(log));
        await runEffect(cmd('a'), {}, { inherit: false, onStep: tagStep(log, 'local') });
        assert.deepEqual(log, ['local:before', 'local:after']);
    });

    it('should reject a non-boolean rather than guessing', async function () {
        await assert.rejects(
            runEffect(cmd('a'), {}, /** @type {any} */ ({ inherit: 'all' })),
            (/** @type {any} */ e) =>
                e instanceof TypeError && /true or false/.test(e.message) && /"all"/.test(e.message)
        );
    });

    it('should record under the global onStep with recordEffect', async function () {
        /** @type {string[]} */
        const log = [];
        configureEffect({ onStep: tagStep(log, 'global') });
        const { result, trace } = await recordEffect(() => cmd('a'), null);
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, ['global:before', 'global:after'], 'tracing kept running');
        assert.equal(trace.trace.length, 1, 'and the run was recorded');
    });

    it('should keep a default replay away from every global hook', async function () {
        /** @type {string[]} */
        const log = [];
        let ran = 0;
        const flow = () =>
            Command(
                () => ++ran,
                (/** @type {any} */ r) => Success(r),
                { name: 'cmdA' }
            );
        const { trace } = await recordEffect(flow, null);
        configureEffect(globalWiring(log));
        const { result } = await replayEffect(flow(), trace);
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, []);
        assert.equal(ran, 1, 'the recording ran it once; the replay not at all');
    });

    it('should replay under the global retry defaults even though a default replay ignores the global hooks', async function () {
        // Production ran with attempts: 5 configured globally and succeeded on the fifth try. A replay
        // that ignored the global wiring wholesale would retry three times, exhaust, and report a Failure
        // production never saw, with hooks: true and hooks: false disagreeing about the same trace.
        /** @type {string[]} */
        const log = [];
        let ran = 0;
        const flow = () =>
            Retry(
                Command(
                    () => {
                        ran++;
                        if (ran < 5) throw new Error(`flaky ${ran}`);
                        return 'ok';
                    },
                    (/** @type {any} */ r) => Success(r),
                    { name: 'cmdFlaky' }
                )
            );
        configureEffect({ retry: { attempts: 5, delay: 0 } });
        const { result, trace } = await recordEffect(flow, null);
        assert.deepEqual(result, Success('ok'));
        assert.equal(trace.trace.length, 5, 'production recorded five attempts');
        configureEffect(globalWiring(log));
        const replayed = await replayEffect(flow(), trace);
        assert.deepEqual(replayed.result, Success('ok'), 'the replay reproduces production');
        assert.deepEqual(replayed.unreached, []);
        assert.deepEqual(log, [], 'the global hooks still did not fire');
        assert.equal(ran, 5, 'the replay executed nothing');
    });

    it('should let a replay with hooks run under the global hooks without executing Commands', async function () {
        /** @type {string[]} */
        const log = [];
        let ran = 0;
        const flow = () =>
            Command(
                () => ++ran,
                (/** @type {any} */ r) => Success(r),
                { name: 'cmdA' }
            );
        const { trace } = await recordEffect(flow, null);
        configureEffect(globalWiring(log));
        const { result } = await replayEffect(flow(), trace, { hooks: true });
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, ['run', 'global-intercept', 'global:before', 'global:after']);
        assert.equal(ran, 1, 'the global onStep observed the replayed step, and the Command still did not run');
    });
});

describe('examples/recording-example.js', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

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
        const result = await runEffect(flow(1), { flowName: 'fanout' });
        assert.deepEqual(result, Success([2, 3]));
        assert.equal(written.length, 1);
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.path).sort(),
            ['0p0/0', '0p1/0'],
            'every entry carries its path'
        );
        configureEffect();
        const replayed = await replayEffect(flow(1), written[0]);
        assert.deepEqual(replayed.result, Success([2, 3]));
        assert.deepEqual(replayed.unreached, []);
        assert.deepEqual(calls, { a: 1, b: 1 }, 'the replay executed nothing');
    });
});

describe('examples/opentelemetry-example.js', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

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
        const { result: replayed } = await replayEffect(flow({ id: 1 }), trace);
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
    beforeEach(() => configureEffect());

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
        for (const meta of /** @type {any[]} */ (['a string', 42, null, { name: 7 }, { name: '' }])) {
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

        const { result: replayed } = await replayEffect(flow({ id: 'x1' }), trace);
        assert.equal(replayed.type, 'Success', 'replay matching lines up on meta.name');
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

describe('initialInput stamping', function () {
    beforeEach(() => configureEffect());

    const input = { customerId: 'cu1', password: 'hunter2' };
    /** @param {string} id */
    const lookup = (id) =>
        Command(
            () => ({ id }),
            (/** @type {any} */ r) => Success(r),
            { name: 'cmdLookup' }
        );

    /** What a hook-based recorder stores as the trace's input: the root node's stamp. */
    const rootStampSeenByHook = async (/** @type {any} */ tree) => {
        /** @type {any} */
        let seen;
        await runEffect(tree, {}, { onRun: async (effect, op) => ((seen = effect.initialInput), await op()) });
        return seen;
    };

    it('should stamp the flow input on a root whose first step returns a Retry-headed sub-pipeline', async function () {
        const viaRetry = (/** @type {any} */ i) =>
            effectPipe((/** @type {string} */ id) => Retry(lookup(id), { attempts: 0 }))(i.customerId);
        const tree = effectPipe(viaRetry, (/** @type {any} */ r) => Success(r))(input);
        assert.deepEqual(tree.initialInput, input, 'the flow input, not the sub-pipeline input');
        assert.deepEqual(await rootStampSeenByHook(tree), input);
    });

    it('should stamp the flow input on a root whose first step returns a Parallel-headed sub-pipeline', async function () {
        const viaParallel = (/** @type {any} */ i) =>
            effectPipe((/** @type {string} */ id) => Parallel([lookup(id)]))(i.customerId);
        const tree = effectPipe(viaParallel, (/** @type {any} */ r) => Success(r))(input);
        assert.deepEqual(tree.initialInput, input);
        assert.deepEqual(await rootStampSeenByHook(tree), input);
    });

    it('should give a Failure from inside a sub-pipeline the flow input', async function () {
        const inner = (/** @type {any} */ i) => effectPipe(lookup, () => Failure('bad'))(i.customerId);
        const result = await runEffect(effectPipe(inner, (/** @type {any} */ r) => Success(r))(input));
        assert.deepEqual(result, Failure('bad', input));
    });

    it('should give a synchronous Failure from a nested pure step the flow input', function () {
        const inner = (/** @type {any} */ i) =>
            effectPipe((/** @type {string} */ id) => Failure(`no ${id}`))(i.customerId);
        assert.deepEqual(
            effectPipe(inner)(input),
            Failure('no cu1', input),
            'the README idiom holds through a sub-pipeline'
        );
    });

    it('should let the outermost pipeline win through two levels of nesting', async function () {
        const innermost = (/** @type {string} */ id) => effectPipe(lookup, () => Failure('deep'))(id);
        const middle = (/** @type {any} */ i) => effectPipe(innermost)(i.customerId);
        const tree = effectPipe(middle)(input);
        assert.deepEqual(tree.initialInput, input);
        const result = await runEffect(tree);
        assert.deepEqual(result, Failure('deep', input));
    });

    it('should give a Failure escaping a Parallel branch the flow input', async function () {
        // chain wraps continuations, not the subtrees a Parallel holds, so only the interpreter can
        // stamp what a branch hands back.
        const failingSub = (/** @type {any} */ i) => effectPipe(lookup, () => Failure('bad'))(i.customerId);
        const result = await runEffect(
            effectPipe(
                (/** @type {any} */ i) => Parallel([failingSub(i)]),
                (/** @type {any} */ v) => Success(v)
            )(input)
        );
        assert.deepEqual(result, Failure('bad', input));
    });

    it('should give a Failure from a Retry fallback the flow input', async function () {
        const failingSub = (/** @type {any} */ i) => effectPipe(lookup, () => Failure('bad'))(i.customerId);
        const withFallback = (/** @type {any} */ i) =>
            Retry(
                Command(() => {
                    throw new Error('down');
                }),
                { attempts: 0, delay: 0, onExhausted: () => failingSub(i) }
            );
        const result = await runEffect(effectPipe(withFallback, (/** @type {any} */ v) => Success(v))(input));
        assert.deepEqual(result, Failure('bad', input));
    });

    it('should give a thrown Command inside a Parallel branch the flow input', async function () {
        const boom = new Error('boom');
        const branch = (/** @type {any} */ i) =>
            effectPipe(() =>
                Command(() => {
                    throw boom;
                })
            )(i.customerId);
        const result = await runEffect(
            effectPipe(
                (/** @type {any} */ i) => Parallel([branch(i)]),
                (/** @type {any} */ v) => Success(v)
            )(input)
        );
        assert.deepEqual(result, Failure(boom, input));
    });

    it('should leave a bare sub-pipeline stamped with its own input when it is the flow', function () {
        // Nothing outer exists here, so the value is what this pipeline was called with.
        const tree = effectPipe(lookup, () => Failure('bad'))('cu1');
        assert.equal(tree.initialInput, 'cu1');
    });
});

describe('Kleisli laws', function () {
    // `Success` is `pure` and the internal `chain` is `bind`, so `effectPipe` is Kleisli composition.
    // The three monad laws are pinned here in that form and observationally, through `runEffect`, because
    // two law-equivalent trees hold different `next` closures and can never be structurally equal. Each
    // law is checked against a step that reaches every node type, so a `chain` case that stops wrapping
    // its continuation fails here rather than only in whichever flow happens to exercise it.
    beforeEach(() => configureEffect());

    const context = { bonus: 5 };
    /** @type {string[]} */
    let calls = [];
    beforeEach(() => (calls = []));

    /** @param {number} x */
    const double = (x) =>
        Command(async function cmdDouble() {
            calls.push(`double:${x}`);
            return x * 2;
        });
    /** @param {number} x */
    const addBonus = (x) => Ask((/** @type {any} */ ctx) => Success(x + ctx.bonus));
    /** @param {number} x */
    const guarded = (x) =>
        x > 100
            ? Failure('too big')
            : Parallel(
                  [
                      Success(x),
                      Command(async function cmdEcho() {
                          calls.push(`echo:${x}`);
                          return x;
                      })
                  ],
                  (/** @type {number[]} */ [a, b]) => Success(a + b)
              );
    /** @param {number} x */
    const retried = (x) =>
        Retry(
            Command(async function cmdIncrement() {
                calls.push(`increment:${x}`);
                return x + 1;
            }),
            { attempts: 2, delay: 0 }
        );
    const steps = [double, addBonus, guarded, retried];
    const inputs = [1, 10, 60];

    /** Runs a flow and returns its outcome together with the I/O it performed, so equivalence covers both. */
    const observe = async (/** @type {(x: number) => any} */ flow, /** @type {number} */ x) => {
        calls = [];
        const result = await runEffect(flow(x), context);
        return { result, calls };
    };

    /** Asserts two flows are indistinguishable through the interpreter on every input. */
    const assertEquivalent = async (
        /** @type {(x: number) => any} */ left,
        /** @type {(x: number) => any} */ right,
        /** @type {string} */ law
    ) => {
        for (const x of inputs) {
            assert.deepEqual(await observe(left, x), await observe(right, x), `${law} on input ${x}`);
        }
    };

    it('should satisfy left identity: pure >=> f is f', async function () {
        for (const f of steps)
            await assertEquivalent(effectPipe(Success, f), effectPipe(f), `left identity for ${f.name}`);
    });

    it('should satisfy right identity: f >=> pure is f', async function () {
        for (const f of steps)
            await assertEquivalent(effectPipe(f, Success), effectPipe(f), `right identity for ${f.name}`);
    });

    it('should satisfy associativity: (f >=> g) >=> h is f >=> (g >=> h) across every node type', async function () {
        const triples = [
            [double, addBonus, guarded],
            [addBonus, retried, guarded],
            [retried, double, addBonus],
            [guarded, retried, double]
        ];
        for (const [f, g, h] of triples) {
            await assertEquivalent(
                effectPipe(effectPipe(f, g), h),
                effectPipe(f, effectPipe(g, h)),
                `associativity for ${f.name}, ${g.name}, ${h.name}`
            );
        }
    });

    it('should compose through every node type to the value the steps compute by hand', async function () {
        // The laws above are equations between two compositions, so a `bind` that dropped every
        // continuation would still satisfy them, both sides being equally broken. This anchors them:
        // one composition through every node type has to reach the value and perform the I/O that
        // applying the steps one after another would.
        const result = await observe(effectPipe(double, addBonus, retried, guarded), 10);
        assert.deepEqual(result, {
            result: Success(52),
            calls: ['double:10', 'increment:25', 'echo:26']
        });
    });

    it('should short-circuit lawfully: a Failure ignores every later step', async function () {
        // The Either half of the structure: bind on the failed case is constant, so composing anything
        // after a Failure changes neither the outcome nor the I/O performed.
        const fail = () => Failure('stop');
        await assertEquivalent(
            effectPipe(double, fail, retried, guarded),
            effectPipe(double, fail),
            'failure absorption'
        );
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

    it('should not stop an in-flight Command whose thunk ignores the signal', async function () {
        // Pinned deliberately: cancellation is cooperative. The sibling's write is already in flight
        // inside the branch's first Command, and a thunk that ignores its signal cannot be interrupted,
        // so the write still lands. What cancellation does buy is in the suite below: no *later*
        // Command in that branch starts, and a thunk that honours the signal is cut off.
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
        assert.deepEqual(written, ['wrote'], 'an uninterruptible in-flight write still performed');
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
        const e = await errorFrom(() => runEffect(effectPipe(/** @type {any} */ (ensureEmailAvailable))({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /returned undefined, which usually means a missing return/);
    });

    it('should reject a Command continuation that returns nothing at the end of a pipeline', async function () {
        // The last step's continuation is reached only through effectPipe's identity pass, which routes it
        // back through `chain`. Without a guard there, `undefined.type` threw a bare TypeError inside the
        // interpreter's try block and the run resolved to a domain Failure carrying it, so the flow bug
        // took the business-error branch and no step was named.
        const e = await errorFrom(() =>
            runEffect(
                effectPipe((/** @type {any} */ x) =>
                    Command(
                        function cmdRead() {
                            return x;
                        },
                        /** @type {any} */ (() => undefined)
                    )
                )(5)
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /A continuation returned undefined, which usually means a missing return/);
    });

    it('should reject a Command continuation that returns nothing in the middle of a pipeline', async function () {
        const e = await errorFrom(() =>
            runEffect(
                effectPipe(
                    (/** @type {any} */ x) =>
                        Command(
                            function cmdRead() {
                                return x;
                            },
                            /** @type {any} */ (() => undefined)
                        ),
                    (/** @type {any} */ y) => Success(y)
                )(5)
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /A continuation returned undefined/);
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
        const result = await runEffect(
            Command(function cmdRecordArgs() {
                args.push([...arguments]);
                return 'done';
            })
        );
        assert.equal(result.type, 'Success');
        assert.deepEqual(args, [[]], 'a thunk outside a Parallel is called with no arguments at all');
    });
});

describe('Declaration parity', function () {
    it('should declare exactly the exports the runtime ships', function () {
        // index.d.ts is hand-maintained beside index.js, so the two can drift silently: a
        // declaration once vanished as edit collateral while every check stayed green. This pins
        // existence in both directions; signatures remain tsd's job.
        const program = ts.createProgram(['index.d.ts'], { noEmit: true });
        const source = program.getSourceFile('index.d.ts');
        assert.ok(source, 'index.d.ts must be part of the program');
        const checker = program.getTypeChecker();
        const moduleSymbol = checker.getSymbolAtLocation(/** @type {import('typescript').Node} */ (source));
        assert.ok(moduleSymbol, 'index.d.ts must be a module');
        const declared = checker
            .getExportsOfModule(moduleSymbol)
            .filter((s) => s.flags & ts.SymbolFlags.Value)
            .map((s) => s.name)
            .sort();
        const shipped = Object.keys(lib).sort();
        assert.deepEqual(declared, shipped);
    });
});

describe('README examples', function () {
    // The README is code readers copy, and for most of this project's life no test ran it. Two wrong
    // examples shipped that way. A guard whose `next` returned `Success(true)`, so the flow saved
    // `true` and never saw the registration data. And a walk that fed a found user to the email
    // guard, then asserted the save step that answer makes unreachable. Both read correctly, which
    // is the whole point: the library's argument is that reading is not verification, and the
    // examples were the one artifact here it had never been applied to. So they are executed. Every
    // `js` block runs as one program with the Quick Start's definitions in scope, which makes every
    // `assert` the README prints a real assertion.
    const markdown = readFileSync('README.md', 'utf8');
    const blocks = [...markdown.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
        .filter((match) => match[1] === 'js')
        .map((match) => match[2]);
    const withoutImports = (/** @type {string} */ code) => code.replace(/^import[^;]*;\s*$/gm, '');
    const AsyncFunction = /** @type {any} */ (Object.getPrototypeOf(async function () {}).constructor);

    beforeEach(function () {
        configureEffect();
    });

    // The Recording and API Reference sections call `configureEffect` themselves, so this suite
    // has to clean up after the examples as well as before them.
    afterEach(function () {
        configureEffect();
    });

    it('should find the examples at all', function () {
        // A regex that silently stops matching would turn every check below into a pass over
        // nothing, which is the failure this whole suite exists to rule out.
        assert.ok(blocks.length >= 20, `expected the README to hold examples, found ${blocks.length}`);
    });

    it('should fence only real JavaScript as js', function () {
        blocks.forEach((block, index) => {
            assert.doesNotThrow(
                () => new AsyncFunction(withoutImports(block)),
                `js block ${index + 1} does not parse; fence a value shape as text instead`
            );
        });
    });

    it('should import only names the library exports', function () {
        const shipped = Object.keys(lib);
        const imports = [...markdown.matchAll(/import\s*\{([^}]*)\}\s*from\s*'pure-effect'/g)];
        assert.ok(imports.length > 0, 'expected the README to import from the package');
        imports.forEach((match) => {
            match[1]
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean)
                .forEach((name) => {
                    assert.ok(shipped.includes(name), `README imports '${name}', which the library does not export`);
                });
        });
    });

    it('should run every example, assertions included, without performing I/O', async function () {
        // The first block is the Quick Start, whose definitions the later examples use. Every other
        // block gets its own scope so two sections can name the same helper without colliding.
        const program =
            withoutImports(blocks[0]) +
            '\n' +
            blocks
                .slice(1)
                .map((block) => `{\n${withoutImports(block)}\n}`)
                .join('\n');

        // Everything the examples reach for that is not the library. These exist so the flows can be
        // built and walked, not to stand in for a real driver: every assertion the README makes is
        // about a value the library itself produced. `fetch` throws rather than resolving, so an
        // example that starts reaching the network fails here instead of in CI.
        const stubCommand = () =>
            Command(function cmdStub() {
                return Promise.resolve({});
            });
        const stubs = {
            input: { email: 'test@test.com', password: 'password123' },
            db: { findUser: async () => null, saveUser: async (/** @type {any} */ user) => user },
            app: { post: () => {} },
            it: () => {},
            fetch: () => {
                throw new Error('a README example must not perform network I/O');
            },
            checkoutFlow: stubCommand,
            chargeCard: stubCommand,
            sendReceipt: stubCommand,
            validateOrder: stubCommand,
            scheduleShipping: stubCommand,
            cmdFn: () => Promise.resolve({}),
            next: Success,
            order: { id: 'order_1' },
            sink: () => {},
            telemetryHooks: () => ({}),
            recordingHooks: () => ({})
        };

        const log = console.log;
        console.log = () => {}; // timeTravel narrates, and that is its job rather than this suite's
        try {
            const run = new AsyncFunction(...Object.keys(lib), 'assert', ...Object.keys(stubs), program);
            await run(...Object.values(lib), assert, ...Object.values(stubs));
        } finally {
            console.log = log;
        }
    });
});
