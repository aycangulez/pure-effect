// @ts-check

import { commandName } from './index.js';

/** @import { Replay, ReplayOutcome, ReplayStep, Resolver } from "./index.js" */

/**
 * Helpers for testing flows with any test runner: `assertStep` and `assertCommand` walk a flow one step at a time,
 * `answers` builds the Resolver that runs a whole flow under `replayEffect` with no I/O, and `assertReproduced`
 * checks that a replay of a recorded run did what the run did.
 */

/**
 * An answer in an `answers` table: an outcome given every time the Command is asked, a list of outcomes given in
 * turn, or a function that gets the step and returns an outcome, or `undefined` for one it has no answer for.
 * @typedef {ReplayOutcome | ReplayOutcome[] | ((step: ReplayStep) => ReplayOutcome | undefined)} Answer
 */

/**
 * The Resolver `answers` returns, which also reports the answers a replay never asked for.
 * @typedef {Resolver & { unused: () => string[] }} AnswerResolver
 */

/**
 * Whether a value is exactly one outcome, `{ result }` or `{ error }`. An object holding both, or anything else,
 * is a mistake in the table rather than an answer.
 * @param {unknown} value
 * @returns {boolean}
 */
const isOutcome = (value) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    ('result' in value || 'error' in value);

/**
 * Describes a step, or whatever was found in its place, for an assertion message. A Failure shows its error,
 * since why a flow stopped is usually the answer to a failing walk.
 * @param {any} step
 * @returns {string}
 */
const describeStep = (step) => {
    if (step?.type === 'Failure') {
        const { error } = step;
        return `Failure(${error instanceof Error ? `${error.name}: ${error.message}` : JSON.stringify(error)})`;
    }
    if (step?.type === 'Command') return `Command '${commandName(step)}'`;
    if (typeof step?.type === 'string') return step.type;
    return String(step);
};

/**
 * An error shaped like `node:assert`'s, built without importing it, so the helpers run anywhere and every test
 * runner shows `expected` and `actual`.
 * @param {string} message
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {Error}
 */
const assertionError = (message, actual, expected) =>
    Object.assign(new Error(message), { name: 'AssertionError', actual, expected, operator: 'strictEqual' });

/**
 * Checks that a step is of the given type and returns it, typed as that kind of step. Otherwise throws an
 * `AssertionError` naming what it found.
 * @template {{ type: string }} S
 * @template {S['type']} K
 * @param {S | undefined} step
 * @param {K} type
 * @returns {Extract<S, { type: K }>}
 */
export function assertStep(step, type) {
    if (step?.type !== type) {
        throw assertionError(`Expected a ${type}, got ${describeStep(step)}.`, describeStep(step), type);
    }
    return /** @type {Extract<S, { type: K }>} */ (step);
}

/**
 * Checks that a step is the Command with the given name and returns it, typed as a Command. Otherwise throws an
 * `AssertionError` naming what it found.
 * @template {{ type: string }} S
 * @param {S | undefined} step
 * @param {string} name
 * @returns {Extract<S, { type: 'Command' }>}
 */
export function assertCommand(step, name) {
    // Only a Command is described as one, so comparing descriptions checks the type and the name at once.
    const expected = `Command '${name}'`;
    const actual = describeStep(step);
    if (actual !== expected) throw assertionError(`Expected ${expected}, got ${actual}.`, actual, expected);
    return /** @type {Extract<S, { type: 'Command' }>} */ (step);
}

/**
 * Shows a value in an assertion message, on one line.
 * @param {unknown} value
 * @returns {string}
 */
const shown = (value) => {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

/**
 * Checks that a replay of a trace reproduced the recorded run, and returns its result: it stopped at no
 * `TimeParadox` or `ReplayError`, asked for every recorded step, and ended as the trace recorded. A trace recorded
 * without `recordOutcome` fails it, since nothing says how the run ended. Otherwise throws an `AssertionError`
 * naming the first thing that differs.
 * @template T, E
 * @param {Replay<T, E>} replay - What `replayEffect` or `timeTravel` returned for a trace
 * @returns {Replay<T, E>['result']}
 */
export function assertReproduced(replay) {
    const { result, unreached, changed } = replay ?? {};
    if (!Array.isArray(unreached)) {
        throw new TypeError(
            `assertReproduced takes what replayEffect returns for a trace, got ${shown(replay)}. A replay from a ` +
                'Resolver has nothing recorded to compare with.'
        );
    }
    const fault = result?.type === 'Failure' && result.error instanceof Error ? result.error : undefined;
    if (fault?.name === 'TimeParadox' || fault?.name === 'ReplayError') {
        const message = `Expected the replay to reproduce the run, but it stopped: ${fault.name}: ${fault.message}`;
        throw assertionError(message, fault.name, 'no replay fault');
    }
    if (unreached.length > 0) {
        const names = unreached.map((entry) => entry.command).join(', ');
        const message = `Expected the replay to reproduce the run, but it never asked for recorded steps: ${names}.`;
        throw assertionError(message, names, 'none');
    }
    if (changed === undefined) {
        throw assertionError(
            'Expected the replay to reproduce the run, but the trace holds no outcome to compare with: it was ' +
                'recorded with recordOutcome: false, or its outcome could not be recorded.',
            undefined,
            'a recorded outcome'
        );
    }
    if (changed !== null) {
        const { path, recorded, replayed } = changed;
        const message =
            `Expected the replay to end as the run did, but it differs at ${path}: recorded ${shown(recorded)}, ` +
            `replayed ${shown(replayed)}.`;
        throw assertionError(message, replayed, recorded);
    }
    return /** @type {Replay<T, E>['result']} */ (result);
}

/**
 * Builds a Resolver for `replayEffect` from a table keyed by Command name. A Command the table does not name gets
 * `undefined`, which ends the replay with a `ReplayError`. A Parallel asks about its decision under the name
 * 'Parallel', which a table leaves out, so its branches run as written. The table is copied, so a list used up in one
 * test is whole in the next, and an entry of any other shape throws a `TypeError` here rather than surfacing later
 * as a confusing replay.
 * @param {Readonly<Record<string, Answer>>} table
 * @returns {AnswerResolver}
 */
export function answers(table) {
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
        throw new TypeError(`answers takes an object keyed by Command name, got ${describeStep(table)}.`);
    }
    /** @type {Map<string, Answer>} */
    const entries = new Map();
    for (const [name, entry] of Object.entries(table)) {
        const valid =
            typeof entry === 'function' ||
            isOutcome(entry) ||
            (Array.isArray(entry) && entry.length > 0 && entry.every(isOutcome));
        if (!valid) {
            throw new TypeError(
                `answers: '${name}' must be { result }, { error }, a non-empty list of them, or a function; got ` +
                    `${JSON.stringify(entry)}. Wrap a plain value as { result: value }.`
            );
        }
        entries.set(name, Array.isArray(entry) ? [...entry] : entry);
    }
    /** The names a replay asked for, so `unused` can report the rest. */
    const asked = new Set();
    /** @type {Resolver} */
    const resolve = (step) => {
        asked.add(step.name);
        const entry = entries.get(step.name);
        if (typeof entry === 'function') return entry(step);
        if (Array.isArray(entry)) return entry.shift();
        return entry;
    };
    /** Each answer the replay never asked for: an entry never reached, or a list not used up. */
    const unused = () =>
        [...entries].flatMap(([name, entry]) => {
            if (!asked.has(name)) return [`${name}: never asked for`];
            if (!Array.isArray(entry) || entry.length === 0) return [];
            return [`${name}: ${entry.length} of ${/** @type {unknown[]} */ (table[name]).length} answers left`];
        });
    return Object.assign(resolve, { unused });
}
