// @ts-check

import { strict as assert } from 'assert';
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
    commandName
} from '../index.js';
import { registerUserFlow, registerUser, valueOf, errorOf } from './helpers.js';

/** @import { CommandInterceptor } from "../index.js" */

describe('Core', function () {
    // Global hooks outlive a suite, so this guards against inheriting another suite's wiring.
    beforeEach(() => configureEffect());

    it('should return Failure when e-mail is invalid', async function () {
        const badInput = { email: 'bad-email', password: '123' };
        const result = registerUserFlow(badInput);
        assert.deepEqual(result, Failure('Invalid email format.'));
    });

    it('should walk through the call tree', async function () {
        const input = { email: 'test@test.com', password: 'password123' };
        const step1 = registerUserFlow(input);
        assert.equal(step1.type, 'Command');
        assert.equal(commandName(step1), 'cmdFindUser');

        const step2 = step1.next(null);
        assert.equal(step2.type, 'Command');
        assert.equal(commandName(step2), 'cmdSaveUser');
    });

    it('should access context through onBeforeCommand', async function () {
        const input = { email: 'context@test.com', password: 'password123' };
        await runEffect(
            registerUserFlow(input),
            { env: 'test' },
            {
                onBeforeCommand: /** @type CommandInterceptor */ async (command, context) =>
                    assert.equal(context.env, 'test')
            }
        );
    });

    it('should access context through Ask', async function () {
        /** @type {any} */
        let capturedCtx;
        const step = () =>
            Ask((ctx) => {
                capturedCtx = ctx;
                return Success(null);
            });
        await runEffect(step(), { env: 'test' });
        assert.equal(capturedCtx.env, 'test');
    });

    it('should work with Ask at any point in the pipeline', async function () {
        const flow = effectPipe(
            () =>
                Command(
                    () => 'value',
                    (r) => Success(r)
                ),
            (value) => Ask((/** @type {any} */ ctx) => Success({ value, env: ctx.env }))
        );
        const result = await runEffect(flow(null), { env: 'test' });
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { value: 'value', env: 'test' });
    });

    it('should return a Retry data structure', function () {
        const inner = Command(
            () => 'x',
            (r) => Success(r)
        );
        const effect = Retry(inner, { attempts: 5 });
        assert.equal(effect.type, 'Retry');
        assert.deepEqual(effect.options, { attempts: 5 });
        assert.strictEqual(effect.effect, inner);
        assert.equal(typeof effect.next, 'function');
    });

    it('should succeed after transient failures', async function () {
        let calls = 0;
        const effect = Retry(
            Command(
                function flakyCmd() {
                    if (++calls < 3) throw new Error('transient');
                    return 'ok';
                },
                (r) => Success(r)
            ),
            { attempts: 3, delay: 0 }
        );
        const result = await runEffect(effect);
        assert.equal(result.type, 'Success');
        assert.equal(result.value, 'ok');
        assert.equal(calls, 3);
    });

    it('should return rich Failure when retries are exhausted', async function () {
        const effect = Retry(
            Command(
                function alwaysFails() {
                    throw new Error('boom');
                },
                (/** @type {any} */ r) => Success(r)
            ),
            { attempts: 2, delay: 0 }
        );
        const result = await runEffect(effect);
        assert.equal(result.type, 'Failure');
        if (result.type !== 'Failure') throw new Error('expected Failure');
        const error = /** @type {import('../index.js').RetryExhaustedError<Error>} */ (result.error);
        assert.equal(error.retryExhausted, true);
        assert.equal(error.attempts, 2);
        assert.equal(error.lastError.message, 'boom');
    });

    it('should apply delay and backoff between retries', async function () {
        this.timeout(2000);
        let calls = 0;
        const start = Date.now();
        const effect = Retry(
            Command(
                function flakyCmd() {
                    if (++calls < 3) throw new Error('transient');
                    return 'ok';
                },
                (r) => Success(r)
            ),
            { attempts: 3, delay: 30, backoff: 2 }
        );
        const result = await runEffect(effect);
        const elapsed = Date.now() - start;
        assert.equal(result.type, 'Success');
        // Two retries, waiting 30 ms and then 60 ms. A flat delay would total 60 ms, so anything from
        // 85 ms up (5 ms of margin for timer variance) shows the multiplier was applied.
        assert.ok(elapsed >= 85, `Expected at least 85 ms elapsed, got ${elapsed} ms`);
    });

    it('should not wait before the first attempt', async function () {
        // The delay applies between attempts, so a Command that succeeds at once never pays it.
        const start = Date.now();
        const result = await runEffect(
            Retry(
                Command(function cmdFirstTry() {
                    return 'ok';
                }),
                { attempts: 2, delay: 300 }
            )
        );
        assert.deepEqual(result, Success('ok'));
        assert.ok(Date.now() - start < 150, 'the first attempt started at once');
    });

    it('should work at any step inside effectPipe', async function () {
        const flow = effectPipe(
            (input) =>
                Retry(
                    Command(
                        function fetchCmd() {
                            return input.toUpperCase();
                        },
                        (r) => Success(r)
                    ),
                    { attempts: 2, delay: 0 }
                ),
            (upper) => Success(`${upper}!`)
        );
        const result = await runEffect(flow('hello'));
        assert.equal(result.type, 'Success');
        assert.equal(result.value, 'HELLO!');
    });

    it('should return a Parallel data structure', () => {
        const e1 = Success(1);
        const e2 = Success(2);
        const next = (/** @type {any[]} */ values) => Success(values);
        const result = Parallel([e1, e2], next);
        assert.equal(result.type, 'Parallel');
        assert.deepEqual(result.effects, [e1, e2]);
        assert.equal(result.next, next);
    });

    it('should default next to Success of the values array when omitted', async () => {
        const e1 = Command(async () => 'a');
        const e2 = Command(async () => 'b');
        const result = await runEffect(Parallel([e1, e2]));
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, ['a', 'b']);
    });

    it('should run effects concurrently and pass results to next', async () => {
        const e1 = Command(
            async () => 'a',
            (v) => Success(v)
        );
        const e2 = Command(
            async () => 'b',
            (v) => Success(v)
        );
        const flow = Parallel([e1, e2], ([a, b]) => Success({ a, b }));
        const result = await runEffect(flow);
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { a: 'a', b: 'b' });
    });

    it('should return Failure if any parallel effect fails', async () => {
        const e1 = Success('ok');
        const e2 = Failure('oops');
        const flow = Parallel([e1, e2], ([a, b]) => Success({ a, b }));
        const result = await runEffect(flow);
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'oops');
    });

    it('should work inside effectPipe', async () => {
        const flow = effectPipe((input) =>
            Parallel(
                [
                    Command(
                        async () => input.a,
                        (v) => Success(v)
                    ),
                    Command(
                        async () => input.b,
                        (v) => Success(v)
                    )
                ],
                ([a, b]) => Success({ a, b })
            )
        );
        const result = await runEffect(flow({ a: 1, b: 2 }));
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { a: 1, b: 2 });
    });

    it('should pass context to parallel branches via Ask', async () => {
        const flow = Parallel(
            [Ask((/** @type {any} */ ctx) => Success(ctx.x)), Ask((/** @type {any} */ ctx) => Success(ctx.y))],
            ([x, y]) => Success({ x, y })
        );
        const result = await runEffect(flow, { x: 10, y: 20 });
        assert.equal(result.type, 'Success');
        assert.deepEqual(result.value, { x: 10, y: 20 });
    });

    it('should run the registration flow to Success', async function () {
        const input = { email: 'test-no-telemetry@test.com', password: 'password123' };
        const result = await registerUser(input);
        assert.equal(result.type, 'Success');
    });

    it('should run a loop that recurses through effectPipe in linear time', async function () {
        // effectPipe ended in an identity pass that wrapped every pipeline once more, so each level of such a loop
        // added a wrapper: 5,000 levels took seconds and 20,000 overflowed the stack. A paged loop whose fetch is
        // retried recurses this way, since a Retry around a Command's next would repeat every later page.
        const fetchPage = (/** @type {number} */ left) =>
            Command(function cmdFetchPage() {
                return left;
            });
        /** @type {(left: number) => import('../index.js').Effect<string>} */
        const poll = (left) =>
            effectPipe(
                (/** @type {number} */ n) => Retry(fetchPage(n), { attempts: 1, delay: 0 }),
                (/** @type {number} */ n) => (n === 0 ? Success('done') : poll(n - 1))
            )(left);
        const job = effectPipe(poll, (status) => Success(`${status} after 50,000 pages`));
        assert.deepEqual(await runEffect(job(50_000)), Success('done after 50,000 pages'));
    });
});

describe('Kleisli laws', function () {
    // `Success` is `pure` and the internal `chain` is `bind`, so `effectPipe` is Kleisli composition.
    // The three monad laws are pinned here in that form and observationally, through `runEffect`, because
    // two law-equivalent trees hold different `next` closures and can never be structurally equal. Each
    // law is checked against a step that reaches every node type, so a `chain` case that stops wrapping
    // its continuation fails here rather than only in whichever flow happens to exercise it.
    beforeEach(() => configureEffect());

    const context = { bonus: 5 };
    /** @type {string[]} */
    let calls = [];
    beforeEach(() => (calls = []));

    /** @param {number} x */
    const double = (x) =>
        Command(async function cmdDouble() {
            calls.push(`double:${x}`);
            return x * 2;
        });
    /** @param {number} x */
    const addBonus = (x) => Ask((/** @type {any} */ ctx) => Success(x + ctx.bonus));
    /** @param {number} x */
    const guarded = (x) =>
        x > 100
            ? Failure('too big')
            : Parallel(
                  [
                      Success(x),
                      Command(async function cmdEcho() {
                          calls.push(`echo:${x}`);
                          return x;
                      })
                  ],
                  (/** @type {number[]} */ [a, b]) => Success(a + b)
              );
    /** @param {number} x */
    const retried = (x) =>
        Retry(
            Command(async function cmdIncrement() {
                calls.push(`increment:${x}`);
                return x + 1;
            }),
            { attempts: 2, delay: 0 }
        );
    // The steps fail in different ways, so each loop over them needs one error type that covers them all.
    /** @typedef {(x: number) => import('../index.js').Effect<number, unknown, any>} LawStep */
    /** @type {LawStep[]} */
    const steps = [double, addBonus, guarded, retried];
    const inputs = [1, 10, 60];

    /** Runs a flow and returns its outcome together with the I/O it performed, so equivalence covers both. */
    const observe = async (/** @type {(x: number) => any} */ flow, /** @type {number} */ x) => {
        calls = [];
        const result = await runEffect(flow(x), context);
        return { result, calls };
    };

    /** Asserts two flows are indistinguishable through the interpreter on every input. */
    const assertEquivalent = async (
        /** @type {(x: number) => any} */ left,
        /** @type {(x: number) => any} */ right,
        /** @type {string} */ law
    ) => {
        for (const x of inputs) {
            assert.deepEqual(await observe(left, x), await observe(right, x), `${law} on input ${x}`);
        }
    };

    it('should satisfy left identity: pure >=> f is f', async function () {
        for (const f of steps)
            await assertEquivalent(effectPipe(Success, f), effectPipe(f), `left identity for ${f.name}`);
    });

    it('should satisfy right identity: f >=> pure is f', async function () {
        for (const f of steps)
            await assertEquivalent(effectPipe(f, Success), effectPipe(f), `right identity for ${f.name}`);
    });

    it('should satisfy associativity: (f >=> g) >=> h is f >=> (g >=> h) across every node type', async function () {
        /** @type {[LawStep, LawStep, LawStep][]} */
        const triples = [
            [double, addBonus, guarded],
            [addBonus, retried, guarded],
            [retried, double, addBonus],
            [guarded, retried, double]
        ];
        for (const [f, g, h] of triples) {
            await assertEquivalent(
                effectPipe(effectPipe(f, g), h),
                effectPipe(f, effectPipe(g, h)),
                `associativity for ${f.name}, ${g.name}, ${h.name}`
            );
        }
    });

    it('should compose through every node type to the value the steps compute by hand', async function () {
        // The laws above are equations between two compositions, so a `bind` that dropped every
        // continuation would still satisfy them, both sides being equally broken. This anchors them:
        // one composition through every node type has to reach the value and perform the I/O that
        // applying the steps one after another would.
        const result = await observe(effectPipe(double, addBonus, retried, guarded), 10);
        assert.deepEqual(result, {
            result: Success(52),
            calls: ['double:10', 'increment:25', 'echo:26']
        });
    });

    it('should short-circuit lawfully: a Failure ignores every later step', async function () {
        // The Either half of the structure: bind on the failed case is constant, so composing anything
        // after a Failure changes neither the outcome nor the I/O performed.
        const fail = () => Failure('stop');
        await assertEquivalent(
            effectPipe(double, fail, retried, guarded),
            effectPipe(double, fail),
            'failure absorption'
        );
    });
});

describe('Malformed flows', function () {
    beforeEach(() => configureEffect());

    /** @param {() => any} fn */
    const errorFrom = async (fn) => {
        try {
            await fn();
            return null;
        } catch (e) {
            return /** @type {any} */ (e);
        }
    };

    it('should name the step that returned something other than an Effect', async function () {
        function validateRegistration(/** @type {any} */ input) {
            return { ...input, ok: true }; // forgot Success()
        }
        const e = await errorFrom(() =>
            runEffect(effectPipe(validateRegistration, (/** @type {any} */ i) => Success(i))({ id: 1 }))
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /Step 'validateRegistration' returned a plain object/);
        assert.match(e.message, /Success\(value\)/, 'the message says what to do about it');
    });

    it('should name a step that returned null', async function () {
        function lookupUser() {
            return null;
        }
        const e = await errorFrom(() => runEffect(effectPipe(/** @type {any} */ (lookupUser))({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /Step 'lookupUser' returned null\./);
    });

    it('should name a type the library does not recognise', async function () {
        function saveUser(/** @type {any} */ input) {
            return { type: 'Sucess', value: input }; // a typo for Success
        }
        const e = await errorFrom(() => runEffect(effectPipe(/** @type {any} */ (saveUser))({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /Step 'saveUser' returned an object with an unrecognised type 'Sucess'\./);
    });

    it('should check a Command built by hand as the flow is built, when a step follows it', function () {
        // `chain` rebuilds a Command through its constructor, which checks its function. Copied with a spread
        // instead, a `cmd` that is not a function would throw only when it ran, as an I/O fault a Retry retries.
        const handBuilt = () => /** @type {any} */ ({ type: 'Command', cmd: 42, next: Success });
        assert.throws(
            () => effectPipe(handBuilt, (/** @type {any} */ x) => Success(x))(1),
            (/** @type {any} */ e) =>
                e.name === 'EffectTypeError' &&
                /Command expects the function that does the I\/O, got the number 42\./.test(e.message)
        );
    });

    it('should call a missing return what it usually is', async function () {
        function ensureEmailAvailable() {}
        const e = await errorFrom(() => runEffect(effectPipe(/** @type {any} */ (ensureEmailAvailable))({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /returned undefined, which usually means a missing return/);
    });

    it('should reject a Command continuation that returns nothing at the end of a pipeline', async function () {
        // The last step's continuation is reached only through effectPipe's identity pass, which routes it
        // back through `chain`. Without a guard there, `undefined.type` threw a bare TypeError inside the
        // interpreter's try block and the run resolved to a domain Failure carrying it, so the flow bug
        // took the business-error branch and no step was named.
        const e = await errorFrom(() =>
            runEffect(
                effectPipe((/** @type {any} */ x) =>
                    Command(
                        function cmdRead() {
                            return x;
                        },
                        /** @type {any} */ (() => undefined)
                    )
                )(5)
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(
            e.message,
            /The next of Command 'cmdRead' returned undefined, which usually means a missing return/
        );
    });

    it('should reject a Command continuation that returns nothing in the middle of a pipeline', async function () {
        const e = await errorFrom(() =>
            runEffect(
                effectPipe(
                    (/** @type {any} */ x) =>
                        Command(
                            function cmdRead() {
                                return x;
                            },
                            /** @type {any} */ (() => undefined)
                        ),
                    (/** @type {any} */ y) => Success(y)
                )(5)
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /The next of Command 'cmdRead' returned undefined/);
    });

    it('should reject a Command continuation that returns a plain value in the middle of a pipeline', async function () {
        const e = await errorFrom(() =>
            runEffect(
                effectPipe(
                    (/** @type {any} */ x) =>
                        Command(
                            function cmdRead() {
                                return x;
                            },
                            /** @type {any} */ ((/** @type {number} */ r) => r + 1)
                        ),
                    (/** @type {any} */ y) => Success(y)
                )(5)
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /The next of Command 'cmdRead' returned the number 6/);
    });

    it('should reject a Command continuation that returns a plain value', async function () {
        // This used to resolve to 6, so `result.type === 'Success'` quietly took the else branch.
        const e = await errorFrom(() =>
            runEffect(
                Command(
                    function cmdRead() {
                        return 5;
                    },
                    (/** @type {any} */ r) => r + 1
                )
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /The next of Command 'cmdRead' returned the number 6/);
    });

    it('should name the node whose next returned something other than an Effect', async function () {
        // The message said only that the flow or a continuation had, so finding the culprit meant reading every next.
        const fromParallel = await errorFrom(() => runEffect(Parallel([Success(1)], /** @type {any} */ (() => 2))));
        assert.match(fromParallel?.message, /The next of a Parallel returned the number 2/);
        const fromAsk = await errorFrom(() => runEffect(Ask(/** @type {any} */ (() => 2))));
        assert.match(fromAsk?.message, /The next of an Ask returned the number 2/);
    });

    it('should recognise a flow that was never called with its input', async function () {
        // runEffect(effectPipe(...)) rather than runEffect(effectPipe(...)(input)).
        const e = await errorFrom(() =>
            runEffect(/** @type {any} */ (effectPipe((/** @type {any} */ i) => Success(i))))
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /a function, which usually means a flow was passed without being called/);
    });

    it('should name a missing return when the flow itself is undefined', async function () {
        // runEffect(flow(input)) where flow forgot to return its pipeline.
        const e = await errorFrom(() => runEffect(/** @type {any} */ (undefined)));
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /The flow returned undefined, which usually means a missing return/);
    });

    it('should not disguise a malformed flow as a domain Failure', async function () {
        // The interpreter turns a thrown Command into a Failure; a bug in the flow must still throw.
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(
                        function cmdRead() {
                            return { id: 1 };
                        },
                        (/** @type {any} */ r) => Success(r)
                    ),
                function afterRead(/** @type {any} */ r) {
                    return r; // forgot Success()
                }
            )(input);
        const e = await errorFrom(() => runEffect(flow({ id: 1 })));
        assert.equal(e?.name, 'EffectTypeError', 'thrown rather than folded into a Failure');
        assert.match(e.message, /Step 'afterRead'/);
    });

    it('should still turn a thrown Command into a Failure', async function () {
        const result = await runEffect(
            Command(
                function cmdBoom() {
                    throw new Error('boom');
                },
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(result.type, 'Failure', 'domain failures are unaffected by the new guard');
        assert.equal(/** @type {Error} */ (errorOf(result)).message, 'boom');
    });

    it('should call an async step what it is, rather than asking for Success', async function () {
        // An async function returns a Promise even when its body returns Success, so "wrap it in
        // Success" was advice the developer had already followed.
        const e = await errorFrom(() =>
            effectPipe(
                /** @type {any} */ (
                    async function loadDefaults(/** @type {any} */ x) {
                        return Success(x);
                    }
                )
            )({})
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /Step 'loadDefaults' returned a Promise, which usually means an async function/);
        assert.match(e.message, /do the awaited work in a Command/, 'the message says where the awaited work belongs');
        assert.doesNotMatch(e.message, /Success\(value\)/);
    });

    it('should call an async Command next what it is', async function () {
        const e = await errorFrom(() =>
            runEffect(
                effectPipe(() =>
                    Command(
                        function cmdFind() {
                            return 1;
                        },
                        /** @type {any} */ (async (/** @type {any} */ r) => Success(r))
                    )
                )({})
            )
        );
        assert.equal(e?.name, 'EffectTypeError');
        assert.match(e.message, /The next of Command 'cmdFind' returned a Promise/);
    });

    it('should not leave a throwing async step as an unhandled rejection', async function () {
        // The EffectTypeError reports the bug. The step's own Promise rejecting with nothing attached
        // used to crash the process on top of it, after the caller had already caught the error.
        /** @type {unknown[]} */
        const unhandled = [];
        const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            const e = await errorFrom(() =>
                effectPipe(
                    /** @type {any} */ (
                        async function validate() {
                            throw new Error('email required');
                        }
                    )
                )({})
            );
            assert.equal(e?.name, 'EffectTypeError');
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        assert.deepEqual(unhandled, []);
    });
});

describe('Constructor arguments', function () {
    beforeEach(() => configureEffect());

    /**
     * The message of the EffectTypeError a constructor throws.
     * @param {() => unknown} build
     * @returns {string}
     */
    const messageFrom = (build) => {
        try {
            build();
        } catch (e) {
            const error = /** @type {any} */ (e);
            assert.equal(error.name, 'EffectTypeError');
            return String(error.message);
        }
        return assert.fail('expected the constructor to throw');
    };

    it('should refuse a Command handed a Promise', async function () {
        // `Command(db.findUser(email))` runs the query when the flow is built, where recording never sees it
        // and a replay repeats it. The Command then counted as an I/O fault and was retried.
        /** @type {unknown[]} */
        const unhandled = [];
        const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
            const message = messageFrom(() => Command(/** @type {any} */ (Promise.reject(new Error('down')))));
            assert.match(message, /Command expects a function, got a Promise/);
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        assert.deepEqual(unhandled, [], 'the reported Promise must not also crash the process');
    });

    it('should refuse a Command without a function', function () {
        // A missing argument is named plainly: a misspelt import is likelier than a missing return.
        assert.match(
            messageFrom(() => Command(/** @type {any} */ (undefined))),
            /Command expects .*, got undefined\.$/
        );
        assert.match(
            messageFrom(() => Command(() => 1, /** @type {any} */ ('next'))),
            /next must be a function/
        );
    });

    it('should refuse meta in the place of next before the Command can run', function () {
        // The Command used to run, charging the card, and the run then rejected with `effect.next is not a function`.
        let charged = 0;
        const message = messageFrom(() => Command(() => charged++, /** @type {any} */ ({ name: 'chargeCard' })));
        assert.match(message, /Command\(fn, undefined, \{ name: 'chargeCard' \}\)/);
        assert.equal(charged, 0);
    });

    it('should treat a null next as skipped, as it treats undefined', async function () {
        const plain = Command(function cmdPlain() {
            return 7;
        }, /** @type {any} */ (null));
        assert.deepEqual(await runEffect(plain), Success(7));
    });

    it('should refuse a Parallel given anything but an array of Effects', function () {
        const map = /** @type {any} */ ({ user: Success(1) });
        assert.match(
            messageFrom(() => Parallel(map)),
            /array of Effects, got a plain object/
        );
        assert.match(
            messageFrom(() => Parallel(/** @type {any} */ (Success(1)))),
            /array of Effects, got an Effect of type 'Success'/
        );
        assert.match(
            messageFrom(() => Parallel([Success(1), /** @type {any} */ (undefined)])),
            /branch 1 is undefined/
        );
        assert.match(
            messageFrom(() => Parallel([Success(1)], /** @type {any} */ (5))),
            /second argument .*the number 5/
        );
        assert.match(
            messageFrom(() => Parallel([Success(1)], /** @type {any} */ (undefined), /** @type {any} */ (5))),
            /options .*the number 5/
        );
    });

    it('should refuse a third argument that a Parallel given its options second would ignore', function () {
        // With the options second nothing reads a third argument, so `Parallel(effects, { limit: 1 }, next)` ran
        // without its next and handed the values on unchanged. Only TypeScript refused it.
        const parallel = /** @type {any} */ (Parallel);
        const next = (/** @type {any[]} */ values) => Success(values.length);
        assert.match(
            messageFrom(() => parallel([Success(1)], { limit: 1 }, next)),
            /next goes second and its options third: Parallel\(effects, next, options\)/
        );
        assert.match(
            messageFrom(() => parallel([Success(1)], { limit: 1 }, { settled: true })),
            /one options object.*a plain object, would be ignored/
        );
        // An absent third argument, as a caller forwarding one may pass, is still fine.
        assert.doesNotThrow(() => parallel([Success(1)], { limit: 1 }, undefined));
        assert.doesNotThrow(() => parallel([Success(1)], { limit: 1 }, null));
    });

    it('should refuse a Retry given the step instead of its Effect, or a bare number of attempts', function () {
        const fetchPrice = () => Success(1);
        assert.match(
            messageFrom(() => Retry(/** @type {any} */ (fetchPrice))),
            /without being called with its input/
        );
        assert.match(
            messageFrom(() => Retry(Success(1), /** @type {any} */ (3))),
            /Retry\(effect, \{ attempts: 3 \}\)/
        );
        assert.doesNotMatch(
            messageFrom(() => Retry(Success(1), /** @type {any} */ ('fast'))),
            /attempts/
        );
    });

    it('should refuse an option name a Retry or Parallel does not read', function () {
        // A name it does not read ran with the default and nothing to say so: `{ concurrency: 4 }`, the word p-limit
        // uses, ran a batch with no limit, `{ settle: true }` ran it fail-fast, and `{ attemps: 5 }` got 3 attempts.
        const effects = [Success(1)];
        assert.match(
            messageFrom(() => Parallel(effects, /** @type {any} */ ({ concurrency: 4 }))),
            /Parallel has no option named 'concurrency'; its options are limit and settled\./
        );
        // Cast: the declarations take a next function second whenever options come third.
        const parallel = /** @type {any} */ (Parallel);
        assert.match(
            messageFrom(() => parallel(effects, undefined, { settle: true })),
            /'settle'/
        );
        assert.match(
            messageFrom(() => Retry(Success(1), /** @type {any} */ ({ attemps: 5 }))),
            /Retry has no option named 'attemps'; its options are attempts, delay, backoff and onExhausted\./
        );
        // An option set to undefined is still one it reads, which is how an absent config key arrives.
        assert.doesNotThrow(() => Retry(Success(1), { attempts: undefined, delay: undefined }));
        assert.doesNotThrow(() => Parallel(effects, { limit: undefined, settled: undefined }));
    });

    it('should name the position of an effectPipe step that is not a function', function () {
        const validate = (/** @type {any} */ input) => Success(input);
        assert.match(
            messageFrom(() => effectPipe(validate, /** @type {any} */ (undefined))),
            /step 2 is undefined/
        );
    });

    it('should refuse an Ask without a function', function () {
        assert.match(
            messageFrom(() => Ask(/** @type {any} */ (undefined))),
            /Ask expects .*, got undefined/
        );
    });

    it('should reject the run rather than retry when a Command function builds a malformed Command', async function () {
        // The EffectTypeError is a harness error, so it is not taken for the I/O failing: no second attempt and
        // no fallback.
        let calls = 0;
        const buildsBadly = Command(function cmdBuildsSubflow() {
            calls++;
            return Command(/** @type {any} */ (undefined));
        });
        const fallback = /** @type {any} */ (() => Success('fallback'));
        await assert.rejects(() => runEffect(Retry(buildsBadly, { delay: 1, onExhausted: fallback })), {
            name: 'EffectTypeError'
        });
        assert.equal(calls, 1);
    });
});

describe('Command identity', function () {
    beforeEach(() => configureEffect());

    /** Captures the name each Command is executed under. */
    const capture = () => {
        /** @type {string[]} */
        const names = [];
        return {
            names,
            onStep: async (/** @type {any} */ name, /** @type {any} */ t, /** @type {any} */ op) => (
                names.push(name),
                await op()
            )
        };
    };

    it('should default next to Success so a result passes straight through', async function () {
        const result = await runEffect(Command(() => 'ok'));
        assert.equal(result.type, 'Success');
        assert.equal(valueOf(result), 'ok');
    });

    it('should prefer meta.name over the thunk name', async function () {
        const { names, onStep } = capture();
        const effect = Command(
            function cmdInternalName() {
                return 'ok';
            },
            (/** @type {any} */ v) => Success(v),
            { name: 'chargeCard' }
        );
        assert.equal(valueOf(await runEffect(effect, {}, { onStep })), 'ok');
        assert.deepEqual(names, ['chargeCard']);
    });

    it('should let an inline thunk be identified through meta.name', async function () {
        const { names, onStep } = capture();
        const effect = Command(
            () => 'ok',
            (/** @type {any} */ v) => Success(v),
            { name: 'cmdInline' }
        );
        await runEffect(effect, {}, { onStep });
        assert.deepEqual(names, ['cmdInline'], 'no longer anonymous');
    });

    it('should fall back to the thunk name when meta carries no name', async function () {
        const { names, onStep } = capture();
        const effect = Command(
            function cmdNamed() {
                return 'ok';
            },
            (/** @type {any} */ v) => Success(v),
            { attempt: 1 }
        );
        await runEffect(effect, {}, { onStep });
        assert.deepEqual(names, ['cmdNamed']);
    });

    it('should fall back to anonymous when neither is available', async function () {
        const { names, onStep } = capture();
        await runEffect(
            Command(
                () => 'ok',
                (/** @type {any} */ v) => Success(v)
            ),
            {},
            { onStep }
        );
        assert.deepEqual(names, ['anonymous']);
    });

    it('should ignore a meta that is not an object or has a non-string name', async function () {
        const { names, onStep } = capture();
        const named = () =>
            Command(
                function cmdFallback() {
                    return 'ok';
                },
                (/** @type {any} */ v) => Success(v)
            );
        for (const meta of /** @type {any[]} */ (['a string', 42, null, { name: 7 }, { name: '' }])) {
            const effect = Command(named().cmd, (/** @type {any} */ v) => Success(v), meta);
            await runEffect(effect, {}, { onStep });
        }
        assert.deepEqual(names, ['cmdFallback', 'cmdFallback', 'cmdFallback', 'cmdFallback', 'cmdFallback']);
    });

    it('should carry meta.name through effectPipe into a trace and a replay', async function () {
        const flow = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) =>
                    Command(
                        () => ({ row: i.id }),
                        (/** @type {any} */ r) => Success(r),
                        { name: 'readRow' }
                    ),
                (/** @type {any} */ r) =>
                    Command(
                        () => ({ written: r.row }),
                        (/** @type {any} */ w) => Success(w),
                        { name: 'writeRow' }
                    )
            )(input);

        const { result, trace } = await recordEffect(flow, { id: 'x1' });
        assert.deepEqual(
            trace.trace.map((e) => e.command),
            ['readRow', 'writeRow'],
            'meta.name survives the rebuild chain performs on each pipe step'
        );

        const { result: replayed } = await replayEffect(flow({ id: 'x1' }), trace);
        assert.equal(replayed.type, 'Success', 'replay matching lines up on meta.name');
        assert.deepEqual(valueOf(replayed), valueOf(result));
    });

    it('should name a Command with commandName the way a trace does', function () {
        // A test walking a flow read `cmd.name`, which is empty for an inline arrow named through meta.name,
        // so the only way to check such a step was to copy the identity rule into the test.
        const cmdInternalName = () => 'ok';
        const cmdFallback = () => 'ok';
        assert.equal(commandName(Command(cmdInternalName, undefined, { name: 'chargeCard' })), 'chargeCard');
        assert.equal(commandName(Command(() => 'ok', undefined, { name: 'cmdInline' })), 'cmdInline');
        assert.equal(commandName(Command(cmdFallback, undefined, { attempt: 1 })), 'cmdFallback');
        assert.equal(commandName(Command(() => 'ok')), 'anonymous');
        for (const meta of /** @type {any[]} */ (['a string', 42, null, { name: 7 }, { name: '' }])) {
            assert.equal(commandName(Command(cmdFallback, undefined, meta)), 'cmdFallback', JSON.stringify(meta));
        }
    });

    it('should refuse to name anything but a Command', function () {
        // A walk that expected a Command and reached a Failure read `cmd.name` off undefined, and the
        // TypeError named neither the step it got nor the one it expected.
        assert.throws(() => commandName(/** @type {any} */ (Failure('Email already in use.'))), {
            name: 'EffectTypeError',
            message: /commandName expects a Command, got an Effect of type 'Failure'/
        });
        assert.throws(() => commandName(/** @type {any} */ (undefined)), {
            name: 'EffectTypeError',
            message: /commandName expects a Command, got undefined/
        });
    });
});

describe('The flow input', function () {
    beforeEach(() => configureEffect());

    const input = { customerId: 'cu1', password: 'hunter2' };
    /** @param {string} id */
    const lookup = (id) =>
        Command(
            () => ({ id }),
            (/** @type {any} */ r) => Success(r),
            { name: 'cmdLookup' }
        );

    /** What a hook-based recorder stores as the trace's input: what `onRun` is handed. */
    const inputSeenByOnRun = async (/** @type {any} */ tree) => {
        /** @type {any} */
        let seen = 'not called';
        await runEffect(
            tree,
            {},
            {
                onRun: async (effect, op, flowName, initialInput) => ((seen = initialInput), await op())
            }
        );
        return seen;
    };

    it('should hand onRun the input of a flow effectPipe built', async function () {
        const flow = effectPipe((/** @type {any} */ i) => lookup(i.customerId));
        assert.deepEqual(await inputSeenByOnRun(flow(input)), input);
    });

    it('should hand onRun the input of a flow that stops before its first Command', async function () {
        // A failed validation is the run a recorder keeps by default, so its trace needs the input most.
        const flow = effectPipe(() => Failure('Invalid email.'), lookup);
        assert.deepEqual(await inputSeenByOnRun(flow(input)), input);
    });

    it('should hand onRun no input for a flow whose root is a bare Command', async function () {
        assert.equal(await inputSeenByOnRun(lookup('cu1')), undefined);
    });

    it('should hand onRun the flow input through a Retry-headed sub-pipeline', async function () {
        const viaRetry = (/** @type {any} */ i) =>
            effectPipe((/** @type {string} */ id) => Retry(lookup(id), { attempts: 1, delay: 0 }))(i.customerId);
        const tree = effectPipe(viaRetry, (/** @type {any} */ r) => Success(r))(input);
        assert.deepEqual(await inputSeenByOnRun(tree), input, 'the flow input, not the sub-pipeline input');
    });

    it('should hand onRun the flow input through a Parallel-headed sub-pipeline', async function () {
        const viaParallel = (/** @type {any} */ i) =>
            effectPipe((/** @type {string} */ id) => Parallel([lookup(id)]))(i.customerId);
        const tree = effectPipe(viaParallel, (/** @type {any} */ r) => Success(r))(input);
        assert.deepEqual(await inputSeenByOnRun(tree), input);
    });

    it('should hand onRun the outermost input through two levels of nesting', async function () {
        const innermost = (/** @type {string} */ id) => effectPipe(lookup, () => Failure('deep'))(id);
        const middle = (/** @type {any} */ i) => effectPipe(innermost)(i.customerId);
        assert.deepEqual(await inputSeenByOnRun(effectPipe(middle)(input)), input);
    });

    it("should hand onRun a sub-pipeline's own input when that pipeline is the flow", async function () {
        // Nothing outer exists here, so the input is what this pipeline was called with.
        assert.equal(await inputSeenByOnRun(effectPipe(lookup, () => Failure('bad'))('cu1')), 'cu1');
    });

    it('should hand each flow its own input when their steps return the same Failure', async function () {
        // One Failure object shared by every run, as a module constant is, must not carry one run's input into another.
        const notFound = Failure('not found');
        const flow = effectPipe(() => notFound);
        const first = flow({ id: 1 });
        const second = flow({ id: 2 });
        assert.deepEqual(await inputSeenByOnRun(first), { id: 1 });
        assert.deepEqual(await inputSeenByOnRun(second), { id: 2 });
    });

    it('should hand the input to every onRun layer', async function () {
        /** @type {any[]} */
        const seen = [];
        /** @param {string} name */
        const layer = (name) => ({
            /** @type {import('../index.js').RunWrapper} */
            onRun: async (effect, op, flowName, initialInput) => (seen.push([name, initialInput]), await op())
        });
        configureEffect(layer('first'), layer('second'));
        configureEffect(layer('third'));
        await runEffect(effectPipe(lookup)('cu1'), {}, layer('call'));
        assert.deepEqual(seen, [
            ['first', 'cu1'],
            ['second', 'cu1'],
            ['third', 'cu1'],
            ['call', 'cu1']
        ]);
    });

    it('should hand onRun the input under a replay that runs the hooks', async function () {
        const flow = effectPipe((/** @type {any} */ i) => lookup(i.customerId));
        const { trace } = await recordEffect(flow, input);
        /** @type {any} */
        let seen;
        configureEffect({
            onRun: async (effect, op, flowName, initialInput) => ((seen = initialInput), await op())
        });
        await replayEffect(flow(trace.initialInput), trace, { hooks: true });
        assert.deepEqual(seen, input);
    });

    it('should leave the input off every node of a flow', function () {
        const tree = effectPipe((/** @type {any} */ i) => lookup(i.customerId))(input);
        assert.equal('initialInput' in tree, false, 'a Command at the root');
        assert.equal('initialInput' in effectPipe(() => Failure('bad'))(input), false, 'a Failure at the root');
        assert.equal('initialInput' in effectPipe(() => Ask(() => Success(1)))(input), false, 'an Ask at the root');
        assert.equal('initialInput' in effectPipe(() => Retry(lookup('cu1')))(input), false, 'a Retry at the root');
        assert.equal('initialInput' in effectPipe(() => Parallel([lookup('cu1')]))(input), false, 'a Parallel');
    });

    it('should leave the input off a Failure a pure step returned', function () {
        const inner = (/** @type {any} */ i) =>
            effectPipe((/** @type {string} */ id) => Failure(`no ${id}`))(i.customerId);
        assert.deepEqual(effectPipe(inner)(input), Failure('no cu1'), 'the same Failure a step test sees');
    });

    it('should leave the input off a Failure from inside a sub-pipeline', async function () {
        const inner = (/** @type {any} */ i) => effectPipe(lookup, () => Failure('bad'))(i.customerId);
        const result = await runEffect(effectPipe(inner, (/** @type {any} */ r) => Success(r))(input));
        assert.deepEqual(result, Failure('bad'));
    });

    it('should leave the input off a Failure escaping a Parallel branch', async function () {
        const failingSub = (/** @type {any} */ i) => effectPipe(lookup, () => Failure('bad'))(i.customerId);
        const result = await runEffect(
            effectPipe(
                (/** @type {any} */ i) => Parallel([failingSub(i)]),
                (/** @type {any} */ v) => Success(v)
            )(input)
        );
        assert.deepEqual(result, Failure('bad'));
    });

    it('should leave the input off a Failure from a Retry fallback', async function () {
        const failingSub = (/** @type {any} */ i) => effectPipe(lookup, () => Failure('bad'))(i.customerId);
        const withFallback = (/** @type {any} */ i) =>
            Retry(
                Command(() => {
                    throw new Error('down');
                }),
                { attempts: 1, delay: 0, onExhausted: () => failingSub(i) }
            );
        const result = await runEffect(effectPipe(withFallback, (/** @type {any} */ v) => Success(v))(input));
        assert.deepEqual(result, Failure('bad'));
    });

    it('should leave the input off a Failure from a Command that threw', async function () {
        const boom = new Error('boom');
        const branch = (/** @type {any} */ i) =>
            effectPipe(() =>
                Command(() => {
                    throw boom;
                })
            )(i.customerId);
        const result = await runEffect(
            effectPipe(
                (/** @type {any} */ i) => Parallel([branch(i)]),
                (/** @type {any} */ v) => Success(v)
            )(input)
        );
        assert.deepEqual(result, Failure(boom));
    });

    it('should leave the input off a Failure from an exhausted Retry and a vetoed Command', async function () {
        const down = Command(() => {
            throw new Error('down');
        });
        const exhausted = await runEffect(effectPipe(() => Retry(down, { attempts: 1, delay: 0 }))(input));
        assert.equal(exhausted.type, 'Failure');
        assert.equal('initialInput' in exhausted, false, 'an exhausted Retry');
        const veto = new Error('rate limited');
        const vetoed = await runEffect(
            effectPipe((/** @type {any} */ i) => lookup(i.customerId))(input),
            {},
            {
                onBeforeCommand: () => {
                    throw veto;
                }
            }
        );
        assert.deepEqual(vetoed, Failure(veto), 'a vetoed Command');
    });

    it('should leave the input off the outcomes a settled Parallel hands next', async function () {
        // A registration's input is its credentials, which would otherwise reach any log of the outcomes.
        const register = (/** @type {any} */ creds) =>
            effectPipe(() =>
                Command(function cmdSave() {
                    throw new Error('duplicate key');
                })
            )(creds);
        const result = await runEffect(
            Parallel([register({ email: 'a@b.com', password: 'hunter2' })], {
                settled: true
            })
        );
        assert.equal(result.type, 'Success');
        const [outcome] = /** @type {any} */ (result).value;
        assert.equal(outcome.type, 'Failure');
        assert.equal('initialInput' in outcome, false);
        assert.equal(outcome.error.message, 'duplicate key');
    });
});

describe('Failure provenance', function () {
    beforeEach(function () {
        configureEffect();
    });

    // One failure channel, three kinds of failure. A step returning `Failure` is an abort: the flow has
    // decided, and the shell is what acts on it. A Command whose function throws is an I/O fault, which
    // is what `Retry` exists for. A harness error is not an outcome at all. The interpreter used to
    // flatten the first two together, so `Retry` re-ran a database lookup four times for an answer that
    // could not change, buried the domain error under `retryExhausted`, and let `onExhausted` swallow a
    // deliberate abort and report `Success`.

    const abortingStep = (/** @type {() => void} */ tick) => () => {
        tick();
        return Failure('invalid input');
    };

    it('should not retry an abort from a pure step', async function () {
        let runs = 0;
        const result = await runEffect(Retry(effectPipe(abortingStep(() => runs++))(null), { attempts: 3, delay: 0 }));
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'invalid input', 'an abort arrives unwrapped');
        assert.equal(runs, 1);
    });

    it('should not retry an abort a Command next returned', async function () {
        let lookups = 0;
        const guard = () =>
            Command(
                function cmdLookup() {
                    lookups++;
                    return Promise.resolve({ id: 1 });
                },
                (found) => (found ? Failure('email taken') : Success('free'))
            );
        const result = await runEffect(Retry(effectPipe(guard)(null), { attempts: 3, delay: 0 }));
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'email taken');
        assert.equal(lookups, 1, 'the answer cannot change, so it is asked for once');
    });

    it('should still retry an I/O fault and wrap the exhaustion', async function () {
        let calls = 0;
        const flaky = () =>
            Command(function cmdFlaky() {
                calls++;
                return Promise.reject(new Error('socket reset'));
            });
        const result = await runEffect(Retry(flaky(), { attempts: 3, delay: 0 }));
        assert.equal(result.type, 'Failure');
        assert.equal(calls, 4);
        assert.equal(/** @type {any} */ (result).error.retryExhausted, true);
        assert.equal(/** @type {any} */ (result).error.lastError.message, 'socket reset');
    });

    it('should keep onExhausted away from an abort', async function () {
        let fallbacks = 0;
        const result = await runEffect(
            Retry(effectPipe(abortingStep(() => {}))(null), {
                attempts: 1,
                delay: 0,
                onExhausted: () => {
                    fallbacks++;
                    return Success('swallowed');
                }
            })
        );
        assert.equal(result.type, 'Failure');
        assert.equal(result.error, 'invalid input');
        assert.equal(fallbacks, 0, 'an abort is not something a fallback may answer');
    });

    it('should still let onExhausted answer an I/O exhaustion', async function () {
        const result = await runEffect(
            Retry(
                Command(function cmdFlaky() {
                    return Promise.reject(new Error('socket reset'));
                }),
                { attempts: 1, delay: 0, onExhausted: () => Success('cached') }
            )
        );
        assert.deepEqual(result, Success('cached'));
    });

    it('should treat a thrown non-Error as an I/O fault too', async function () {
        let calls = 0;
        const result = await runEffect(
            Retry(
                Command(function cmdRejects() {
                    calls++;
                    return Promise.reject('a string');
                }),
                { attempts: 2, delay: 0 }
            )
        );
        assert.equal(calls, 3);
        assert.equal(/** @type {any} */ (result).error.lastError, 'a string');
    });

    it('should carry provenance out of a Parallel branch', async function () {
        let aborts = 0;
        let faults = 0;
        const abortBranch = () =>
            Retry(Parallel([effectPipe(abortingStep(() => aborts++))(null), Success(1)]), {
                attempts: 3,
                delay: 0
            });
        const faultBranch = () =>
            Retry(
                Parallel([
                    Command(function cmdThrows() {
                        faults++;
                        return Promise.reject(new Error('down'));
                    }),
                    Success(1)
                ]),
                { attempts: 2, delay: 0 }
            );
        const aborted = await runEffect(abortBranch());
        assert.equal(/** @type {any} */ (aborted).error, 'invalid input');
        assert.equal(aborts, 1, 'an abort inside a branch is still an abort');
        await runEffect(faultBranch());
        assert.equal(faults, 3, 'an I/O fault inside a branch is still a fault');
    });

    it('should treat a settled outcome a step returns as an abort, whatever the input', async function () {
        // A settled Parallel hands `next` plain Failures, so returning one is a step returning a Failure.
        // Provenance used to ride on the object as a hidden mark that `chain` dropped only when the
        // pipeline had an input, so the same flow retried or not depending on that.
        for (const input of [undefined, 'in']) {
            let calls = 0;
            const flow = effectPipe(
                () =>
                    Parallel(
                        [
                            Command(function cmdThrows() {
                                calls++;
                                return Promise.reject(new Error('down'));
                            })
                        ],
                        { settled: true }
                    ),
                (/** @type {any[]} */ outcomes) => outcomes[0]
            );
            const result = await runEffect(Retry(flow(input), { attempts: 2, delay: 0 }));
            assert.equal(calls, 1, `not retried with input ${input}`);
            assert.equal(/** @type {any} */ (result).error.message, 'down', 'and not wrapped as an exhaustion');
        }
    });

    it('should treat an inner exhaustion as a fault so nested Retry still retries', async function () {
        let calls = 0;
        const inner = () =>
            Retry(
                Command(function cmdFlaky() {
                    calls++;
                    return Promise.reject(new Error('down'));
                }),
                { attempts: 1, delay: 0 }
            );
        await runEffect(Retry(inner(), { attempts: 1, delay: 0 }));
        assert.equal(calls, 4, 'two attempts of the inner Retry, twice');
    });

    it('should hand the caller a plain Failure for an I/O fault', async function () {
        // Provenance lives only inside the interpreter, so a fault and an abort reach the caller as the
        // same two-key Failure and compare equal to one written by hand.
        const thrown = await runEffect(
            effectPipe(() =>
                Command(function cmdThrows() {
                    return Promise.reject(new Error('down'));
                })
            )('in')
        );
        assert.deepEqual(Object.keys(thrown), ['type', 'error']);
        assert.equal(JSON.parse(JSON.stringify(thrown)).type, 'Failure');
        assert.deepStrictEqual(thrown, Failure(/** @type {any} */ (thrown).error));

        const aborted = await runEffect(effectPipe(() => Failure('nope'))('in'));
        assert.deepStrictEqual(aborted, Failure('nope'));
    });
});
