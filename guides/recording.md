# Recording in Production

This guide continues the [README](../README.md), and its examples use the Quick Start's `registerUserFlow` and `input`. The exact rules are in [REFERENCE.md](../REFERENCE.md#pure-effectflight-recorder).

Pick the recording function by the job:

- One run, in a test or a script: `recordEffect`.
- Every run of an application: `enableRecording`, from `pure-effect/flight-recorder`.
- Reading a trace back: `replayEffect` or `timeTravel`.

To build your own wiring instead, start from [`recorder`](../REFERENCE.md#recorderoptions).

The flight recorder records every run of an application without changing any call site. Like a plane's flight recorder, it is always on, and it keeps the runs worth looking at after a failure. Install it once at startup.

It ships as a second entry point, `pure-effect/flight-recorder`, so the core stays free of imports. It needs `AsyncLocalStorage` from `node:async_hooks`, so it runs in Node, Deno, Bun, and Cloudflare Workers with `nodejs_compat`, but not in a browser.

```js
import { randomUUID } from 'node:crypto';
import { enableRecording } from 'pure-effect/flight-recorder';

enableRecording({
    // trace.flowName is the name passed as runEffect(flow, context, { flowName }), so pass one for every run.
    sink: (trace) => putObject(`traces/${trace.flowName}/${randomUUID()}.json`, JSON.stringify(trace)),
    // Attached to each trace, so timeTravel(flow, trace, { version }) warns when it replays one against another build.
    version: process.env.BUILD_ID,
    // A replay runs validation again on the stored input, so the stand-in keeps the password rule's verdict.
    redact: (value, name, kind) =>
        kind === 'initialInput' && typeof value?.password === 'string'
            ? { ...value, password: value.password.length >= 8 ? '[redacted]' : '' }
            : value,
    maxEntries: 500,
    keep: (result, entries) => result.type === 'Failure' || entries.some((e) => e.threw) // the default
});
```

To install it beside other hooks, such as the [telemetry example](hooks.md#tracing-with-opentelemetry)'s, pass `recordingHooks` to `configureEffect` instead. It takes the same options, and [Hooks](hooks.md#hooks) shows how hooks installed together run.

The flight recorder keeps the trace of a run that failed or in which a Command threw, passes every value through `redact`, caps a trace at `maxEntries`, reports a storage failure to `onSinkError`, and warns once per flow about a trace that has no input, was capped, is missing values, or has steps named `'anonymous'`. Each trace also holds how its run ended, unless it is given `recordOutcome: false`, so a replay can say whether it ends the same way; see [Checking that a replay ends the same way](time-travel.md#checking-that-a-replay-ends-the-same-way).

A trace stores every value as JSON, so return plain data from Commands; [Keeping a replay faithful](time-travel.md#keeping-a-replay-faithful) shows how.

Exact rules: [the flight recorder](../REFERENCE.md#pure-effectflight-recorder).

## Storing fewer traces

By default the flight recorder stores every run that ended in a `Failure` or in which a Command threw. A busy application returns many routine failures, such as a rejected email, and one fault can repeat thousands of times while a supplier is down. `sample` stores a share of each kind of run, and caps how many traces a flow stores in a minute:

```js
import { enableRecording } from 'pure-effect/flight-recorder';

enableRecording({
    sink, // your function that stores a trace, as in Recording in Production
    sample: {
        threw: 1, // a Command threw, or the flow's own code did: store every run
        failed: 0.1, // a step returned a Failure: store one run in ten
        succeeded: 0, // store none
        perMinute: 20, // at most 20 traces per flow per minute
        // By flowName. A flow's entry replaces only the keys it names.
        flows: {
            checkout: { failed: 1, succeeded: 0.01 },
            search: { perMinute: 5 }
        }
    }
});
```

What to know:

- **Every run is one kind.** A run in which a Command threw is `threw`, even when a `Retry` then made it succeed. Any other run is `failed` or `succeeded`, by how it ended.
- **A share is counted, not picked at random.** One in ten is a flow's first run of that kind, then its eleventh, so a failure is stored the first time it happens.
- **A share left out keeps what the flight recorder stores without `sample`:** 1 for `threw` and `failed`, 0 for `succeeded`, and no cap.
- **The cap comes after the shares.** It counts one flow's traces of every kind together, so a fault that makes every run throw cannot fill your storage.
- **`sample` saves storage, not work.** The choice is made once a run has ended, since a failure is not known before then, so every run is still recorded in memory.
- **Each process counts for itself.** Ten servers with `perMinute: 20` can store 200 traces of a flow in a minute.

`sample` takes the place of `keep`, so pass one or the other. For a choice `sample` cannot make, such as one that reads the result, write a `keep`; it gets the run's `flowName` as its third argument.

Exact rules: [the flight recorder](../REFERENCE.md#pure-effectflight-recorder).

## Keeping secrets out of a trace

`redact` sees everything a trace stores: each result, each thrown error, the flow's input, the context, and how the run ended, as a result or an error named `'outcome'`, told apart by `kind`.

Check a value before replacing a field in it, since `{ ...value, email: '[redacted]' }` turns a `null` into an object and the replay takes the other branch:

```js
// Masks a field only where there is one, so a lookup that found nothing still records null.
const mask = (value, field) =>
    value && typeof value === 'object' && field in value ? { ...value, [field]: '[redacted]' } : value;

const redact = (value, name, kind) => {
    if (kind === 'initialInput') return mask(value, 'cardNumber');
    if (kind === 'context') return mask(value, 'authToken');
    if (kind === 'error') return mask(value, 'attempted');
    // The flow returns the user it fetched, so its outcome holds the email too.
    return name === 'cmdFetchUser' || name === 'outcome' ? mask(value, 'email') : value;
};
// Pass it as the redact option of enableRecording, recordEffect or recorder.

assert.equal(redact(null, 'cmdFetchUser', 'result'), null); // still nothing found
assert.equal(redact('card_declined', 'cmdCharge', 'error'), 'card_declined'); // still a string
```

A replay rebuilds the flow from the redacted input and context. So a field a step checks, such as a password, needs a stand-in the check treats the same way, as the `redact` in [Recording in Production](#recording-in-production) does. A context field an `Ask` reads should stay.

Some checks have no such stand-in. A webhook's signature check needs the real signature and the secret. Make that check a Command, as in `const cmdVerifySignature = () => verifySignature(event, secret)`. The trace then records its verdict, and a replay uses the recorded verdict instead of checking the redacted field again.

Exact rules: [what `redact` gets](../REFERENCE.md#what-redact-gets).
