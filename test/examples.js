// @ts-check

import { strict as assert } from 'assert';
import {
    Success,
    Failure,
    Command,
    Ask,
    Parallel,
    effectPipe,
    runEffect,
    configureEffect,
    replayEffect
} from '../index.js';
import { enableTelemetry, telemetryHooks } from '../examples/opentelemetry-example.js';
import { enableRecording, recordingHooks } from '../examples/recording-example.js';
import { importCopiedExample, exampleTypeErrors } from './helpers.js';

describe('examples/recording-example.js', function () {
    beforeEach(() => configureEffect());
    afterEach(() => configureEffect());

    it('should run as it is when copied into a project that installs the library', async function () {
        // It imported '../index.js', a path that exists only in this repository, so every copy failed with
        // `Cannot find module` until its import was edited. It imports the library by its package name instead.
        const copied = await importCopiedExample('recording-example.js');
        assert.equal(typeof copied.recordingHooks, 'function');
    });

    it('should type-check in a project with exactOptionalPropertyTypes', function () {
        // It passes `redact` and `stack` on as it got them, possibly undefined, which RecorderOptions refused under
        // that flag, so a TypeScript project that copied the example failed to compile until the types took it.
        this.timeout(20000);
        assert.deepEqual(exampleTypeErrors('recording-example.js'), []);
    });

    const failing = (/** @type {any} */ input) =>
        effectPipe(
            (/** @type {any} */ i) =>
                Command(
                    function cmdRead() {
                        return { row: i.id };
                    },
                    (/** @type {any} */ r) => Success(r)
                ),
            () =>
                Command(
                    function cmdWrite() {
                        throw new Error('write failed');
                    },
                    (/** @type {any} */ r) => Success(r)
                )
        )(input);

    it('should send a trace to the sink when a flow fails', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ trace) => void written.push(trace) });
        const result = await runEffect(failing({ id: 1 }), { flowName: 'writer', tenant: 'acme' });
        assert.equal(result.type, 'Failure');
        assert.equal(written.length, 1);
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdRead', 'cmdWrite']
        );
        assert.equal(written[0].flowName, 'writer');
        assert.deepEqual(written[0].context, { flowName: 'writer', tenant: 'acme' }, 'context captured for Ask replay');
        assert.deepEqual(written[0].initialInput, { id: 1 });
    });

    it('should store the input of a run that fails before its first Command', async function () {
        // A failed validation stops at the flow's root, and it is a run `keep` keeps by default. Its trace needs the
        // input as much as any, or a replay rebuilds the flow from undefined.
        /** @type {any[]} */
        const written = [];
        /** @type {string[]} */
        const warnings = [];
        enableRecording({ sink: (t) => void written.push(t), onWarning: (message) => void warnings.push(message) });
        const register = (/** @type {any} */ input) =>
            effectPipe(
                (/** @type {any} */ i) => (i.email.includes('@') ? Success(i) : Failure('Invalid email.')),
                (/** @type {any} */ i) =>
                    Command(function cmdSaveUser() {
                        return i;
                    })
            )(input);
        const result = await runEffect(register({ email: 'bad' }), { flowName: 'register' });
        assert.deepEqual(result, Failure('Invalid email.'));
        assert.deepEqual(written[0].initialInput, { email: 'bad' });
        assert.deepEqual(warnings, [], 'the flow carries its input, so there is nothing to warn about');
        const { result: replayed } = await replayEffect(register(written[0].initialInput), written[0]);
        assert.deepEqual(replayed, result);
    });

    it('should not let an input or a context it cannot copy decide the run, and mark it on the trace', async function () {
        // The wiring copied the context in `onBeforeCommand`, where a throw vetoes the Command, so a context that
        // could not be copied stopped the charge and failed the run, and `onSinkError` never heard of it. The input
        // was copied in `onRun` ahead of the run, where a throw rejected the run before it started. Caught and reported,
        // such a field was then left out with nothing on the trace to say so, and a replay ran with an empty context.
        // The recorder now marks it, as it marks a value redact throws on.
        const uncopyable = (/** @type {object} */ target) =>
            new Proxy(target, {
                ownKeys() {
                    throw new Error('cannot list keys');
                }
            });
        /** @type {unknown[]} */
        const errors = [];
        /** @type {string[]} */
        const warnings = [];
        /** @type {any[]} */
        const written = [];
        enableRecording({
            keep: () => true,
            sink: (/** @type {any} */ t) => void written.push(t),
            onSinkError: (error) => void errors.push(error),
            onWarning: (message) => void warnings.push(message)
        });
        let calls = 0;
        const charge = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Command(function cmdCharge() {
                    calls++;
                    return i.amount;
                })
            )(input);

        const withContext = await runEffect(charge({ amount: 5 }), uncopyable({ tenant: 'acme' }));
        assert.deepEqual(withContext, Success(5));
        assert.equal(calls, 1, 'the Command ran');
        assert.equal(written.length, 1, 'the trace was still kept');
        assert.equal(written[0].context, undefined);
        assert.deepEqual(written[0].unrecorded, { context: 'copy' });

        const withInput = await runEffect(charge(uncopyable({ amount: 7 })), { tenant: 'acme' });
        assert.deepEqual(withInput, Success(7));
        assert.equal(calls, 2, 'the run started');
        assert.equal(written.length, 2);
        assert.equal(written[1].initialInput, undefined);
        assert.deepEqual(written[1].unrecorded, { initialInput: 'copy' });
        assert.deepEqual(errors, [], 'nothing failed: the trace says what it lacks');
        assert.equal(warnings.length, 1, 'the flow is warned about once');
        assert.match(warnings[0], /could not be recorded/);
    });

    it('should send the trace of a run whose own code throws, and still reject', async function () {
        // Since a throw in a pure step rejects the run, the wiring awaited the run outside its try block, and a
        // rejection skipped keep and the sink. That is the run most worth replaying: the payment provider renamed
        // a field and the step after the charge crashed, and the recorded charge reproduces it offline.
        /** @type {any[]} */
        const written = [];
        /** @type {any[]} */
        const offered = [];
        enableRecording({
            keep: (/** @type {any} */ result) => (offered.push(result), result.type === 'Failure'),
            sink: (/** @type {any} */ t) => void written.push(t)
        });
        const checkout = (/** @type {any} */ order) =>
            effectPipe(
                () =>
                    Command(function cmdCharge() {
                        return { id: 'ch_1', amount_cents: order.total * 100 };
                    }),
                (/** @type {any} */ charge) => Success(`Charged ${charge.amount.toFixed(2)}`)
            )(order);

        await assert.rejects(runEffect(checkout({ total: 12 })), TypeError, 'the run still rejects with its own error');
        assert.equal(offered.length, 1, 'keep is offered the run that crashed');
        assert.equal(offered[0].type, 'Failure', 'as a Failure');
        assert.ok(offered[0].error instanceof TypeError);
        assert.equal(written.length, 1, 'and the default keep sends it to the sink');
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.command),
            ['cmdCharge']
        );
        configureEffect();
        await assert.rejects(replayEffect(checkout(written[0].initialInput), written[0]), TypeError);
    });

    it('should send the input and context as the run received them', async function () {
        // Both were held by reference and copied only when the trace was packaged, so a Command that wrote to
        // either rewrote what the trace said production received.
        /** @type {any[]} */
        const written = [];
        enableRecording({ keep: () => true, sink: (/** @type {any} */ t) => void written.push(t) });
        const flow = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Ask((/** @type {any} */ ctx) =>
                    Command(function cmdSave() {
                        i.id = 'u_1';
                        ctx.user = { id: 7 };
                        return i.id;
                    })
                )
            )(input);
        await runEffect(flow({ email: 'a@b.com' }), { tenant: 'acme' });
        assert.deepEqual(written[0].initialInput, { email: 'a@b.com' });
        assert.deepEqual(written[0].context, { tenant: 'acme' });
    });

    it('should not let an in-place redact change the run it records', async function () {
        // The wiring redacts the input as the run starts and the context at the first Command, both before any
        // Command reads them, so a redact that deleted fields in place saved a user with no password and called
        // the API with no token, but only while recording was installed.
        /** @type {any[]} */
        const written = [];
        /** @type {any[]} */
        const seen = [];
        enableRecording({
            keep: () => true,
            sink: (/** @type {any} */ t) => void written.push(t),
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'initialInput') delete value.password;
                if (kind === 'context') delete value.apiToken;
                return value;
            }
        });
        const register = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ i) =>
                Ask((/** @type {any} */ ctx) =>
                    Command(function cmdSaveUser() {
                        seen.push([i.password, ctx.apiToken]);
                        return { id: 2 };
                    })
                )
            )(input);
        const result = await runEffect(register({ email: 'new@x.io', password: 'secret123' }), {
            apiToken: 'tok_live'
        });
        assert.equal(result.type, 'Success');
        assert.deepEqual(seen, [['secret123', 'tok_live']], 'the Command saw what the caller passed');
        assert.deepEqual(written[0].initialInput, { email: 'new@x.io' });
        assert.deepEqual(written[0].context, {});
    });

    it('should leave out an input or context redact throws on, and name both on the trace', async function () {
        // The context is packaged at the first Command, apart from the input, so its failure has to reach the trace
        // the run started with.
        /** @type {any[]} */
        const written = [];
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            sink: (/** @type {any} */ t) => void written.push(t),
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'initialInput' || kind === 'context') throw new Error('redact bug');
                return value;
            },
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const result = await runEffect(failing({ id: 5 }), { flowName: 'writer', tenant: 'acme' });
        assert.equal(result.type, 'Failure', 'the run keeps its own outcome');
        assert.equal(written[0].initialInput, undefined);
        assert.equal(written[0].context, undefined);
        assert.deepEqual(written[0].unrecorded, { initialInput: 'redact', context: 'redact' });
        assert.equal(warnings.length, 1, 'one warning for the flow');
        assert.match(warnings[0][0], /^Recording 'writer': 2 of the values a kept trace holds could not be recorded/);
        assert.equal(warnings[0][1], 'writer');
    });

    it('should not let a failing sink change the outcome, and report the failure', async function () {
        // The README's sink calls JSON.stringify, which throws on a circular value such as an HTTP client's
        // error. The sink was awaited inside onRun, so that throw replaced the run's own outcome.
        /** @type {any[]} */
        const reported = [];
        const circular = () => {
            throw new TypeError('Converting circular structure to JSON');
        };
        const remove = enableRecording({
            sink: circular,
            onSinkError: (/** @type {any} */ error, /** @type {any} */ flowName) =>
                void reported.push([error.message, flowName])
        });
        const result = await runEffect(failing({ id: 1 }), { flowName: 'checkout' });
        assert.equal(/** @type {any} */ (result).error.message, 'write failed', 'the run keeps its own outcome');
        assert.deepEqual(reported, [['Converting circular structure to JSON', 'checkout']]);
        remove();

        // Reporting is the caller's code too, so a reporter that throws changes nothing either.
        enableRecording({
            sink: circular,
            onSinkError: () => {
                throw new Error('reporter failed');
            }
        });
        const again = await runEffect(failing({ id: 1 }), { flowName: 'checkout' });
        assert.equal(/** @type {any} */ (again).error.message, 'write failed');
    });

    it('should report a failing keep or sink to console.error by default', async function () {
        const errorLog = console.error;
        /** @type {any[][]} */
        const logged = [];
        console.error = (/** @type {any[]} */ ...args) => void logged.push(args);
        try {
            enableRecording({
                keep: () => {
                    throw new Error('keep failed');
                }
            });
            const result = await runEffect(failing({ id: 1 }), { flowName: 'checkout' });
            assert.equal(result.type, 'Failure');
            assert.equal(logged.length, 1);
            assert.match(String(logged[0][0]), /Recording failed for 'checkout'/);
            assert.equal(logged[0][1].message, 'keep failed');
        } finally {
            console.error = errorLog;
        }
    });

    it('should keep successful runs out of the sink by default', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t) });
        const ok = (/** @type {any} */ i) =>
            Command(
                function cmdOk() {
                    return i;
                },
                (/** @type {any} */ v) => Success(v)
            );
        assert.equal((await runEffect(ok({ id: 2 }))).type, 'Success');
        assert.deepEqual(written, []);
    });

    it('should warn once per flow when it keeps a trace whose flow carried no input', async function () {
        // Only effectPipe puts the input on a flow, so a bare Command's traces hold none and timeTravel would
        // rebuild the flow from undefined. Warning at the first kept trace says so before an incident needs it.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const read = () =>
            Command(function cmdRead() {
                return 1;
            });
        await runEffect(read(), { flowName: 'bare' });
        await runEffect(read(), { flowName: 'bare' });
        await runEffect(effectPipe(read)({ id: 1 }), { flowName: 'piped' });
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'bare');
        assert.match(warnings[0][0], /effectPipe/);
    });

    it('should warn once per flow when it keeps a trace maxEntries cut short', async function () {
        // A capped trace lacks steps production ran, so it replays only up to the first of them. The default
        // cap is 500, so a long batch run is cut short without anyone having chosen to.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        /** @type {any[]} */
        const written = [];
        enableRecording({
            keep: () => true,
            maxEntries: 2,
            sink: (/** @type {any} */ t) => void written.push(t),
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const read = (/** @type {number} */ n) =>
            Command(function cmdRead() {
                return n;
            });
        const long = effectPipe(
            () => read(1),
            () => read(2),
            () => read(3)
        );
        const short = effectPipe(() => read(1));
        await runEffect(long({ id: 1 }), { flowName: 'long' });
        await runEffect(long({ id: 2 }), { flowName: 'long' });
        await runEffect(short({ id: 3 }), { flowName: 'short' });
        assert.deepEqual(
            written.map((t) => t.dropped),
            [1, 1, 0],
            'every capped trace still reaches the sink'
        );
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'long');
        assert.match(warnings[0][0], /dropped 1 entries under maxEntries \(2\)/);
    });

    it('should warn once per flow when it keeps a trace redact left values out of', async function () {
        // A value redact throws on is left out of the trace, which replays only up to it. Nothing else says so until
        // someone replays an incident.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            sink: () => {},
            redact: (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
                if (kind === 'context' || name === 'cmdRead') throw new Error('redact bug');
                return value;
            },
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const flow = effectPipe(
            () =>
                Command(function cmdRead() {
                    return 1;
                }),
            () =>
                Command(function cmdWrite() {
                    return 2;
                })
        );
        await runEffect(flow({ id: 1 }), { flowName: 'writer' });
        await runEffect(flow({ id: 2 }), { flowName: 'writer' });
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'writer');
        assert.match(warnings[0][0], /2 of the values a kept trace holds could not be recorded/);
        assert.match(warnings[0][0], /replays only up to the first of them/);
    });

    it('should warn once per flow when it keeps a trace with anonymous steps', async function () {
        // A replay tells steps apart by name, and inline arrow Commands are all 'anonymous', so a refactor that swapped
        // two of them replayed as a Success with each handed the other's recorded result, and nothing flagged it.
        /** @type {[string, string | undefined][]} */
        const warnings = [];
        enableRecording({
            keep: () => true,
            onWarning: (message, flowName) => void warnings.push([message, flowName])
        });
        const inline = effectPipe(
            () => Command(() => 1),
            () => Command(() => 2)
        );
        const named = effectPipe(() =>
            Command(function cmdNamed() {
                return 1;
            })
        );
        await runEffect(inline({ id: 1 }), { flowName: 'inline' });
        await runEffect(inline({ id: 2 }), { flowName: 'inline' });
        await runEffect(named({ id: 3 }), { flowName: 'named' });
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], 'inline');
        assert.match(warnings[0][0], /2 of its steps are named 'anonymous'/);
        assert.match(warnings[0][0], /meta\.name/);
    });

    it('should give concurrent runs separate traces', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t) });
        const slowFail = (/** @type {any} */ label) => (/** @type {any} */ input) =>
            effectPipe(
                () =>
                    Command(
                        function cmdSlow() {
                            return new Promise((r) => setTimeout(() => r(label), label === 'A' ? 20 : 5));
                        },
                        (/** @type {any} */ v) => Success(v)
                    ),
                () =>
                    Command(
                        function cmdFail() {
                            throw new Error(`${label} failed`);
                        },
                        (/** @type {any} */ v) => Success(v)
                    )
            )(input);
        await Promise.all([
            runEffect(slowFail('A')({ id: 'A' }), { flowName: 'A' }),
            runEffect(slowFail('B')({ id: 'B' }), { flowName: 'B' })
        ]);
        assert.equal(written.length, 2);
        for (const trace of written) {
            assert.deepEqual(
                trace.trace.map((/** @type {any} */ e) => e.command),
                ['cmdSlow', 'cmdFail'],
                'each trace holds only its own run'
            );
            assert.equal(trace.trace[0].result, trace.flowName);
        }
    });

    it('should compose with a telemetry hook in one configureEffect call', async function () {
        /** @type {string[]} */
        const spans = [];
        /** @type {any[]} */
        const written = [];
        configureEffect(
            {
                onStep: async (/** @type {any} */ n, /** @type {any} */ t, /** @type {any} */ op) => (
                    spans.push(n),
                    await op()
                )
            },
            recordingHooks({ sink: async (/** @type {any} */ t) => void written.push(t) })
        );
        const result = await runEffect(failing({ id: 3 }), { flowName: 'both' });
        assert.equal(result.type, 'Failure');
        assert.deepEqual(spans, ['cmdRead', 'cmdWrite'], 'telemetry still saw every step');
        assert.equal(written.length, 1, 'and the trace was still written');
    });

    it('should redact recorded results before they reach the sink', async function () {
        /** @type {any[]} */
        const written = [];
        enableRecording({
            sink: async (/** @type {any} */ t) => void written.push(t),
            redact: (/** @type {any} */ result) => (result && result.row ? { row: '[redacted]' } : result)
        });
        await runEffect(failing({ id: 4 }));
        assert.deepEqual(written[0].trace[0].result, { row: '[redacted]' });
    });

    it('should record paths so a Parallel flow replays from the trace it ships', async function () {
        // A hand-rolled `onStep` wrapper that calls the inner hook with three arguments drops the fourth,
        // `path`, and the trace it ships carries none. Such a trace replays positionally, which cannot
        // tell Parallel branches apart, so the positional resolver refuses it. This is the hazard the
        // hook contract in CLAUDE.md names, and the reference wiring is the first place it has to be right.
        /** @type {any[]} */
        const written = [];
        const calls = { a: 0, b: 0 };
        enableRecording({ sink: async (/** @type {any} */ t) => void written.push(t), keep: () => true });
        const flow = (/** @type {any} */ input) =>
            effectPipe((/** @type {any} */ x) =>
                Parallel([
                    Command(function cmdA() {
                        calls.a++;
                        return x + 1;
                    }),
                    Command(function cmdB() {
                        calls.b++;
                        return x + 2;
                    })
                ])
            )(input);
        const result = await runEffect(flow(1), { flowName: 'fanout' });
        assert.deepEqual(result, Success([2, 3]));
        assert.equal(written.length, 1);
        assert.deepEqual(
            written[0].trace.map((/** @type {any} */ e) => e.path).sort(),
            ['0p', '0p0/0', '0p1/0'],
            'every entry carries its path, the Parallel decision included'
        );
        configureEffect();
        const replayed = await replayEffect(flow(1), written[0]);
        assert.deepEqual(replayed.result, Success([2, 3]));
        assert.deepEqual(replayed.unreached, []);
        assert.deepEqual(calls, { a: 1, b: 1 }, 'the replay executed nothing');
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
        assert.deepEqual(exampleTypeErrors('opentelemetry-example.js'), []);
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
        await runEffect(workFlow(secret), { flowName: 'register' });

        const attributes = JSON.stringify(spans.map((/** @type {any} */ sp) => sp.attributes));
        assert.ok(!attributes.includes('plaintext'), 'no input values on spans');
        assert.ok(!attributes.includes('user@test.com'), 'not even harmless-looking ones');
        assert.ok(!attributes.includes('done'), 'no Command output on spans');
        assert.deepEqual(Object.keys(spans[0].attributes), ['effect.flow'], 'the root span carries the flow name');
        assert.deepEqual(Object.keys(spans[1].attributes), ['effect.type'], 'and a step span its type');
    });

    it('should name the root span after the flow and open a child span per Command', async function () {
        const { tracer, spans } = fakeTracer();
        configureEffect(telemetryHooks({ tracer }));
        await runEffect(workFlow({ id: 1 }), { flowName: 'checkout' });
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
        const result = await runEffect(Parallel([load('cmdUser'), load('cmdCart')]), { flowName: 'checkout' });
        assert.deepEqual(result, Success(['cmdUser', 'cmdCart']));
        assert.deepEqual(
            spans.map((/** @type {any} */ s) => s.name),
            ['checkout', 'Parallel', 'cmdUser', 'cmdCart'],
            'the Parallel span opens before its branches do'
        );
        assert.equal(spans[1].attributes['effect.type'], 'Parallel');
        assert.ok(spans.every((/** @type {any} */ s) => s.ended));
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
        const result = await runEffect(workFlow({ id: 1 }), { flowName: 'noop-tracer' });
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
        const result = await runEffect(workFlow({ id: 1 }), { flowName: 'both' });
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
