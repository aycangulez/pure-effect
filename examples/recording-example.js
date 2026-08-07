// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { configureEffect, recorder } from '../index.js';

/** @import { EffectConfiguration, RunWrapper, StepRunner, CommandInterceptor, TraceLog, SuccessState, FailureState } from "../index.js" */

/**
 * Example wiring for recording every run of an application.
 * `recordEffect` covers tests and scripts, where one call site holds the whole run. This
 * exists for the other case: recording without touching any call site.
 */

/**
 * @typedef {Object} RecordingStore
 * @property {ReturnType<typeof recorder>} rec
 * @property {string} [flowName]
 * @property {any} initialInput
 * @property {any} context
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
 *           sample successes with a probability check.
 */

/**
 * Builds the three hooks that record each run, without installing them.
 *
 * Returning a configuration rather than calling `configureEffect` is what lets recording coexist
 * with tracing: there is one slot per hook, so both concerns go into a single `configureEffect` call,
 * which merges them. A helper that installed itself would silently replace whatever was there.
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
        keep = (result) => result.type === 'Failure'
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
        /** @type {RecordingStore} */
        const store = { rec, flowName, initialInput: /** @type {any} */ (effect).initialInput, context: undefined };
        return scope.run(store, async () => {
            const result = await pipeline();
            if (keep(result)) await sink(rec.toTrace(store));
            return result;
        });
    };

    /**
     * Outside a recorded run there is no store, so the Command runs untouched.
     * @type {StepRunner}
     */
    const onStep = async (name, type, op) => {
        const store = scope.getStore();
        return store ? await store.rec.onStep(name, type, op) : await op();
    };

    /**
     * `onRun` never sees the context, so it is captured from the first Command of the run.
     * @type {CommandInterceptor}
     */
    const onBeforeCommand = async (command, context) => {
        const store = scope.getStore();
        if (store && store.context === undefined) store.context = context;
    };

    return { onRun, onStep, onBeforeCommand };
}

/**
 * Installs recording on its own. Pass `recordingHooks()` to `configureEffect` alongside anything else
 * that needs the hooks instead, since a bare call here replaces whatever was configured before.
 *
 * @param {RecordingOptions} [options]
 */
export function enableRecording(options) {
    configureEffect(recordingHooks(options));
}
