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
    gen,
    step
} from '../index.js';
import { registerUserFlow, validateRegistration, db } from './helpers.js';

// The same flow as `registerUserFlow`, written as a generator, with the same Command names so the two record the
// same trace.
const registerUserGen = gen(function* (/** @type {import('./helpers.js').User} */ input) {
    yield* step(validateRegistration(input));
    const cmdFindUser = () => db.findUserByEmail(input.email);
    const found = yield* step(Command(cmdFindUser));
    if (found) return Failure('Email already in use.');
    const { email, password } = input;
    const cmdSaveUser = () => db.saveUser({ email, password: `hashed_${password}` });
    return yield* step(Command(cmdSaveUser));
});

// Untyped, for the tests that make a mistake on purpose, which the declarations refuse.
const looseStep = /** @type {(effect: any) => any} */ (step);
const looseGen = /** @type {(body: any) => (input?: any) => any} */ (gen);

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

    it('should accept a node copied with spread', function () {
        const original = Command(function cmdFindUser() {});
        const flow = gen(function* () {
            return yield* step({ ...original, meta: { name: 'renamed' } });
        });
        assert.equal(commandName(/** @type {any} */ (flow(undefined))), 'renamed');
    });
});

describe('gen', function () {
    beforeEach(() => configureEffect());

    describe('building a flow', function () {
        it('should refuse a value that is not a function, and an async generator function', async function () {
            assert.match(await messageOf(() => looseGen(42)), /gen expects a generator function/);
            assert.match(await messageOf(() => looseGen(async function* () {})), /not async function\*/);
        });

        it('should refuse a function that returns no generator, when the flow is built', async function () {
            const flow = looseGen(() => 1);
            assert.match(await messageOf(() => flow()), /its function returned the number 1/);
        });

        it('should run the body up to its first step when the flow is built', function () {
            /** @type {string[]} */
            const seen = [];
            const flow = gen(function* () {
                seen.push('before');
                yield* step(Command(function cmdFirst() {}));
                seen.push('after');
            });
            flow(undefined);
            assert.deepEqual(seen, ['before']);
        });

        it('should return a validation Failure as the flow is built, as the pipeline does', function () {
            const bad = { email: 'bad-email', password: '123' };
            assert.deepEqual(registerUserGen(bad), registerUserFlow(bad));
        });
    });

    describe('what the body returns', function () {
        it('should succeed with a plain value, and with undefined when it returns nothing', async function () {
            assert.deepEqual(
                await runEffect(
                    gen(function* () {
                        return 1;
                    })(undefined)
                ),
                Success(1)
            );
            assert.deepEqual(await runEffect(gen(function* () {})(undefined)), Success(undefined));
        });

        it('should stop with a returned Failure', async function () {
            assert.deepEqual(
                await runEffect(
                    gen(function* () {
                        return Failure('no');
                    })(undefined)
                ),
                Failure('no')
            );
        });

        it('should run a returned Effect, with or without yield*', async function () {
            const cmd = () =>
                Command(function cmdFive() {
                    return 5;
                });
            assert.deepEqual(
                await runEffect(
                    gen(function* () {
                        return cmd();
                    })(undefined)
                ),
                Success(5)
            );
            assert.deepEqual(
                await runEffect(
                    gen(function* () {
                        return yield* step(cmd());
                    })(undefined)
                ),
                Success(5)
            );
        });

        it('should refuse a returned step and a returned Promise', async function () {
            const s = looseStep(Success(1));
            assert.match(
                await messageOf(() =>
                    looseGen(function* () {
                        return s;
                    })()
                ),
                /return yield\* step/
            );
            assert.match(
                await messageOf(() =>
                    looseGen(function* () {
                        return Promise.resolve(1);
                    })()
                ),
                /returned a Promise; put the call in a Command/
            );
        });

        it('should throw from the flow function when the body throws before its first step', async function () {
            const flow = gen(function* () {
                throw new Error('bug');
            });
            assert.match(await messageOf(() => flow(undefined)), /^bug$/);
        });

        it('should reject the run when the body throws after a step', async function () {
            const flow = gen(function* () {
                yield* step(Command(function cmdFirst() {}));
                throw new Error('bug');
            });
            await assert.rejects(runEffect(flow(undefined)), /^Error: bug$/);
        });
    });

    describe('mistakes', function () {
        const cmd = () => Command(function cmdFindUser() {});

        it('should refuse yield step(...) without the star', async function () {
            const flow = looseGen(function* () {
                yield step(cmd());
            });
            assert.match(await messageOf(() => flow()), /yielded step\(Command 'cmdFindUser'\) without the star/);
        });

        it('should refuse a yielded Effect, a yielded Promise and any other yielded value', async function () {
            assert.match(
                await messageOf(() =>
                    looseGen(function* () {
                        yield cmd();
                    })()
                ),
                /write yield\* step\(effect\)/
            );
            assert.match(
                await messageOf(() =>
                    looseGen(function* () {
                        yield Promise.resolve(1);
                    })()
                ),
                /yielded a Promise; put the call in a Command/
            );
            assert.match(
                await messageOf(() =>
                    looseGen(function* () {
                        yield 7;
                    })()
                ),
                /yielded the number 7/
            );
        });

        it("should add a hint to V8's error for yield* on an Effect, keeping it as the cause", async function () {
            const fromCall = looseGen(function* () {
                yield* /** @type {any} */ (cmd());
            });
            const fromVariable = looseGen(function* () {
                const effect = /** @type {any} */ (cmd());
                yield* effect;
            });
            for (const flow of [fromCall, fromVariable]) {
                let thrown;
                try {
                    flow();
                } catch (e) {
                    thrown = /** @type {Error} */ (e);
                }
                assert.match(String(thrown?.message), /If it came from yield\* on an Effect, write yield\* step/);
                assert.ok(thrown?.cause instanceof TypeError);
            }
        });

        it('should leave other errors about iteration alone', async function () {
            const flow = looseGen(function* () {
                const notIterable = /** @type {any} */ ({});
                for (const _ of notIterable);
            });
            assert.match(await messageOf(() => flow()), /is not iterable$/);
        });
    });

    describe('running the body again', function () {
        it('should advance one run when the flow is walked straight through', function () {
            let runs = 0;
            const flow = gen(function* () {
                runs++;
                const a = yield* step(Command(function cmdA() {}));
                const b = yield* step(Command(function cmdB() {}));
                return [a, b];
            });
            const first = /** @type {any} */ (flow(undefined));
            const second = first.next(1);
            assert.deepEqual(second.next(2), Success([1, 2]));
            assert.equal(runs, 1);
        });

        it('should run the body again for a second branch walked from one step', function () {
            let runs = 0;
            const flow = gen(function* () {
                runs++;
                const found = yield* step(Command(() => /** @type {{ id: number } | null} */ (null)));
                return found ? Failure('taken') : 'free';
            });
            const root = /** @type {any} */ (flow(undefined));
            assert.deepEqual(root.next({ id: 1 }), Failure('taken'));
            assert.deepEqual(root.next(null), Success('free'));
            assert.equal(runs, 2);
        });

        it('should refuse a body that asks for a different step when it runs again', async function () {
            let runs = 0;
            const flow = gen(function* () {
                yield* step(Command(function cmdA() {}));
                runs++;
                yield* step(Command(runs === 1 ? function cmdB() {} : function cmdC() {}));
                yield* step(Command(function cmdD() {}));
            });
            const atD = /** @type {any} */ (flow(undefined)).next(1).next(2);
            atD.next(3);
            // The live run has finished, so answering cmdD again runs the body from the top, where it now asks for cmdC.
            assert.match(
                await messageOf(() => atD.next(4)),
                /asked for Command 'cmdC' where its earlier run asked for Command 'cmdB'/
            );
        });

        it('should keep a long run of pure steps off the stack, and finish a long loop of Commands quickly', async function () {
            this.timeout(10000);
            const pure = gen(function* () {
                let sum = 0;
                for (let i = 0; i < 5000; i++) sum += yield* step(Success(i));
                return sum;
            });
            assert.deepEqual(pure(undefined), Success(12497500));
            const io = gen(function* () {
                let sum = 0;
                for (let i = 0; i < 5000; i++)
                    sum += yield* step(
                        Command(function cmdNext() {
                            return i;
                        })
                    );
                return sum;
            });
            const started = Date.now();
            assert.deepEqual(await runEffect(io(undefined)), Success(12497500));
            assert.ok(Date.now() - started < 2000, `5,000 Commands took ${Date.now() - started} ms`);
        });
    });

    describe('reading the context', function () {
        it('should read it with Ask()', async function () {
            const flow = gen(function* () {
                const { tenant } = /** @type {{ tenant: string }} */ (yield* step(Ask()));
                return tenant;
            });
            assert.deepEqual(await runEffect(flow(undefined), { tenant: 't1' }), Success('t1'));
        });
    });
});
