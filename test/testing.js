// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Retry,
    Parallel,
    effectPipe,
    effectGen,
    step,
    configureEffect,
    recordEffect,
    replayEffect
} from '../index.js';
import { answers, assertCommand, assertReproduced, assertStep } from '../testing.js';
import { registerUserFlow, valueOf, errorOf } from './helpers.js';

/** @import { User } from "./helpers.js" */

const input = { email: 'test@test.com', password: 'password123' };
const saved = { id: 1, ...input };

/** A Command that must never run: every test here answers it. */
const unreachable = (/** @type {string} */ name) => () => {
    throw new Error(`${name} ran for real`);
};

/** One Parallel branch per zone, each fetching and storing a forecast under the same Command names. */
const forecastFlow = effectPipe(
    () => Command(unreachable('cmdLoadZones'), { name: 'cmdLoadZones' }),
    (/** @type {string[]} */ zones) =>
        Parallel(
            zones.map((zone) =>
                effectPipe(
                    () =>
                        Retry(Command(unreachable('cmdFetchForecast'), { name: 'cmdFetchForecast' }), { delay: 1000 }),
                    (/** @type {number[]} */ hours) =>
                        Command(unreachable('cmdStoreForecast'), () => Success({ zone, hours: hours.length }), {
                            name: 'cmdStoreForecast'
                        })
                )(zone)
            ),
            { limit: 2, settled: true }
        )
);

describe('pure-effect/testing', function () {
    beforeEach(() => configureEffect());

    describe('assertStep and assertCommand', function () {
        it('should return the step they checked, so a walk continues from it', function () {
            const found = assertCommand(registerUserFlow(input), 'cmdFindUser');
            const saving = assertCommand(found.next(null), 'cmdSaveUser');
            assert.deepEqual(assertStep(saving.next(saved), 'Success'), Success(saved));
        });

        it("should throw an error shaped like node:assert's, naming the Failure a walk stopped at", function () {
            const found = assertCommand(registerUserFlow(input), 'cmdFindUser');
            assert.throws(() => assertCommand(found.next({ id: 9 }), 'cmdSaveUser'), {
                name: 'AssertionError',
                message: `Expected Command 'cmdSaveUser', got Failure("Email already in use.").`,
                actual: 'Failure("Email already in use.")',
                expected: "Command 'cmdSaveUser'",
                operator: 'strictEqual'
            });
        });

        it('should name a Command by its name and an Error by its message', function () {
            assert.throws(() => assertCommand(registerUserFlow(input), 'cmdSaveUser'), {
                message: "Expected Command 'cmdSaveUser', got Command 'cmdFindUser'."
            });
            assert.throws(
                () => assertStep(/** @type {{ type: string }} */ (Failure(new TypeError('bad row'))), 'Success'),
                {
                    message: 'Expected a Success, got Failure(TypeError: bad row).'
                }
            );
            assert.throws(() => assertStep(undefined, 'Command'), { message: 'Expected a Command, got undefined.' });
            const retry = Retry(Command(unreachable('cmdSaveUser'), { name: 'cmdSaveUser' }));
            assert.throws(() => assertCommand(retry, 'cmdSaveUser'), {
                message: "Expected Command 'cmdSaveUser', got Retry."
            });
            assertCommand(assertStep(retry, 'Retry').effect, 'cmdSaveUser');
        });
    });

    describe('answers', function () {
        it('should answer each Command by name, an outcome every time and a list in turn', async function () {
            const answer = answers({
                cmdFindUser: { result: null },
                cmdSaveUser: [{ error: new Error('connection reset') }, { result: saved }]
            });
            const saveWithRetry = (/** @type {User} */ user) =>
                effectPipe(
                    () => Command(unreachable('cmdFindUser'), { name: 'cmdFindUser' }),
                    () => Retry(Command(unreachable('cmdSaveUser'), { name: 'cmdSaveUser' }), { delay: 1000 })
                )(user);
            const started = Date.now();
            const { result } = await replayEffect(saveWithRetry(input), answer);
            assert.deepEqual(result, Success(saved));
            assert.ok(Date.now() - started < 500, 'a replay from answers waits for no retry');
            assert.deepEqual(answer.unused(), []);
        });

        it('should hand a function entry the step, with the branch it is in at each Parallel', async function () {
            const zones = ['nyc-1', 'nyc-2', 'nyc-3'];
            const e503 = { error: new Error('HTTP 503') };
            /** @type {({ result: number[] } | { error: Error })[][]} */
            const forecasts = [[{ result: [1, 2, 3] }], [e503, e503, e503, e503], [e503, { result: [4, 5] }]];
            /** @type {(readonly number[])[]} */
            const seen = [];
            const answer = answers({
                cmdLoadZones: { result: zones },
                cmdFetchForecast: (asked) => {
                    seen.push(asked.branches);
                    return forecasts[asked.branches[0]].shift();
                },
                cmdStoreForecast: { result: undefined }
            });
            const { result } = await replayEffect(forecastFlow(undefined), answer);
            const outcomes = valueOf(result);
            assert.deepEqual(outcomes[0], Success({ zone: 'nyc-1', hours: 3 }));
            assert.equal(errorOf(outcomes[1]).lastError.message, 'HTTP 503');
            assert.deepEqual(outcomes[2], Success({ zone: 'nyc-3', hours: 2 }));
            assert.equal(seen.length, 1 + 4 + 2);
            assert.deepEqual(answer.unused(), []);
        });

        it('should leave a Command it does not name to the replay, which stops with a ReplayError', async function () {
            const { result } = await replayEffect(registerUserFlow(input), answers({ cmdFindUser: { result: null } }));
            assert.equal(errorOf(result).name, 'ReplayError');
            assert.match(errorOf(result).message, /no answer for 'cmdSaveUser'/);
        });

        it('should copy the table, so a list used up in one replay is whole in the next', async function () {
            const table = { cmdFindUser: { result: null }, cmdSaveUser: [{ result: saved }] };
            for (let run = 0; run < 2; run++) {
                const { result } = await replayEffect(registerUserFlow(input), answers(table));
                assert.deepEqual(result, Success(saved));
            }
            assert.equal(table.cmdSaveUser.length, 1);
        });

        it('should refuse an entry of any other shape as the table is built, naming it', function () {
            assert.throws(() => answers({ cmdFindUser: /** @type {any} */ (null) }), {
                name: 'TypeError',
                message:
                    /answers: 'cmdFindUser' must be \{ result \}, \{ error \}.*got null\. Wrap a plain value as \{ result: value \}\./
            });
            for (const entry of [{ id: 1 }, { result: 1, error: 2 }, [], [{ result: 1 }, 2], 'saved', 'r', 7]) {
                assert.throws(
                    () => answers({ cmdSaveUser: /** @type {any} */ (entry) }),
                    /answers: 'cmdSaveUser' must be/
                );
            }
            for (const table of [null, [], 'cmdFindUser']) {
                assert.throws(
                    () => answers(/** @type {any} */ (table)),
                    /answers takes an object keyed by Command name/
                );
            }
        });

        it('should report what the replay never asked for, or did not use up', async function () {
            const answer = answers({
                cmdFindUser: { result: { id: 9 } },
                cmdSaveUser: [{ error: new Error('connection reset') }, { result: saved }],
                cmdNeverAsked: () => ({ result: 1 })
            });
            const { result } = await replayEffect(registerUserFlow(input), answer);
            assert.deepEqual(result, Failure('Email already in use.'));
            assert.deepEqual(answer.unused(), ['cmdSaveUser: never asked for', 'cmdNeverAsked: never asked for']);

            const leftover = answers({
                cmdFindUser: { result: null },
                cmdSaveUser: [{ result: saved }, { result: saved }]
            });
            await replayEffect(registerUserFlow(input), leftover);
            assert.deepEqual(leftover.unused(), ['cmdSaveUser: 1 of 2 answers left']);
        });

        it('should answer a generator flow, whose for loop leaves branches empty', async function () {
            const each = effectGen(function* (/** @type {string[]} */ names) {
                /** @type {string[]} */
                const greeted = [];
                for (const name of names) {
                    greeted.push(yield* step(Command(unreachable('cmdGreet'), { name: 'cmdGreet' })));
                }
                return greeted;
            });
            /** @type {(readonly number[])[]} */
            const seen = [];
            const replies = ['hi a', 'hi b'];
            const answer = answers({
                cmdGreet: (asked) => {
                    seen.push(asked.branches);
                    return { result: replies.shift() };
                }
            });
            const { result } = await replayEffect(each(['a', 'b']), answer);
            assert.deepEqual(result, Success(['hi a', 'hi b']));
            assert.deepEqual(seen, [[], []]);
        });
    });

    describe('assertReproduced', function () {
        /** A flow that decides a discount from a recorded order, and returns the decision. */
        const discount = (/** @type {number} */ percent) =>
            effectPipe((/** @type {string} */ id) =>
                Command(
                    function cmdLoadOrder() {
                        return { id, total: 200 };
                    },
                    (/** @type {any} */ order) => Success({ id: order.id, off: (order.total * percent) / 100 })
                )
            );

        it('should return the result of a replay that did what the run did', async function () {
            const { trace } = await recordEffect(discount(10)('o-1'));
            const result = assertReproduced(
                await replayEffect(discount(10)(/** @type {string} */ (trace.initialInput)), trace)
            );
            assert.deepEqual(result, Success({ id: 'o-1', off: 20 }));
        });

        it('should name where the outcome differs, with the values a test runner diffs', async function () {
            const { trace } = await recordEffect(discount(10)('o-1'));
            const replay = await replayEffect(discount(15)(/** @type {string} */ (trace.initialInput)), trace);
            assert.throws(() => assertReproduced(replay), {
                name: 'AssertionError',
                message:
                    'Expected the replay to end as the run did, but it differs at $.value.off: recorded 20, replayed 30.',
                actual: 30,
                expected: 20
            });
        });

        it('should fail a trace that recorded no outcome, rather than pass it unchecked', async function () {
            const { trace } = await recordEffect(discount(10)('o-1'), { recordOutcome: false });
            const replay = await replayEffect(discount(10)(/** @type {string} */ (trace.initialInput)), trace);
            assert.throws(() => assertReproduced(replay), {
                name: 'AssertionError',
                message: /the trace holds no outcome to compare with: it was recorded with recordOutcome: false/
            });
        });

        it('should name a replay fault before anything it left behind', async function () {
            const { trace } = await recordEffect(registerUserFlow(input));
            const reshaped = effectPipe(() => Command(function cmdAudit() {}));
            const replay = await replayEffect(reshaped(input), trace);
            assert.throws(() => assertReproduced(replay), {
                name: 'AssertionError',
                message: /^Expected the replay to reproduce the run, but it stopped: TimeParadox: /
            });
        });

        it('should name the recorded steps a replay never asked for', async function () {
            // A new email, so the recorded run went on to save the user.
            const signup = { email: 'early@test.com', password: 'password123' };
            const { trace } = await recordEffect(registerUserFlow(signup));
            const stopsEarly = effectPipe(() => Command(function cmdFindUser() {}));
            const replay = await replayEffect(stopsEarly(signup), trace);
            assert.throws(() => assertReproduced(replay), {
                name: 'AssertionError',
                message: 'Expected the replay to reproduce the run, but it never asked for recorded steps: cmdSaveUser.'
            });
        });

        it('should refuse what a replay from a Resolver returns, which has nothing recorded to compare', async function () {
            const fromResolver = await replayEffect(Success(1), () => undefined);
            assert.throws(() => assertReproduced(/** @type {any} */ (10n)), { name: 'TypeError', message: /got 10\./ });
            assert.throws(() => assertReproduced(/** @type {any} */ (fromResolver)), {
                name: 'TypeError',
                message: /^assertReproduced takes what replayEffect returns for a trace, got \{"result"/
            });
        });
    });
});
