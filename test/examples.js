// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Ask,
    Parallel,
    Retry,
    effectPipe,
    runEffect,
    configureEffect,
    replayEffect,
    timeTravel
} from '../index.js';
import { enableTelemetry, telemetryHooks } from '../examples/opentelemetry-example.js';
import { recordingHooks } from '../flight-recorder.js';
import { importCopiedExample, jsTypeErrors, consumerTypeErrors, consumerFilesTypeErrors } from './helpers.js';
import { jsDeclarations } from '../scripts/js-declarations.js';
import { readFileSync } from 'node:fs';

describe('The generated declaration files', function () {
    // The examples shipped as JavaScript alone, so a TypeScript project that copied one needed allowJs, which also
    // type-checked the copy under its own settings: the telemetry example's SDK imports failed a project without the
    // SDK installed. In every round of the October 2026 DX experiments a TypeScript reader raised it.
    it('should hold exactly the declarations the generator writes', async function () {
        this.timeout(20000);
        for (const [path, generated] of await jsDeclarations()) {
            assert.ok(
                readFileSync(path, 'utf8') === generated,
                `${path} differs from what scripts/js-declarations.js writes; run npm run generate`
            );
        }
    });

    it('should type the flight recorder and the telemetry example for a project without allowJs, naming no package beyond the API', function () {
        this.timeout(20000);
        const source = [
            "import { configureEffect } from 'pure-effect';",
            "import { recordingHooks, enableRecording } from 'pure-effect/flight-recorder';",
            "import { telemetryHooks, enableTelemetry, startTelemetrySdk } from './examples/opentelemetry-example.js';",
            'declare const fromConfig: { cap?: number; build?: string };',
            'configureEffect(',
            '    telemetryHooks({ tracerName: undefined }),',
            '    recordingHooks({ sink: (trace) => void trace.flowName, maxEntries: fromConfig.cap, version: fromConfig.build })',
            ');',
            'const removers: (() => void)[] = [enableRecording(), enableTelemetry()];',
            'void removers;',
            'void startTelemetrySdk({ serviceName: undefined }).then((sdk) => sdk.shutdown());',
            '// @ts-expect-error maxEntries is a number',
            "recordingHooks({ maxEntries: 'many' });"
        ].join('\n');
        assert.deepEqual(consumerFilesTypeErrors({ 'consumer.ts': source }, { allowJs: false, checkJs: false }), []);
        for (const path of ['flight-recorder.d.ts', 'examples/opentelemetry-example.d.ts']) {
            const text = readFileSync(path, 'utf8');
            assert.ok(!/sdk-node|exporter-trace|sdk-trace-base/.test(text), `${path} names an SDK package`);
        }
    });
});

describe('examples/opentelemetry-example.js', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

    it('should run as it is when copied into a project that installs the library', async function () {
        // It imported '../index.js', a path that exists only in this repository, so every copy failed with
        // `Cannot find module` until its import was edited. It imports the library by its package name instead.
        const copied = await importCopiedExample('opentelemetry-example.js');
        assert.equal(typeof copied.telemetryHooks, 'function');
    });

    it('should type-check in a project with exactOptionalPropertyTypes', function () {
        // A failed run's status set `message: undefined` for an error it keeps off the span, which SpanStatus refuses
        // under that flag.
        this.timeout(20000);
        assert.deepEqual(jsTypeErrors('examples/opentelemetry-example.js'), []);
    });

    /** A tracer stub, so the example is testable without standing up an SDK. */
    const fakeTracer = () => {
        /** @type {any[]} */
        const spans = [];
        return {
            spans,
            tracer: /** @type {any} */ ({
                startActiveSpan: (/** @type {string} */ name, /** @type {any} */ fn) => {
                    const span = {
                        name,
                        /** @type {Record<string, any>} */ attributes: {},
                        /** @type {any} */ status: undefined,
                        exceptions: /** @type {any[]} */ ([]),
                        ended: false,
                        setAttribute(/** @type {string} */ k, /** @type {any} */ v) {
                            this.attributes[k] = v;
                        },
                        setStatus(/** @type {any} */ st) {
                            this.status = st;
                        },
                        recordException(/** @type {any} */ e) {
                            this.exceptions.push(e);
                        },
                        end() {
                            this.ended = true;
                        }
                    };
                    spans.push(span);
                    return fn(span);
                }
            })
        };
    };

    const workFlow = (/** @type {any} */ input) =>
        effectPipe((/** @type {any} */ i) =>
            Command(
                function cmdWork() {
                    return 'done';
                },
                (/** @type {any} */ v) => Success(v)
            )
        )(input);

    it('should not let an unserializable input stop the flow', async function () {
        // A request object or database client in the input is ordinary, and both hold cycles.
        // Nothing serializes the input any more, so this guards against reintroducing that.
        /** @type {any} */
        const input = { id: 1 };
        input.self = input;

        const { tracer, spans } = fakeTracer();
        let ran = 0;
        const flow = (/** @type {any} */ i) =>
            effectPipe(() =>
                Command(
                    function cmdWork() {
                        ran++;
                        return 'done';
                    },
                    (/** @type {any} */ v) => Success(v)
                )
            )(i);

        configureEffect(telemetryHooks({ tracer }));
        const result = await runEffect(flow(input));

        assert.equal(result.type, 'Success', 'telemetry must not decide whether the flow runs');
        assert.equal(ran, 1);
        assert.ok(spans.every((/** @type {any} */ sp) => sp.ended));
    });

    it('should never put Command values on spans', async function () {
        const secret = { email: 'user@test.com', password: 'plaintext' };
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        await runEffect(workFlow(secret), undefined, { flowName: 'register' });

        const attributes = JSON.stringify(spans.map((/** @type {any} */ sp) => sp.attributes));
        assert.ok(!attributes.includes('plaintext'), 'no input values on spans');
        assert.ok(!attributes.includes('user@test.com'), 'not even harmless-looking ones');
        assert.ok(!attributes.includes('done'), 'no Command output on spans');
        assert.deepEqual(Object.keys(spans[0].attributes), ['effect.flow'], 'the root span carries the flow name');
        assert.deepEqual(
            Object.keys(spans[1].attributes),
            ['effect.type', 'effect.path'],
            'and a step span its type and path'
        );
    });

    it('should name the root span after the flow and open a child span per Command', async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        await runEffect(workFlow({ id: 1 }), undefined, { flowName: 'checkout' });
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => s.name),
            ['checkout', 'cmdWork']
        );
        assert.equal(spans[1].attributes['effect.type'], 'Command');
    });

    it('should open a span per Parallel, around the Command spans of its branches', async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        const load = (/** @type {string} */ name) =>
            Command(
                () => name,
                (/** @type {any} */ v) => Success(v),
                { name }
            );
        const result = await runEffect(Parallel([load('cmdUser'), load('cmdCart')]), undefined, {
            flowName: 'checkout'
        });
        assert.deepEqual(result, Success(['cmdUser', 'cmdCart']));
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => s.name),
            ['checkout', 'Parallel', 'cmdUser', 'cmdCart'],
            'the Parallel span opens before its branches do'
        );
        assert.equal(spans[1].attributes['effect.type'], 'Parallel');
        assert.ok(spans.every((/** @type {any} */ s) => s.ended));
    });

    it("should put each step's path on its span, so Retry attempts and Parallel branches are told apart", async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        let calls = 0;
        const flaky = Command(function cmdFlaky() {
            if (++calls === 1) throw new Error('timeout');
            return 'ok';
        });
        const other = Command(function cmdOther() {
            return 'other';
        });
        await runEffect(Parallel([Retry(flaky, { retries: 1, delay: 0 }), other]));
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => [s.name, s.attributes['effect.path']]),
            [
                ['Effect Pipeline', undefined],
                ['Parallel', '0p'],
                ['cmdFlaky', '0p0/0r0/0'],
                ['cmdOther', '0p1/0'],
                ['cmdFlaky', '0p0/0r1/0']
            ]
        );
    });

    it("should mark a cancelled Parallel's span as ERROR, whether a branch failed or threw", async function () {
        // A Parallel's op returns its decision rather than throwing, even when a branch's own code threw, so a
        // span that marked every returned value OK showed the step that failed the run as green.
        const declined = Command(() => Promise.reject(new Error('declined')), undefined, { name: 'cmdCharge' });
        const crashing = effectPipe(
            () => Command(() => ({ lines: [] }), undefined, { name: 'cmdCart' }),
            (/** @type {any} */ cart) => Success(cart.items.length)
        )(null);
        const calm = Command(() => 'ok', undefined, { name: 'cmdOk' });

        const statusOf = async (/** @type {any} */ flow) => {
            const { tracer, spans } = fakeTracer();
            const remove = configureEffect(telemetryHooks({ tracer }));
            await runEffect(flow).catch(() => {});
            remove();
            return spans.find((/** @type {any} */ s) => s.name === 'Parallel').status.code;
        };
        assert.equal(await statusOf(Parallel([declined, calm])), 2, 'a branch failed');
        assert.equal(await statusOf(Parallel([crashing, calm])), 2, "a branch's own code threw");
        assert.equal(await statusOf(Parallel([calm, calm])), 1, 'nothing was cancelled');
    });

    it('should mark a Failure on the root span and record a thrown Command', async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        const boom = (/** @type {any} */ input) =>
            effectPipe(() =>
                Command(
                    function cmdBoom() {
                        throw new Error('boom');
                    },
                    (/** @type {any} */ v) => Success(v)
                )
            )(input);
        const result = await runEffect(boom({ id: 1 }));
        assert.equal(result.type, 'Failure');
        assert.equal(spans[1].exceptions.length, 1, 'the step span recorded the exception');
        assert.equal(spans[0].status.code, 2, 'and the root span is ERROR');
        assert.ok(spans.every((/** @type {any} */ s) => s.ended));
    });

    it('should still work through enableTelemetry with no SDK started', async function () {
        enableTelemetry();
        const result = await runEffect(workFlow({ id: 1 }), undefined, { flowName: 'noop-tracer' });
        assert.equal(result.type, 'Success');
    });

    it('should compose with recording in one configureEffect call', async function () {
        const { tracer, spans } = fakeTracer();
        /** @type {any[]} */
        const written = [];
        configureEffect(
            telemetryHooks({ tracer }),
            recordingHooks({ keep: () => true, sink: async (/** @type {any} */ t) => void written.push(t) })
        );
        const result = await runEffect(workFlow({ id: 1 }), undefined, { flowName: 'both' });
        assert.equal(result.type, 'Success');
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => s.name),
            ['both', 'cmdWork']
        );
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdWork']
        );
    });
});
