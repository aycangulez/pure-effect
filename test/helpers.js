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
    return await runEffect(registerUserFlow(input), undefined, { flowName: 'registerUser' });
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
 * Imports `source` as a module of a project that installs this library, from a directory whose node_modules holds the
 * repository under its package name, so imports resolve through package.json's `exports` as a user's would.
 * @param {string} source
 * @returns {Promise<any>}
 */
export const importInProject = async (source) => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const project = mkdtempSync(join(tmpdir(), 'pure-effect-project-'));
    try {
        mkdirSync(join(project, 'node_modules'));
        symlinkSync(repo, join(project, 'node_modules', 'pure-effect'), 'dir');
        writeFileSync(join(project, 'package.json'), '{ "type": "module" }');
        writeFileSync(join(project, 'main.js'), source);
        return await import(pathToFileURL(join(project, 'main.js')).href);
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
};

/** The options of a strict TypeScript project with `exactOptionalPropertyTypes` on, which `jsconfig.json` leaves off. */
const strictProject = {
    allowJs: true,
    checkJs: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
};

/** @param {import('typescript').Program} program */
const typeErrorsOf = (program) =>
    ts.getPreEmitDiagnostics(program).map((d) => {
        const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const at = where ? `${d.file?.fileName}:${where.line + 1}: ` : '';
        return at + ts.flattenDiagnosticMessageText(d.messageText, ' ');
    });

/**
 * The type errors a JavaScript file that ships raises in a strict TypeScript project.
 * @param {string} path - The file's path from the repository root, such as 'flight-recorder.js'
 * @returns {string[]}
 */
export const jsTypeErrors = (path) => typeErrorsOf(ts.createProgram([path], strictProject));

/**
 * The type errors a strict TypeScript project gets from `files`, each a file at the repository root, so it can import
 * the library or an example as a project that copied it would. One program checks them all.
 * @param {Record<string, string>} files - Each file's source, by its name
 * @param {import('typescript').CompilerOptions} [options] - Options that differ from the strict project's
 * @returns {string[]}
 */
export const consumerFilesTypeErrors = (files, options = {}) => {
    const project = { ...strictProject, ...options };
    const host = ts.createCompilerHost(project);
    const { getSourceFile, fileExists } = host;
    host.getSourceFile = (name, ...rest) =>
        name in files
            ? ts.createSourceFile(name, files[name], ts.ScriptTarget.ES2022)
            : getSourceFile.call(host, name, ...rest);
    host.fileExists = (name) => name in files || fileExists.call(host, name);
    return typeErrorsOf(ts.createProgram(Object.keys(files), project, host));
};

/**
 * The type errors a strict TypeScript project gets from `source`, a file at the repository root, so it can import
 * an example as a project that copied it would.
 * @param {string} source
 * @returns {string[]}
 */
export const consumerTypeErrors = (source) => consumerFilesTypeErrors({ 'consumer.ts': source });
