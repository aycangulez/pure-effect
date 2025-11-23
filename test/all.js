import { strict as assert } from 'assert';
import { Success, Failure, Command, effectPipe, runEffect } from '../index.js';

const db = {
    users: new Map(),
    async findUserByEmail(email) {
        return this.users.get(email) || null;
    },
    async saveUser(user) {
        const u = { id: Date.now(), ...user };
        this.users.set(user.email, u);
        return u;
    },
};

function validateRegistration(input) {
    const { email, password } = input;
    if (!email?.includes('@')) {
        return Failure('Invalid email format.');
    }
    if (password?.length < 8) {
        return Failure('Password must be at least 8 characters long.');
    }
    return Success(input);
}

function findUserByEmail(email) {
    const cmdFindUser = () => db.findUserByEmail(email);
    const next = (foundUser) => Success(foundUser);
    return Command(cmdFindUser, next);
}

function ensureEmailIsAvailable(foundUser) {
    return foundUser ? Failure('Email already in use.') : Success(true);
}

function saveUser(input) {
    const { email, password } = input;
    const hashedPassword = `hashed_${password}`;
    const userToSave = { email, password: hashedPassword };
    const cmdSaveUser = () => db.saveUser(userToSave);
    const next = (savedUser) => Success(savedUser);
    return Command(cmdSaveUser, next);
}

const registerUserFlow = (input) =>
    effectPipe(
        validateRegistration,
        () => findUserByEmail(input.email),
        ensureEmailIsAvailable,
        () => saveUser(input)
    )(input);

async function registerUser(input) {
    return await runEffect(registerUserFlow(input));
}

describe('Pure Effect', function () {
    it('should return Failure when e-mail is invalid', async function () {
        const input = { email: 'bad-email', password: '123' };
        const effect = await registerUser(input);
        assert.deepEqual(effect, Failure('Invalid email format.'));
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
});
