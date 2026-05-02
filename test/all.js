// @ts-check

import { strict as assert } from 'assert';
import { Success, Failure, Command, Ask, Retry, effectPipe, runEffect, configureEffect } from '../index.js';
import { enableTelemetry } from '../opentelemetry-example.js';

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

function findUserByEmail(/** @type string */ email) {
    const cmdFindUser = () => db.findUserByEmail(email);
    const next = (/** @type {User} */ foundUser) => Success(foundUser);
    return Command(cmdFindUser, next);
}

function ensureEmailIsAvailable(/** @type {User} */ foundUser) {
    return foundUser ? Failure('Email already in use.') : Success(true);
}

function saveUser(/** @type {User} */ input) {
    const { email, password } = input;
    const hashedPassword = `hashed_${password}`;
    const userToSave = { email, password: hashedPassword };
    const cmdSaveUser = () => db.saveUser(userToSave);
    const next = (/** @type {User} */ savedUser) => Success(savedUser);
    return Command(cmdSaveUser, next);
}

const registerUserFlow = (/** @type {User} */ input) =>
    effectPipe(
        validateRegistration,
        () => findUserByEmail(input.email),
        ensureEmailIsAvailable,
        () => saveUser(input)
    )(input);

async function registerUser(/** @type {User} */ input) {
    return await runEffect(registerUserFlow(input), { flowName: 'registerUser' });
}

describe('Pure Effect', function () {
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
                    return /** @type {any} */ (null);
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
        // Per-use: attempts 3 (overrides call-level — should succeed on 3rd try)
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

    it('should return Success after runEffect with telemetry disabled', async function () {
        const input = { email: 'test-no-telemetry@test.com', password: 'password123' };
        const result = await registerUser(input);
        assert.equal(result.type, 'Success');
    });

    it('should return Success after runEffect with telemetry enabled', async function () {
        enableTelemetry();
        const input = { email: 'test-telemetry@test.com', password: 'password123' };
        const result = await registerUser(input);
        assert.equal(result.type, 'Success');
    });
});
