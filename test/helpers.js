// @ts-check

// What the test files share: the user-registration domain they run on, and helpers for results, recorded flows
// and the examples.

import { Success, Failure, Command, effectPipe, runEffect } from '../index.js';
import ts from 'typescript';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @typedef {{id?: number, email: string, password: string}} User */

export const db = {
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

export function validateRegistration(/** @type {User} */ input) {
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
export function ensureEmailIsAvailable(/** @type {User} */ input) {
    const cmdFindUser = () => db.findUserByEmail(input.email);
    const next = (/** @type {User | null} */ foundUser) =>
        foundUser ? Failure('Email already in use.') : Success(input);
    return Command(cmdFindUser, next);
}

export function saveUser(/** @type {User} */ input) {
    const { email, password } = input;
    const userToSave = { email, password: `hashed_${password}` };
    // No continuation: the saved user passes straight through.
    const cmdSaveUser = () => db.saveUser(userToSave);
    return Command(cmdSaveUser);
}

export const registerUserFlow = (/** @type {User} */ input) =>
    effectPipe(validateRegistration, ensureEmailIsAvailable, saveUser)(input);

export async function registerUser(/** @type {User} */ input) {
    return await runEffect(registerUserFlow(input), { flowName: 'registerUser' });
}

/** Reads `.value` off a runEffect result once its type has been asserted. */
export const valueOf = (/** @type {any} */ result) => result.value;

/** Reads `.error` off a runEffect result once its type has been asserted. */
export const errorOf = (/** @type {any} */ result) => result.error;

/** A registration flow whose Commands count their calls, so a test can assert a replay ran none. */
export const makeFlow = () => {
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

/**
 * Imports an example as a user who copied it into their own project would: from a directory whose node_modules holds
 * this library under its package name, and the example's other dependency.
 * @param {string} file - The example's file name in examples/
 * @returns {Promise<any>}
 */
export const importCopiedExample = async (file) => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const project = mkdtempSync(join(tmpdir(), 'pure-effect-example-'));
    try {
        mkdirSync(join(project, 'node_modules'));
        symlinkSync(repo, join(project, 'node_modules', 'pure-effect'), 'dir');
        symlinkSync(
            join(repo, 'node_modules', '@opentelemetry'),
            join(project, 'node_modules', '@opentelemetry'),
            'dir'
        );
        writeFileSync(join(project, 'package.json'), '{ "type": "module" }');
        copyFileSync(join(repo, 'examples', file), join(project, file));
        return await import(pathToFileURL(join(project, file)).href);
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
};

/**
 * The type errors an example raises in a strict TypeScript project that copied it, with `exactOptionalPropertyTypes`
 * on, which `jsconfig.json` leaves off.
 * @param {string} file - The example's file name in examples/
 * @returns {string[]}
 */
export const exampleTypeErrors = (file) => {
    const program = ts.createProgram([join('examples', file)], {
        allowJs: true,
        checkJs: true,
        strict: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext
    });
    return ts.getPreEmitDiagnostics(program).map((d) => {
        const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const at = where ? `${d.file?.fileName}:${where.line + 1}: ` : '';
        return at + ts.flattenDiagnosticMessageText(d.messageText, ' ');
    });
};
