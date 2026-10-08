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
    recorder,
    recordEffect,
    replayEffect
} from '../index.js';
import { valueOf } from './helpers.js';

describe('configureEffect merging', function () {
    beforeEach(() => configureEffect());

    /** A Command whose thunk is named, so hooks can be asserted by name. */
    const work = (/** @type {any} */ value = 'ok') =>
        Command(
            function cmdWork() {
                return value;
            },
            (/** @type {any} */ v) => Success(v)
        );

    it('should nest onStep wrappers with the first config outermost', async function () {
        /** @type {string[]} */
        const order = [];
        const outer = async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
            order.push('outer:in');
            const r = await op();
            order.push('outer:out');
            return r;
        };
        const inner = async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
            order.push('inner:in');
            const r = await op();
            order.push('inner:out');
            return r;
        };
        configureEffect({ onStep: outer }, { onStep: inner });
        const result = await runEffect(work('ok'));
        assert.equal(result.type, 'Success');
        assert.deepEqual(order, ['outer:in', 'inner:in', 'inner:out', 'outer:out']);
    });

    it('should let recording and telemetry share the single onStep slot', async function () {
        /** @type {string[]} */
        const spans = [];
        const telemetry = async (/** @type {any} */ name, /** @type {any} */ t, /** @type {any} */ op) => {
            spans.push(name);
            return await op();
        };
        const rec = recorder();
        configureEffect({ onStep: telemetry }, { onStep: rec.onStep });
        const result = await runEffect(work('ok'));
        assert.equal(valueOf(result), 'ok');
        assert.deepEqual(spans, ['cmdWork']);
        assert.deepEqual(
            rec.entries.map(({ command, result }) => ({ command, result })),
            [{ command: 'cmdWork', result: 'ok' }]
        );
    });

    it('should propagate a thrown Command through every wrapper', async function () {
        /** @type {string[]} */
        const saw = [];
        const watcher =
            (/** @type {string} */ label) =>
            async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
                try {
                    return await op();
                } catch (e) {
                    saw.push(label);
                    throw e;
                }
            };
        const rec = recorder();
        configureEffect({ onStep: watcher('a') }, { onStep: rec.onStep }, { onStep: watcher('b') });
        const result = await runEffect(
            Command(
                function cmdBoom() {
                    throw new Error('boom');
                },
                (/** @type {any} */ v) => Success(v)
            )
        );
        assert.equal(result.type, 'Failure');
        assert.deepEqual(saw, ['b', 'a'], 'the error unwinds from innermost to outermost');
        assert.equal(rec.entries.length, 1, 'the recorder still captured the failing step');
        assert.ok('error' in rec.entries[0]);
    });

    it('should nest onRun wrappers and preserve flowName and the result', async function () {
        /** @type {any[]} */
        const seen = [];
        const wrap =
            (/** @type {string} */ label) =>
            async (/** @type {any} */ effect, /** @type {any} */ op, /** @type {any} */ flowName) => {
                seen.push([label, flowName]);
                return await op();
            };
        configureEffect({ onRun: wrap('a') }, { onRun: wrap('b') });
        const result = await runEffect(work('ok'), { flowName: 'checkout' });
        assert.equal(valueOf(result), 'ok');
        assert.deepEqual(seen, [
            ['a', 'checkout'],
            ['b', 'checkout']
        ]);
    });

    it('should pass onRun an empty flowName when the context names none', async function () {
        /** @type {any[]} */
        const seen = [];
        configureEffect({
            onRun: async (/** @type {any} */ effect, /** @type {any} */ op, /** @type {any} */ flowName) => {
                seen.push(flowName);
                return await op();
            }
        });
        await runEffect(work('ok'));
        await runEffect(work('ok'), {});
        assert.deepEqual(seen, ['', '']);
    });

    it('should run every onBeforeCommand interceptor in order', async function () {
        /** @type {string[]} */
        const calls = [];
        configureEffect(
            { onBeforeCommand: async (/** @type {any} */ c) => void calls.push(`a:${c.cmd.name}`) },
            { onBeforeCommand: async (/** @type {any} */ c) => void calls.push(`b:${c.cmd.name}`) }
        );
        await runEffect(work('ok'));
        assert.deepEqual(calls, ['a:cmdWork', 'b:cmdWork']);
    });

    it('should leave slots no layer defines at their defaults, and tolerate gaps', async function () {
        /** @type {string[]} */
        const intercepted = [];
        configureEffect({ onBeforeCommand: async (/** @type {any} */ c) => void intercepted.push(c.cmd.name) });

        // A second layer naming only onStep adds to the first rather than displacing it, the undefined
        // and empty configurations are ignored, and onRun, which no layer names, stays at its default.
        configureEffect(
            { onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => await op() },
            undefined,
            {}
        );
        assert.equal(valueOf(await runEffect(work('ok'))), 'ok');
        assert.deepEqual(intercepted, ['cmdWork'], 'the earlier layer still runs');
    });

    it('should stack a second call on top of the first, and remove only that layer', async function () {
        // Each call adds a layer. Under the old one-slot rule the second call displaced the first and the
        // returned function restored a snapshot, which needed a guard against interleaved installs.
        /** @type {string[]} */
        const order = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                order.push('first'),
                await op()
            )
        });
        const remove = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                order.push('second'),
                await op()
            )
        });
        await runEffect(work('ok'));
        assert.deepEqual(order, ['first', 'second'], 'both ran, the earlier layer outermost');

        order.length = 0;
        remove();
        await runEffect(work('ok'));
        assert.deepEqual(order, ['first'], 'removing the second layer left the first in place');
    });

    it('should stack separate calls exactly as one call with several configurations', async function () {
        /** @type {string[]} */
        const viaOne = [];
        /** @type {string[]} */
        const viaTwo = [];
        /** @param {string[]} log @param {string} label */
        const tag = (log, label) => ({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
                log.push(`${label}>`);
                const r = await op();
                log.push(`<${label}`);
                return r;
            },
            onBeforeCommand: async () => {
                log.push(`${label}!`);
            }
        });
        configureEffect(tag(viaOne, 'a'), tag(viaOne, 'b'));
        await runEffect(work('ok'));
        configureEffect();
        configureEffect(tag(viaTwo, 'a'));
        configureEffect(tag(viaTwo, 'b'));
        await runEffect(work('ok'));
        assert.deepEqual(viaTwo, viaOne);
        assert.deepEqual(viaOne, ['a!', 'b!', 'a>', 'b>', '<b', '<a']);
    });

    it('should make removing a layer idempotent', async function () {
        /** @type {string[]} */
        const seen = [];
        const removeA = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push('a'),
                await op()
            )
        });
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push('b'),
                await op()
            )
        });
        removeA();
        removeA();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['b'], 'a second removal took nothing else with it');
    });

    it('should remove the only layer back to no hooks', async function () {
        /** @type {string[]} */
        const seen = [];
        const remove = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        await runEffect(work('ok'));
        remove();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the second run had no hooks at all');
    });

    it('should leave a newer layer in place when an older one is removed', async function () {
        /** @type {string[]} */
        const a = [];
        /** @type {string[]} */
        const b = [];
        const removeA = configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (a.push(n), await op())
        });
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (b.push(n), await op())
        });

        removeA();
        await runEffect(work('ok'));
        assert.deepEqual(b, ['cmdWork'], "B's layer survived A's removal");
        assert.deepEqual(a, [], 'and A is gone');
    });

    it('should remove every layer when called with nothing', async function () {
        /** @type {string[]} */
        const seen = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        await runEffect(work('ok'));
        configureEffect();
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the second run ran with no hooks at all');
    });

    it('should install nothing and remove nothing when every argument is absent', async function () {
        // `configureEffect(flag ? hooks : undefined)` is a conditional install, not a reset. Only a call
        // with no arguments at all removes every layer; a call whose arguments are all absent adds no
        // layer, leaves the host's wiring alone, and hands back a remover that has nothing to remove.
        /** @type {string[]} */
        const seen = [];
        configureEffect({
            onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                seen.push(n),
                await op()
            )
        });
        const remove = configureEffect(undefined);
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork'], 'the host layer survived configureEffect(undefined)');
        remove();
        configureEffect(undefined, undefined);
        await runEffect(work('ok'));
        assert.deepEqual(seen, ['cmdWork', 'cmdWork'], 'still installed after removing the empty call');
    });
});

describe('Per-call inherit', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

    /** @param {string} name */
    const cmd = (name) =>
        Command(
            () => name,
            (/** @type {any} */ r) => Success(r),
            { name }
        );

    /** @param {string[]} log @param {string} label */
    const tagStep = (log, label) => async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => {
        log.push(`${label}:before`);
        try {
            return await op();
        } finally {
            log.push(`${label}:after`);
        }
    };

    /** @param {string[]} log */
    const globalWiring = (log) => ({
        onStep: tagStep(log, 'global'),
        onRun: async (/** @type {any} */ e, /** @type {any} */ op) => (log.push('run'), await op()),
        onBeforeCommand: async () => {
            log.push('global-intercept');
        }
    });

    it('should nest per-call hooks inside the global ones by default', async function () {
        // Adding, not replacing: a per-call hook used to switch the global one off for that run, which
        // is how recordEffect inside an instrumented application silently produced runs with no spans.
        /** @type {string[]} */
        const log = [];
        configureEffect(globalWiring(log));
        const result = await runEffect(
            cmd('a'),
            {},
            {
                onStep: tagStep(log, 'local'),
                onBeforeCommand: async () => {
                    log.push('local-intercept');
                }
            }
        );
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, [
            'run',
            'global-intercept',
            'local-intercept',
            'global:before',
            'local:before',
            'local:after',
            'global:after'
        ]);
    });

    it('should behave the same with inherit: true spelled out', async function () {
        /** @type {string[]} */
        const log = [];
        configureEffect(globalWiring(log));
        await runEffect(cmd('a'), {}, { inherit: true, onStep: tagStep(log, 'local') });
        assert.deepEqual(log, [
            'run',
            'global-intercept',
            'global:before',
            'local:before',
            'local:after',
            'global:after'
        ]);
    });

    it('should consult nothing global under inherit: false, falling back to library defaults', async function () {
        /** @type {string[]} */
        const log = [];
        let calls = 0;
        const flaky = Command(() => {
            calls++;
            throw new Error('down');
        });
        configureEffect(globalWiring(log));
        const result = await runEffect(Retry(flaky, { delay: 0 }), {}, { inherit: false });
        assert.equal(result.type, 'Failure');
        assert.deepEqual(log, [], 'no global hook fired');
        assert.equal(calls, 4, 'the library retry defaults applied, as they do under any inherit');
    });

    it('should still apply per-call hooks under inherit: false', async function () {
        /** @type {string[]} */
        const log = [];
        configureEffect(globalWiring(log));
        await runEffect(cmd('a'), {}, { inherit: false, onStep: tagStep(log, 'local') });
        assert.deepEqual(log, ['local:before', 'local:after']);
    });

    it('should reject a non-boolean rather than guessing', async function () {
        await assert.rejects(
            runEffect(cmd('a'), {}, /** @type {any} */ ({ inherit: 'all' })),
            (/** @type {any} */ e) =>
                e instanceof TypeError && /true or false/.test(e.message) && /"all"/.test(e.message)
        );
    });

    it('should record under the global onStep with recordEffect', async function () {
        /** @type {string[]} */
        const log = [];
        configureEffect({ onStep: tagStep(log, 'global') });
        const { result, trace } = await recordEffect(() => cmd('a'), null);
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, ['global:before', 'global:after'], 'tracing kept running');
        assert.equal(trace.trace.length, 1, 'and the run was recorded');
    });

    it('should keep a default replay away from every global hook', async function () {
        /** @type {string[]} */
        const log = [];
        let ran = 0;
        const flow = () =>
            Command(
                () => ++ran,
                (/** @type {any} */ r) => Success(r),
                { name: 'cmdA' }
            );
        const { trace } = await recordEffect(flow, null);
        configureEffect(globalWiring(log));
        const { result } = await replayEffect(flow(), trace);
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, []);
        assert.equal(ran, 1, 'the recording ran it once; the replay not at all');
    });

    it('should let a replay with hooks run under the global hooks without executing Commands', async function () {
        /** @type {string[]} */
        const log = [];
        let ran = 0;
        const flow = () =>
            Command(
                () => ++ran,
                (/** @type {any} */ r) => Success(r),
                { name: 'cmdA' }
            );
        const { trace } = await recordEffect(flow, null);
        configureEffect(globalWiring(log));
        const { result } = await replayEffect(flow(), trace, { hooks: true });
        assert.equal(result.type, 'Success');
        assert.deepEqual(log, ['run', 'global-intercept', 'global:before', 'global:after']);
        assert.equal(ran, 1, 'the global onStep observed the replayed step, and the Command still did not run');
    });

    it('should name what an inherit that is not a boolean holds', async function () {
        // The message printed it with JSON.stringify, which gives undefined for a function or a symbol and throws its
        // own TypeError for a BigInt, so the message said nothing, or the wrong thing.
        const cases = /** @type {[any, RegExp][]} */ ([
            ['false', /got the string "false"\.$/],
            [Symbol('on'), /got the symbol Symbol\(on\)\.$/],
            [1n, /got the bigint 1\.$/],
            [() => true, /got a function/]
        ]);
        for (const [inherit, named] of cases) {
            await assert.rejects(runEffect(cmd('a'), {}, { inherit }), (/** @type {any} */ e) =>
                e instanceof TypeError && /^callConfig\.inherit must be true or false, got /.test(e.message)
                    ? named.test(e.message) || assert.fail(e.message)
                    : assert.fail(e.message)
            );
        }
    });
});

describe('Where a throw comes from', function () {
    beforeEach(function () {
        configureEffect();
    });

    // A throw is an I/O fault only when the Command's function threw it. The interpreter's catch used to
    // wrap the interceptor and the Command's `next` as well, so a guardrail's veto and a bug in pure
    // code were both reported as "the I/O broke": `Retry` re-ran a Command that had succeeded because a
    // TypeError followed it, and retried a guardrail the docs say aborts.

    it('should treat a throwing onBeforeCommand as an abort, not retried', async function () {
        let calls = 0;
        let vetoes = 0;
        configureEffect({
            onBeforeCommand: async () => {
                vetoes++;
                throw new Error('tenant not allowed');
            }
        });
        const result = await runEffect(
            Retry(
                Command(function cmdWork() {
                    calls++;
                    return 'ok';
                }),
                { attempts: 3, delay: 0, onExhausted: () => Success('fallback') }
            ),
            {}
        );
        assert.equal(result.type, 'Failure');
        assert.equal(/** @type {any} */ (result).error.message, 'tenant not allowed', 'an abort arrives unwrapped');
        assert.equal(vetoes, 1, 'the veto is not asked again');
        assert.equal(calls, 0, 'the vetoed Command never runs');
    });

    it('should reject when a Command next throws, and not run the I/O again', async function () {
        let calls = 0;
        const bug = new TypeError('bug in next');
        const flow = Retry(
            Command(
                function cmdWork() {
                    calls++;
                    return 'ok';
                },
                () => {
                    throw bug;
                }
            ),
            { attempts: 2, delay: 0 }
        );
        await assert.rejects(runEffect(flow), (e) => e === bug);
        assert.equal(calls, 1, 'the I/O succeeded, so it is not repeated for a bug that followed it');
    });

    it('should reject when a pure step after a Command throws', async function () {
        const flow = effectPipe(
            () =>
                Command(function cmdLoad() {
                    return { items: null };
                }),
            (/** @type {any} */ order) => Success(order.items.length)
        )(null);
        await assert.rejects(runEffect(flow), TypeError);
    });

    it('should reject with a non-Error value thrown from next', async function () {
        const flow = Command(
            function cmdWork() {
                return 'ok';
            },
            () => {
                throw 'plain string';
            }
        );
        await assert.rejects(runEffect(flow), (e) => e === 'plain string');
    });

    it('should cancel the siblings of a branch whose next throws, and wait for them', async function () {
        const bug = new TypeError('bug in branch');
        let secondStarted = false;
        let firstSettled = false;
        const slow = Command(
            async function cmdSlow() {
                await new Promise((r) => setTimeout(r, 30));
                firstSettled = true;
                return 'slow';
            },
            () =>
                Command(function cmdAfter() {
                    secondStarted = true;
                    return 'after';
                })
        );
        const broken = Command(
            function cmdBroken() {
                return 'ok';
            },
            () => {
                throw bug;
            }
        );
        for (const options of [undefined, { settled: true }, { limit: 1 }]) {
            secondStarted = false;
            firstSettled = false;
            // Cast: the loop makes `settled` a plain boolean, which the declarations refuse on purpose.
            await assert.rejects(runEffect(Parallel([broken, slow], /** @type {any} */ (options))), (e) => e === bug);
            assert.equal(firstSettled, options?.limit ? false : true, 'a started sibling is awaited');
            assert.equal(secondStarted, false, 'a cancelled sibling starts no further Commands');
        }
    });

    it('should reject a replay whose next throws rather than returning a Failure', async function () {
        let broken = false;
        const flow = () =>
            Command(
                function cmdWork() {
                    return 'ok';
                },
                (/** @type {any} */ v) => {
                    if (broken) throw new TypeError('regression');
                    return Success(v);
                }
            );
        const { trace } = await recordEffect(flow, null);
        broken = true;
        await assert.rejects(replayEffect(flow(), trace), TypeError);
    });

    it('should still fold a throwing Command function into a retried I/O fault', async function () {
        let calls = 0;
        const result = await runEffect(
            Retry(
                Command(function cmdFlaky() {
                    calls++;
                    throw new Error('socket reset');
                }),
                { attempts: 2, delay: 0 }
            )
        );
        assert.equal(/** @type {any} */ (result).error.retryExhausted, true);
        assert.equal(calls, 3);
    });

    it('should reject when an onStep hook throws after the Command succeeded, and not run it again', async function () {
        // A telemetry hook whose exporter fails once the Command has returned. The work is done, so this
        // is a bug in the hook, and retrying it charged the card once per attempt.
        let charges = 0;
        const exporterFull = new Error('exporter queue full');
        configureEffect({
            onStep: async (name, type, op) => {
                await op();
                throw exporterFull;
            }
        });
        const flow = Retry(
            Command(function cmdCharge() {
                charges++;
                return { charged: true };
            }),
            { attempts: 2, delay: 0, onExhausted: () => Success({ charged: false }) }
        );
        await assert.rejects(runEffect(flow), (e) => e === exporterFull);
        assert.equal(charges, 1, 'a Command that succeeded is not repeated for a hook that failed after it');
    });

    it('should reject when an onStep hook calls op and returns nothing, rather than hand next undefined', async function () {
        // A metrics hook that awaited op and forgot the return turned "email taken" into undefined, so the flow
        // saved a duplicate account while a recorder inside the hook kept the real answer.
        let saves = 0;
        configureEffect({
            onStep: async (name, type, op) => {
                await op();
            }
        });
        const flow = effectPipe(
            () =>
                Command(
                    function cmdFindUser() {
                        return { id: 1 };
                    },
                    (found) => (found ? Failure('Email already in use.') : Success('free'))
                ),
            () =>
                Command(function cmdSaveUser() {
                    saves++;
                    return { id: 2 };
                })
        )({ email: 'taken@x.com' });
        // Matched up to "although", since a hook that did not wait for op is told so in the same place.
        await assert.rejects(
            runEffect(flow),
            (e) =>
                e instanceof TypeError && /'cmdFindUser' at path '0' and returned undefined, although/.test(e.message)
        );
        assert.equal(saves, 0, 'the flow must not continue as though no user was found');
    });

    it('should reject when an onStep hook calls op without waiting for it, rather than hand next undefined', async function () {
        // The same hook without its await. The check ran when the hook returned, while a Command that took any
        // time was still running, so the found user still became undefined and the duplicate was saved.
        let saves = 0;
        configureEffect({
            onStep: async (name, type, op) => {
                op();
            }
        });
        const flow = effectPipe(
            () =>
                Command(
                    async function cmdFindUser() {
                        await new Promise((r) => setTimeout(r, 5));
                        return { id: 1 };
                    },
                    (found) => (found ? Failure('Email already in use.') : Success('free'))
                ),
            () =>
                Command(async function cmdSaveUser() {
                    await new Promise((r) => setTimeout(r, 5));
                    saves++;
                    return { id: 2 };
                })
        )({ email: 'taken@x.com' });
        await assert.rejects(
            runEffect(flow),
            (e) => e instanceof TypeError && /'cmdFindUser'.*before op had finished/.test(e.message)
        );
        assert.equal(saves, 0, 'the flow must not continue as though no user was found');
    });

    it('should treat a throw from an op the hook did not wait for as an I/O fault', async function () {
        // Judged as though the hook had awaited op, which a hook missing only its return does. The throw was
        // otherwise left unobserved, so the step passed as a success and the rejection went unhandled.
        let calls = 0;
        configureEffect({
            onStep: async (name, type, op) => {
                op();
            }
        });
        const result = await runEffect(
            Retry(
                Command(async function cmdFlaky() {
                    calls++;
                    await new Promise((r) => setTimeout(r, 5));
                    throw new Error('socket reset');
                }),
                { attempts: 1, delay: 0 }
            )
        );
        assert.equal(/** @type {any} */ (result).error.retryExhausted, true);
        assert.equal(/** @type {any} */ (result).error.lastError.message, 'socket reset');
        assert.equal(calls, 2);
    });

    it('should let a hook return undefined when there was no result to lose', async function () {
        // Replay answers without calling op, a Command can return undefined itself, and a Parallel's op returns
        // its decision, which the interpreter takes from op rather than from the hook.
        const one = () =>
            Command(function cmdOne() {
                return 1;
            });
        assert.deepEqual(await runEffect(one(), {}, { onStep: async () => undefined }), Success(undefined));

        const nothing = Command(function cmdNothing() {
            return undefined;
        });
        const forgetful = {
            onStep: /** @type {import('../index.js').StepRunner} */ (async (n, t, op) => void (await op()))
        };
        assert.deepEqual(await runEffect(nothing, {}, forgetful), Success(undefined));

        const slowNothing = Command(async function cmdSlowNothing() {
            await new Promise((r) => setTimeout(r, 5));
            return undefined;
        });
        const unwaiting = { onStep: /** @type {import('../index.js').StepRunner} */ (async (n, t, op) => void op()) };
        assert.deepEqual(await runEffect(slowNothing, {}, unwaiting), Success(undefined));

        /** @type {import('../index.js').StepRunner} */
        const dropsOnlyParallel = async (name, type, op) => {
            const result = await op();
            return type === 'Parallel' ? undefined : result;
        };
        assert.deepEqual(await runEffect(Parallel([one()]), {}, { onStep: dropsOnlyParallel }), Success([1]));
    });

    it('should still retry an onStep hook that throws without calling op', async function () {
        // How replay reports a recorded error, and how a circuit breaker written as a hook refuses a call.
        let refusals = 0;
        let calls = 0;
        configureEffect({
            onStep: async () => {
                refusals++;
                throw new Error('circuit open');
            }
        });
        const result = await runEffect(
            Retry(
                Command(function cmdWork() {
                    calls++;
                    return 'ok';
                }),
                { attempts: 2, delay: 0 }
            )
        );
        assert.equal(/** @type {any} */ (result).error.retryExhausted, true);
        assert.equal(refusals, 3);
        assert.equal(calls, 0);
    });

    it('should still retry when a hook rethrows the Command error as a different error', async function () {
        let calls = 0;
        configureEffect({
            onStep: async (name, type, op) => {
                try {
                    return await op();
                } catch (e) {
                    throw new Error(`${name} failed`, { cause: e });
                }
            }
        });
        const result = await runEffect(
            Retry(
                Command(function cmdFlaky() {
                    calls++;
                    throw new Error('socket reset');
                }),
                { attempts: 2, delay: 0 }
            )
        );
        assert.equal(calls, 3, 'the Command failed, so the wrapped error is still an I/O fault');
        assert.equal(/** @type {any} */ (result).error.lastError.message, 'cmdFlaky failed');
    });

    it('should hand a hook a promise from op, even for a synchronous Command', async function () {
        // The declared type and the README's "must await op()" both say op returns a promise. It used to hand
        // back a synchronous function's value as it was, so a hook written as op().then(...) compiled and then
        // rejected every run with a synchronous Command, such as the Date.now() the README says to wrap.
        configureEffect({
            onStep: (name, type, op) => op().then((/** @type {any} */ value) => value)
        });
        const result = await runEffect(
            Command(function cmdNow() {
                return 42;
            })
        );
        assert.deepEqual(result, Success(42));

        let calls = 0;
        const thrown = await runEffect(
            Retry(
                Command(function cmdSyncThrow() {
                    calls++;
                    throw new Error('sync');
                }),
                { attempts: 1, delay: 0 }
            )
        );
        assert.equal(
            /** @type {any} */ (thrown).error.retryExhausted,
            true,
            'a synchronous throw is still an I/O fault'
        );
        assert.equal(calls, 2);
    });
});
