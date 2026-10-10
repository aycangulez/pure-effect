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

/** @param {string} name */
const boom = (name) =>
    Command(
        Object.defineProperty(
            () => {
                throw new Error('io');
            },
            'name',
            { value: name }
        )
    );

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

        it('should refuse a function that returns an async generator, a plain iterator or null', async function () {
            // A bundler can turn an async function* into a plain function, which the check in gen cannot see.
            const returns = [() => (async function* () {})(), () => [].values(), () => null];
            for (const body of returns) {
                assert.match(
                    await messageOf(() => looseGen(body)()),
                    /gen expects a generator function.*its function returned/
                );
            }
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

        it('should run the body again for a second branch walked from before a pure step', function () {
            const flow = gen(function* () {
                const a = yield* step(Command(function cmdA() {}));
                yield* step(Success('pure'));
                const b = yield* step(Command(function cmdB() {}));
                return [a, b];
            });
            const root = /** @type {any} */ (flow(undefined));
            root.next(1);
            // Answering cmdA again runs the body again, so it asks for cmdB rather than taking 2 as cmdB's answer.
            const again = root.next(2);
            assert.equal(commandName(again), 'cmdB');
            assert.deepEqual(again.next(3), Success([2, 3]));
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

describe('gen: stopping', function () {
    beforeEach(() => configureEffect());

    /** @type {string[]} */
    let seen = [];
    beforeEach(() => (seen = []));

    /**
     * A flow that waits at `effect` inside try/catch/finally, recording which blocks ran and rethrowing.
     * @param {import('../index.js').Effect<any, any, any>} effect
     */
    const watching = (effect) =>
        gen(function* () {
            try {
                return yield* step(effect);
            } catch (e) {
                seen.push(`catch:${/** @type {Error} */ (e).name}`);
                throw e;
            } finally {
                seen.push('finally');
            }
        })(undefined);

    it('should run catch and finally when a Command throws, and keep the I/O fault as the outcome', async function () {
        const result = await runEffect(watching(boom('cmdSave')));
        assert.equal(result.type, 'Failure');
        assert.equal(/** @type {any} */ (result).error.message, 'io');
        assert.deepEqual(seen, ['catch:FlowStopped', 'finally']);
    });

    it('should stop the body for every way a step can stop the flow', async function () {
        const failingNext = Command(
            function cmdLook() {},
            () => Failure('nope')
        );
        const ways = {
            'a Failure yielded as the flow is built': Failure('early'),
            "a Failure from a step's next": failingNext,
            'a Failure inside a Retry': Retry(failingNext),
            'a Retry out of attempts': Retry(boom('cmdFlaky'), { attempts: 1, delay: 0 }),
            'a failing Parallel branch': Parallel([Success(1), failingNext])
        };
        for (const [way, effect] of Object.entries(ways)) {
            seen = [];
            const result = await runEffect(/** @type {any} */ (watching(effect)));
            assert.equal(result.type, 'Failure', way);
            assert.deepEqual(seen, ['catch:FlowStopped', 'finally'], way);
        }
    });

    it('should not throw into a body that returned its own Failure', async function () {
        const flow = gen(function* () {
            try {
                yield* step(Command(function cmdLook() {}));
                return Failure('done');
            } finally {
                seen.push('finally');
            }
        });
        assert.deepEqual(await runEffect(flow(undefined)), Failure('done'));
        assert.deepEqual(seen, ['finally']);
    });

    it('should reject the run when a catch swallows the stop', async function () {
        const flow = gen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } catch {
                return 'recovered';
            }
        });
        await assert.rejects(runEffect(flow(undefined)), /kept going after Command 'cmdSave' stopped it/);
    });

    it('should reject the run when a catch throws another error, keeping it as the cause', async function () {
        const flow = gen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } catch {
                throw new Error('mine');
            }
        });
        await assert.rejects(runEffect(flow(undefined)), (/** @type {Error} */ e) => {
            assert.match(e.message, /threw another error after Command 'cmdSave' stopped it/);
            assert.equal(/** @type {Error} */ (e.cause).message, 'mine');
            return true;
        });
    });

    it('should reject the run when finally runs a step while stopping', async function () {
        const flow = gen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } finally {
                yield* step(Command(function cmdCleanUp() {}));
            }
        });
        await assert.rejects(runEffect(flow(undefined)), /or a finally ran a step/);
    });

    it('should stop nested flows innermost first, each once', async function () {
        const inner = gen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } finally {
                seen.push('inner');
            }
        });
        const outer = gen(function* () {
            try {
                yield* step(inner(undefined));
            } finally {
                seen.push('outer');
            }
        });
        await runEffect(outer(undefined));
        assert.deepEqual(seen, ['inner', 'outer']);
    });

    it('should stop each attempt under Retry, starting the body afresh for the next', async function () {
        let calls = 0;
        const flow = gen(function* () {
            seen.push('start');
            try {
                return yield* step(
                    Command(function cmdFlaky() {
                        if (++calls < 3) throw new Error('io');
                        return 'ok';
                    })
                );
            } finally {
                seen.push('finally');
            }
        });
        assert.deepEqual(await runEffect(Retry(flow(undefined), { attempts: 3, delay: 0 })), Success('ok'));
        assert.deepEqual(seen, ['start', 'finally', 'start', 'finally', 'start', 'finally']);
    });

    it('should let the body go on when onExhausted recovers', async function () {
        const flow = gen(function* () {
            const value = yield* step(
                Retry(boom('cmdPrice'), { attempts: 1, delay: 0, onExhausted: () => Success('cached') })
            );
            return `${value}!`;
        });
        assert.deepEqual(await runEffect(flow(undefined)), Success('cached!'));
    });

    it('should stop a cancelled branch, the failing branch and the flow around them', async function () {
        const slow = gen(function* () {
            try {
                yield* step(Command(() => new Promise((resolve) => setTimeout(resolve, 20))));
                yield* step(Command(function cmdAfter() {}));
            } finally {
                seen.push('slow');
            }
        });
        const failing = gen(function* () {
            try {
                yield* step(boom('cmdBad'));
            } finally {
                seen.push('failing');
            }
        });
        const outer = gen(function* () {
            try {
                yield* step(Parallel([slow(undefined), failing(undefined)]));
            } finally {
                seen.push('outer');
            }
        });
        assert.equal((await runEffect(outer(undefined))).type, 'Failure');
        assert.deepEqual([...seen].sort(), ['failing', 'outer', 'slow']);
    });

    it('should stop a failed branch under settled while the flow around it goes on', async function () {
        const failing = gen(function* () {
            try {
                yield* step(boom('cmdBad'));
            } finally {
                seen.push('failing');
            }
        });
        const outer = gen(function* () {
            const outcomes = yield* step(Parallel([failing(undefined), Success(1)], { settled: true }));
            return outcomes.map((outcome) => outcome.type);
        });
        assert.deepEqual(await runEffect(outer(undefined)), Success(['Failure', 'Success']));
        assert.deepEqual(seen, ['failing']);
    });

    it('should stop a generator flow used as an effectPipe step before another', async function () {
        // effectPipe's chain copies the flow's nodes with no listener of its own, and has to keep the flow's.
        const watched = gen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } finally {
                seen.push('finally');
            }
        });
        const piped = effectPipe(
            () => watched(undefined),
            (/** @type {any} */ value) => Success(value)
        );
        assert.equal((await runEffect(piped(undefined))).type, 'Failure');
        assert.deepEqual(seen, ['finally']);
    });

    it('should run no catch or finally in a sibling branch when a branch throws, so the real error is kept', async function () {
        // A throw rejects the run, so it stops no generator flow, in its own branch or a sibling cancelled because of it.
        const sibling = gen(function* () {
            try {
                yield* step(Command(() => new Promise((resolve) => setTimeout(resolve, 20))));
                yield* step(Command(function cmdAfter() {}));
            } catch {
                seen.push('catch');
                return 'recovered';
            } finally {
                seen.push('finally');
            }
        });
        const bug = Command(
            function cmdFast() {},
            () => {
                throw new Error('the real bug');
            }
        );
        await assert.rejects(runEffect(Parallel([sibling(undefined), bug])), /^Error: the real bug$/);
        assert.deepEqual(seen, []);
    });

    it('should stop a generator flow inside a Retry or a Parallel in a branch cancelled before it started', async function () {
        // The body already ran up to its first step, inside its try, when the flow was built.
        const opened = gen(function* () {
            try {
                yield* step(Command(function cmdNever() {}));
            } finally {
                seen.push('finally');
            }
        });
        const wrappers = [(/** @type {any} */ flow) => Retry(flow), (/** @type {any} */ flow) => Parallel([flow])];
        for (const wrap of wrappers) {
            seen = [];
            const result = await runEffect(Parallel([boom('cmdBad'), wrap(opened(undefined))], { limit: 1 }));
            assert.equal(result.type, 'Failure');
            assert.deepEqual(seen, ['finally']);
        }
    });

    it('should keep the waiting flows on a root that effectPipe or gen copied', async function () {
        const watched = gen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } finally {
                seen.push('finally');
            }
        });
        await runEffect(effectPipe(() => watched(undefined))(undefined));
        assert.deepEqual(seen, ['finally']);
    });
});

describe('gen: the same as a pipeline', function () {
    beforeEach(() => configureEffect());
    beforeEach(() => db.users.clear());

    const input = { email: 'test@test.com', password: 'password123' };

    it('should walk the same Commands as registerUserFlow', function () {
        const piped = /** @type {any} */ (registerUserFlow(input));
        const generated = /** @type {any} */ (registerUserGen(input));
        assert.equal(commandName(generated), commandName(piped));
        assert.equal(commandName(generated.next(null)), commandName(piped.next(null)));
        assert.deepEqual(generated.next({ id: 1 }), piped.next({ id: 1 }));
    });

    it('should show onStep the same names and paths', async function () {
        /** @type {string[][]} */
        const steps = [[], []];
        for (const [i, flow] of [registerUserFlow, registerUserGen].entries()) {
            db.users.clear();
            await runEffect(
                flow(input),
                {},
                {
                    onStep: async (name, type, op, path) => {
                        steps[i].push(`${type} ${name} ${path}`);
                        return op();
                    }
                }
            );
        }
        assert.deepEqual(steps[1], steps[0]);
    });

    it('should record the same trace, and replay it from JSON with no I/O', async function () {
        const piped = await recordEffect(registerUserFlow, input);
        db.users.clear();
        const generated = await recordEffect(registerUserGen, input);
        /** @param {import('../index.js').TraceEntry[]} trace */
        const shape = (trace) => trace.map(({ command, path }) => ({ command, path }));
        assert.deepEqual(shape(generated.trace.trace), shape(piped.trace.trace));

        let io = 0;
        const saveUser = db.saveUser;
        db.saveUser = async (user) => {
            io++;
            return saveUser.call(db, user);
        };
        try {
            const replay = await replayEffect(registerUserGen(input), JSON.parse(JSON.stringify(generated.trace)));
            assert.deepEqual(replay.result, generated.result);
            assert.deepEqual(replay.unreached, []);
            assert.equal(io, 0);
        } finally {
            db.saveUser = saveUser;
        }
    });

    it('should hand onRun the input, so a hook-based recorder can rebuild the flow', async function () {
        // recordEffect is handed the input itself, so only onRun shows that gen recorded it.
        /** @type {unknown} */
        let initialInput;
        await runEffect(
            registerUserGen(input),
            {},
            {
                onRun: async (_effect, op, _flowName, given) => {
                    initialInput = given;
                    return op();
                }
            }
        );
        assert.deepEqual(initialInput, input);
    });

    it('should compose with effectPipe in both directions', async function () {
        const double = (/** @type {number} */ x) =>
            Command(function cmdDouble() {
                return x * 2;
            });
        const doubled = gen(function* (/** @type {number} */ x) {
            return yield* step(double(x));
        });
        const inPipe = effectPipe(doubled, (/** @type {number} */ x) => Success(x + 1));
        assert.deepEqual(await runEffect(inPipe(2)), Success(5));
        const aroundPipe = gen(function* (/** @type {number} */ x) {
            return (yield* step(effectPipe(double, double)(x))) + 1;
        });
        assert.deepEqual(await runEffect(aroundPipe(2)), Success(9));
    });
});

describe('gen: Kleisli laws', function () {
    // `gen(function* (x) { return yield* step(f(x)) })` must be `f`, and `gen(function* (x) { return x })` must be
    // `Success`, observed through runEffect, since two equivalent flows hold different closures.
    beforeEach(() => configureEffect());

    const f = (/** @type {number} */ x) =>
        Command(function cmdDouble() {
            return x * 2;
        });
    const g = (/** @type {number} */ x) => Ask((/** @type {any} */ ctx) => Success(x + ctx.bonus));
    const context = { bonus: 5 };

    it('should treat a body that returns its input as Success', async function () {
        const pure = gen(function* (/** @type {number} */ x) {
            return x;
        });
        assert.deepEqual(await runEffect(pure(3)), Success(3));
    });

    it('should treat a body that returns one step as that step', async function () {
        const lifted = gen(function* (/** @type {number} */ x) {
            return yield* step(f(x));
        });
        assert.deepEqual(await runEffect(lifted(3)), await runEffect(f(3)));
        assert.deepEqual(await runEffect(lifted(3)), Success(6));
    });

    it('should give the same result nested as flat', async function () {
        const flat = gen(function* (/** @type {number} */ x) {
            const doubled = yield* step(f(x));
            return yield* step(g(doubled));
        });
        const inner = gen(function* (/** @type {number} */ x) {
            return yield* step(f(x));
        });
        const nested = gen(function* (/** @type {number} */ x) {
            const doubled = yield* step(inner(x));
            return yield* step(g(doubled));
        });
        assert.deepEqual(await runEffect(flat(3), context), Success(11));
        assert.deepEqual(await runEffect(nested(3), context), await runEffect(flat(3), context));
        assert.deepEqual(await runEffect(effectPipe(f, g)(3), context), Success(11));
    });
});
