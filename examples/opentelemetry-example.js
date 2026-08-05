// @ts-check

import { trace, SpanStatusCode } from '@opentelemetry/api';
import { configureEffect } from '../index.js';

/** @import { Tracer } from "@opentelemetry/api" */
/** @import { EffectConfiguration, RunWrapper, StepRunner } from "../index.js" */

/**
 * Reference wiring for OpenTelemetry spans
 *
 * `onRun` opens one span per `runEffect` call and `onStep` opens a child span per Command,
 * which is the whole integration: the hooks already sit exactly where spans want to start
 * and end.
 *
 * Importing this file does nothing on its own. Call `startTelemetrySdk()` to stand up an
 * exporter, and `enableTelemetry()` to install the hooks, or `telemetryHooks()` to get them
 * as a configuration you can merge with others.
 *
 * No Command input or output is put on a span, deliberately. Spans carry names, timings, and
 * status; values belong in a trace, where `recorder`'s `redact` strips them before they leave the
 * process and what remains can be replayed. Copying values onto spans would duplicate them into
 * the one place they cannot be redacted after the fact, and an initial input routinely holds a
 * password, a token, or a card number.
 *
 * These hooks use the raw `onStep` and `onRun` rather than `observe`, because a span has to wrap
 * `op`: `startActiveSpan` is what makes each Command span a child of the run's span. An integration
 * that only watches, such as metrics or logging, should use `observe` instead and cannot break a
 * flow by throwing.
 */

/**
 * @typedef {Object} TelemetryOptions
 * @property {string} [tracerName] - Defaults to `'pure-effect'`.
 * @property {Tracer} [tracer] - Supply a tracer directly instead of resolving one by name. Useful in tests.
 */

/**
 * A span status message, without putting a Command's data on the span.
 *
 * Only a string error or an Error's message is used. A structured error object can hold the very
 * values this file keeps off spans, and `String(someObject)` would say nothing useful anyway.
 *
 * @param {any} error
 * @returns {string | undefined}
 */
const statusMessage = (error) =>
    error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;

/**
 * Builds the tracing hooks without installing them.
 *
 * Returning a configuration rather than calling `configureEffect` is what lets tracing coexist with
 * recording: there is one slot per hook, so both concerns go into a single `configureEffect` call,
 * which merges them. A helper that installed itself would silently replace whatever was there.
 *
 * @param {TelemetryOptions} [options]
 * @returns {EffectConfiguration}
 */
export function telemetryHooks(options = {}) {
    const { tracerName = 'pure-effect', tracer = trace.getTracer(tracerName) } = options;

    /**
     * The root span is named after the flow, so traces are distinguishable in a UI. Every span
     * ends in a `finally`, so a thrown Command cannot leak one.
     * @type {RunWrapper}
     */
    const onRun = (effect, pipeline, flowName) =>
        tracer.startActiveSpan(flowName || 'Effect Pipeline', async (rootSpan) => {
            rootSpan.setAttribute('effect.flow', flowName || '');
            try {
                const result = await pipeline();
                if (result.type === 'Failure') {
                    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage(result.error) });
                } else {
                    rootSpan.setStatus({ code: SpanStatusCode.OK });
                }
                return result;
            } catch (/** @type any */ err) {
                rootSpan.recordException(err);
                rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
                throw err;
            } finally {
                rootSpan.end();
            }
        });

    /**
     * `op` has to be awaited and its result returned. Returning a value without calling `op` is how
     * replay suppresses I/O, so a hook that forgot to call it would silently stop every Command.
     * @type {StepRunner}
     */
    const onStep = (name, type, op) =>
        tracer.startActiveSpan(name, async (span) => {
            span.setAttribute('effect.type', type);
            try {
                const result = await op();
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
            } catch (/** @type any */ err) {
                span.recordException(err);
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
                throw err;
            } finally {
                span.end();
            }
        });

    return { onRun, onStep };
}

/**
 * Installs tracing on its own. Pass `telemetryHooks()` to `configureEffect` alongside anything else
 * that needs the hooks instead, since a bare call here replaces whatever was configured before.
 *
 * @param {TelemetryOptions} [options]
 */
export function enableTelemetry(options) {
    configureEffect(telemetryHooks(options));
}

/**
 * Starts a Node SDK exporting over OTLP, and returns it so a caller can shut it down.
 *
 * Kept out of module scope on purpose: importing a reference file should not open exporters, spawn
 * background work, or register process handlers. The SDK is imported dynamically so the hooks above
 * stay usable wherever `@opentelemetry/api` runs, without pulling the Node SDK in behind them.
 *
 * @param {Object} [options]
 * @param {string} [options.serviceName]
 * @param {string} [options.url] - OTLP HTTP endpoint.
 * @param {boolean} [options.handleSigterm] - Flush and exit on SIGTERM. Off by default, since
 *          installing a process handler is the application's decision, not a library's.
 */
export async function startTelemetrySdk(options = {}) {
    const { serviceName = 'pure-effect', url = 'http://localhost:4318/v1/traces', handleSigterm = false } = options;
    const [{ NodeSDK }, { OTLPTraceExporter }, { SimpleSpanProcessor }] = await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/exporter-trace-otlp-proto'),
        import('@opentelemetry/sdk-trace-base')
    ]);

    const traceExporter = new OTLPTraceExporter({ url });
    // `spanProcessors` replaced the deprecated singular `spanProcessor`, and passing an exporter
    // alongside a processor that already wraps it was redundant.
    const sdk = new NodeSDK({
        serviceName,
        spanProcessors: [new SimpleSpanProcessor(traceExporter)],
        instrumentations: []
    });

    sdk.start();

    if (handleSigterm) {
        process.on('SIGTERM', () => {
            sdk.shutdown()
                .then(() => console.log('Tracing terminated'))
                .catch((error) => console.log('Error terminating tracing', error))
                .finally(() => process.exit(0));
        });
    }

    return sdk;
}
