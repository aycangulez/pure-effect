// @ts-check

import { strict as assert } from 'assert';
import { Success, Failure, Command, effectPipe, runEffect, configureEffect } from '../index.js';
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
    },
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
        configureEffect({
            onBeforeCommand: /** @type CommandInterceptor */ async (command, context) =>
                assert.equal(context.env, 'test'),
        });
        const input = { email: 'context@test.com', password: 'password123' };
        const result = await runEffect(registerUserFlow(input), { env: 'test' });
        configureEffect({ onBeforeCommand: undefined });
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
