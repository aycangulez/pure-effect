// @ts-check

// Random flows, each built twice from one seeded spec: once as pipelines only, and once with generator flows mixed in.
// The two must do the same thing, and every generator body must close as the README says. Timing comes from chains of
// zero-delay timers, so a run is the same every time and a failure reproduces from its seed:
// FUZZ_SEED=<seed> FUZZ_N=1 npx mocha test/fuzz.js. FUZZ_SCALE multiplies the number of flows; CI's fuzz job sets it.

import { strict as assert } from 'assert';
import { isDeepStrictEqual, inspect } from 'node:util';
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
    recorder,
    recordEffect,
    replayEffect,
    effectGen,
    step
} from '../index.js';

/** @import { Effect, CallConfiguration } from "../index.js" */

/**
 * One node of a random flow. A `cmd` answers each call in turn from `outcomes`; `ok` is a pure step that builds an
 * object the next step changes, so a body that runs again and reuses the earlier object gives a different value. A
 * `seq` written as a generator body rethrows from its catch, or breaks a rule on purpose: it swallows the stop, or its
 * finally runs a cleanup Command, which is allowed when the body ends normally and refused when a step stopped it.
 * @typedef {{ kind: 'cmd', id: number, outcomes: string[], ticks: number[], honors: boolean, veto: boolean }} CmdSpec
 * @typedef {CmdSpec | { kind: 'ok', id: number } | { kind: 'fail', id: number } | { kind: 'ask', id: number }
 *   | { kind: 'seq', id: number, children: Spec[], useGen: boolean, ending: 'vals' | 'returnLast' | 'retFail',
 *       body: 'rethrow' | 'swallow' | 'cleanup', cleanup?: CmdSpec }
 *   | { kind: 'retry', id: number, child: Spec, retries: number, fallback: Spec | null }
 *   | { kind: 'par', id: number, children: Spec[], settled: boolean, limit: number | undefined }} Spec
 */

/**
 * What one run did: the Commands it called, in order, and what each generator body did.
 * @typedef {{ counts: Map<number, number>, calls: string[], events: [number, number, string][], anomalies: string[],
 *   bodyRun: number, inflight: Map<number, number> }} RunLog
 */

const scale = Number(process.env.FUZZ_SCALE ?? 1);
const onlySeed = process.env.FUZZ_SEED === undefined ? undefined : Number(process.env.FUZZ_SEED);
const onlyCount = process.env.FUZZ_N === undefined ? undefined : Number(process.env.FUZZ_N);

/**
 * A small seeded generator, so a seed always builds the same flow.
 * @param {number} seed
 * @returns {() => number}
 */
const seeded = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * @param {() => number} rand
 * @param {{ harness: boolean, veto: boolean, unsafe: boolean }} mode
 * @returns {Spec}
 */
const randomSpec = (rand, mode) => {
    let nextId = 0;
    const int = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + Math.floor(rand() * (hi - lo + 1));
    /** @returns {Spec} */
    const leaf = () => {
        const r = rand();
        const id = nextId++;
        if (r < 0.7) {
            const calls = int(1, 4);
            const outcomes = Array.from({ length: calls }, () => {
                const x = rand();
                if (mode.harness && x < 0.03) return 'nextThrows';
                return x < 0.6 ? 'ok' : x < 0.85 ? 'throw' : 'fail';
            });
            const ticks = Array.from({ length: calls }, () => int(0, 5));
            return { kind: 'cmd', id, outcomes, ticks, honors: rand() < 0.4, veto: mode.veto && rand() < 0.08 };
        }
        // A replay finds where a cancelled branch stopped only by its Commands, so it carries a body past an Ask, or
        // a Retry or Parallel with no Command in it, where production stopped it (Documented sharp edges). The mode that
        // holds a replay of a crash to its recording makes every leaf a Command.
        if (mode.harness && mode.unsafe) {
            const outcome = r >= 0.8 && r < 0.87 ? 'fail' : 'ok';
            return { kind: 'cmd', id, outcomes: [outcome], ticks: [0], honors: false, veto: false };
        }
        if (r < 0.8) return { kind: 'ok', id };
        if (r < 0.87) return { kind: 'fail', id };
        return { kind: 'ask', id };
    };
    /** @returns {Spec} */
    const node = (/** @type {number} */ depth) => {
        if (depth >= 4 || rand() < 0.25 + depth * 0.1) return leaf();
        const id = nextId++;
        const r = rand();
        if (r < 0.45) {
            const children = Array.from({ length: int(1, 4) }, () => node(depth + 1));
            const end = rand();
            /** @type {'vals' | 'returnLast' | 'retFail'} */
            let ending = end < 0.15 ? 'returnLast' : end < 0.22 ? 'retFail' : 'vals';
            const useGen = rand() < 0.75;
            if (!mode.unsafe) return { kind: 'seq', id, children, useGen, ending, body: 'rethrow' };
            // Drawn only in this mode, so the other modes keep the flows their seeds always built.
            const b = rand();
            const body = b < 0.6 ? 'rethrow' : b < 0.8 ? 'swallow' : 'cleanup';
            if (body !== 'cleanup') return { kind: 'seq', id, children, useGen, ending, body };
            // A cleanup step runs before what the body returns, which a returned Effect would make hard to mirror.
            if (ending === 'returnLast') ending = 'vals';
            /** @type {CmdSpec} */
            const cleanup = {
                kind: 'cmd',
                id: nextId++,
                outcomes: ['ok'],
                ticks: [int(0, 3)],
                honors: false,
                veto: false
            };
            return { kind: 'seq', id, children, useGen, ending, body, cleanup };
        }
        if (r < 0.7) {
            const child = node(depth + 1);
            return { kind: 'retry', id, child, retries: int(1, 3), fallback: rand() < 0.4 ? node(depth + 1) : null };
        }
        const children = Array.from({ length: int(1, 4) }, () => node(depth + 1));
        return { kind: 'par', id, children, settled: rand() < 0.35, limit: rand() < 0.35 ? int(1, 3) : undefined };
    };
    const flow = node(0);
    if (!(mode.harness && mode.unsafe)) return flow;
    // Around the random flow, a body that would swallow its stop, still waiting on a slow step when a later branch
    // throws: production stops no generator, and a replay that let the cut body swallow its stop would report that
    // body's error, since a Parallel rethrows the first throw by array order.
    const slow = { kind: 'cmd', id: nextId++, outcomes: ['ok'], ticks: [5], honors: false, veto: false };
    const after = leaf();
    const swallowing = {
        kind: 'seq',
        id: nextId++,
        children: [slow, after],
        useGen: true,
        ending: 'vals',
        body: 'swallow'
    };
    const thrower = {
        kind: 'cmd',
        id: nextId++,
        outcomes: ['nextThrows'],
        ticks: [int(0, 2)],
        honors: false,
        veto: false
    };
    return /** @type {Spec} */ ({
        kind: 'par',
        id: nextId++,
        children: [swallowing, flow, thrower],
        settled: rand() < 0.3,
        limit: undefined
    });
};

/** @returns {RunLog} */
const newLog = () => ({ counts: new Map(), calls: [], events: [], anomalies: [], bodyRun: 0, inflight: new Map() });

/**
 * Waits `hops` zero-delay timers, ending early when a Command that honours its signal is cancelled.
 * @param {number} hops
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
const wait = (hops, signal) =>
    new Promise((resolve, reject) => {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const hop = () => {
            if (hops-- <= 0) {
                signal?.removeEventListener('abort', onAbort);
                return resolve();
            }
            timer = setTimeout(hop, 0);
        };
        hop();
    });

/**
 * @param {Extract<Spec, { kind: 'cmd' }>} spec
 * @param {RunLog} log
 * @param {number} [owner] - The generator body whose step this is, so its catch can be checked against it
 * @returns {Effect<any, any, any>}
 */
const makeCommand = (spec, log, owner) => {
    const call = async (/** @type {AbortSignal | undefined} */ signal) => {
        const c = log.counts.get(spec.id) ?? 0;
        log.counts.set(spec.id, c + 1);
        const i = Math.min(c, spec.outcomes.length - 1);
        log.calls.push(`c${spec.id}.${c}`);
        if (owner !== undefined) log.inflight.set(owner, (log.inflight.get(owner) ?? 0) + 1);
        try {
            await wait(spec.ticks[i], signal);
        } finally {
            if (owner !== undefined) log.inflight.set(owner, (log.inflight.get(owner) ?? 1) - 1);
        }
        if (spec.outcomes[i] === 'throw') throw new Error(`E${spec.id}.${c}`);
        return { v: `v${spec.id}.${c}`, o: spec.outcomes[i] };
    };
    // A function that declares a parameter gets the Parallel's signal; one that does not, none.
    const cmd = spec.honors ? (/** @type {AbortSignal | undefined} */ signal) => call(signal) : () => call(undefined);
    return Command(
        cmd,
        (/** @type {{ v: string, o: string }} */ r) => {
            if (r.o === 'fail') return Failure(`F${r.v}`);
            if (r.o === 'nextThrows') throw new Error(`H${r.v}`);
            return Success(r.v);
        },
        { name: `c${spec.id}`, veto: spec.veto }
    );
};

/**
 * A pure step that builds an object, then a step that changes it, as a pipeline.
 * @param {number} id
 * @returns {Effect<string, never, unknown>}
 */
const freshObject = (id) =>
    effectPipe(
        () => Success({ n: 0 }),
        (/** @type {{ n: number }} */ o) => {
            o.n++;
            return Success(`P${id}:${o.n}`);
        }
    )(undefined);

/**
 * @param {Extract<Spec, { kind: 'retry' }>} spec
 * @param {(spec: Spec, log: RunLog) => Effect<any, any, any>} build
 * @param {RunLog} log
 */
const fallbackOf = (spec, build, log) => {
    const fallback = spec.fallback;
    if (!fallback) return undefined;
    return (/** @type {any} */ err) =>
        effectPipe(
            () => build(fallback, log),
            (/** @type {any} */ v) => Success(['fb', v, err.retries, err.lastError?.message ?? String(err.lastError)])
        )(undefined);
};

/**
 * @param {Extract<Spec, { kind: 'retry' }>} spec
 * @param {(spec: Spec, log: RunLog) => Effect<any, any, any>} build
 * @param {RunLog} log
 * @returns {Effect<any, any, any>}
 */
const retryOf = (spec, build, log) =>
    // Typed loosely, since the fallback is optional and Retry's overloads tell a fallback from none by its presence.
    Retry(
        build(spec.child, log),
        /** @type {any} */ ({ retries: spec.retries, delay: 0, onExhausted: fallbackOf(spec, build, log) })
    );

/**
 * @param {Extract<Spec, { kind: 'par' }>} spec
 * @param {(spec: Spec, log: RunLog) => Effect<any, any, any>} build
 * @param {RunLog} log
 * @returns {Effect<any, any, any>}
 */
const parallelOf = (spec, build, log) =>
    // Typed loosely, since Parallel's overloads tell settled from not by a literal true or false.
    Parallel(
        spec.children.map((child) => build(child, log)),
        parallelNext(spec),
        /** @type {any} */ ({ settled: spec.settled, limit: spec.limit })
    );

/** @param {Extract<Spec, { kind: 'par' }>} spec */
const parallelNext = (spec) => (/** @type {any[]} */ xs) =>
    Success(spec.settled ? xs.map((o) => (o.type === 'Success' ? o.value : ['ERR', normal(o.error)])) : xs);

/**
 * The flow as pipelines only.
 * @param {Spec} spec
 * @param {RunLog} log
 * @returns {Effect<any, any, any>}
 */
const buildPipe = (spec, log) => {
    switch (spec.kind) {
        case 'cmd':
            return makeCommand(spec, log);
        case 'ok':
            return freshObject(spec.id);
        case 'fail':
            return Failure(`PF${spec.id}`);
        case 'ask':
            return Ask((/** @type {{ tag: string }} */ ctx) => Success(ctx.tag));
        case 'seq': {
            const n = spec.children.length;
            /** @type {((acc: any) => Effect<any, any, any>)[]} */
            const steps = spec.children.map((child, i) =>
                spec.ending === 'returnLast' && i === n - 1
                    ? () => buildPipe(child, log)
                    : (/** @type {any[]} */ acc) =>
                          effectPipe(
                              () => buildPipe(child, log),
                              (/** @type {any} */ v) => Success([...acc, v])
                          )(undefined)
            );
            const cleanup = spec.useGen && spec.body === 'cleanup' ? spec.cleanup : undefined;
            if (cleanup) {
                steps.push((/** @type {any[]} */ acc) =>
                    effectPipe(
                        () => makeCommand(cleanup, log),
                        () => Success(acc)
                    )(undefined)
                );
            }
            if (spec.ending === 'retFail') steps.push(() => Failure(`RF${spec.id}`));
            return /** @type {any} */ (effectPipe)(...steps)([]);
        }
        case 'retry':
            return retryOf(spec, buildPipe, log);
        case 'par':
            return parallelOf(spec, buildPipe, log);
    }
};

/**
 * The same flow with generator flows mixed in: most sequences become a body with try/catch/finally that records
 * what it did and rethrows.
 * @param {Spec} spec
 * @param {RunLog} log
 * @returns {Effect<any, any, any>}
 */
const buildGen = (spec, log) => {
    if (spec.kind === 'retry') {
        return retryOf(spec, buildGen, log);
    }
    if (spec.kind === 'par') {
        return parallelOf(spec, buildGen, log);
    }
    if (spec.kind !== 'seq') return buildPipe(spec, log);
    if (!spec.useGen) {
        const n = spec.children.length;
        /** @type {((acc: any) => Effect<any, any, any>)[]} */
        const steps = spec.children.map((child, i) =>
            spec.ending === 'returnLast' && i === n - 1
                ? () => buildGen(child, log)
                : (/** @type {any[]} */ acc) =>
                      effectPipe(
                          () => buildGen(child, log),
                          (/** @type {any} */ v) => Success([...acc, v])
                      )(undefined)
        );
        if (spec.ending === 'retFail') steps.push(() => Failure(`RF${spec.id}`));
        return /** @type {any} */ (effectPipe)(...steps)([]);
    }
    const body = effectGen(function* () {
        const me = ++log.bodyRun;
        log.events.push([me, spec.id, 'enter']);
        try {
            /** @type {any[]} */
            const vals = [];
            const n = spec.children.length;
            for (let i = 0; i < n; i++) {
                const child = spec.children[i];
                if (spec.ending === 'returnLast' && i === n - 1) {
                    log.events.push([me, spec.id, 'complete']);
                    return child.kind === 'cmd' ? makeCommand(child, log, me) : buildGen(child, log);
                }
                if (child.kind === 'ask') {
                    vals.push(/** @type {{ tag: string }} */ (yield* step(Ask())).tag);
                } else if (child.kind === 'ok') {
                    const o = yield* step(Success({ n: 0 }));
                    o.n++;
                    vals.push(`P${child.id}:${o.n}`);
                } else if (child.kind === 'cmd') {
                    vals.push(yield* step(makeCommand(child, log, me)));
                } else {
                    vals.push(yield* step(buildGen(child, log)));
                }
                log.events.push([me, spec.id, `after${i}`]);
            }
            log.events.push([me, spec.id, 'complete']);
            if (spec.ending === 'retFail') return Failure(`RF${spec.id}`);
            return vals;
        } catch (e) {
            const name = /** @type {Error} */ (e)?.name;
            log.events.push([me, spec.id, 'catch']);
            if (name !== 'FlowStopped') log.anomalies.push(`body ${me} caught ${name}, not FlowStopped`);
            if ((log.inflight.get(me) ?? 0) > 0) log.anomalies.push(`body ${me} caught while its Command ran`);
            // Swallows only the stop: a JavaScript catch also catches an error thrown inside its try, such as a nested
            // flow's refusal as it is built, and that is the language, not the library.
            if (spec.body === 'swallow' && name === 'FlowStopped') return `swallowed${spec.id}`;
            throw e;
        } finally {
            log.events.push([me, spec.id, 'finally']);
            if (spec.body === 'cleanup' && spec.cleanup) yield* step(makeCommand(spec.cleanup, log, me));
        }
    });
    return body(undefined);
};

/**
 * Errors as plain data, so two runs' outcomes compare by value.
 * @param {any} x
 * @returns {any}
 */
const normal = (x) => {
    if (x instanceof Error) return { name: x.name, message: x.message };
    if (x && typeof x === 'object' && x.retryExhausted) return { ...x, lastError: normal(x.lastError) };
    if (Array.isArray(x)) return x.map(normal);
    return x;
};

/** @param {any} outcome */
const normalOutcome = (outcome) =>
    outcome.type === 'Success'
        ? { type: 'Success', value: normal(outcome.value) }
        : { type: 'Failure', error: normal(outcome.error) };

/**
 * Runs a flow to its outcome or its rejection, failing on a run that does not finish.
 * @param {() => Promise<any>} run
 * @returns {Promise<{ ok?: any, err?: any }>}
 */
const settle = async (run) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('the run did not finish in 10 s')), 10000);
    });
    try {
        // Called inside the chain, so a flow that throws as it is built counts as a rejection too.
        return await Promise.race([
            Promise.resolve()
                .then(run)
                .then(
                    (ok) => ({ ok }),
                    (err) => ({ err })
                ),
            timeout
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Every body a run entered ran its finally exactly once, last, and caught at most once, never after completing.
 * @param {RunLog} log
 * @param {string} label
 * @param {string[]} problems
 */
const checkBodies = (log, label, problems) => {
    /** @type {Map<number, string[]>} */
    const byBody = new Map();
    for (const [body, , event] of log.events) byBody.set(body, [...(byBody.get(body) ?? []), event]);
    for (const [body, events] of byBody) {
        const count = (/** @type {string} */ e) => events.filter((x) => x === e).length;
        if (count('enter') !== 1) problems.push(`${label}: body ${body} entered ${count('enter')} times`);
        if (count('finally') !== 1) problems.push(`${label}: body ${body} ran finally ${count('finally')} times`);
        if (count('catch') > 1 || (count('catch') && count('complete'))) {
            problems.push(`${label}: body ${body} did ${events.join(', ')}`);
        }
        if (events.includes('finally') && events[events.length - 1] !== 'finally') {
            problems.push(`${label}: body ${body} went on after its finally: ${events.join(', ')}`);
        }
    }
    problems.push(...log.anomalies.map((a) => `${label}: ${a}`));
};

/**
 * The ids of the generator bodies in a flow that break a rule on purpose, with how.
 * @param {Spec} spec
 * @param {Map<number, 'swallow' | 'cleanup'>} [ids]
 * @returns {Map<number, 'swallow' | 'cleanup'>}
 */
const ruleBreakers = (spec, ids = new Map()) => {
    if (spec.kind === 'seq' && spec.useGen && spec.body !== 'rethrow') ids.set(spec.id, spec.body);
    if (spec.kind === 'seq' || spec.kind === 'par') spec.children.forEach((child) => ruleBreakers(child, ids));
    if (spec.kind === 'retry') {
        ruleBreakers(spec.child, ids);
        if (spec.fallback) ruleBreakers(spec.fallback, ids);
    }
    return ids;
};

/**
 * Builds and runs `count` flows from consecutive seeds, and fails with the first seed's problems.
 * @param {{ name: string, firstSeed: number, count: number, harness?: boolean, veto?: boolean, replay?: boolean,
 *   unsafe?: boolean }} options
 */
const fuzz = async ({ name, firstSeed, count, harness = false, veto = false, replay = false, unsafe = false }) => {
    /** @type {CallConfiguration} */
    const callConfig = veto
        ? {
              onBeforeCommand: async (command) => {
                  await new Promise((resolve) => setTimeout(resolve, 0));
                  if (command.meta?.veto) throw new Error(`veto ${command.meta.name}`);
              }
          }
        : {};
    const context = { tag: 'T' };
    const seeds =
        onlySeed !== undefined
            ? [onlySeed]
            : Array.from({ length: onlyCount ?? count * scale }, (_, i) => firstSeed + i);
    for (const seed of seeds) {
        const spec = randomSpec(seeded(seed), { harness, veto, unsafe });
        const pipeLog = newLog();
        const genLog = newLog();
        const piped = await settle(() => runEffect(buildPipe(spec, pipeLog), context, callConfig));
        const generated = await settle(() => runEffect(buildGen(spec, genLog), context, callConfig));
        /** @type {string[]} */
        const problems = [];
        const breakers = ruleBreakers(spec);
        const caughtIn = (/** @type {RunLog} */ log, /** @type {'swallow' | 'cleanup'} */ body) =>
            log.events.some(([, id, event]) => event === 'catch' && breakers.get(id) === body);
        const caught = (/** @type {'swallow' | 'cleanup'} */ body) => caughtIn(genLog, body);
        const realBug = /^Hv/.test(generated.err?.message ?? '');
        if (caught('cleanup')) {
            // A step in a body's finally is unsupported: an error passing through can be lost when a cancellation
            // skips that step (Documented sharp edges), but the run never succeeds.
            if (generated.ok?.type === 'Success')
                problems.push('a body with a step in its finally was stopped, and the run succeeded');
        } else if (caught('swallow')) {
            // A stop reached a body that swallows it or runs a step in its finally, which rejects the run. A throw
            // in another branch can come first in array order and be the one rethrown.
            if (!/kept going after/.test(generated.err?.message ?? '') && !realBug) {
                problems.push(
                    `a rule-breaking body was stopped, and the run ended with ${generated.err?.message ?? 'no rejection'}`
                );
            }
        } else {
            if (piped.ok && generated.ok && !isDeepStrictEqual(normalOutcome(piped.ok), normalOutcome(generated.ok))) {
                problems.push('the outcomes differ');
            }
            if (Boolean(piped.err) !== Boolean(generated.err)) problems.push('only one of the two runs rejected');
            if (piped.err && generated.err && piped.err.message !== generated.err.message) {
                problems.push(`they rejected differently: ${piped.err.message} / ${generated.err.message}`);
            }
            if (!isDeepStrictEqual(pipeLog.calls, genLog.calls)) {
                problems.push(`the Commands differ:\n  ${pipeLog.calls.join(' ')}\n  ${genLog.calls.join(' ')}`);
            }
            // A rejected run leaves bodies open by design: a throw stops no generator flow.
            if (!generated.err) checkBodies(genLog, 'run', problems);
        }
        if (replay && generated.ok) {
            const replayLog = newLog();
            // Recorded without the veto, which leaves no trace entry to replay.
            const recorded = await recordEffect(buildGen(spec, newLog()), { context });
            const replayed = await settle(() =>
                replayEffect(buildGen(spec, replayLog), JSON.parse(JSON.stringify(recorded.trace)))
            );
            if (replayed.err) problems.push(`the replay rejected: ${replayed.err.message}`);
            else {
                if (!isDeepStrictEqual(normalOutcome(recorded.result), normalOutcome(replayed.ok.result))) {
                    problems.push('the replay ended differently');
                }
                if (replayed.ok.unreached?.length) problems.push('the replay left recorded steps unreached');
                if (replayLog.calls.length) problems.push(`the replay made I/O: ${replayLog.calls.join(' ')}`);
                checkBodies(replayLog, 'replay', problems);
            }
        }
        if (harness && realBug) {
            // A run rejected by a throw replays to the same rejection, and no sibling's catch replaces it. The trace
            // comes from a second run, whose recorder shifts the timing, so the replay is held to that run.
            const trace = recorder();
            const recordedLog = newLog();
            const recordedRun = await settle(() =>
                runEffect(buildGen(spec, recordedLog), context, { onStep: trace.onStep })
            );
            const recordedBug = /^Hv/.test(recordedRun.err?.message ?? '');
            if (recordedBug && !caughtIn(recordedLog, 'cleanup')) {
                const replayLog = newLog();
                const again = await settle(() =>
                    replayEffect(buildGen(spec, replayLog), JSON.parse(JSON.stringify(trace.toTrace({ context }))))
                );
                if (again.err?.message !== recordedRun.err.message) {
                    const events = (/** @type {RunLog} */ log) => log.events.map((e) => e.join(':')).join(' ');
                    problems.push(
                        `the replay of a rejected run ended with ${again.err?.message ?? 'no rejection'}\n` +
                            `recorded run's bodies: ${events(recordedLog)}\nreplay's bodies: ${events(replayLog)}`
                    );
                }
            }
        }
        if (problems.length) {
            const rerun = `FUZZ_SEED=${seed} npx mocha test/fuzz.js --grep "${name}"`;
            const outcome = generated.err ? `rejected: ${generated.err.message}` : inspect(generated.ok, { depth: 6 });
            const events = genLog.events.map((e) => e.join(':')).join(' ');
            assert.fail(
                `seed ${seed} (${rerun}):\n${problems.join('\n')}\ngenerator run: ${outcome}\nbody events: ${events}\n` +
                    `${genLog.anomalies.join('\n')}\n${inspect(spec, { depth: 20 })}`
            );
        }
    }
};

describe('Generator flows against pipelines, at random', function () {
    this.timeout(120000 * scale);
    beforeEach(() => configureEffect());

    it('should run every random flow as its pipelines do, closing every body', async function () {
        await fuzz({ name: 'closing every body', firstSeed: 1, count: 120 });
    });

    it('should record and replay every random flow that succeeded, with no I/O', async function () {
        await fuzz({ name: 'that succeeded, with no I/O', firstSeed: 10001, count: 60, replay: true });
    });

    it('should reject as the pipelines do when a step throws, and replay to the same rejection', async function () {
        await fuzz({ name: 'when a step throws', firstSeed: 20001, count: 60, harness: true });
    });

    it('should stop as the pipelines do when onBeforeCommand vetoes, and replay the same', async function () {
        await fuzz({ name: 'onBeforeCommand vetoes', firstSeed: 30001, count: 40, veto: true, replay: true });
    });

    it('should reject a run whenever a stop reaches a body that swallows it or runs a step in its finally', async function () {
        await fuzz({ name: 'swallows it or runs a step', firstSeed: 40001, count: 120, unsafe: true });
    });

    it('should replay a successful run with rule-breaking bodies, none of them stopped', async function () {
        await fuzz({ name: 'rule-breaking bodies, none', firstSeed: 50001, count: 60, unsafe: true, replay: true });
    });

    it('should replay a throw to the same error when a sibling body would swallow its stop', async function () {
        await fuzz({ name: 'sibling body would swallow', firstSeed: 60001, count: 100, unsafe: true, harness: true });
    });
});
