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
 * @property {string | undefined} [version] - Commit or build id, attached to each trace, so `timeTravel` can warn
 *           when it replays a trace against another build.
 * @property {((result: SuccessState<any> | FailureState<any>, entries: TraceEntry[]) => boolean) | undefined} [keep] - Decides which
 *           runs reach the sink, from the outcome and the trace's entries: by default a run that ended in a Failure
 *           or in which a Command threw, as a retried or dead-lettered one did. Return `true` to keep everything, or
 *           sample. A run whose own code threw is offered as a Failure carrying the thrown error.
 * @property {((error: unknown, flowName?: string) => void) | undefined} [onSinkError] - Receives an error thrown by `keep` or
 *           `sink`. Defaults to `console.error`.
 * @property {((message: string, flowName?: string) => void) | undefined} [onWarning] - Receives a warning, once per flow, about a
 *           kept trace that will not replay as recorded: it has no input, `maxEntries` cut it short, some of its values
 *           could not be recorded, or some of its steps are named 'anonymous'. Defaults to `console.warn`.
 */

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
        version,
        keep = (result, entries) => result.type === 'Failure' || entries.some((entry) => entry.threw === true),
        onSinkError = (error, flowName) => console.error(`Recording failed for '${flowName || 'flow'}':`, error),
        onWarning = (message) => console.warn(message)
    } = options;
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
                const { dropped = 0, trace } = rec.toTrace();
                if (keep(result, trace)) {
                    const unrecorded =
                        Object.keys(head.unrecorded ?? {}).length +
                        trace.filter((e) => e.unrecorded !== undefined).length;
                    warnAboutReplay(flowName, initialInput, dropped, trace, unrecorded);
                    await sink({ ...head, dropped, trace });
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
     */
    const warnAboutReplay = (flowName, initialInput, dropped, trace, unrecorded) => {
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
