// @ts-check

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { configureEffect } from './index.js';

/** @import { RunWrapper, StepRunner } from "./index.js" */

const traceExporter = new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces'
});

const sdk = new NodeSDK({
    serviceName: 'pure-effect-test',
    traceExporter,
    spanProcessor: new SimpleSpanProcessor(traceExporter),
    instrumentations: []
});

sdk.start();

process.on('SIGTERM', () => {
    sdk.shutdown()
        .then(() => console.log('Tracing terminated'))
        .catch((error) => console.log('Error terminating tracing', error))
        .finally(() => process.exit(0));
});

export function enableTelemetry() {
    const tracer = trace.getTracer('pure-effect-test');
    configureEffect({
        /** @type RunWrapper */
        onRun: (effect, pipeline, flowName) => {
            return tracer.startActiveSpan('Effect Pipeline', async (rootSpan) => {
                try {
                    rootSpan.setAttribute('effect.initialInput', JSON.stringify(effect.initialInput));
                    rootSpan.setAttribute('effect.flow', flowName || '');

                    const result = await pipeline();

                    if (result.type === 'Failure') {
                        rootSpan.setStatus({
                            code: SpanStatusCode.ERROR,
                            message: String(result.error)
                        });
                    } else {
                        rootSpan.setStatus({ code: SpanStatusCode.OK });
                    }

                    return result;
                } catch (/** @type any */ err) {
                    rootSpan.recordException(err);
                    rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                    throw err;
                } finally {
                    rootSpan.end();
                }
            });
        },
        /** @type StepRunner */
        onStep: (name, type, op) => {
            return tracer.startActiveSpan(name, async (span) => {
                span.setAttribute('effect.type', type);
                try {
                    const result = await op();
                    try {
                        if (result !== undefined) {
                            const outputString = typeof result === 'object' ? JSON.stringify(result) : String(result);
                            span.setAttribute('effect.output', outputString);
                        }
                    } catch (serializationError) {
                        span.setAttribute('effect.output', '[Circular or Non-Serializable Data]');
                    }
                    span.setStatus({ code: SpanStatusCode.OK });
                    return result;
                } catch (/** @type any */ err) {
                    span.recordException(err);
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: err.message
                    });
                    throw err;
                } finally {
                    span.end();
                }
            });
        }
    });
}
