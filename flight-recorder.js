// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { configureEffect, recorder, Failure } from './index.js';

/** @import { EffectConfiguration, RunWrapper, StepRunner, TraceEntry, TraceLog, SuccessState, FailureState, RecorderOptions } from "./index.js" */

/**
 * The flight recorder: records every run of an application without touching any call site, one trace per run, and
 * keeps the runs worth replaying. `recordEffect` covers tests and scripts, where one call holds the whole run.
 */

/**
 * @typedef {Object} RecordingOptions
 * @property {((trace: TraceLog) => Promise<void> | void) | undefined} [sink] - Receives each kept trace, to write to S3 or a
 *           database. Hand slow writes to a queue rather than awaiting them inside a request.
 * @property {RecorderOptions['redact']} [redact] - Scrubs every value before it enters the
 *           trace: results, serialized errors, and the stored `initialInput` and `context`, told apart by `kind`.
 *           It receives a copy, so changing it in place never reaches the run. A value it throws on is left out of
 *           the trace, which marks where, as is one the recorder cannot copy.
 * @property {number | undefined} [maxEntries] - Caps trace length, 500 by default; the overflow is reported as `dropped`.
 * @property {boolean | undefined} [stack] - Records stack traces for thrown errors.
 * @property {boolean | undefined} [recordOutcome] - Records how each run ended in its trace, through `redact`, so a
 *           replay can say whether it ends the same way. On by default; `false` leaves it out.
 * @property {string | undefined} [version] - Commit or build id, attached to each trace, so `timeTravel` can warn
 *           when it replays a trace against another build.
 * @property {((result: SuccessState<any> | FailureState<any>, entries: TraceEntry[], flowName: string) => boolean) | undefined} [keep] - Decides
 *           which runs reach the sink, from the outcome, the trace's entries and the run's name: by default a run that
 *           ended in a Failure or in which a Command threw, as a retried or dead-lettered one did. Return `true` to
 *           keep everything. A run whose own code threw is offered as a Failure carrying the thrown error. Not given
 *           with `sample`.
 * @property {SampleOptions | undefined} [sample] - Keeps a share of each kind of run in place of `keep`, with a cap
 *           on how many traces a flow stores in a minute, and other shares for the flows `flows` names.
 * @property {((error: unknown, flowName?: string) => void) | undefined} [onSinkError] - Receives an error thrown by `keep` or
 *           `sink`. Defaults to `console.error`.
 * @property {((message: string, flowName?: string) => void) | undefined} [onWarning] - Receives a warning, once per flow, about a
 *           kept trace that will not replay as recorded: it has no input, `maxEntries` cut it short, some of its values
 *           could not be recorded, its outcome could not be recorded, or some of its steps are named 'anonymous'.
 *           Defaults to `console.warn`.
 */

/**
 * The share of each kind of run to keep, from 0 to 1, and a cap. Every run is one kind: `threw` if a Command in it
 * threw or its own code did, whatever it ended in, else `failed` or `succeeded` by its outcome.
 * @typedef {Object} SampleRates
 * @property {number | undefined} [threw] - The share of runs in which something threw. 1 by default.
 * @property {number | undefined} [failed] - The share of runs that ended in a Failure a step returned. 1 by default.
 * @property {number | undefined} [succeeded] - The share of runs that succeeded. 0 by default.
 * @property {number | undefined} [perMinute] - The most traces one flow stores in a minute, of every kind together.
 *           No cap by default.
 */

/**
 * The shares for every flow, and under `flows` the ones a flow replaces, by its `flowName`. A flow's entry replaces
 * only the keys it names.
 * @typedef {SampleRates & { flows?: Record<string, SampleRates> | undefined }} SampleOptions
 */

/** @typedef {'threw' | 'failed' | 'succeeded'} RunKind */

/** What `sample` keeps when a share or the cap is left out, which is what the default `keep` keeps. */
const defaultRates = { threw: 1, failed: 1, succeeded: 0, perMinute: Infinity };

/**
 * Describes a value for an error message.
 * @param {unknown} value
 * @returns {string}
 */
const describe = (value) => {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value)) return 'an array';
    if (typeof value === 'object' || typeof value === 'function')
        return `a${typeof value === 'object' ? 'n' : ''} ${typeof value}`;
    return typeof value === 'string' ? JSON.stringify(value) : `the ${typeof value} ${String(value)}`;
};

/**
 * Refuses rates that are not an object, a key they do not have, a share outside 0 to 1, and a cap that is not a
 * positive integer. A key set to `undefined` keeps its default.
 * @param {any} rates
 * @param {string} source - Where they were given, as the message names it
 * @param {string[]} known - The keys they may hold
 */
const checkRates = (rates, source, known) => {
    if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) {
        throw new TypeError(`${source} must be an object, got ${describe(rates)}.`);
    }
    const unknown = Object.keys(rates).find((key) => !known.includes(key));
    if (unknown !== undefined) {
        throw new TypeError(`${source} has no key named '${unknown}'; its keys are ${known.join(', ')}.`);
    }
    for (const kind of ['threw', 'failed', 'succeeded']) {
        const share = rates[kind];
        if (share !== undefined && !(typeof share === 'number' && share >= 0 && share <= 1)) {
            throw new TypeError(`${source}.${kind} must be a number from 0 to 1, got ${describe(share)}.`);
        }
    }
    const { perMinute } = rates;
    if (perMinute !== undefined && !(Number.isInteger(perMinute) && perMinute >= 1)) {
        throw new TypeError(`${source}.perMinute must be a positive integer, got ${describe(perMinute)}.`);
    }
};

/**
 * Builds the function that decides whether a run of one kind is kept, from `sample`. A share is counted rather than
 * drawn at random: each flow keeps the first run of a kind and then every run that brings the share back up to date,
 * so one in ten is the first, the eleventh and so on. The cap comes after the shares, and counts one flow's kept
 * traces of every kind in a minute that starts with the first of them.
 * @param {SampleOptions} sample
 * @returns {(kind: RunKind, flowName: string) => boolean}
 */
const sampler = (sample) => {
    const rateNames = Object.keys(defaultRates);
    checkRates(sample, "recordingHooks' sample", [...rateNames, 'flows']);
    const { flows = {}, ...shared } = sample;
    checkRates(flows, "recordingHooks' sample.flows", Object.keys(flows ?? {}));
    for (const [name, rates] of Object.entries(flows))
        checkRates(rates, `recordingHooks' sample.flows.${name}`, rateNames);
    const given = (/** @type {SampleRates} */ rates) =>
        Object.fromEntries(Object.entries(rates).filter(([, value]) => value !== undefined));
    const ratesFor = (/** @type {string} */ flowName) => ({
        ...defaultRates,
        ...given(shared),
        // Own keys only, so a flow named 'constructor' gets no rates from Object.prototype.
        ...(Object.hasOwn(flows, flowName) ? given(flows[flowName]) : {})
    });
    /** How much of its share each kind of each flow is owed, as `kind:flowName`. A run is kept once it reaches 1. */
    const owed = new Map();
    /** @type {Map<string, { started: number, kept: number }>} Each flow's current minute. */
    const minutes = new Map();
    return (kind, flowName) => {
        const rates = ratesFor(flowName);
        const share = rates[kind];
        if (share <= 0) return false;
        const key = `${kind}:${flowName}`;
        // Starts one share short of 1, so the first run is kept.
        const credit = (owed.get(key) ?? 1 - share) + share;
        // A little under 1 counts, since ten additions of 0.1 fall just short of it.
        const due = credit >= 1 - 1e-9;
        owed.set(key, due ? credit - 1 : credit);
        if (!due) return false;
        if (rates.perMinute === Infinity) return true;
        const now = Date.now();
        let minute = minutes.get(flowName);
        if (!minute || now - minute.started >= 60_000) minutes.set(flowName, (minute = { started: now, kept: 0 }));
        if (minute.kept >= rates.perMinute) return false;
        minute.kept++;
        return true;
    };
};

/**
 * Builds the two hooks that record each run, without installing them, so the caller decides where recording sits
 * among its other hooks.
 *
 * @param {RecordingOptions} [options]
 * @returns {EffectConfiguration}
 */
export function recordingHooks(options = {}) {
    const {
        sink = async () => {},
        redact,
        maxEntries = 500,
        stack,
        recordOutcome = true,
        version,
        sample,
        keep = (result, entries) => result.type === 'Failure' || entries.some((entry) => entry.threw === true),
        onSinkError = (error, flowName) => console.error(`Recording failed for '${flowName || 'flow'}':`, error),
        onWarning = (message) => console.warn(message)
    } = options;
    if (sample !== undefined && options.keep !== undefined) {
        throw new TypeError(
            'recordingHooks takes sample or keep, not both: sample keeps a share of each kind of run, and keep ' +
                'decides each run itself.'
        );
    }
    const sampled = sample === undefined ? undefined : sampler(sample);
    // One recorder per run, found through async-local scope: a single shared recorder would mix concurrent runs.
    // `head` holds the trace's own fields, packaged as the run starts rather than after it.
    /** @type {AsyncLocalStorage<{ rec: ReturnType<typeof recorder>, head: TraceLog }>} */
    const scope = new AsyncLocalStorage();
    /** Warnings already given, as `kind:flowName`. */
    const warned = new Set();

    /** @type {RunWrapper} */
    const onRun = async (op, flowName, initialInput, context) => {
        const rec = recorder({ redact, maxEntries, stack });
        // Packaged before the run, so a Command that changes its input or context cannot rewrite what the trace says
        // the run received, and a run that stops before its first Command keeps both. `toTrace` never throws, which
        // matters here, where a throw would stop the run before it started: a value it cannot record is left out and
        // named in the trace's `unrecorded`.
        const head = rec.toTrace({ flowName, initialInput, context, version });
        return scope.run({ rec, head }, async () => {
            /** @type {{ result: SuccessState<any> | FailureState<any> } | { error: unknown }} */
            let outcome;
            try {
                outcome = { result: await op() };
            } catch (error) {
                outcome = { error };
            }
            // A run whose own code threw is kept as a Failure: it is the one most worth replaying.
            const result = 'result' in outcome ? outcome.result : Failure(outcome.error);
            // Recording never decides the outcome: a keep or sink that throws is reported, not returned.
            try {
                // The outcome is packed with the entries, once the run has ended.
                const tail = rec.toTrace(recordOutcome ? { outcome: result } : {});
                const { dropped = 0, trace } = tail;
                const threw = 'error' in outcome || trace.some((entry) => entry.threw === true);
                const kind = threw ? 'threw' : result.type === 'Failure' ? 'failed' : 'succeeded';
                if (sampled ? sampled(kind, flowName ?? '') : keep(result, trace, flowName ?? '')) {
                    const unrecordedFields = { ...head.unrecorded, ...tail.unrecorded };
                    const unrecorded =
                        Object.keys(head.unrecorded ?? {}).length +
                        trace.filter((e) => e.unrecorded !== undefined).length;
                    warnAboutReplay(flowName, initialInput, dropped, trace, unrecorded, 'outcome' in unrecordedFields);
                    await sink({
                        ...head,
                        ...('outcome' in tail && { outcome: tail.outcome }),
                        ...(Object.keys(unrecordedFields).length > 0 && { unrecorded: unrecordedFields }),
                        dropped,
                        trace
                    });
                }
            } catch (error) {
                reportSinkError(error, flowName);
            }
            if ('error' in outcome) throw outcome.error;
            return outcome.result;
        });
    };

    /**
     * Warns, once per flow, about a kept trace that will not replay as recorded.
     * @param {string} flowName
     * @param {unknown} initialInput
     * @param {number} dropped
     * @param {TraceEntry[]} trace
     * @param {number} unrecorded - How many values the trace leaves out because they could not be recorded
     * @param {boolean} noOutcome - Whether `recordOutcome` could not record how the run ended
     */
    const warnAboutReplay = (flowName, initialInput, dropped, trace, unrecorded, noOutcome) => {
        const warnOnce = (/** @type {string} */ kind, /** @type {string} */ message) => {
            if (warned.has(`${kind}:${flowName}`)) return;
            warned.add(`${kind}:${flowName}`);
            onWarning(`Recording '${flowName || 'flow'}': ${message}`, flowName);
        };
        if (initialInput === undefined) {
            warnOnce(
                'input',
                'the flow carries no input, so its traces hold none and timeTravel rebuilds it from undefined. ' +
                    'If the flow takes an input, build its outermost flow with effectPipe, even as a one-step ' +
                    'pipeline.'
            );
        }
        if (dropped > 0) {
            warnOnce(
                'capped',
                `a kept trace dropped ${dropped} entries under maxEntries (${maxEntries}), so it replays only up to ` +
                    'the first step it lacks. Raise maxEntries for this flow to replay whole runs.'
            );
        }
        if (unrecorded > 0) {
            warnOnce(
                'unrecorded',
                `${unrecorded} of the values a kept trace holds could not be recorded, because redact threw on them or ` +
                    'returned undefined, or they could not be copied, so it replays only up to the first of them. ' +
                    'Make redact handle every value it is given, null included, and return a value for each, and ' +
                    "keep Commands' results to plain data."
            );
        }
        if (noOutcome) {
            warnOnce(
                'outcome',
                'a kept trace holds no outcome, because redact threw on it or returned undefined, or it could not be ' +
                    'copied, so a replay cannot say whether it ends the same way. Make redact handle the value ' +
                    "named 'outcome', and keep what the flow returns to plain data."
            );
        }
        const anonymous = trace.filter((entry) => entry.command === 'anonymous').length;
        if (anonymous > 0) {
            warnOnce(
                'anonymous',
                `${anonymous} of its steps are named 'anonymous', usually inline arrow Commands, so a replay cannot ` +
                    'tell them apart and would not notice two of them trading places. Name them with a const, as in ' +
                    'const cmdLoadOrder = () => ..., or with meta.name.'
            );
        }
    };

    /** A reporter that throws does not change the run either. */
    const reportSinkError = (/** @type {unknown} */ error, /** @type {string} */ flowName) => {
        try {
            onSinkError(error, flowName);
        } catch {}
    };

    /**
     * Outside a recorded run there is no store, so the Command runs untouched. `path` must be passed on: a replay
     * matches steps on it.
     * @type {StepRunner}
     */
    const onStep = async (name, type, op, path) => {
        const store = scope.getStore();
        return store ? await store.rec.onStep(name, type, op, path) : await op();
    };

    return { onRun, onStep };
}

/**
 * Installs recording as its own layer and returns the function that removes it. Call it once per process: layers
 * stack, so a second call records every run twice.
 *
 * @param {RecordingOptions} [options]
 */
export function enableRecording(options) {
    return configureEffect(recordingHooks(options));
}
