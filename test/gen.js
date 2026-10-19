// @ts-check

import { strict as assert } from 'assert';
import { inspect } from 'node:util';
import v8 from 'node:v8';
import vm from 'node:vm';
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
    recorder,
    commandName,
    effectGen,
    step
} from '../index.js';
import { registerUserFlow, validateRegistration, db } from './helpers.js';

// The same flow as `registerUserFlow`, written as a generator, with the same Command names so the two record the
// same trace.
const registerUserGen = effectGen(function* (/** @type {import('./helpers.js').User} */ input) {
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
const looseGen = /** @type {(body: any) => (input?: any) => any} */ (effectGen);

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
            { retries: 2, delay: 0 }
        );
        await assert.rejects(runEffect(flow), /was used as a value/);
        assert.equal(tries, 1);
    });

    it('should accept a node copied with spread', function () {
        const original = Command(function cmdFindUser() {});
        const flow = effectGen(function* () {
            return yield* step({ ...original, meta: { name: 'renamed' } });
        });
        assert.equal(commandName(/** @type {any} */ (flow(undefined))), 'renamed');
    });
});

describe('effectGen', function () {
    beforeEach(() => configureEffect());

    describe('building a flow', function () {
        it('should refuse a value that is not a function, and an async generator function', async function () {
            assert.match(await messageOf(() => looseGen(42)), /effectGen expects a generator function/);
            assert.match(await messageOf(() => looseGen(async function* () {})), /not async function\*/);
        });

        it('should refuse a generator function that declares more than one parameter', async function () {
            // A flow is called with one value, and every run after the first builds it again from that value alone,
            // so a second parameter could only ever be undefined.
            assert.match(
                await messageOf(() => looseGen(function* (/** @type {any} */ batch, /** @type {any} */ options) {})),
                /effectGen's generator function declares 2 parameters, but a flow takes one input.*function\* \(\{ batch, limit \}\)/
            );
        });

        it('should build from a generator function that declares one parameter, none, or only a rest parameter', function () {
            // Checked on the definition rather than the call, so `list.map(flow)`, which passes an index and the
            // list as well, still works.
            const bodies = [
                function* (/** @type {any} */ input) {},
                function* () {},
                function* (/** @type {any[]} */ ...args) {}
            ];
            for (const body of bodies) {
                const flow = looseGen(body);
                assert.deepEqual(
                    [1, 2].map(flow).map((root) => root.type),
                    ['Success', 'Success']
                );
            }
        });

        it('should refuse a function that returns no generator, when the flow is built', async function () {
            const flow = looseGen(() => 1);
            assert.match(await messageOf(() => flow()), /its function returned the number 1/);
        });

        it('should refuse a function that returns an async generator, a plain iterator or null', async function () {
            // A bundler can turn an async function* into a plain function, which the check in effectGen cannot see.
            const returns = [() => (async function* () {})(), () => [].values(), () => null];
            for (const body of returns) {
                assert.match(
                    await messageOf(() => looseGen(body)()),
                    /effectGen expects a generator function.*its function returned/
                );
            }
        });

        it('should run the body up to its first step when the flow is built', function () {
            /** @type {string[]} */
            const seen = [];
            const flow = effectGen(function* () {
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
                    effectGen(function* () {
                        return 1;
                    })(undefined)
                ),
                Success(1)
            );
            assert.deepEqual(await runEffect(effectGen(function* () {})(undefined)), Success(undefined));
        });

        it('should stop with a returned Failure', async function () {
            assert.deepEqual(
                await runEffect(
                    effectGen(function* () {
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
                    effectGen(function* () {
                        return cmd();
                    })(undefined)
                ),
                Success(5)
            );
            assert.deepEqual(
                await runEffect(
                    effectGen(function* () {
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
            const flow = effectGen(function* () {
                throw new Error('bug');
            });
            assert.match(await messageOf(() => flow(undefined)), /^bug$/);
        });

        it('should reject the run when the body throws after a step', async function () {
            const flow = effectGen(function* () {
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

        it('should refuse a step(...) called without yield*, rather than skip it', async function () {
            // A step written as a bare statement was never iterated, so the body went on past it: a Failure it held
            // was dropped and a Command it held never ran, and the flow succeeded.
            let charges = 0;
            const charge = () =>
                Command(function cmdCharge() {
                    charges++;
                });
            const atBuild = looseGen(function* () {
                step(Failure('Card declined.'));
                return 'charged';
            });
            assert.match(
                await messageOf(() => atBuild()),
                /^step\(a Failure\) was called without yield\*, so it never ran; write yield\* step\(\.\.\.\)\.$/
            );
            const later = looseGen(function* () {
                yield* step(cmd());
                step(charge());
                return 'charged';
            });
            await assert.rejects(runEffect(later()), {
                name: 'EffectTypeError',
                message: /^step\(Command 'cmdCharge'\) was called without yield\*/
            });
            assert.equal(charges, 0, 'the skipped Command did not run');
            // A truth test cannot be trapped, but the step it read is still one the body never ran.
            const tested = looseGen(function* () {
                const found = step(Command(() => /** @type {{ id: number } | null} */ (null)));
                return found ? 'taken' : 'free';
            });
            assert.match(await messageOf(() => tested()), /^step\(Command 'anonymous'\) was called without yield\*/);
            // A step made first and run with yield* later in the same stretch of the body is fine.
            const held = looseGen(function* () {
                const pending = step(charge());
                const value = yield* pending;
                return value;
            });
            assert.deepEqual(await runEffect(held()), Success(undefined));
            assert.equal(charges, 1);
            // One left for a later stretch of the body is refused when the body first yields without it.
            const deferred = looseGen(function* () {
                const pending = step(charge());
                yield* step(cmd());
                return yield* pending;
            });
            assert.match(await messageOf(() => deferred()), /^step\(Command 'cmdCharge'\) was called without yield\*/);
            assert.equal(charges, 1, 'the deferred Command did not run');
            // A flow built inside a body tracks its own steps, and the body goes on tracking its own after it.
            const inner = looseGen(function* () {
                return yield* step(cmd());
            });
            const outer = looseGen(function* () {
                const nested = inner();
                step(Failure('Card declined.'));
                return yield* step(nested);
            });
            assert.match(await messageOf(() => outer()), /^step\(a Failure\) was called without yield\*/);
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
            const flow = effectGen(function* () {
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
            const flow = effectGen(function* () {
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
            const flow = effectGen(function* () {
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

        it('should hand a body that runs again the value its pure step computes now, not the earlier value', async function () {
            // Each attempt of a Retry builds a fresh order, as a retried async function would.
            let reserveCalls = 0;
            const placeOrder = effectGen(function* () {
                const order = yield* step(Success({ lines: /** @type {number[]} */ ([]) }));
                order.lines.push(
                    yield* step(
                        Command(function cmdPrice() {
                            return 10;
                        })
                    )
                );
                yield* step(
                    Command(function cmdReserve() {
                        if (reserveCalls++ === 0) throw new Error('timeout');
                        return 'ok';
                    })
                );
                return order.lines;
            });
            assert.deepEqual(await runEffect(Retry(placeOrder(undefined), { retries: 2, delay: 0 })), Success([10]));

            // One flow value in three branches: each runs its own body, with its own array.
            const counted = effectGen(function* () {
                const seen = yield* step(Success(/** @type {number[]} */ ([])));
                seen.push(
                    yield* step(
                        Command(function cmdGet() {
                            return 1;
                        })
                    )
                );
                return seen.length;
            })(undefined);
            assert.deepEqual(await runEffect(Parallel([counted, counted, counted])), Success([1, 1, 1]));
        });

        it('should let a body that runs again consume what its pure step built', async function () {
            // A queue the first run emptied must not be handed to the second.
            let saves = 0;
            const importRows = effectGen(function* () {
                const queue = yield* step(Success(['a', 'b']));
                const saved = [];
                while (queue.length) {
                    const row = /** @type {string} */ (queue.shift());
                    saved.push(
                        yield* step(
                            Command(function cmdSaveRow() {
                                if (saves++ === 1) throw new Error('timeout');
                                return row;
                            })
                        )
                    );
                }
                return saved;
            });
            assert.deepEqual(
                await runEffect(Retry(importRows(undefined), { retries: 1, delay: 0 })),
                Success(['a', 'b'])
            );
        });

        it('should refuse a body that asks for a different step when it runs again', async function () {
            let runs = 0;
            const flow = effectGen(function* () {
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

        it('should say a body returned where its earlier run asked for a step', async function () {
            let runs = 0;
            const flow = effectGen(function* () {
                yield* step(Command(function cmdA() {}));
                runs++;
                if (runs > 1) return 'early';
                yield* step(Command(function cmdB() {}));
                yield* step(Command(function cmdC() {}));
            });
            const atC = /** @type {any} */ (flow(undefined)).next(1).next(2);
            atC.next(3);
            assert.match(
                await messageOf(() => atC.next(4)),
                /^A generator flow returned where its earlier run asked for Command 'cmdB'\./
            );
        });

        it('should keep a long run of pure steps off the stack, and finish a long loop of Commands quickly', async function () {
            this.timeout(10000);
            const pure = effectGen(function* () {
                let sum = 0;
                for (let i = 0; i < 5000; i++) sum += yield* step(Success(i));
                return sum;
            });
            assert.deepEqual(pure(undefined), Success(12497500));
            const io = effectGen(function* () {
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
            const flow = effectGen(function* () {
                const { tenant } = /** @type {{ tenant: string }} */ (yield* step(Ask()));
                return tenant;
            });
            assert.deepEqual(await runEffect(flow(undefined), { tenant: 't1' }), Success('t1'));
        });
    });
});

describe('effectGen: stopping', function () {
    beforeEach(() => configureEffect());

    /** @type {string[]} */
    let seen = [];
    beforeEach(() => (seen = []));

    /**
     * A flow that waits at `effect` inside try/catch/finally, recording which blocks ran and rethrowing.
     * @param {import('../index.js').Effect<any, any, any>} effect
     */
    const watching = (effect) =>
        effectGen(function* () {
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

    it('should say which step the flow stopped after', async function () {
        /** @type {string[]} */
        const messages = [];
        const flow = effectGen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } catch (e) {
                messages.push(/** @type {Error} */ (e).message);
                throw e;
            }
        });
        await runEffect(flow(undefined));
        assert.match(messages[0], /^The flow stopped after Command 'cmdSave'\./);
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
            'a Retry out of attempts': Retry(boom('cmdFlaky'), { retries: 1, delay: 0 }),
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
        const flow = effectGen(function* () {
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
        const flow = effectGen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } catch {
                return 'recovered';
            }
        });
        await assert.rejects(runEffect(flow(undefined)), /kept going after Command 'cmdSave' stopped it/);
    });

    it('should reject the run when a catch throws another error, keeping it as the cause', async function () {
        const flow = effectGen(function* () {
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
        const flow = effectGen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } finally {
                yield* step(Command(function cmdCleanUp() {}));
            }
        });
        await assert.rejects(runEffect(flow(undefined)), /or a finally ran a step/);
    });

    it('should stop nested flows innermost first, each once', async function () {
        const inner = effectGen(function* () {
            try {
                yield* step(boom('cmdSave'));
            } finally {
                seen.push('inner');
            }
        });
        const outer = effectGen(function* () {
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
        const flow = effectGen(function* () {
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
        assert.deepEqual(await runEffect(Retry(flow(undefined), { retries: 3, delay: 0 })), Success('ok'));
        assert.deepEqual(seen, ['start', 'finally', 'start', 'finally', 'start', 'finally']);
    });

    it('should close a nested flow a body builds again when it runs again, in a run that succeeds', async function () {
        // On the second attempt the outer body runs again to reach its step, building a new inner flow it does not
        // run, since the answer is already known. That inner body entered its try, so its finally has to run.
        let calls = 0;
        const inner = effectGen(function* () {
            seen.push('inner enter');
            try {
                return yield* step(
                    Command(function cmdA() {
                        return 'a';
                    })
                );
            } finally {
                seen.push('inner finally');
            }
        });
        const outer = effectGen(function* () {
            const a = yield* step(inner(undefined));
            const b = yield* step(
                Command(function cmdB() {
                    if (calls++ === 0) throw new Error('flaky');
                    return 'b';
                })
            );
            return [a, b];
        });
        assert.deepEqual(await runEffect(Retry(outer(undefined), { retries: 1, delay: 0 })), Success(['a', 'b']));
        const entered = seen.filter((event) => event === 'inner enter').length;
        assert.equal(seen.filter((event) => event === 'inner finally').length, entered);
    });

    it('should let the body go on when onExhausted recovers', async function () {
        const flow = effectGen(function* () {
            const value = yield* step(
                Retry(boom('cmdPrice'), { retries: 1, delay: 0, onExhausted: () => Success('cached') })
            );
            return `${value}!`;
        });
        assert.deepEqual(await runEffect(flow(undefined)), Success('cached!'));
    });

    it('should stop a cancelled branch, the failing branch and the flow around them', async function () {
        const slow = effectGen(function* () {
            try {
                yield* step(Command(() => new Promise((resolve) => setTimeout(resolve, 20))));
                yield* step(Command(function cmdAfter() {}));
            } finally {
                seen.push('slow');
            }
        });
        const failing = effectGen(function* () {
            try {
                yield* step(boom('cmdBad'));
            } finally {
                seen.push('failing');
            }
        });
        const outer = effectGen(function* () {
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
        const failing = effectGen(function* () {
            try {
                yield* step(boom('cmdBad'));
            } finally {
                seen.push('failing');
            }
        });
        const outer = effectGen(function* () {
            const outcomes = yield* step(Parallel([failing(undefined), Success(1)], { settled: true }));
            return outcomes.map((outcome) => outcome.type);
        });
        assert.deepEqual(await runEffect(outer(undefined)), Success(['Failure', 'Success']));
        assert.deepEqual(seen, ['failing']);
    });

    it('should stop a generator flow used as an effectPipe step before another', async function () {
        // effectPipe's chain copies the flow's nodes with no listener of its own, and has to keep the flow's.
        const watched = effectGen(function* () {
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
        const sibling = effectGen(function* () {
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
        const opened = effectGen(function* () {
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

    it('should replay a branch that threw without running a sibling catch or finally, as production did', async function () {
        // A sibling whose catch swallows the stop would otherwise replace the real error in the replay.
        const sibling = effectGen(function* () {
            try {
                yield* step(Command(() => new Promise((resolve) => setTimeout(resolve, 20))));
                yield* step(
                    Parallel([
                        effectGen(function* () {
                            try {
                                yield* step(Command(function cmdNested() {}));
                            } finally {
                                seen.push('nested finally');
                            }
                        })(undefined)
                    ])
                );
                return yield* step(Command(function cmdAfter() {}));
            } catch {
                seen.push('catch');
                return 'recovered';
            } finally {
                seen.push('finally');
            }
        });
        const bug = Command(
            () => new Promise((resolve) => setTimeout(resolve, 5)),
            () => {
                throw new Error('the real bug');
            }
        );
        const flow = () => Parallel([sibling(undefined), bug]);
        const recording = recorder();
        await assert.rejects(runEffect(flow(), {}, { onStep: recording.onStep }), /^Error: the real bug$/);
        assert.deepEqual(seen, []);
        const trace = JSON.parse(JSON.stringify(recording.toTrace()));
        await assert.rejects(replayEffect(flow(), trace), /^Error: the real bug$/);
        assert.deepEqual(seen, []);
    });

    it('should replay a throw that came after another branch cancelled the Parallel to the same error', async function () {
        // A Failure cancels the others first; a branch's throw comes next and marks the scope, so production stops no
        // generator, and the replay, which knows only the order the trace gives it, must not either.
        const swallowing = effectGen(function* () {
            try {
                yield* step(Command(() => new Promise((resolve) => setTimeout(resolve, 20))));
                return yield* step(Command(function cmdAfter() {}));
            } catch {
                seen.push('catch');
                return 'recovered';
            }
        });
        const bug = Command(
            () => new Promise((resolve) => setTimeout(resolve, 5)),
            () => {
                throw new Error('the real bug');
            }
        );
        // Fails while the bug's Command is already running, which ignores the cancellation and then throws.
        const declined = Command(() => new Promise((_, reject) => setTimeout(() => reject(new Error('declined')), 2)));
        const flow = () => Parallel([swallowing(undefined), declined, bug]);
        const recording = recorder();
        await assert.rejects(runEffect(flow(), {}, { onStep: recording.onStep }), /^Error: the real bug$/);
        const trace = JSON.parse(JSON.stringify(recording.toTrace()));
        await assert.rejects(replayEffect(flow(), trace), /^Error: the real bug$/);
        assert.deepEqual(seen, []);
    });

    it('should replay a cancelled branch that skipped a Parallel of generator flows, running their finally as production did', async function () {
        const leaf = effectGen(function* (/** @type {string} */ id) {
            try {
                return yield* step(
                    Command(function cmdLeaf() {
                        return id;
                    })
                );
            } finally {
                seen.push(`leaf ${id} finally`);
            }
        });
        // Its slow step ignores the signal, so the branch reaches the Parallel after the cancellation, which skips it.
        const branch = effectGen(function* () {
            yield* step(
                Command(function cmdSlow() {
                    return new Promise((resolve) => setTimeout(resolve, 30));
                })
            );
            return yield* step(Parallel([leaf('x'), leaf('y')]));
        });
        const failing = Command(function cmdFail() {
            return new Promise((_, reject) => setTimeout(() => reject(new Error('declined')), 5));
        });
        const flow = () => Parallel([branch(undefined), failing]);
        const recording = recorder();
        const production = await runEffect(flow(), {}, { onStep: recording.onStep });
        assert.equal(production.type, 'Failure');
        assert.deepEqual([...seen].sort(), ['leaf x finally', 'leaf y finally']);
        seen = [];
        const replay = await replayEffect(flow(), JSON.parse(JSON.stringify(recording.toTrace())));
        assert.equal(replay.result.type, 'Failure');
        assert.deepEqual([...seen].sort(), ['leaf x finally', 'leaf y finally']);
    });

    it('should keep the waiting flows on a root that effectPipe or effectGen copied', async function () {
        const watched = effectGen(function* () {
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

describe('effectGen: running a flow again', function () {
    beforeEach(() => configureEffect());

    /** @type {string[]} */
    let log = [];
    let ids = 0;
    let failures = 0;
    beforeEach(() => {
        log = [];
        ids = 0;
        failures = 0;
    });

    // Makes its ID in the body, which the docs advise against, so the log shows which run of the body built each
    // Command.
    const reserveAndCharge = effectGen(function* () {
        const id = `id-${++ids}`;
        const cmdReserve = () => log.push(`reserve ${id}`);
        yield* step(Command(cmdReserve));
        const cmdCharge = () => {
            if (failures-- > 0) throw new Error('card network timeout');
            log.push(`charge ${id}`);
            return id;
        };
        return yield* step(Command(cmdCharge));
    });

    it('should run a flow once on the run its body made as the flow was built', async function () {
        assert.deepEqual(await runEffect(reserveAndCharge(undefined)), Success('id-1'));
        assert.equal(ids, 1);
    });

    it('should build the flow again for each Retry attempt, so an attempt hands every Command its own values', async function () {
        failures = 1;
        const result = await runEffect(Retry(reserveAndCharge(undefined), { retries: 2, delay: 0 }));
        assert.deepEqual(result, Success('id-2'));
        assert.deepEqual(log, ['reserve id-1', 'reserve id-2', 'charge id-2']);
    });

    it('should build a flow value again for each run and each branch it is used in', async function () {
        const flow = reserveAndCharge(undefined);
        assert.deepEqual(await runEffect(Parallel([flow, flow])), Success(['id-1', 'id-2']));
        assert.deepEqual(await runEffect(flow), Success('id-3'));
        // Sorted, since the branches' Commands interleave.
        assert.deepEqual([...log].sort(), [
            'charge id-1',
            'charge id-2',
            'charge id-3',
            'reserve id-1',
            'reserve id-2',
            'reserve id-3'
        ]);
    });

    it('should build a walked flow again when it runs', async function () {
        const flow = /** @type {any} */ (reserveAndCharge(undefined));
        assert.equal(commandName(flow.next(1)), 'cmdCharge');
        assert.deepEqual(await runEffect(flow), Success('id-2'));
        assert.deepEqual(log, ['reserve id-2', 'charge id-2']);
    });

    it('should build a flow again when a walk stopped its body at the step it was built at', async function () {
        // The walk stops the body without moving it on, and the run that follows takes the other branch.
        const flow = effectGen(function* () {
            const id = `id-${++ids}`;
            const cmdFind = () => (log.push(`find ${id}`), null);
            yield* step(Command(cmdFind, (found) => (found ? Failure('taken') : Success(found))));
            const cmdSave = () => log.push(`save ${id}`);
            yield* step(Command(cmdSave));
            return id;
        });
        const root = /** @type {any} */ (flow(undefined));
        assert.deepEqual(root.next({ id: 1 }), Failure('taken'));
        assert.deepEqual(await runEffect(root), Success('id-2'));
        assert.deepEqual(log, ['find id-2', 'save id-2']);
    });

    it('should build again a flow that effectPipe or another generator flow starts with', async function () {
        const flows = [
            () => effectPipe(reserveAndCharge, (/** @type {string} */ id) => Success(`paid ${id}`))(undefined),
            () =>
                effectGen(function* () {
                    const id = yield* step(reserveAndCharge(undefined));
                    return `paid ${id}`;
                })(undefined)
        ];
        for (const build of flows) {
            log = [];
            ids = 0;
            failures = 1;
            const result = await runEffect(Retry(build(), { retries: 2, delay: 0 }));
            assert.deepEqual(result, Success('paid id-2'));
            assert.deepEqual(log, ['reserve id-1', 'reserve id-2', 'charge id-2']);
        }
    });

    it('should leave alone a flow another branch ran when a cancellation skips it', async function () {
        /** @type {string[]} */
        const seen = [];
        const opened = effectGen(function* () {
            seen.push('enter');
            try {
                return yield* step(Command(function cmdOpen() {}));
            } finally {
                seen.push('finally');
            }
        });
        const flow = opened(undefined);
        const result = await runEffect(Parallel([flow, boom('cmdBad'), flow], { limit: 1 }));
        assert.equal(result.type, 'Failure');
        assert.deepEqual(seen, ['enter', 'finally']);
    });

    it('should hold no earlier answer in a run, so a long loop keeps only the page it is on', async function () {
        v8.setFlagsFromString('--expose-gc');
        const gc = vm.runInNewContext('gc');
        /** @type {WeakRef<object> | undefined} */
        let firstPage;
        let released = false;
        const flow = effectGen(function* () {
            for (let i = 0; i < 3; i++) {
                const cmdFetchPage = async () => {
                    const page = { items: [i] };
                    if (i === 0) firstPage = new WeakRef(page);
                    if (i === 2) {
                        // A turn later, so the WeakRef no longer holds its target for the job that made it.
                        await new Promise((resolve) => setImmediate(resolve));
                        gc();
                        released = firstPage?.deref() === undefined;
                    }
                    return page;
                };
                yield* step(Command(cmdFetchPage));
            }
        });
        await runEffect(flow(undefined));
        assert.equal(released, true);
    });

    it('should still walk a flow a run has used, down more than one branch', async function () {
        const flow = /** @type {any} */ (reserveAndCharge(undefined));
        assert.deepEqual(await runEffect(flow), Success('id-1'));
        const charge = flow.next(1);
        assert.equal(commandName(charge), 'cmdCharge');
        assert.deepEqual(charge.next('a'), Success('a'));
        assert.deepEqual(charge.next('b'), Success('b'));
    });

    it('should reject a run whose step a hook answered first, since the run keeps no answers to run the body again', async function () {
        configureEffect({
            onBeforeCommand: (command) => {
                if (commandName(command) === 'cmdCharge') command.next('early');
            }
        });
        await assert.rejects(runEffect(reserveAndCharge(undefined)), /answered again after a run had gone past it/);
    });

    it('should record a retried flow and replay it from JSON with no I/O', async function () {
        failures = 1;
        const flowFn = () => Retry(reserveAndCharge(undefined), { retries: 2, delay: 0 });
        const recorded = await recordEffect(flowFn());
        assert.deepEqual(recorded.result, Success('id-2'));
        log = [];
        const replay = await replayEffect(flowFn(), JSON.parse(JSON.stringify(recorded.trace)));
        assert.deepEqual(replay.result, recorded.result);
        assert.deepEqual(replay.unreached, []);
        assert.deepEqual(log, []);
    });
});

describe('effectGen: the same as a pipeline', function () {
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
        const piped = await recordEffect(registerUserFlow(input));
        db.users.clear();
        const generated = await recordEffect(registerUserGen(input));
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
        // recordEffect is handed the input itself, so only onRun shows that effectGen recorded it.
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
        const doubled = effectGen(function* (/** @type {number} */ x) {
            return yield* step(double(x));
        });
        const inPipe = effectPipe(doubled, (/** @type {number} */ x) => Success(x + 1));
        assert.deepEqual(await runEffect(inPipe(2)), Success(5));
        const aroundPipe = effectGen(function* (/** @type {number} */ x) {
            return (yield* step(effectPipe(double, double)(x))) + 1;
        });
        assert.deepEqual(await runEffect(aroundPipe(2)), Success(9));
    });
});

describe('effectGen: Kleisli laws', function () {
    // `effectGen(function* (x) { return yield* step(f(x)) })` must be `f`, and `effectGen(function* (x) { return x })` must be
    // `Success`, observed through runEffect, since two equivalent flows hold different closures.
    beforeEach(() => configureEffect());

    const f = (/** @type {number} */ x) =>
        Command(function cmdDouble() {
            return x * 2;
        });
    const g = (/** @type {number} */ x) => Ask((/** @type {any} */ ctx) => Success(x + ctx.bonus));
    const context = { bonus: 5 };

    it('should treat a body that returns its input as Success', async function () {
        const pure = effectGen(function* (/** @type {number} */ x) {
            return x;
        });
        assert.deepEqual(await runEffect(pure(3)), Success(3));
    });

    it('should treat a body that returns one step as that step', async function () {
        const lifted = effectGen(function* (/** @type {number} */ x) {
            return yield* step(f(x));
        });
        assert.deepEqual(await runEffect(lifted(3)), await runEffect(f(3)));
        assert.deepEqual(await runEffect(lifted(3)), Success(6));
    });

    it('should give the same result nested as flat', async function () {
        const flat = effectGen(function* (/** @type {number} */ x) {
            const doubled = yield* step(f(x));
            return yield* step(g(doubled));
        });
        const inner = effectGen(function* (/** @type {number} */ x) {
            return yield* step(f(x));
        });
        const nested = effectGen(function* (/** @type {number} */ x) {
            const doubled = yield* step(inner(x));
            return yield* step(g(doubled));
        });
        assert.deepEqual(await runEffect(flat(3), context), Success(11));
        assert.deepEqual(await runEffect(nested(3), context), await runEffect(flat(3), context));
        assert.deepEqual(await runEffect(effectPipe(f, g)(3), context), Success(11));
    });
});
