# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![minified size (gzip)](https://img.shields.io/bundlejs/size/pure-effect)](https://bundlejs.com/?q=pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Inject context without touching function signatures
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks
- Zero dependencies, about 4.5 KB minified and gzipped
- Works in JavaScript and TypeScript (full generics, bundled `.d.ts`)

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Testing Without Mocks](#testing-without-mocks)
- [How It Works](#how-it-works)
- [Time-Travel Debugging](#time-travel-debugging)
- [Recording in Production](#recording-in-production)
- [Passing Runtime Context](#passing-runtime-context)
- [Retrying Transient Failures](#retrying-transient-failures)
- [Running Effects in Parallel](#running-effects-in-parallel)
- [Composing Larger Flows](#composing-larger-flows)
- [Which Errors Are Data](#which-errors-are-data)
- [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context)
- [Why Pure Effect](#why-pure-effect)
- [API Reference](#api-reference)
- [Limitations](#limitations)

## Installation

```
npm install pure-effect
```

## Quick Start

A complete user registration flow. Every step receives the value the previous step produced, so the pipeline reads top-to-bottom as the flow of data. Each I/O step is a pair: the call to make, plus a `next` function that receives its answer and decides what follows.

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

// With no next function, the result passes straight through.
const saveUser = (input) => {
    const cmdSaveUser = () => db.saveUser(input);
    return Command(cmdSaveUser);
};

// Build the flow. Validation runs now; no I/O happens until runEffect.
const registerUserFlow = (input) => effectPipe(validateRegistration, ensureEmailAvailable, saveUser)(input);

// This is the only place side effects actually run
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

Because pipelines return plain objects, you can assert on _what the code intends to do_ without executing any of it.

Validation runs as soon as you build the flow, so testing it needs nothing else:

```js
const badInput = { email: 'bad-email', password: '123' };
assert.deepEqual(registerUserFlow(badInput), Failure('Invalid email.', badInput));
```

Next, test the steps. Hand a step an answer and check what it returns:

```js
const input = { email: 'test@test.com', password: 'password123' };

// The email is free, so the step passes the input on.
assert.deepEqual(ensureEmailAvailable(input).next(null), Success(input));

// The email is taken, so the flow stops here.
assert.deepEqual(ensureEmailAvailable(input).next({ id: 1 }), Failure('Email already in use.'));
```

Then test the flow: the right calls, in the right order.

```js
const step1 = registerUserFlow(input);
assert.equal(step1.cmd.name, 'cmdFindUser');

const step2 = step1.next(null); // pretend no user was found
assert.equal(step2.cmd.name, 'cmdSaveUser');
// The database was never touched.
```

Write both kinds. They catch different things, and the step tests are the ones that catch real bugs, because they are the only place you can see the value moving from one step to the next.

Say the email guard returned `Success(true)` by mistake, instead of `Success(input)`. The step test fails at once: it asked for the input back and got `true`. The flow test does not fail. `cmdFindUser` is still the first call and `cmdSaveUser` is still the second, so both assertions hold, and the flow saves `true` to the database instead of the user.

Two smaller things to know.

A step tested on its own has no `initialInput` on its `Failure`. That is why the assertion above is `Failure('Email already in use.')` with nothing after the message, while the validation one is `Failure('Invalid email.', badInput)`. `effectPipe` adds that value while it builds a flow, so a `Failure` only carries it when it came out of a flow.

Nothing can see inside a Command's function without running it. If `cmdFindUser` said `db.findUser(input.name)` instead of `input.email`, every test on this page would still pass. Keep those functions to a single call, and let an integration test cover them.

## How It Works

A flow is a chain of pairs: an I/O call to make, plus a `next` function that receives its answer and returns whatever comes after, another Command, a Success, or a Failure. `runEffect` walks that chain in a loop.

Recording and replay attach at the single point where a Command's function is called: recording wraps that call to write down each answer, and replay substitutes the recorded answer without making the call, which is why a replayed flow performs no I/O.

Building a flow runs the pure steps immediately: `registerUserFlow(badInput)` returns the validation `Failure` synchronously, which is why the tests above do not need `runEffect`. Only the I/O inside Commands requires it.

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
Step 3: cmdChargeCard threw { "message": "Amount must be non-zero.", "code": "invalid_amount" }
Replay finished with state: Failure
```

A production incident becomes a permanent test of the flow's logic, with no mocks and no fixtures:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test verifies that the flow still takes the recorded path and handles the recorded outcomes the same way: a refactor that reorders or replaces a step raises a `TimeParadox` naming the path it diverged at, and changed error handling fails the assertion.

One divergence is quieter. A flow that stops issuing Commands before the recording ends (a fix that skips the charge, say) mismatches nothing, so nothing mismatches and the replay can end in `Success` with recorded steps left over. `replayEffect` returns those steps as `unreached` beside the result, so a test can say which ones it expects to skip, and fail if the answer changes:

```js
it('incident 8f3a fixed: a 100% promo checks out without a charge', async () => {
    const { result, unreached } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Success');
    assert.deepEqual(
        unreached.map((e) => e.command),
        ['cmdChargeCard']
    );
});
```

For every other recording of the flow, `unreached` should be empty: a fix that skips a step it was not meant to skip then fails loudly instead of passing.

**A trace records what each Command returned, not what it was asked.** It does not need to. Given the recorded input and the recorded results, the flow does the same thing again, so replaying to a step rebuilds the exact arguments that Command ran with, in the real code, under a debugger if you want one. Storing them as well would only double what `redact` has to cover, since arguments are usually the sensitive half of a call.

**Anything that varies between runs belongs inside a Command.** The current time or a random ID counts as I/O as far as replay is concerned. Wrap it in a Command and it is recorded and replayed like any other response; a step that calls `Date.now()` directly computes a fresh value on every replay and silently diverges from the trace.

**Checking this takes one round trip.** Record a flow, replay it immediately, and compare the outcomes. A step that computes a fresh nondeterministic value surfaces as a `TimeParadox` when it changes which Commands run, or as a mismatch in the final value:

```js
const { result, trace } = await recordEffect(registerUserFlow, input);
const { result: replayed } = await replayEffect(registerUserFlow(input), trace);
assert.deepEqual(replayed, result); // fails if any step computed a fresh value
```

The comparison holds for a `Failure` as well: an error that crossed the trace is revived with the same message, name, cause, and custom properties, and compares deep-equal to the one the Command threw. The one exception is an error class of your own, which revives as a plain `Error` carrying that class's name; compare `error.name` and `error.message` there.

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

`Retry` runs part of a flow again when it fails. Like everything else in Pure Effect, the retry configuration is a plain object you can inspect and assert on without running anything.

**Wrap the Command that fails, not the pipeline.** Every attempt re-runs the whole wrapped tree, including Commands that already succeeded:

```js
// Dangerous: a flaky receipt step charges the customer again on every attempt.
Retry(effectPipe(chargeCard, sendReceipt)(order), { attempts: 3 });

// Correct: only the step that fails transiently is retried.
effectPipe(chargeCard, (charge) => Retry(sendReceipt(charge), { attempts: 3 }))(order);
```

Wrapping a pipeline is safe only when every Command in it is idempotent (safe to run more than once).

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

```text
{ retryExhausted: true, lastError: <the last error>, attempts: 3 }
```

In TypeScript, a `Retry` contributes `RetryExhaustedError<E>` to the pipeline's error union rather than the inner `E` itself, matching what the Failure actually carries: the wrapped tree's error type survives as `result.error.lastError`.

**Recover from exhaustion in-flow with `onExhausted`.** When every attempt has failed, the fallback Effect runs instead of returning the structured Failure. Its success feeds the rest of the pipeline exactly as the primary's would have, and its failure propagates unwrapped:

```js
const fetchPrice = (sku) =>
    Retry(fetchLivePrice(sku), {
        attempts: 3,
        onExhausted: (err) => fetchCachedPrice(sku) // err = { retryExhausted, lastError, attempts }
    });
```

Fallback steps are recorded under their own trace paths, so a replay reproduces the fallback exactly, and a fallback never starts in a `Parallel` branch that a sibling's failure has already cancelled. With `onExhausted` set, the exhaustion error never escapes, so in TypeScript the `Retry` contributes the fallback's error type to the pipeline's union instead of `RetryExhaustedError<E>`.

Every attempt is a recorded step, so a replay reproduces the exact sequence of failures. It also skips the delays.

## Running Effects in Parallel

`Parallel` runs several flows at the same time and passes their results to `next` as an ordered array. The first branch to fail cancels its siblings, `next` is not called, and that branch's `Failure` is what propagates.

```js
import { Success, Command, Parallel } from 'pure-effect';

const loadProfile = (userId) =>
    Parallel([getUser(userId), getPermissions(userId)], ([user, permissions]) => Success({ user, permissions }));
```

`next` is optional, defaulting to `(values) => Success(values)` just like `Command`'s, so a bare `Parallel(effects)` resolves to the ordered array of success values.

`Ask` context flows into all parallel branches without any extra wiring.

**For a batch, pass options instead of letting the first failure win.** The second argument is `next` or the options, whichever it looks like, so neither needs a placeholder:

```js
// At most 5 branches in flight, for a gateway that rate limits.
Parallel(subscriptions.map(billOne), { limit: 5 });

// Every branch runs to completion, and `next` receives the outcomes rather than the values.
Parallel(subscriptions.map(billOne), { limit: 5, settled: true });
```

`settled: true` is what makes one bad record survivable. Without it a single branch's `Failure` cancels its siblings and becomes the whole `Parallel`'s result, which for a batch means one unexpected exception can stop the run with work half done. With it, every branch runs to the end and `next` receives one `Success` or `Failure` per branch, in array order, so a failed record is a value you count rather than an outcome that ends the job:

```js
Parallel(subscriptions.map(billOne), (outcomes) => Success(outcomes.map(summarize)), { limit: 5, settled: true });
```

A flow bug still escapes. An `EffectTypeError`, the error a malformed flow raises, is not a branch outcome and passes straight through a settled `Parallel`, because settled mode is for outcomes you expected to be possible, not for silencing mistakes.

`limit` caps how many branches are in flight; the rest start as slots free. Results and recorded paths stay in array order either way, so limiting changes the pacing and nothing else, and a trace recorded with a limit replays exactly as one recorded without. A `limit` that is not a positive integer throws a `TypeError`.

**Cancelling is a request, not a guarantee, and it works at two levels.** A cancelled branch starts no further Commands. For example, a three-step branch whose first step is in flight when a sibling fails runs that step and stops. Cancelling the step already in flight needs the function to accept the `AbortSignal` it is handed and pass it to whatever performs the I/O:

```js
// Cancellable: the request is aborted the moment a sibling branch fails.
const fetchProfile = (userId) => Command((signal) => fetch(`/users/${userId}`, { signal }).then((r) => r.json()));

// Not cancellable: this runs to completion even after a sibling fails.
const fetchProfileUncancellable = (userId) => Command(() => fetch(`/users/${userId}`).then((r) => r.json()));
```

Outside a `Parallel` the function is called with no arguments at all, so nothing changes for a Command that never runs in a branch. A `Retry` inside a cancelled branch stops retrying rather than working through the rest of its backoff schedule.

## Composing Larger Flows

`effectPipe` is a straight line, but flows rarely are. Branching and joining work with the pieces already here. Here is how:

**A step can return a sub-pipeline.** `effectPipe(...)(value)` returns an Effect like any other, so a step can branch into a whole sub-flow, and the sub-flow's `Failure` stops the outer pipeline exactly like a local one:

```js
const processOrder = (order) => (order.isGift ? giftFlow(order) : standardFlow(order));

const fulfillment = effectPipe(validateOrder, processOrder, scheduleShipping);
```

**Joining values that do not depend on each other: `Parallel`.** When a later step needs several such values, run them at the same time and collect the results. With `next` omitted, the branch results arrive as an ordered array:

```js
const loadCheckout = effectPipe(
    (input) => Parallel([fetchCart(input.cartId), fetchUser(input.userId)]),
    ([cart, user]) => Success({ cart, user, total: cartTotal(cart) })
);
```

**Joining values that do depend on each other: join locally.** When step B needs step A's result and step C needs both, carry both forward in a value shaped for the next step. A local sub-pipeline that closes over its own parameter makes the join without nested callbacks:

```js
const applyLoyaltyDiscount = (orderId) =>
    effectPipe(
        fetchOrder,
        (order) => effectPipe(fetchCustomer, (customer) => Success({ order, customer }))(order.customerId),
        ({ order, customer }) => Success(discountedTotal(order, customer))
    )(orderId);
```

**Carry exactly what downstream needs, never an accumulator.** Passing a minimal, purpose-shaped value between steps, rather than a scope object that grows with everything ever computed, is a strategy for avoiding bugs, not a style preference. Each step's input is its complete contract, so a step cannot quietly depend on a value produced far upstream, a stale field cannot outlive the step that should have replaced it, and two steps cannot collide on a key neither knows the other uses. It also keeps data alive no longer than the flow needs it, which matters when the values are credentials or PII. In TypeScript the same discipline is what keeps the pipeline checked end to end: every step consumes the value it receives, so changing what an upstream step produces is a compile error at exactly the step that reads it, instead of an `undefined` at runtime.

## Which Errors Are Data

There is no catch, and that is deliberate. A flow's outcomes divide into two kinds, and the division decides how each is written.

**An outcome the flow handles is data.** A Command's `next` receives the result and can branch into any Effect, including a whole fallback sub-pipeline. When the I/O itself can reject, catch inside the Command's `cmd` function and return the miss as a value:

```js
const fetchCachedPrice = (sku) => {
    const cmdFetchCachedPrice = () => cache.get(sku);
    return Command(cmdFetchCachedPrice, (price) => Success({ ...price, stale: true }));
};

const fetchPrice = (sku) => {
    const cmdFetchLivePrice = () =>
        pricing
            .get(sku)
            .then((price) => ({ ok: true, price }))
            .catch((error) => ({ ok: false, error }));
    return Command(cmdFetchLivePrice, (r) => (r.ok ? Success({ ...r.price, stale: false }) : fetchCachedPrice(sku)));
};
```

The failed live attempt is recorded as that Command's result, error included, so a replay takes the same fallback branch and an incident trace still becomes a regression test. Nothing is hidden; the miss is simply categorized as what it is, an outcome the flow was written to handle.

**A `Failure` means abort.** It stops everything and lands in the shell, which is the one place that decides what a dead flow means: an HTTP status, a queue retry, an alert. Reserving `Failure` for outcomes the flow cannot handle keeps its meaning brutally simple; a reader never has to scan up the tree for a handler, because there is none. A catch would reintroduce exactly the non-local control flow that writing effects as data is meant to eliminate.

The rule of thumb: if you would handle it, return it; if you would only report it, fail with it. The one handled outcome that cannot be modeled as data is retry exhaustion, since the failing happens inside `Retry`; that case has its own in-flow form, the `onExhausted` option in [Retrying Transient Failures](#retrying-transient-failures).

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

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, because they are built on the same idea: record what every step returned, replay it deterministically. Those engines run it as a managed execution guarantee: histories persist server-side, and workflows resume automatically after a crash. The difference is who operates it. An engine stores histories and restarts dead runs for you; with Pure Effect that is your application's job, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full functional programming ecosystem with fibers, streaming, schema validation, structured concurrency, and more, though it comes with a steep learning curve and a vocabulary of its own. Pure Effect borrows only the concept of effects as data, and covers a narrower scope: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers, in-flight cancellation, or streaming, Effect-TS is the right tool.

**vs. plain async/await with mocks:** A mock that passes all your tests but diverges from what the real driver does is worse than no test. Business logic never executes I/O, so there is nothing to mock.

**When to use something else:** If your codebase has little async I/O, or test isolation and production debuggability are not pain points, plain async/await is the simpler choice.

## API Reference

### Building blocks

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
Command(function cmdChargeCard() {
    return api.charge();
}, next); // 2. the function's own name
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
- `options.onExhausted(error)`: Runs a fallback Effect when every attempt has failed, receiving `{ retryExhausted, lastError, attempts }`. The fallback's success feeds `next`; its failure propagates unwrapped. Per-use only. See [Retrying Transient Failures](#retrying-transient-failures).

#### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`. Runs all effects concurrently. `next` receives the ordered array of success values and is optional, defaulting to `(values) => Success(values)` like `Command`'s. The first branch to fail cancels its siblings and its `Failure` is returned; `next` is not called. When several branches fail in the same tick, the first by array order wins. Each branch's Commands receive an `AbortSignal` as their only argument, so I/O that accepts one is cancelled in flight; see [Running Effects in Parallel](#running-effects-in-parallel).

The second argument is `next` or the options, whichever it looks like, so `Parallel(effects, { limit: 5 })` needs no placeholder.

- `limit`: most branches in flight at once. Results and recorded paths stay in array order, so a limit changes pacing and nothing else. Not a positive integer throws a `TypeError`.
- `settled`: run every branch to completion and hand `next` one outcome per branch, `Success` or `Failure`, in array order. No branch cancels its siblings and the `Parallel` itself never fails on a branch's account. An `EffectTypeError` still escapes, because a malformed flow is a bug rather than a branch outcome.

### Building pipelines

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

### Running a flow

#### `runEffect(effect, context?, callConfig?)`

Walks the flow, runs each Command with `async/await`, resolves `Ask` with the supplied `context`, and returns the final `Success` or `Failure`.

- `context`: Passed to `Ask`'s next function and to `onBeforeCommand`. `context.flowName` names the workflow in telemetry.
- `callConfig`: Per-call `onStep`, `onRun`, `onBeforeCommand`, and `retry`, added to the `configureEffect` wiring unless `inherit: false`, which ignores that wiring for the run. See [`configureEffect`](#configureeffectconfigs).
- `onRun` fires exactly once per `runEffect` call. Retry attempts run inside that single span.

A step that returns something other than an Effect is a bug in the flow, not a domain failure, so it throws an `EffectTypeError` naming the step rather than resolving to a `Failure`:

```
Step 'validateRegistration' returned a plain object. Return Success, Failure, Command, Ask,
Retry, or Parallel: a plain value has to be wrapped, as in Success(value).
```

The same check catches a missing `return`, a Command's next function returning a plain value, and `runEffect(flow)` where `runEffect(flow(input))` was meant. A Command that throws is still a `Failure`.

#### `configureEffect(...configs)`

- `onRun(effect, pipeline, flowName)` wraps the entire workflow; must `await pipeline()`.
- `onStep(name, type, op)` wraps each Command; must `await op()` and return its result. Returning a value _without_ calling `op()` is how replay works.
- `onBeforeCommand(command, context)` fires before each Command; throw to abort.
- `retry: { attempts?, delay?, backoff? }` global retry defaults.

Each call adds a layer of hooks on top of those already installed and returns a function that removes that layer. Layers merge, and several configurations passed to one call are merged the same way, so the two forms below are equivalent. Everything about the merge is visible in what runs during a single `runEffect`:

```js
configureEffect(telemetryHooks(), recordingHooks({ sink }));

// or, as two layers:
configureEffect(telemetryHooks());
configureEffect(recordingHooks({ sink }));
```

```
runEffect(flow(input))
│
├─ telemetry.onRun                       first configuration: outermost
│  └─ recording.onRun                    last configuration: innermost
│     │
│     │  for each Command:
│     ├─ telemetry.onBeforeCommand       interceptors all run, in the order given
│     ├─ recording.onBeforeCommand
│     ├─ telemetry.onStep
│     │  └─ recording.onStep             closest to the Command
│     │     └─ cmd()
│     │  ┌─ recording.onStep returns     a result, or a thrown error, unwinds
│     ├─ telemetry.onStep returns        from the inside out
│     │
│  ┌─ recording.onRun returns
├─ telemetry.onRun returns
│
retry: { ...telemetry.retry, ...recording.retry }    later configurations win
```

Removing a layer takes out exactly that layer, whatever was installed after it, so a library can add its own hooks without touching its host's and give them back when it is done. Calling `configureEffect()` with no arguments removes every layer. A call whose arguments are all `undefined`, such as a conditional `configureEffect(flag ? hooks : undefined)`, installs nothing and removes nothing.

```js
const remove = configureEffect(telemetryHooks());
// ... later
remove();
```

**A per-call `callConfig` is added to the configured wiring, or ignores it.** By default the call's hooks merge over the configured ones by the same rules as above: wrappers nest with the configured one outside, interceptors run configured first, and `retry` combines with the call's values winning. `inherit: false` leaves the configured wiring out of the run entirely. Given a configured wiring `C` and a call `K` that supplies only `onStep` and `retry`:

```
                  inherit: true (default)        inherit: false

onRun             C.onRun                        (none)
onBeforeCommand   C.onBeforeCommand              (none)
onStep            C.onStep( K.onStep( cmd ) )    K.onStep
retry             { ...C.retry, ...K.retry }     { ...defaults, ...K.retry }
```

`recordEffect` inherits, so recording inside an application that already has tracing keeps its spans. `replayEffect` passes `inherit: false` unless `hooks: true`.

### Recording and replay

#### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`. Pass `onStep` to `runEffect` or `configureEffect` to record what every Command returned.

Each entry is `{ command, path, result, durationMs }`, or `{ command, path, error, durationMs }` when the Command threw, so a trace also answers which step was slow. `path` is the Command's position in the flow, which is what a replay matches on. Results are snapshotted on capture, so a later step that mutates a returned object cannot rewrite what the trace says an earlier step saw. Values that cannot be structurally cloned, such as an object holding a function, are stored by reference instead. Recording cannot change a run: a `redact` that throws records `'[redaction failed]'` for that step instead of failing the flow.

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

Replays a flow, feeding recorded results to Commands instead of running them. Returns `{ result, unreached }`: the flow's outcome, and the recorded entries the flow never asked for (empty when every step was reached). A flow that stops early mismatches nothing and raises no `TimeParadox`, so `unreached` is where that divergence shows. For a resolver only `{ result }` is returned, since only a trace knows what it holds.

- `traceOrResolver`: a trace (or bare entries array) to replay directly, or a resolver function for traces stored in some other shape. A resolver returns `{ result }`, `{ error }`, or `undefined` if the step is unrecorded. A malformed trace rejects with a `ReplayError`.
- `options.context`: context for `Ask`; pass the recorded context.
- `options.onMissing`: `'throw'` (default) fails on an unrecorded step; `'execute'` runs the real Command, giving a recorded prefix with a live tail.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the global hooks, resolver innermost, so configured hooks observe it, a global recorder included. Off ignores the global hooks, so a replay cannot reach a telemetry backend or a trace sink. Global `retry` defaults apply either way, since a replay has to make the attempts production made.
- `options.onResolved(step, outcome)`: observe each replayed step.

A trace whose entries carry no `path` (written by hand, or recorded before paths existed) is matched positionally, which is exact for a sequential flow; a `Parallel` step in such a trace is refused with a `ReplayError`, since completion order cannot tell its branches apart.

#### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates each step with its recorded duration, naming any recorded steps that were never reached and warning when the trace's `version` differs from `options.version`. Returns the flow's outcome; for the unreached entries as data, use `replayEffect`. Takes `options.context` to override the trace's, and `options.log` in place of `console.log`.

## Limitations

- **`Retry` repeats the whole wrapped tree.** Commands that already succeeded run again on every attempt, so wrapping a pipeline re-executes its side effects. Wrap the single Command that fails transiently unless every Command in it is safe to run more than once.
- **Cancelling a `Parallel` branch is a request, so it cannot stop everything.** A cancelled branch starts no further Commands, and a function that accepts the `AbortSignal` it is passed can be cut off in flight. A function that ignores the signal cannot: it runs to completion, so a branch whose _first_ Command is a write can still write after a sibling has failed. `Parallel` also waits for every branch to settle before returning, deliberately, so no cancelled work is left running unobserved after the `Failure` is returned.
- **A `Failure` is complete by design.** It carries the full error and the `initialInput` that `effectPipe` attached to it, and neither is trimmed, because a test asserting on a Failure and a developer debugging one both need everything. Keeping PII out of a **trace** is `redact`'s job. Keeping it out of your **logs** is the shell's: log `result.error` rather than serializing the whole `Failure`, which for a login or registration flow holds the credentials that flow received.
- **Replay reproduces observed inputs, not concurrency.** A stale read replays exactly. A race between two concurrent requests does not: a trace records one flow's view. `Parallel` branches replay with the results their own branch saw, since every step is matched by its position in the tree, but the interleaving between them is not reproduced, so a flow whose branches race each other through shared state is not something a replay can settle.
- **Global configuration is per module instance.** `configureEffect` writes to module-level state, so two copies of the library in one process, from a dual ESM and CJS resolution, two versions in a dependency tree, or a worker thread, each carry their own wiring. Code that configures one gets nothing in the other, with no error.
- **A Command needs an identity.** `meta.name` is stable under minification; relying on `cmd.name` instead means a mangler renames every step of every trace, so mangling has to be disabled or names preserved.
- **`Retry` delays cannot be overridden from `callConfig`.** Per-use options are merged over call config, so a delay written at the call site always wins. `replayEffect` works around this by rewriting the `Retry`s in the flow; other callers cannot.
