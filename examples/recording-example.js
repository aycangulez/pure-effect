// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { configureEffect, recorder, Failure } from 'pure-effect';

/** @import { EffectConfiguration, RunWrapper, StepRunner, CommandInterceptor, TraceEntry, TraceLog, SuccessState, FailureState } from "pure-effect" */

/**
 * Records every run of an application without touching any call site, one trace per run. `recordEffect` covers
 * tests and scripts, where one call holds the whole run.
 */

/**
 * @typedef {Object} RecordingStore
 * @property {ReturnType<typeof recorder>} rec
 * @property {TraceLog} head - The trace's own fields, packaged as the run starts rather than after it
 * @property {boolean} contextCaptured
 */

/**
 * @typedef {Object} RecordingOptions
 * @property {(trace: TraceLog) => Promise<void> | void} [sink] - Receives each kept trace, to write to S3 or a
 *           database. Hand slow writes to a queue rather than awaiting them inside a request.
 * @property {(value: any, name: string, kind: string) => any} [redact] - Scrubs every value before it enters the
 *           trace: results, serialized errors, and the stored `initialInput` and `context`, told apart by `kind`.
 *           It receives a copy, so changing it in place never reaches the run.
 * @property {number} [maxEntries] - Caps trace length, 500 by default; the overflow is reported as `dropped`.
 * @property {boolean} [stack] - Records stack traces for thrown errors.
 * @property {(result: SuccessState<any> | FailureState<any>) => boolean} [keep] - Decides which runs reach the sink:
 *           failures only by default. Return `true` to keep everything, or sample. A run whose own code threw is
 *           offered as a Failure carrying the thrown error.
 * @property {(error: unknown, flowName?: string) => void} [onSinkError] - Receives an error thrown by `keep` or
 *           `sink`. Defaults to `console.error`.
 * @property {(message: string, flowName?: string) => void} [onWarning] - Receives a warning, once per flow, about a
 *           kept trace that will not replay as recorded: it has no input, `maxEntries` cut it short, or some of its
 *           steps are named 'anonymous'. Defaults to `console.warn`.
 */

/**
 * Builds the three hooks that record each run, without installing them, so the caller decides where recording sits
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
        keep = (result) => result.type === 'Failure',
        onSinkError = (error, flowName) => console.error(`Recording failed for '${flowName || 'flow'}':`, error),
        onWarning = (message) => console.warn(message)
    } = options;
    // One recorder per run, found through async-local scope: a single shared recorder would mix concurrent runs.
    /** @type {AsyncLocalStorage<RecordingStore>} */
    const scope = new AsyncLocalStorage();
    /** Warnings already given, as `kind:flowName`. */
    const warned = new Set();

    /** @type {RunWrapper} */
    const onRun = async (effect, pipeline, flowName, initialInput) => {
        const rec = recorder({ redact, maxEntries, stack });
        // Packaged before the run, so a Command that changes its input cannot rewrite what the trace says it received.
        const head = rec.toTrace({ flowName, initialInput });
        return scope.run({ rec, head, contextCaptured: false }, async () => {
            /** @type {{ result: SuccessState<any> | FailureState<any> } | { error: unknown }} */
            let outcome;
            try {
                outcome = { result: await pipeline() };
            } catch (error) {
                outcome = { error };
            }
            // A run whose own code threw is kept as a Failure: it is the one most worth replaying.
            const result = 'result' in outcome ? outcome.result : Failure(outcome.error);
            // Recording never decides the outcome: a keep or sink that throws is reported, not returned.
            try {
                if (keep(result)) {
                    const { dropped = 0, trace } = rec.toTrace();
                    warnAboutReplay(flowName, initialInput, dropped, trace);
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
     */
    const warnAboutReplay = (flowName, initialInput, dropped, trace) => {
        const warnOnce = (/** @type {string} */ kind, /** @type {string} */ message) => {
            if (warned.has(`${kind}:${flowName}`)) return;
            warned.add(`${kind}:${flowName}`);
            onWarning(`Recording '${flowName || 'flow'}': ${message}`, flowName);
        };
        if (initialInput === undefined) {
            warnOnce(
                'input',
                'the flow carries no input, so its traces hold none and timeTravel rebuilds it from undefined. ' +
                    'Build the outermost flow with effectPipe, even as a one-step pipeline.'
            );
        }
        if (dropped > 0) {
            warnOnce(
                'capped',
                `a kept trace dropped ${dropped} entries under maxEntries (${maxEntries}), so it replays only up to ` +
                    'the first step it lacks. Raise maxEntries for this flow to replay whole runs.'
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

    /**
     * `onRun` never sees the context, so it is copied from the run's first Command, before that Command can change
     * it. A run that stops before any Command records none.
     * @type {CommandInterceptor}
     */
    const onBeforeCommand = async (command, context) => {
        const store = scope.getStore();
        if (!store || store.contextCaptured) return;
        store.contextCaptured = true;
        store.head.context = store.rec.toTrace({ context }).context;
    };

    return { onRun, onStep, onBeforeCommand };
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
