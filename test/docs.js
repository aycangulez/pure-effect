// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Retry,
    Parallel,
    effectPipe,
    runEffect,
    configureEffect,
    recordEffect,
    replayEffect,
    recorder,
    Ask,
    effectGen,
    step
} from '../index.js';
import * as lib from '../index.js';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { effectPipeOverloads, currentOverloads } from '../scripts/effect-pipe-overloads.js';
import { rulesFile, rulesSection, githubAnchor, headingAnchors } from '../scripts/rules-file.js';
import { errorOf, consumerFilesTypeErrors } from './helpers.js';

describe('README examples', function () {
    // The README is code readers copy, and for most of this project's life no test ran it. Two wrong
    // examples shipped that way. A guard whose `next` returned `Success(true)`, so the flow saved
    // `true` and never saw the registration data. And a walk that fed a found user to the email
    // guard, then asserted the save step that answer makes unreachable. Both read correctly, which
    // is the whole point: the library's argument is that reading is not verification, and the
    // examples were the one artifact here it had never been applied to. So they are executed. Every
    // `js` block runs as one program with the Quick Start's definitions in scope, which makes every
    // `assert` the README prints a real assertion.
    const markdown = readFileSync('README.md', 'utf8');
    /**
     * The js blocks grouped by the heading they sit under, at any depth. The pattern matches a whole
     * fence before anything inside it, so a `#` comment in a shell block does not count as a heading.
     * @param {string} text
     */
    const jsSections = (text) => {
        const found = /** @type {string[][]} */ ([[]]);
        for (const match of text.matchAll(/^#+ .*$|```(\w*)\n([\s\S]*?)```/gm)) {
            if (match[0].startsWith('#')) found.push([]);
            else if (match[1] === 'js') found[found.length - 1].push(match[2]);
        }
        return found;
    };
    const sections = jsSections(markdown);
    const reference = readFileSync('REFERENCE.md', 'utf8');
    const referenceSections = jsSections(reference);
    const blocks = [...sections.flat(), ...referenceSections.flat()];
    const withoutImports = (/** @type {string} */ code) => code.replace(/^import[^;]*;\s*$/gm, '');
    const AsyncFunction = /** @type {any} */ (Object.getPrototypeOf(async function () {}).constructor);

    beforeEach(function () {
        configureEffect();
    });

    // The Recording in Production and Hooks sections call `configureEffect` themselves, so this suite
    // has to clean up after the examples as well as before them.
    afterEach(function () {
        configureEffect();
    });

    it('should find the examples at all', function () {
        // A regex that silently stops matching would turn every check below into a pass over
        // nothing, which is the failure this whole suite exists to rule out.
        const inReadme = sections.flat().length;
        const inReference = referenceSections.flat().length;
        assert.ok(inReadme >= 20, `expected the README to hold examples, found ${inReadme}`);
        assert.ok(inReference >= 3, `expected REFERENCE.md to hold examples, found ${inReference}`);
    });

    it('should fence only real JavaScript as js', function () {
        blocks.forEach((block, index) => {
            assert.doesNotThrow(
                () => new AsyncFunction(withoutImports(block)),
                `js block ${index + 1} does not parse; fence a value shape as text instead`
            );
        });
    });

    it('should import only names the library exports', function () {
        const shipped = Object.keys(lib);
        const imports = [...(markdown + reference).matchAll(/import\s*\{([^}]*)\}\s*from\s*'pure-effect'/g)];
        assert.ok(imports.length > 0, 'expected the README to import from the package');
        imports.forEach((match) => {
            match[1]
                .split(',')
                .map((name) => name.trim())
                .filter(Boolean)
                .forEach((name) => {
                    assert.ok(shipped.includes(name), `README imports '${name}', which the library does not export`);
                });
        });
    });

    it('should import from pure-effect/flight-recorder only names it exports', async function () {
        const shipped = Object.keys(await import('../flight-recorder.js'));
        const pattern = /import\s*\{([^}]*)\}\s*from\s*'pure-effect\/flight-recorder'/g;
        const imports = [...(markdown + reference).matchAll(pattern)];
        assert.ok(imports.length > 0, 'expected the README to import from pure-effect/flight-recorder');
        for (const match of imports) {
            for (const name of match[1]
                .split(',')
                .map((n) => n.trim())
                .filter(Boolean)) {
                assert.ok(
                    shipped.includes(name),
                    `README imports '${name}', which pure-effect/flight-recorder does not export`
                );
            }
        }
    });

    // The Quick Start's definitions, which every later example may use.
    const [quickStart, ...readmeRest] = sections.filter((section) => section.length > 0);

    // Everything the examples reach for that is not the library. These exist so the flows can be
    // built and walked, not to stand in for a real driver: every assertion the README makes is
    // about a value the library itself produced. `fetch` throws rather than resolving, so an
    // example that starts reaching the network fails here instead of in CI.
    const stubCommand = () =>
        Command(function cmdStub() {
            return Promise.resolve({});
        });
    const stubs = {
        input: { email: 'test@test.com', password: 'password123' },
        db: {
            findUser: async () => null,
            saveUser: async (/** @type {any} */ user) => ({ id: 1, ...user }),
            createWorkspace: async (/** @type {number} */ ownerId) => ({ id: 'ws_1', ownerId, name: 'Personal' })
        },
        mailer: { sendWelcome: async () => ({ sent: true }), sendReceipt: async () => ({ sent: true }) },
        app: { post: () => {} },
        it: () => {},
        fetch: () => {
            throw new Error('a README example must not perform network I/O');
        },
        checkoutFlow: stubCommand,
        mySpans: [{ attributes: { path: '0', output: {} } }],
        flags: { get: async () => false },
        chargeCard: stubCommand,
        sendReceipt: stubCommand,
        validateOrder: stubCommand,
        scheduleShipping: stubCommand,
        cmdFn: () => Promise.resolve({}),
        next: Success,
        order: { id: 'order_1' },
        subscriptions: [{ id: 'sub_1' }, { id: 'sub_2' }],
        billOne: stubCommand,
        fetchPrice: stubCommand,
        cmdHoldSeat: () => Promise.resolve({ holdId: 'seat_1' }),
        trip: { id: 'trip_1' },
        work: [Success(1)],
        pricing: { get: async () => ({ amount: 1 }) },
        // The checkout the shape-changing fix recipe records: a free cart, and a gateway that refuses to charge 0.
        carts: {
            find: async (/** @type {string} */ cartId) => ({ id: cartId, total: cartId === 'cart_free' ? 0 : 120 })
        },
        gateway: {
            charge: async (/** @type {number} */ amount) => {
                if (amount === 0)
                    throw Object.assign(new Error('Amount must be non-zero.'), { code: 'invalid_amount' });
                return { chargeId: 'ch_1', amount };
            }
        },
        orderStore: {
            save: async () => ({ orderId: 'order_1' }),
            markPaid: async (/** @type {string} */ orderId) => ({ orderId, paid: true })
        },
        // The ending-early example's event log, which its walk never calls.
        eventLog: { claim: async () => true },
        // The try/catch translation's refund: a reservation that fails after the charge went through.
        warehouse: {
            reserve: async () => {
                throw new Error('out of stock');
            }
        },
        // The services the undo and loop examples call.
        payments: {
            charge: async () => ({ ok: true, chargeId: 'ch_1' }),
            refund: async () => ({ refunded: true })
        },
        inventory: { reserve: async () => ({ ok: true, reservationId: 'res_1' }) },
        sku: 'sku_1',
        summarize: (/** @type {any} */ outcome) => outcome.type,
        sink: () => {},
        telemetryHooks: () => ({}),
        recordingHooks: () => ({}),
        enableRecording: () => () => {},
        // Real: the Hooks example shows a scope reaching every hook, which only the real one does.
        AsyncLocalStorage
    };

    /**
     * Runs the Quick Start's blocks, then `extra`, then each of `given` in a scope of its own. Every
     * section after the Quick Start gets its own scope so two sections can name the same helper without
     * colliding. Within a section each block's scope sits inside the one before it: a block sees what the
     * blocks above it defined, as a reader does, so a test can follow the code it tests, and two
     * independent examples can still both declare `result`.
     * @param {string[][]} given
     * @param {string} [extra]
     */
    const runExamples = async (given, extra = '') => {
        const nested = (/** @type {string[]} */ section) =>
            section.reduceRight((inner, block) => `{\n${withoutImports(block)}\n${inner}}\n`, '');
        const program =
            quickStart.map(withoutImports).join('\n') +
            '\n' +
            extra +
            '\n' +
            given
                .filter((section) => section.length > 0)
                .map(nested)
                .join('');
        const log = console.log;
        console.log = () => {}; // timeTravel narrates, and that is its job rather than this suite's
        try {
            const run = new AsyncFunction(...Object.keys(lib), 'assert', ...Object.keys(stubs), program);
            await run(...Object.values(lib), assert, ...Object.values(stubs));
        } finally {
            console.log = log;
        }
    };

    it('should run every example, assertions included, without performing I/O', async function () {
        // The Quick Start shows one flow written two ways, and they must stay the same flow.
        const sameFlow = `
            for (const given of [input, { email: 'bad-email', password: 'password123' }]) {
                const piped = await recordEffect(registerUserFlow(given));
                const generated = await recordEffect(registerUserFlowGen(given));
                assert.deepEqual(generated.result, piped.result);
                const shape = (log) => log.trace.map(({ command, path, result }) => ({ command, path, result }));
                assert.deepEqual(shape(generated.trace), shape(piped.trace));
            }
        `;
        await runExamples(readmeRest, sameFlow);
    });

    it('should run every REFERENCE.md example, with the Quick Start in scope', async function () {
        await runExamples(referenceSections);
    });
});

describe('README TypeScript examples', function () {
    // The ts blocks once held `{ ... }` where a function's body went, and no test compiled them, so a TypeScript
    // reader got examples that did not build. Each now compiles as a file of its own in a strict project, as a
    // reader's copy would, with every library export in scope and stubs for what the example leaves out.
    const markdown = readFileSync('README.md', 'utf8');
    const tsBlocks = [...markdown.matchAll(/^#+ (.*)$|```(\w*)\n([\s\S]*?)```/gm)].reduce(
        (found, match) => {
            if (match[1] !== undefined) found.heading = match[1];
            else if (match[2] === 'ts') found.blocks.push({ heading: found.heading, code: match[3] });
            return found;
        },
        { heading: '', blocks: /** @type {{ heading: string, code: string }[]} */ ([]) }
    ).blocks;

    // What each example reaches for that is not the library, by the heading it sits under.
    /** @type {Record<string, string>} */
    const stubs = {
        'Error union across pipeline steps': `
            declare function submitSignup(input: { email: string }): Effect<{ id: number }, ApiError>;`,
        'Handling every error': `
            declare function billTenant(tenantId: string): Effect<{ amount: number }, BillingError | RetryExhaustedError>;
            declare function billed(value: { amount: number }): string;
            declare function retryLater(retries: number): string;
            declare function serverError(error: unknown): string;
            declare function skipTenant(): string;
            declare function notifyDecline(code: string): string;`,
        'Typed context with `Ask`': `
            type Product = { id: string; name: string };
            declare const catalog: { find(tenant: string, id: string): Promise<Product | null> };`,
        'Generator flows': `
            type User = { id: number; email: string };
            declare function findUser(email: string): Effect<User | null, never>;
            declare function saveUser(input: { email: string }): Effect<User, 'db_unavailable'>;`,
        'A flow with no input': `
            declare function listUsers(): Effect<{ id: number }[], never>;`,
        'Testing a flow in TypeScript': `
            declare const input: { email: string; password: string };
            declare function registerUserFlow(input: { email: string; password: string }): Effect<{ id: number }, string>;
            declare function saveUserWithRetry(input: { email: string; password: string }): Effect<{ id: number }, string>;`,
        'Replaying in TypeScript': `
            declare function registerUserFlow(input: Signup): Effect<{ id: number; email: string }, string>;
            declare function readTrace(id: string): Promise<string>;`
    };

    // Every export in scope, so an example may leave its imports out as a js block does; its own imports from the
    // library are dropped so the two do not clash, and any other import stays.
    const exportedTypes = [...readFileSync('index.d.ts', 'utf8').matchAll(/^export (?:type|interface) (\w+)/gm)].map(
        (match) => match[1]
    );
    const header =
        `import { ${Object.keys(lib).join(', ')} } from 'pure-effect';\n` +
        `import type { ${exportedTypes.join(', ')} } from 'pure-effect';\n`;
    const withoutLibraryImports = (/** @type {string} */ code) =>
        code.replace(/^import[^;]*from 'pure-effect';\s*$/gm, '');

    it('should find the examples at all', function () {
        assert.ok(tsBlocks.length >= 7, `expected the README to hold ts examples, found ${tsBlocks.length}`);
    });

    it('should compile every ts block in a strict TypeScript project', function () {
        this.timeout(20000);
        /** @type {Record<string, string>} */
        const files = {};
        tsBlocks.forEach(({ heading, code }, index) => {
            files[`readme-ts-${index + 1}.ts`] = header + withoutLibraryImports(code) + (stubs[heading] ?? '');
        });
        const errors = consumerFilesTypeErrors(files).map((error) => {
            const block = tsBlocks[Number(/readme-ts-(\d+)/.exec(error)?.[1]) - 1];
            return block ? `${error} (under '${block.heading}')` : error;
        });
        assert.deepEqual(errors, []);
    });
});

describe('Documented sharp edges', function () {
    beforeEach(() => configureEffect());

    it('should re-run already-succeeded Commands on every Retry attempt', async function () {
        // Pinned deliberately: `Retry` repeats the whole wrapped tree, which is why the docs say to
        // wrap the one Command that fails transiently rather than a pipeline.
        /** @type {string[]} */
        const charges = [];
        let receiptFailures = 0;
        const effect = Retry(
            effectPipe(
                () =>
                    Command(
                        function cmdCharge() {
                            charges.push('charged');
                            return { id: charges.length };
                        },
                        (/** @type {any} */ r) => Success(r)
                    ),
                () =>
                    Command(
                        function cmdSendReceipt() {
                            if (++receiptFailures < 3) throw new Error('smtp down');
                            return 'sent';
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )({ order: 1 }),
            { retries: 3, delay: 0 }
        );

        const result = await runEffect(effect);
        assert.equal(result.type, 'Success');
        assert.equal(charges.length, 3, 'one order, three charges: wrap the Command, not the pipeline');
    });

    it('should repeat everything a retried Command next leads to, not just that Command', async function () {
        // The sharper form of the edge above, and the one that is easy to write by accident. Wrapping a
        // single Command looks like it satisfies "wrap the Command, not the pipeline", but a Command's
        // `next` is part of the tree the Retry repeats, so a Retry whose `next` continues the flow wraps
        // everything downstream. Found by building a booking saga: an exception in the last step charged
        // the card nine times, because two enclosing retries each re-ran the whole remainder.
        const ledger = { seats: 0, charges: 0 };
        const saga = (/** @type {() => void} */ onCharge) =>
            Retry(
                Command(
                    function cmdHoldSeat() {
                        ledger.seats++;
                        return Promise.resolve({ holdId: 'seat_1' });
                    },
                    () =>
                        Command(function cmdCharge() {
                            ledger.charges++;
                            onCharge();
                            throw new Error('gateway exploded');
                        })
                ),
                { retries: 2, delay: 0 }
            );

        const result = await runEffect(saga(() => {}));
        assert.equal(result.type, 'Failure');
        assert.equal(ledger.seats, 3, 'the seat is held once per attempt');
        assert.equal(
            ledger.charges,
            3,
            'and the card is charged once per attempt, though only one charge was asked for'
        );

        // The shape that does what the sentence above promises: the retried Command keeps its default
        // pass-through `next`, and the branching happens in a later pipeline step, outside the Retry.
        ledger.seats = 0;
        ledger.charges = 0;
        const fixed = effectPipe(
            () =>
                Retry(
                    Command(function cmdHoldSeat() {
                        ledger.seats++;
                        return Promise.resolve({ holdId: 'seat_1' });
                    }),
                    { retries: 2, delay: 0 }
                ),
            () =>
                Command(function cmdCharge() {
                    ledger.charges++;
                    throw new Error('gateway exploded');
                })
        )(null);

        const fixedResult = await runEffect(fixed);
        assert.equal(fixedResult.type, 'Failure');
        assert.equal(ledger.seats, 1, 'the retried tree is now the one Command');
        assert.equal(ledger.charges, 1, 'and a later failure costs one charge, not one per attempt');
    });

    it('should not retry a rejection the Command function caught and returned', async function () {
        // Two pieces of guidance that do not compose: catching inside the `cmd` function turns the
        // rejection into a returned Failure, which is an abort, and aborts are not retried. Wrapping
        // that step in Retry then buys nothing and says nothing. Found by following both at once.
        const attempt = (/** @type {boolean} */ catchInside) => {
            let calls = 0;
            const get = () => {
                calls++;
                return Promise.reject(new Error('503'));
            };
            const step = catchInside
                ? Command(
                      function cmdFetch() {
                          return get().then(
                              (/** @type {any} */ value) => /** @type {any} */ ({ ok: true, value }),
                              (/** @type {any} */ error) => /** @type {any} */ ({ ok: false, error })
                          );
                      },
                      (/** @type {any} */ r) => (r.ok ? Success(r.value) : Failure({ at: 'pricing' }))
                  )
                : Command(function cmdFetch() {
                      return get();
                  });
            return { step, calls: () => calls };
        };

        const caught = attempt(true);
        const caughtResult = await runEffect(Retry(caught.step, { retries: 3, delay: 0 }));
        assert.equal(caughtResult.type, 'Failure');
        assert.equal(caught.calls(), 1, 'a caught rejection is an abort, so the Retry never tries again');

        const thrown = attempt(false);
        const thrownResult = await runEffect(Retry(thrown.step, { retries: 3, delay: 0 }));
        assert.equal(thrownResult.type, 'Failure');
        assert.equal(thrown.calls(), 4, 'letting it throw is what makes it an I/O fault the Retry acts on');
    });

    it('should not stop an in-flight Command whose thunk ignores the signal', async function () {
        // Pinned deliberately: cancellation is cooperative. The sibling's write is already in flight
        // inside the branch's first Command, and a thunk that ignores its signal cannot be interrupted,
        // so the write still lands. What cancellation does buy is in the suite below: no *later*
        // Command in that branch starts, and a thunk that honours the signal is cut off.
        /** @type {string[]} */
        const written = [];
        const result = await runEffect(
            Parallel(
                [
                    Command(
                        function cmdValidate() {
                            return null;
                        },
                        () => Failure('validation_failed')
                    ),
                    Command(
                        function cmdSlowWrite() {
                            return new Promise((r) =>
                                setTimeout(() => {
                                    written.push('wrote');
                                    r('ok');
                                }, 20)
                            );
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
                ],
                (/** @type {any} */ vals) => Success(vals)
            )
        );
        assert.equal(result.type, 'Failure');
        assert.equal(errorOf(result), 'validation_failed');
        assert.deepEqual(written, ['wrote'], 'an uninterruptible in-flight write still performed');
    });

    it('should hand the signal to a plain first parameter that a function passed by name treats as optional', async function () {
        // Pinned deliberately: inside a Parallel a function that declares a parameter is called with its branch's
        // AbortSignal, so one that treats a plain first parameter as optional, defaulting it in its body, takes the
        // signal for it. A parameter with a default value is safe, since it does not count toward `length`. The
        // README's Limitations entry says to wrap such a function.
        const pageSize = /** @type {any} */ (
            (/** @type {unknown} */ limit) =>
                limit === undefined ? 50 : typeof limit === 'number' ? limit : 'a signal'
        );
        assert.deepEqual(await runEffect(Command(pageSize)), Success(50));
        assert.deepEqual(await runEffect(Parallel([Command(pageSize)])), Success(['a signal']));
        assert.deepEqual(await runEffect(Parallel([Command(() => pageSize())])), Success([50]), 'wrapped, it works');
    });

    it("should run no generator flow's finally when the run is rejected", async function () {
        // Pinned deliberately: a harness error, such as this TimeParadox, rejects the run without running the body's
        // catch or finally, since a catch could otherwise hide the real error.
        /** @type {string[]} */
        const seen = [];
        const recorded = effectGen(function* () {
            yield* step(Command(function cmdFirst() {}));
            yield* step(Command(function cmdSecond() {}));
        });
        const trace = (await recordEffect(recorded(undefined))).trace;
        const changed = effectGen(function* () {
            try {
                yield* step(Command(function cmdFirst() {}));
                yield* step(Parallel([Command(function cmdSecond() {})]));
            } finally {
                seen.push('finally');
            }
        });
        const replay = await replayEffect(changed(undefined), trace);
        assert.equal(/** @type {any} */ (replay.result).error.name, 'TimeParadox');
        assert.deepEqual(seen, []);
    });

    it('should record an input a step changed before the first Command, as changed', async function () {
        // Pinned deliberately: a step before the first Command runs as the flow is built, before anything copies the
        // input, so a trace holds what that step left. Copying every input as each flow is built was weighed and
        // dropped, since every flow, recorded or not, would pay for it.
        const pipe = effectPipe(
            (/** @type {{ count: number }} */ input) => {
                input.count++;
                return Success(input);
            },
            (input) => Command(() => input.count, undefined, { name: 'cmdRead' })
        );
        const gen = effectGen(function* (/** @type {{ count: number }} */ input) {
            input.count++;
            return yield* step(Command(() => input.count, undefined, { name: 'cmdRead' }));
        });
        for (const flow of [pipe, gen]) {
            const { result, trace } = await recordEffect(flow({ count: 0 }));
            assert.deepEqual(result, Success(1));
            assert.deepEqual(trace.initialInput, { count: 1 }, 'the trace holds the changed input');
            const { result: replayed } = await replayEffect(flow(trace.initialInput), trace);
            assert.deepEqual(replayed, Success(1), 'a replay answers the Command from the recording, not the input');
        }
    });

    it('should change a variable outside a generator body again when a test walks a second branch', function () {
        // Pinned deliberately: a generator cannot be copied, so answering an earlier step again runs the body from
        // the top, and code in it that changes something outside it does so again.
        let logged = 0;
        const flow = effectGen(function* () {
            logged++;
            const found = yield* step(Command(() => /** @type {{ id: number } | null} */ (null)));
            return found ? 'taken' : 'free';
        });
        const root = /** @type {any} */ (flow(undefined));
        root.next({ id: 1 });
        root.next(null);
        assert.equal(logged, 2);
    });

    it('should run a generator body again when one flow value is run twice', async function () {
        // Pinned deliberately: as calling an `async` function again does, the second run builds the flow again from
        // its input, so code in the body that changes something outside it does so again.
        let started = 0;
        const flow = effectGen(function* () {
            started++;
            return yield* step(
                Command(function cmdOne() {
                    return 1;
                })
            );
        })(undefined);
        await runEffect(flow);
        await runEffect(flow);
        assert.equal(started, 2);
    });

    it('should run the finally of a branch elsewhere that stops for its own reason before a throw reaches it', async function () {
        // Pinned deliberately: a throw stops no generator flow in its own Parallel, but it waits there for that
        // Parallel's other branches, and a sibling in the enclosing Parallel that stops meanwhile, here on a declined
        // card, still runs its finally. Which comes first depends on timing.
        /** @type {string[]} */
        const seen = [];
        const sibling = effectGen(function* () {
            try {
                yield* step(
                    Command(function cmdDeclined() {
                        return new Promise((_, reject) => setTimeout(() => reject(new Error('declined')), 15));
                    })
                );
            } finally {
                seen.push('sibling finally');
            }
        });
        const crashing = Parallel([
            Command(function cmdSlowIgnoresSignal() {
                return new Promise((resolve) => setTimeout(resolve, 40));
            }),
            Command(
                function cmdFast() {},
                () => {
                    throw new Error('the real bug');
                }
            )
        ]);
        await assert.rejects(runEffect(Parallel([crashing, sibling(undefined)])), /^Error: the real bug$/);
        assert.deepEqual(seen, ['sibling finally']);
    });

    it('should replay a cancelled branch past an Ask that production stopped it at', async function () {
        // Pinned deliberately: a trace marks where a cancelled branch stopped only by its Commands, and an Ask
        // consults none, so the replay carries the body past the Ask where production stopped it.
        /** @type {string[]} */
        const seen = [];
        const branch = effectGen(function* () {
            try {
                yield* step(
                    Command(function cmdSlowIgnoresSignal() {
                        return new Promise((resolve) => setTimeout(resolve, 30));
                    })
                );
                yield* step(Ask());
                seen.push('after Ask');
            } catch (e) {
                seen.push('caught');
                throw e;
            }
        });
        const failing = Command(function cmdFail() {
            return new Promise((_, reject) => setTimeout(() => reject(new Error('declined')), 5));
        });
        const flow = () => Parallel([branch(undefined), failing]);
        const recording = recorder();
        await runEffect(flow(), {}, { onStep: recording.onStep });
        assert.deepEqual(seen, ['caught']);
        seen.length = 0;
        // The context production ran with, which a bare toTrace() does not hold.
        await replayEffect(flow(), JSON.parse(JSON.stringify(recording.toTrace())), { context: {} });
        assert.deepEqual(seen, ['after Ask']);
    });

    it('should lose an error passing through a body whose finally step a cancellation skips', async function () {
        // Pinned deliberately: a step in a body's finally is unsupported. Here a nested flow's refusal is passing
        // through the outer body when its finally yields a step; the cancellation reaches the body before that step
        // starts, and the stop thrown into the paused finally replaces the pending error.
        const refused = effectGen(function* () {
            try {
                yield* step(Failure('early'));
            } finally {
                yield* step(Command(function cmdInnerCleanup() {}));
            }
        });
        const outer = effectGen(function* () {
            try {
                yield* step(refused(undefined));
            } finally {
                yield* step(Command(function cmdOuterCleanup() {}));
            }
        });
        const failing = Command(function cmdFail() {
            return new Promise((_, reject) => setTimeout(() => reject(new Error('declined')), 5));
        });
        const result = await runEffect(Parallel([failing, outer(undefined)], { limit: 1 }));
        assert.equal(result.type, 'Failure');
        assert.equal(/** @type {any} */ (result).error.message, 'declined');
    });
});

describe('Declaration parity', function () {
    it('should declare exactly the exports the runtime ships', function () {
        // index.d.ts is hand-maintained beside index.js, so the two can drift silently: a
        // declaration once vanished as edit collateral while every check stayed green. This pins
        // existence in both directions; signatures remain tsd's job.
        const program = ts.createProgram(['index.d.ts'], { noEmit: true });
        const source = program.getSourceFile('index.d.ts');
        assert.ok(source, 'index.d.ts must be part of the program');
        const checker = program.getTypeChecker();
        const moduleSymbol = checker.getSymbolAtLocation(/** @type {import('typescript').Node} */ (source));
        assert.ok(moduleSymbol, 'index.d.ts must be a module');
        const declared = checker
            .getExportsOfModule(moduleSymbol)
            .filter((s) => s.flags & ts.SymbolFlags.Value)
            .map((s) => s.name)
            .sort();
        const shipped = Object.keys(lib).sort();
        assert.deepEqual(declared, shipped);
    });

    it('should hold exactly the effectPipe overloads the generator writes', async function () {
        // Two thirds of index.d.ts is effectPipe's overloads, one per pipeline length. Edited by hand, a
        // pattern meant for their type parameters once also rewrote ten return types. They are written by
        // scripts/effect-pipe-overloads.js instead, and this fails when the file and the script disagree.
        this.timeout(20000);
        const generated = await effectPipeOverloads();
        const current = currentOverloads(readFileSync('index.d.ts', 'utf8'));
        assert.ok(current === generated, 'index.d.ts differs from the generator: run npm run generate');
    });
});

describe('Rules file', function () {
    // RULES.md ships so an agent that sees only node_modules finds the rules, and it is generated from the README so
    // the two cannot drift. These pin that it is current, that the README keeps the rules where the generator reads
    // them, and that every link in it lands on the heading it names.
    const readme = readFileSync('README.md', 'utf8');

    it('should hold exactly the RULES.md the generator writes', async function () {
        this.timeout(20000);
        const generated = await rulesFile(readme);
        assert.ok(
            readFileSync('RULES.md', 'utf8') === generated,
            'RULES.md differs from the generator: run npm run generate'
        );
    });

    it('should keep the twelve rules as one numbered list between one pair of markers', function () {
        const items = rulesSection(readme).split('\n');
        items.forEach((item, index) =>
            assert.ok(item.startsWith(`${index + 1}. **`), `rule ${index + 1} reads '${item}'`)
        );
        // The section opens by counting them, so adding or removing a rule means changing that sentence too.
        assert.equal(items.length, 12, 'the README says "Twelve rules": change it with the list');
        assert.ok(readme.includes('Twelve rules cover most of what goes wrong.'));
    });

    it('should give headings the anchors GitHub gives them', function () {
        // Anchored to values, so a change to the anchor rule shows here before it breaks every link at once.
        assert.equal(githubAnchor('`Command(cmdFn, nextFn?, meta?)`'), 'commandcmdfn-nextfn-meta');
        assert.equal(githubAnchor('Coming from async/await'), 'coming-from-asyncawait');
        assert.equal(
            githubAnchor("Proving a fix that changes the flow's shape"),
            'proving-a-fix-that-changes-the-flows-shape'
        );
        assert.equal(githubAnchor('What runs once, and what runs again'), 'what-runs-once-and-what-runs-again');
        assert.equal(githubAnchor('TypeScript: Typed Errors and Context'), 'typescript-typed-errors-and-context');
        assert.equal(githubAnchor('Translating `try`/`catch`'), 'translating-trycatch');
        assert.deepEqual(headingAnchors('# A\n```sh\n# not a heading\n```\n## A'), ['a', 'a-1']);
    });

    it('should link only to headings the README or REFERENCE.md has, each of them once', function () {
        const headings = {
            'README.md': new Set(headingAnchors(readme)),
            'REFERENCE.md': new Set(headingAnchors(readFileSync('REFERENCE.md', 'utf8')))
        };
        const links = [...readFileSync('RULES.md', 'utf8').matchAll(/\]\(([^)]*)\)/g)].map((match) => match[1]);
        assert.ok(links.length >= 20, `expected RULES.md to link to the README, found ${links.length} links`);
        links.forEach((link) => {
            const [file, anchor] = link.split('#');
            assert.ok(file in headings && anchor, `RULES.md links to '${link}', not to a heading in either file`);
            const anchors = headings[/** @type {keyof typeof headings} */ (file)];
            assert.ok(anchors.has(anchor), `RULES.md links to '${link}', which no heading has`);
            // A second heading with the same text would take the anchor with -1, and the link would land on the first.
            assert.ok(!anchors.has(`${anchor}-1`), `RULES.md links to '${link}', which two headings share`);
        });
    });

    it('should ship README.md, RULES.md and REFERENCE.md in the package', function () {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
        for (const file of ['README.md', 'RULES.md', 'REFERENCE.md']) {
            assert.ok(pkg.files.includes(file), `add ${file} to package.json's files`);
        }
    });
});

describe('Documentation links', function () {
    // README.md teaches and REFERENCE.md holds the exact rules, and the two link into each other, so a heading
    // renamed or moved in either one breaks links nothing else would notice.
    const docs = /** @type {Record<string, string>} */ ({
        'README.md': readFileSync('README.md', 'utf8'),
        'REFERENCE.md': readFileSync('REFERENCE.md', 'utf8')
    });

    it('should link only to headings that exist, each of them once', function () {
        const anchors = Object.fromEntries(
            Object.entries(docs).map(([name, text]) => [name, new Set(headingAnchors(text))])
        );
        for (const [name, text] of Object.entries(docs)) {
            // Links inside fenced code are not links.
            const prose = text.replace(/```[\s\S]*?```/g, '');
            for (const [, target, anchor] of prose.matchAll(/\]\(((?:README|REFERENCE)\.md)?#([^)]*)\)/g)) {
                const file = target ?? name;
                assert.ok(anchors[file].has(anchor), `${name} links to '${file}#${anchor}', which no heading has`);
                // A second heading with the same text would take the anchor with -1, and the link would land on the first.
                assert.ok(
                    !anchors[file].has(`${anchor}-1`),
                    `${name} links to '${file}#${anchor}', which two headings share`
                );
            }
        }
    });

    it('should link the README to REFERENCE.md from its table of contents', function () {
        const contents = docs['README.md'].split('## Installation')[0];
        assert.match(contents, /\]\(REFERENCE\.md\)/);
    });
});

describe('Agent guidance', function () {
    it('should keep CLAUDE.md within the 32 KiB Codex reads of AGENTS.md', function () {
        // AGENTS.md links to CLAUDE.md, and Codex drops whatever lies past 32 KiB without saying so.
        const bytes = readFileSync('CLAUDE.md').length;
        assert.ok(bytes <= 32 * 1024, `CLAUDE.md is ${bytes} bytes; move explanation to DESIGN.md`);
    });
});
