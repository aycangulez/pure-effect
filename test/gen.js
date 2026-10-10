// @ts-check

import { strict as assert } from 'assert';
import { inspect } from 'node:util';
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
    recordEffect,
    replayEffect,
    commandName,
    step
} from '../index.js';

// Untyped, for the tests that make a mistake on purpose, which the declarations refuse.
const looseStep = /** @type {(effect: any) => any} */ (step);

/**
 * The message a call throws, or rejects with.
 * @param {() => unknown} fn
 * @returns {Promise<string>}
 */
const messageOf = async (fn) => {
    try {
        await fn();
    } catch (e) {
        return /** @type {Error} */ (e).message;
    }
    return 'nothing was thrown';
};

describe('step', function () {
    beforeEach(() => configureEffect());

    it('should refuse anything but an Effect, naming a Promise as a call to put in a Command', async function () {
        assert.match(await messageOf(() => looseStep(42)), /step expects an Effect, got the number 42/);
        assert.match(await messageOf(() => looseStep(Promise.resolve(1))), /put the call in a Command/);
    });

    it('should throw when a step is used as a value', async function () {
        const s = looseStep(Command(function cmdFindUser() {}));
        const uses = [
            () => s.id,
            () => `${s}`,
            () => JSON.stringify(s),
            () => Promise.resolve(s),
            () => ({ ...s }),
            () => 'id' in s,
            () => Object.keys(s)
        ];
        for (const use of uses) {
            assert.match(await messageOf(use), /step\(Command 'cmdFindUser'\) was used as a value/);
        }
    });

    it("should throw when a step's iterator is used outside yield*", async function () {
        const s = looseStep(Success(1));
        const iterations = [
            () => [...s],
            () => Array.from(s),
            () => {
                const [first] = s;
                return first;
            },
            () => {
                for (const _ of s) break;
            }
        ];
        for (const iterate of iterations) {
            assert.match(await messageOf(iterate), /was iterated outside yield\*/);
        }
    });

    it('should print a hint when logged', function () {
        assert.equal(
            inspect(step(Command(function cmdFindUser() {}))),
            "[step: Command 'cmdFindUser', use with yield*]"
        );
    });

    it('should reject the run rather than retry when a step is used as a value inside a Command', async function () {
        let tries = 0;
        const flow = Retry(
            Command(function cmdMisuse() {
                tries++;
                return looseStep(Success(1)).id;
            }),
            { attempts: 2, delay: 0 }
        );
        await assert.rejects(runEffect(flow), /was used as a value/);
        assert.equal(tries, 1);
    });
});
