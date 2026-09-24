// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { configureEffect, recorder, Failure } from '../index.js';

/** @import { EffectConfiguration, RunWrapper, StepRunner, CommandInterceptor, TraceLog, SuccessState, FailureState } from "../index.js" */

/**
 * Example wiring for recording every run of an application.
 * `recordEffect` covers tests and scripts, where one call site holds the whole run. This
 * exists for the other case: recording without touching any call site.
 */

/**
 * @typedef {Object} RecordingStore
 * @property {ReturnType<typeof recorder>} rec
 * @property {TraceLog} head - The trace's own fields, packaged as the run starts rather than after it
 * @property {boolean} contextCaptured
 */

/**
 * @typedef {Object} RecordingOptions
 * @property {(trace: TraceLog) => Promise<void> | void} [sink] - Receives a finished trace. Writing to
 *           S3 or a database fit here. Prefer not to await slow I/O inside
 *           a request: hand the trace to a queue or a background task instead.
 * @property {(value: any, name: string, kind: string) => any} [redact] - Runs before any value enters the
 *           trace, so nothing sensitive reaches the sink even in memory. It sees results, serialized errors,
 *           and the `initialInput` and `context` the trace stores, distinguished by `kind`.
 * @property {number} [maxEntries] - Caps trace length; the overflow count is reported as `dropped`.
 * @property {boolean} [stack] - Records stack traces for thrown errors.
 * @property {(result: SuccessState<any> | FailureState<any>) => boolean} [keep] - Decides which runs
 *           reach the sink. Defaults to failures only. Return `true` always to keep everything, or
 *           sample successes with a probability check. A run that rejected, because the flow's own code
 *           threw, is offered as a Failure carrying the thrown error, so the default keeps it.
 * @property {(error: unknown, flowName?: string) => void} [onSinkError] - Receives an error thrown by `keep`
 *           or `sink`, which would otherwise have replaced the run's outcome. Defaults to `console.error`.
 */

/**
 * Builds the three hooks that record each run, without installing them.
 *
 * Returning a configuration leaves the caller in charge of where recording sits relative to tracing:
 * passed to one `configureEffect` call together, or installed as separate layers, the two merge the
 * same way, and the caller holds the function that removes each.
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
        onSinkError = (error, flowName) => console.error(`Recording failed for '${flowName || 'flow'}':`, error)
    } = options;
    /** @type {AsyncLocalStorage<RecordingStore>} */
    const scope = new AsyncLocalStorage();

    /**
     * One recorder per run, held in async-local scope so `onStep` can find the right one without a
     * recorder being threaded through any business-logic signature. A single module-level recorder
     * would interleave the steps of concurrent runs into one trace.
     * @type {RunWrapper}
     */
    const onRun = async (effect, pipeline, flowName) => {
        const rec = recorder({ redact, maxEntries, stack });
        // `toTrace` copies the input when it is called, so it is called now: a Command that assigns an id to
        // the object it was handed would otherwise rewrite what the trace says production received. The input
        // is read off the flow, where only `effectPipe` puts it, so a flow whose outermost node is a bare
        // Command, Ask, Retry, or Parallel records none; wrap it in a one-step pipeline to record it.
        const head = rec.toTrace({ flowName, initialInput: /** @type {any} */ (effect).initialInput });
        /** @type {RecordingStore} */
        const store = { rec, head, contextCaptured: false };
        return scope.run(store, async () => {
            // A run rejects when the flow's own code throws, a TypeError after an API changed shape for one, and
            // that is the run most worth replaying: the trace reproduces the throw offline. So it is offered to
            // `keep` as a Failure carrying the thrown error, and still rejects once the trace has been handled.
            /** @type {{ result: SuccessState<any> | FailureState<any> } | { error: unknown }} */
            let outcome;
            try {
                outcome = { result: await pipeline() };
            } catch (error) {
                outcome = { error };
            }
            const result = 'result' in outcome ? outcome.result : Failure(outcome.error);
            // Recording must never decide a run's outcome, the rule the telemetry example keeps as well. `keep`
            // and `sink` are the application's code, and a sink that serializes the trace throws on a circular
            // value such as an HTTP client's error, so a failure is reported rather than returned.
            try {
                if (keep(result)) {
                    const { dropped, trace } = rec.toTrace();
                    await sink({ ...head, dropped, trace });
                }
            } catch (error) {
                try {
                    onSinkError(error, flowName);
                } catch {
                    // A reporter that throws does not get to change the run either.
                }
            }
            if ('error' in outcome) throw outcome.error;
            return outcome.result;
        });
    };

    /**
     * Outside a recorded run there is no store, so the Command runs untouched. The fourth argument,
     * `path`, has to be forwarded: it is what a replay matches on, and a trace without it cannot tell
     * `Parallel` branches apart.
     * @type {StepRunner}
     */
    const onStep = async (name, type, op, path) => {
        const store = scope.getStore();
        return store ? await store.rec.onStep(name, type, op, path) : await op();
    };

    /**
     * `onRun` never sees the context, so it is captured from the first Command of the run, and copied there,
     * before that Command can write to it. A run that stops before any Command, at a validation step or an
     * `Ask` check, records no context, and its replay can take another branch and report `Trace exhausted`.
     * Such a run did no I/O, so running the flow again with its input and the logged context reproduces it.
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
 * Installs recording as its own layer on top of whatever is configured, and returns the function that
 * removes it again. Call it once per process: layers stack, so a second call records every Command
 * twice and writes two traces per run. A setup path that can run again (a reloading dev server, a
 * per-suite bootstrap) should hold the remover and call it before installing a fresh layer.
 *
 * @param {RecordingOptions} [options]
 */
export function enableRecording(options) {
    return configureEffect(recordingHooks(options));
}
