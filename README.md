# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![bundle size](https://img.shields.io/badge/minified%2Bgzipped-4KB-brightgreen)](https://bundlephobia.com/package/pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** is a zero-dependency effect library for JavaScript and TypeScript with time-travel debugging, dependency injection, retry, and OpenTelemetry, where business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Inject context without touching function signatures
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks
- Zero dependencies, under 4 KB minified and gzipped
- Works in JavaScript and TypeScript (full generics, bundled `.d.ts`)

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Testing Without Mocks](#testing-without-mocks)
- [Time-Travel Debugging](#time-travel-debugging)
- [Recording in Production](#recording-in-production)
- [Passing Runtime Context](#passing-runtime-context)
- [Retrying Transient Failures](#retrying-transient-failures)
- [Running Effects in Parallel](#running-effects-in-parallel)
- [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context)
- [Why Pure Effect](#why-pure-effect)
- [API Reference](#api-reference)
- [Limitations](#limitations)

## Installation

```
npm install pure-effect
```

## Quick Start

A complete user registration flow. Every step receives the value the previous step produced, so the pipeline reads top-to-bottom as the flow of data:

```js
import { Success, Failure, Command, effectPipe, runEffect } from 'pure-effect';

// Pure. No I/O, instantly testable.
const validateRegistration = (input) => {
    if (!input.email.includes('@')) return Failure('Invalid email.');
    if (input.password.length < 8) return Failure('Password too short.');
    return Success(input);
};

// These following two functions return a Command object. They do NOT call the database.
// Name the commands since traces, replay matching, and telemetry spans are keyed on them.
const ensureEmailAvailable = (input) => {
    const cmdFindUser = () => db.findUser(input.email);
    const next = (found) => (found ? Failure('Email already in use.') : Success(input));
    return Command(cmdFindUser, next);
};

// With no continuation (next), the result passes straight through.
const saveUser = (input) => {
    const cmdSaveUser = () => db.saveUser(input);
    return Command(cmdSaveUser);
};

// Create flow (not executed yet)
const registerUserFlow = (input) => effectPipe(validateRegistration, ensureEmailAvailable, saveUser)(input);

// Imperative shell: this is the only place side effects run
async function registerUser(input) {
    const result = await runEffect(registerUserFlow(input));

    if (result.type === 'Success') {
        console.log('User created:', result.value);
    } else {
        console.error('Error:', result.error);
    }
}
```

## Testing Without Mocks

Because pipelines return plain objects, you can assert on _what the code intends to do_ without executing any of it:

```js
// 1. Test validation failure synchronously
const badInput = { email: 'bad-email', password: '123' };
assert.deepEqual(registerUserFlow(badInput), Failure('Invalid email.', badInput));

// 2. Walk the pipeline to verify intent
const step1 = registerUserFlow({ email: 'test@test.com', password: 'password123' });
assert.equal(step1.cmd.name, 'cmdFindUser');

const step2 = step1.next(null); // simulate "user not found"
assert.equal(step2.cmd.name, 'cmdSaveUser');
// The full flow is verified. The database was never touched.
```

## Time-Travel Debugging

Record what each Command returned, then feed those results back into the same flow to retrace the exact path a request took, with no database and no network attached.

```js
import { recordEffect, replayEffect, timeTravel } from 'pure-effect';

// Record a real run.
const { result, trace } = await recordEffect(checkoutFlow, input, { version: process.env.BUILD_ID });

// Later, somewhere else, with nothing connected:
await timeTravel(checkoutFlow, trace);
```

```
Replaying 'checkout' (3 recorded steps)
Initial input: { "cartId": "cart_abc123", "promoCode": "FREE_YEAR_VIP" }
Step 1: cmdFetchCart returned { "totalAmount": "120.00" }
Step 2: cmdValidatePromo returned { "isValid": true, "discountValue": 100 }
Step 3: cmdChargeCreditCard threw { "message": "Amount must be non-zero.", "code": "invalid_amount" }
Replay finished with state: Failure
```

A production incident becomes a permanent test of the flow's logic, with no mocks and no fixtures:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const result = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test verifies that the flow still takes the recorded path and handles the recorded outcomes the same way: a refactor that reorders or drops a step raises a `TimeParadox` naming the path it diverged at, and changed error handling fails the assertion.

**Nondeterminism belongs inside a Command.** A value that varies between runs (the current time, a random ID) is I/O as far as replay is concerned. Wrap it in a Command and it is recorded and replayed like any other response; a step that calls `Date.now()` directly computes a fresh value on every replay and silently diverges from the trace.

**The trace format is yours.** `replayEffect` also takes a resolver function in place of a trace, so OpenTelemetry spans, a log pipeline, or a database table work as well as the JSON that `recorder` produces.

```js
// A resolver answers one question: what did production get back for this step?
const resolve = (step) => ({ result: mySpans[step.index].attributes.output });
await replayEffect(checkoutFlow(input), resolve);
```

## Recording in Production

`recordEffect` covers tests and scripts, where one call site holds the whole run. To record an application without touching any call site, install the hooks once at startup (see: `examples/recording-example.js`).

```js
import { configureEffect } from 'pure-effect';
import { recordingHooks } from './recording-example.js';
import { telemetryHooks } from './opentelemetry-example.js';

configureEffect(
    telemetryHooks(),
    recordingHooks({
        sink: (trace) => putObject(`traces/${trace.flowName}/${requestId}.json`, JSON.stringify(trace)),
        redact: (value, name, kind) => (kind === 'initialInput' ? { ...value, password: '[redacted]' } : value),
        maxEntries: 500,
        keep: (result) => result.type === 'Failure' // the default; keep everything, or sample
    })
);
```

Successful runs are buffered and discarded by default, so steady-state cost is memory only. `redact` runs before anything enters the trace, including the stored `initialInput` and `context`. `maxEntries` caps a runaway trace, reporting the overflow as `dropped`. A trace is plain JSON, so a sink can be S3 or a database column.

## Passing Runtime Context

Some values come from the framework layer (an authenticated tenant, a request trace ID, an environment config) rather than from the data being processed. `Ask` lets a pipeline step read the `context` object passed to `runEffect` without threading it through every function signature:

```js
import { Success, Failure, Command, Ask, effectPipe, runEffect } from 'pure-effect';

const findProduct = (productId) =>
    Ask((ctx) => {
        const cmdFindProduct = () => db[ctx.tenant].findProduct(productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('Product not found.')));
    });

app.post('/checkout', async (req, res) => {
    const result = await runEffect(checkoutFlow(req.body.productId), { tenant: req.tenant });
    res.json(result);
});
```

Recording stores the context alongside the trace, so `Ask` replays with the values the original request saw.

## Retrying Transient Failures

`Retry` wraps any Effect tree with retry-on-failure semantics. Like everything else in Pure Effect, the retry configuration is a plain object you can inspect and assert on without running anything.

**Wrap the Command that fails, not the pipeline.** Every attempt re-runs the whole wrapped tree, including Commands that already succeeded:

```js
// Dangerous: a flaky receipt step charges the customer again on every attempt.
Retry(effectPipe(chargeCard, sendReceipt)(order), { attempts: 3 });

// Correct: only the step that fails transiently is retried.
effectPipe(chargeCard, (charge) => Retry(sendReceipt(charge), { attempts: 3 }))(order);
```

Wrapping a pipeline is safe only when every Command in it is idempotent.

```js
import { Success, Failure, Command, Retry, runEffect } from 'pure-effect';

const fetchWeather = (city) => {
    const cmdFetchWeather = () =>
        fetch(`https://example-weather-api.com/v1/current?city=${city}`).then((r) => r.json());
    return Retry(
        Command(cmdFetchWeather, (data) => (data.error ? Failure(data.error) : Success(data))),
        { attempts: 3, delay: 200, backoff: 2 } // 200ms, 400ms, 800ms
    );
};

const weatherFn = fetchWeather('Tokyo');
assert.equal(weatherFn.type, 'Retry');
assert.equal(weatherFn.options.attempts, 3);
```

When all attempts are exhausted, `runEffect` returns a structured `Failure`:

```js
{ retryExhausted: true, lastError: <the last error>, attempts: 3 }
```

Every attempt is a recorded step, so a replay reproduces the exact sequence of failures. It also skips the delays, because waiting out production backoff during debugging is never what you want.

## Running Effects in Parallel

`Parallel` runs multiple Effect trees concurrently and passes their results to `next` as an ordered array. The first branch to fail cancels its siblings, `next` is not called, and that branch's `Failure` is what propagates.

```js
import { Success, Command, Parallel } from 'pure-effect';

const loadProfile = (userId) =>
    Parallel([getUser(userId), getPermissions(userId)], ([user, permissions]) => Success({ user, permissions }));
```

`Ask` context flows into all parallel branches without any extra wiring.

**Cancellation is cooperative, and it works at two levels.** A cancelled branch starts no further Commands. For example, a three-step branch whose first step is in flight when a sibling fails runs that step and stops. Cancelling the step already in flight needs the function to accept the `AbortSignal` it is handed and pass it to whatever performs the I/O:

```js
// Cancellable: the request is aborted the moment a sibling branch fails.
const fetchProfile = (userId) => Command((signal) => fetch(`/users/${userId}`, { signal }).then((r) => r.json()));

// Not cancellable: this runs to completion even after a sibling fails.
const fetchProfileUncancellable = (userId) => Command(() => fetch(`/users/${userId}`).then((r) => r.json()));
```

Outside a `Parallel` the function is called with no arguments at all, so nothing changes for a Command that never runs in a branch. A `Retry` inside a cancelled branch stops retrying rather than working through the rest of its backoff schedule.

## TypeScript: Typed Errors and Context

### Error union across pipeline steps

Each step in `effectPipe` carries its own error type. The compiler collects them into a union automatically:

```ts
type ValidationError = 'invalid_email' | 'weak_password';
type ApiError = 'network_timeout' | 'rate_limited';

const validate = (input: { email: string }): Effect<{ email: string }, ValidationError> => { ... };
const submit = (input: { email: string }): Effect<{ id: number }, ApiError> => { ... };

const result = await runEffect(effectPipe(validate, submit)({ email: 'user@example.com' }));
if (result.type === 'Failure') {
    result.error; // 'invalid_email' | 'weak_password' | 'network_timeout' | 'rate_limited'
}
```

Value types thread through the pipeline as well, so a step that reads a field the accumulator does not have yet is a compile error rather than a runtime surprise. This only works while every step accepts the piped value. A step written as `() => doSomething(outer)` discards it, and the chain stops being checked.

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => { ... });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

## Why Pure Effect

**vs. Effect-TS:** Effect-TS is a full functional programming ecosystem with fibers, streaming, schema validation, structured concurrency, and more, though it comes with a steep learning curve. Pure Effect covers a narrower scope: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers, in-flight cancellation, or streaming, Effect-TS is the right tool.

**vs. fp-ts:** fp-ts brings category theory abstractions (functors, monads, applicatives) to TypeScript. Pure Effect borrows only the concept of effects as data, without that vocabulary.

**vs. plain async/await with mocks:** A mock that passes all your tests but diverges from what the real driver does is worse than no test. Business logic never executes I/O, so there is nothing to mock.

**When to use something else:** If your codebase has little async I/O, or test isolation and production debuggability are not pain points, plain async/await is the simpler choice.

## API Reference

### Primitives

#### `Success(value)`

Returns `{ type: 'Success', value }`.

#### `Failure(error, initialInput?)`

Returns `{ type: 'Failure', error, initialInput }`. Stops the pipeline immediately.

#### `Command(cmdFn, nextFn?, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmd`: A function (sync or async) that performs the side effect. Inside a `Parallel` branch it is called with an `AbortSignal` that fires when a sibling branch fails; elsewhere it is called with no arguments.
- `next`: Receives the result of `cmd` and returns the next Effect. Optional, defaulting to `(result) => Success(result)`, which is what most Commands want.
- `meta`: Optional metadata, passed to `onBeforeCommand`. A string `meta.name` becomes the Command's identity. Otherwise, the name of the function is used (`cmd.name`).

**Every Command needs an identity**, because it is what test assertions, trace entries, replay matching, and telemetry spans are keyed on. It resolves in this order:

```js
Command(cmdFn, next, { name: 'chargeCard' }); // 1. meta.name, independent of how cmdFn was written
Command(function cmdChargeCard() { ... }, next); // 2. the function's own name
Command(() => api.charge(), next); // 3. neither, so 'anonymous'
```

Prefer `meta.name` in code that gets minified, since a mangler rewrites function names and would rename every step of every trace. Naming the function stays fine everywhere else, and is what the examples do.

#### `Ask(nextFn)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`.

#### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`.

- `options.attempts`: Max retries, not counting the first try (default: `3`).
- `options.delay`: Ms before the first retry (default: `100`).
- `options.backoff`: Multiplier applied to delay on each attempt (default: `1`, flat).

#### `Parallel(effects, next)`

Returns `{ type: 'Parallel', effects, next }`. Runs all effects concurrently. The first branch to fail cancels its siblings and its `Failure` is returned; `next` is not called. When several branches fail in the same tick, the first by array order wins. Each branch's Commands receive an `AbortSignal` as their only argument, so I/O that accepts one is cancelled in flight; see [Running Effects in Parallel](#running-effects-in-parallel).

### Combinators

#### `effectPipe(...functions)`

Composes functions into a sequential pipeline. Each function receives the unwrapped `Success` value from the previous step, and a `Failure` from any step stops the pipeline.

A step does not have to use the value it receives. In JavaScript, closing over something from the enclosing scope is fine:

```js
// The last step ignores what came before and uses the enclosing input instead.
const registerUserFlow = (input) => effectPipe(validateRegistration, () => saveUser(input))(input);
```

In TypeScript that step is where the type chain stops being checked, because a function that ignores its parameter constrains nothing about what produced it. See [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context). Threading the value through every step is what keeps the whole pipeline checked, which is why the Quick Start is written that way.

One shape to avoid in either language:

```js
(value) => {
    sendWelcomeEmail(value); // built and thrown away: the email is never sent
    return Success(value);
};
```

Commands are data, so a Command that is constructed and discarded never runs, and a `Failure` it would have produced is swallowed. Return the effect itself, or have that Command's own `next` return the value the rest of the pipeline needs.

### Interpreter

#### `runEffect(effect, context?, callConfig?)`

Traverses the effect tree, executes Commands with `async/await`, resolves `Ask` with the supplied `context`, and returns the final `Success` or `Failure`.

- `context`: Passed to `Ask` continuations and `onBeforeCommand`. `context.flowName` names the workflow in telemetry.
- `callConfig`: Per-call overrides for `onStep`, `onRun`, `onBeforeCommand`, and `retry`. Takes precedence over `configureEffect` globals.
- `onRun` fires exactly once per `runEffect` call. Retry attempts run inside that single span.

A step that returns something other than an Effect is a bug in the flow, not a domain failure, so it throws an `EffectTypeError` naming the step rather than resolving to a `Failure`:

```
Step 'validateRegistration' returned a plain object. Return Success, Failure, Command, Ask,
Retry, or Parallel: a plain value has to be wrapped, as in Success(value).
```

The same check catches a missing `return`, a Command continuation that returns a plain value, and `runEffect(flow)` where `runEffect(flow(input))` was meant. A Command that throws is still a `Failure`.

#### `configureEffect(...configs)`

- `onRun(effect, pipeline, flowName)` wraps the entire workflow; must `await pipeline()`.
- `onStep(name, type, op)` wraps each Command; must `await op()` and return its result. Returning a value _without_ calling `op()` is how replay works.
- `onBeforeCommand(command, context)` fires before each Command; throw to abort.
- `retry: { attempts?, delay?, backoff? }` global retry defaults.

Several configurations can be passed and are merged, which is how independent concerns share the one slot each hook has:

```js
configureEffect(telemetryHooks(), recordingHooks({ sink }));
```

- `onStep` and `onRun` are wrappers, so they nest: the first configuration is outermost, the last sits closest to the Command, and a thrown Command unwinds from the last back to the first.
- `onBeforeCommand` interceptors all run, in the order given.
- `retry` merges, with later configurations winning.
- Merging is per call and does not accumulate: a later `configureEffect` replaces the previous wiring, an unset slot returns to its default, and calling it with nothing resets everything.
- Returns a function that restores whatever was installed before the call, so hooks can be installed without owning the global wiring forever. It undoes this call only while its wiring is still in effect, so a later `configureEffect` is never silently discarded:

```js
const restore = configureEffect(telemetryHooks());
// ... later
restore();
```

**A per-call `callConfig` replaces a global hook rather than layering over it.** `runEffect(effect, context, { onStep })` uses that `onStep` _instead of_ the configured one, so a `recordEffect` call inside an instrumented application produces a run with no spans, and a `replayEffect` call produces one with no recording. This is deliberate: replay works by displacing `onStep` so the Command never executes. Pass both concerns in one `callConfig` when a single run needs both.

### Recording and replay

#### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`. Pass `onStep` to `runEffect` or `configureEffect` to record what every Command returned.

Each entry is `{ command, path, result, durationMs }`, or `{ command, path, error, durationMs }` when the Command threw, so a trace also answers which step was slow. `path` is the Command's position in the Effect tree, which is what a replay matches on. Results are snapshotted on capture, so a later step that mutates a returned object cannot rewrite what the trace says an earlier step saw. Values that cannot be structurally cloned, such as an object holding a function, are stored by reference instead. Recording cannot change a run: a `redact` that throws records `'[redaction failed]'` for that step instead of failing the flow.

- `options.redact(value, name, kind)`: The single place PII is kept out of a trace. It sees every value a trace holds, with `kind` distinguishing them:

```js
recorder({
    redact: (value, name, kind) => {
        if (kind === 'initialInput') return { ...value, password: '[redacted]' };
        if (kind === 'context') return { ...value, authToken: '[redacted]' };
        if (kind === 'error') return { ...value, attempted: '[redacted]' };
        return name === 'cmdFetchUser' ? { ...value, email: '[redacted]' } : value;
    }
});
```

`'result'` and `'error'` arrive with the Command's name; `'initialInput'` and `'context'` are the trace's own fields and pass the kind as the name. Redacting `initialInput` rarely breaks replay, since replay feeds recorded results rather than running Commands, so a stripped field only matters when the flow's control flow reads it. Redacting `context` does break `Ask` replay if you strip something a step reads.

- `options.maxEntries`: Cap trace length; overflow is counted in `dropped`.
- `options.stack`: Record stack traces for thrown errors (off by default).

#### `recordEffect(flowFn, initialInput, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. Accepts `recorder` options plus `context` and `version`. For tests and scripts; in an application install `recorder().onStep` via `configureEffect` instead.

#### `replayEffect(effect, traceOrResolver, options?)`

Replays an effect tree, feeding recorded results to Commands instead of running them.

- `traceOrResolver`: a trace (or bare entries array) to replay directly, or a resolver function for traces stored in some other shape. A resolver returns `{ result }`, `{ error }`, or `undefined` if the step is unrecorded. A malformed trace rejects with a `ReplayError`.
- `options.context`: context for `Ask`; pass the recorded context.
- `options.onMissing`: `'throw'` (default) fails on an unrecorded step; `'execute'` runs the real Command, giving a recorded prefix with a live tail.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): whether configured `onRun` / `onBeforeCommand` may fire. Off so a replay cannot reach a telemetry backend.
- `options.onResolved(step, outcome)`: observe each replayed step.

#### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates each step with its recorded duration, warning when recorded steps were never reached or when the trace's `version` differs from `options.version`. Takes `options.context` to override the trace's, and `options.log` in place of `console.log`.

## Limitations

- **`Retry` repeats the whole wrapped tree.** Commands that already succeeded run again on every attempt, so wrapping a pipeline re-executes its side effects. Wrap the single Command that fails transiently unless every Command in the tree is idempotent.
- **`Parallel` cancellation is cooperative, so it cannot stop everything.** A cancelled branch starts no further Commands, and a function that accepts the `AbortSignal` it is passed can be cut off in flight. A function that ignores the signal cannot: it runs to completion, so a branch whose _first_ Command is a write can still write after a sibling has failed. `Parallel` also waits for every branch to settle before returning, deliberately, so no cancelled work is left running unobserved after the `Failure` is returned.
- **A `Failure` is complete by design.** It carries the full error and the `initialInput` that `effectPipe` stamped on it, and neither is trimmed, because a test asserting on a Failure and a developer debugging one both need everything. Keeping PII out of a **trace** is `redact`'s job. Keeping it out of your **logs** is the shell's: log `result.error` rather than serializing the whole `Failure`, which for a login or registration flow holds the credentials that flow received.
- **Replay reproduces observed inputs, not concurrency.** A stale read replays exactly. A race between two concurrent requests does not: a trace records one flow's view. `Parallel` branches replay with the results their own branch saw, since every step is matched by its position in the tree, but the interleaving between them is not reproduced, so a flow whose branches race each other through shared state is not something a replay can settle.
- **A trace records responses, not requests.** Command arguments live in a closure and are unreachable, so a trace shows what a call returned but not what was passed to it. This also bounds what a replay verifies: the flow's path and its handling of recorded outcomes. The upside is that arguments can never leak into a trace.
- **Global configuration is per module instance.** `configureEffect` writes to module-level state, so two copies of the library in one process, from a dual ESM and CJS resolution, two versions in a dependency tree, or a worker thread, each carry their own wiring. Code that configures one gets nothing in the other, with no error.
- **A Command needs an identity.** `meta.name` is stable under minification; relying on `cmd.name` instead means a mangler renames every step of every trace, so mangling has to be disabled or names preserved.
- **`Retry` delays cannot be overridden from `callConfig`.** Per-use options are merged over call config, so a delay written at the call site always wins. `replayEffect` works around this by rewriting `Retry` nodes; other callers cannot.
