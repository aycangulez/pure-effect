# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![minified size (gzip)](https://img.shields.io/bundlejs/size/pure-effect)](https://bundlejs.com/?q=pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Inject context without touching function signatures
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks
- Zero dependencies, less than 6 KB minified and gzipped
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

A user registration flow. Each step receives the value the previous step produced. An I/O step is a pair: the call to make, and a `next` function that receives the answer and decides what happens next.

```js
import { Success, Failure, Command, effectPipe, runEffect } from 'pure-effect';

// Pure. No I/O, instantly testable.
const validateRegistration = (input) => {
    if (!input.email.includes('@')) return Failure('Invalid email.');
    if (input.password.length < 8) return Failure('Password too short.');
    return Success(input);
};

// The next two functions return a Command object. They do not call the database.
// Name the commands: traces, replay matching, and telemetry spans use the names.
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

Pipelines return plain objects, so you can check what the code will do without running it.

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

Write both kinds, because they catch different bugs. Only step tests see the value passed from one step to the next.

For example, if the email guard returned `Success(true)` instead of `Success(input)`, the step test would fail: it expects the input back and gets `true`. The flow test would still pass, because `cmdFindUser` is still the first call and `cmdSaveUser` the second, while the flow saves `true` to the database instead of the user.

A step tested on its own returns a `Failure` without `initialInput`. That is why the assertion above is `Failure('Email already in use.')`, while the validation one is `Failure('Invalid email.', badInput)`: `effectPipe` adds the input when it builds a flow.

Tests cannot see inside a Command's function without running it. If `cmdFindUser` said `db.findUser(input.name)` instead of `input.email`, every test on this page would still pass. Keep those functions to a single call, and let an integration test cover them.

## How It Works

A flow is a chain of pairs: an I/O call, and a `next` function that receives its answer and returns the next Command, a Success, or a Failure. `runEffect` walks the chain in a loop.

Recording and replay hook into the one place where a Command's function is called. Recording writes down each answer. Replay supplies the recorded answer instead of making the call, so a replayed flow does no I/O.

Building a flow runs the pure steps right away: `registerUserFlow(badInput)` returns the validation `Failure` synchronously, so the tests above do not need `runEffect`. Only Commands need it.

## Time-Travel Debugging

Record what each Command returned, then feed those results back into the flow to retrace the path a request took, with no database or network.

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

A production incident becomes a regression test, with no mocks or fixtures:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test checks that the flow still takes the recorded path and handles the recorded outcomes the same way. If a refactor reorders or replaces a step, the replay raises a `TimeParadox` naming where it diverged. If the error handling changes, the assertion fails.

A flow that stops issuing Commands before the recording ends (for example, a fix that skips the charge) raises no `TimeParadox`, and the replay can end in `Success` with recorded steps left over. `replayEffect` returns those steps as `unreached`, so a test can assert which ones it expects to skip:

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

For every other recording, `unreached` should be empty, so a fix that skips a step by accident fails the test.

This works when the removed step is the last one the flow reaches. Remove a step from the middle and every later step moves to a different path, so the replay stops at a `TimeParadox`. In that case `unreached` lists the steps the replay never got to, not the steps the fix made unnecessary.

**Replay checks the path, not the values.** It shows that the flow asks for the same Commands in the same order and handles the same answers. It cannot check what the flow computes, because every Command's result comes from the recording, not from the new code. If you fix how a refund amount is calculated and replay the bad run, the charge step gets the old amount from the recording: the replay reports `Success`, returns the value from before the fix, and flags nothing. Test a change to a value against the pure step that computes it.

**A trace records what each Command returned, not the arguments it was called with.** Given the recorded input and results, the flow does the same thing again, so replaying up to a step rebuilds the arguments that Command ran with. You can inspect them in a debugger, but you cannot assert on them. Storing arguments would also double what `redact` has to cover, since arguments are usually the sensitive part of a call.

**Put anything that varies between runs inside a Command.** For replay, the current time or a random ID counts as I/O. Wrapped in a Command, it is recorded and replayed like any other result. A step that calls `Date.now()` directly gets a new value on every replay and drifts from the trace.

**To check for this,** record a flow, replay it right away, and compare the outcomes. A step that computes a new value on each run shows up as a `TimeParadox` if it changes which Commands run, or as a different final value:

```js
const { result, trace } = await recordEffect(registerUserFlow, input);
const { result: replayed } = await replayEffect(registerUserFlow(input), trace);
assert.deepEqual(replayed, result); // fails if any step computed a fresh value
```

This also works for a `Failure`: an error read back from a trace keeps its message, name, cause, custom properties, and an `AggregateError`'s list of errors, and is deep-equal to the one the Command threw. The exception is a custom error class, which comes back as a plain `Error` with that class's name; compare `error.name` and `error.message` instead.

**You choose the trace format.** `replayEffect` also accepts a resolver function instead of a trace, so you can replay from OpenTelemetry spans, a log pipeline, or a database table, not only from the JSON that `recorder` produces.

```js
// A resolver answers one question: what did production get back for this step?
const resolve = (step) => ({ result: mySpans[step.index].attributes.output });
await replayEffect(checkoutFlow(input), resolve);
```

## Recording in Production

`recordEffect` suits tests and scripts, where one call covers the whole run. To record an application without changing any call site, install the hooks once at startup (see `examples/recording-example.js`).

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

By default, successful runs are held in memory and then discarded. `redact` runs before anything enters the trace, including the stored `initialInput` and `context`. `maxEntries` caps the length of a trace and reports the overflow as `dropped`. The sink can write a trace to S3 or a database column as JSON, as long as your Commands return plain data.

**A trace keeps data, not objects.** A result is copied when it is recorded, and copied again each time a replay hands it to the flow, so neither a later step nor a replay can change what the trace says. The copy keeps values but not classes: a money object or a database entity comes back as a plain object without its methods, and a `Buffer` as a plain byte array. An error returned inside a result keeps its message but loses properties such as `code`. Writing the trace as JSON loses more: a `Date` becomes a string, a `Map` becomes `{}`, an error inside a result becomes `{}`, and a `BigInt` makes the sink throw.

So return plain data from a Command's function. Turn a class instance into a plain object before returning it, with a small named function you can test on its own, as in `() => db.findCart(id).then(cartToData)`, and rebuild the object in `next` if the flow needs its methods. When you catch an error to return it as data, copy the fields the flow branches on, as in `.catch((error) => ({ ok: false, code: error.code }))`, rather than returning the error itself.

## Passing Runtime Context

Some values come from the framework (an authenticated tenant, a request ID, environment config) rather than from the data being processed. `Ask` lets a step read the `context` object passed to `runEffect` without passing it through every function:

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

`Retry` runs part of a flow again when its I/O fails, meaning a Command's function throws. It does not retry a `Failure` that a step returned: that means the flow decided to stop, so the `Failure` is passed on at once, unchanged. Options are given where `Retry` is used, since they describe one dependency. To reuse the same settings, share an object:

```js
const flakyNetwork = { attempts: 3, delay: 200, backoff: 2 };
Retry(fetchPrice(sku), flakyNetwork);
```

The retry settings are a plain object, so you can inspect and assert on them without running anything:

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

**Wrap the Command that fails, not the pipeline.** Each attempt re-runs everything inside the `Retry`, including Commands that already succeeded:

```js
// Dangerous: a flaky receipt step charges the customer again on every attempt.
Retry(effectPipe(chargeCard, sendReceipt)(order), { attempts: 3 });

// Correct: only the step that fails transiently is retried.
effectPipe(chargeCard, (charge) => Retry(sendReceipt(charge), { attempts: 3 }))(order);
```

Wrapping a pipeline is safe only when every Command in it is idempotent (safe to run more than once).

**Wrapping one Command is not always enough.** A Command's `next` is inside the `Retry` too, so if `next` continues the flow, everything after it is retried as well. This looks like it follows the advice above, but it does not:

```js
// Dangerous: `next` continues the booking, so every later step is inside the Retry.
Retry(
    Command(cmdHoldSeat, (seat) => chargeCard(trip, seat)),
    { attempts: 2 }
);
```

If a later Command's function throws, the `Retry` runs again, which repeats the seat hold and the charge. With two of these nested, a failure in the last step of a booking charges the card nine times.

Instead, leave the retried Command with its default `next` and continue in a later pipeline step, outside the `Retry`:

```js
// Safe: the tree the Retry repeats is that one Command.
effectPipe(
    () => Retry(Command(cmdHoldSeat), { attempts: 2 }),
    (seat) => chargeCard(trip, seat)
);
```

When every attempt fails, `runEffect` returns a `Failure` with this error:

```text
{ retryExhausted: true, lastError: <the last error>, attempts: 3 }
```

In TypeScript, a `Retry` adds `RetryExhaustedError<E>` to the pipeline's error union, not the inner `E`. The inner error type is available as `result.error.lastError`.

**Use `onExhausted` to fall back when every attempt fails.** The fallback runs instead of returning the `Failure`. If it succeeds, its value continues down the pipeline. If it fails, its own `Failure` is returned as is:

```js
const fetchPrice = (sku) =>
    Retry(fetchLivePrice(sku), {
        attempts: 3,
        onExhausted: (err) => fetchCachedPrice(sku) // err = { retryExhausted, lastError, attempts }
    });
```

Fallback steps are recorded, so a replay repeats the fallback too. A fallback never starts in a `Parallel` branch that has already been cancelled. With `onExhausted` set, the `Retry` adds the fallback's error type to the TypeScript error union instead of `RetryExhaustedError<E>`.

Every attempt is recorded, so a replay repeats the same sequence of failures, without the delays.

## Running Effects in Parallel

`Parallel` runs several flows at the same time and passes their results to `next` as an array, in order. If a branch fails, the other branches are cancelled, `next` is not called, and that branch's `Failure` is returned.

```js
import { Success, Command, Parallel } from 'pure-effect';

const loadProfile = (userId) =>
    Parallel([getUser(userId), getPermissions(userId)], ([user, permissions]) => Success({ user, permissions }));
```

`next` is optional, as with `Command`. Without it, `Parallel(effects)` returns the array of values.

Every branch can read the `Ask` context.

**Options for batches.** The second argument can be either `next` or an options object:

```js
// At most 5 branches in flight, for a gateway that rate limits.
Parallel(subscriptions.map(billOne), { limit: 5 });

// Every branch runs to completion, and `next` receives the outcomes rather than the values.
Parallel(subscriptions.map(billOne), { limit: 5, settled: true });
```

Without `settled`, one failing branch cancels the rest and becomes the result of the whole `Parallel`, so one bad record can stop a batch halfway through. With `settled: true`, every branch runs to the end and `next` receives one `Success` or `Failure` per branch, in order, so a failed record is something you can count instead of the end of the job:

```js
Parallel(subscriptions.map(billOne), (outcomes) => Success(outcomes.map(summarize)), { limit: 5, settled: true });
```

Each `Failure` in the list carries the input the flow was called with, like a top-level `Failure`. When you report the outcomes, pick the fields you need rather than logging the whole object:

```js
Parallel(work, (outcomes) => Success(outcomes.map((o) => (o.type === 'Success' ? o.value : o.error.message))), {
    settled: true
});
```

Logging the outcomes as they are would include the flow's input, which for a registration or login contains credentials.

The outcomes are plain `Success` and `Failure` objects. Returning one of them from `next` is the same as returning any other `Failure`: the flow stops, and `Retry` does not run it again.

Bugs in the flow are not collected. An `EffectTypeError`, thrown for a malformed flow, and an error thrown by a `next` function or a pure step both still escape a settled `Parallel`, after the other branches are cancelled.

`limit` caps how many branches run at once; the rest start as others finish. Results and recorded paths stay in array order, so a limit changes only the pacing, and a trace recorded with a limit replays the same without one. A `limit` that is not a positive integer throws a `TypeError`.

**Cancelling is a request, not a guarantee.** A cancelled branch starts no new Commands: a three-step branch whose first step is running when a sibling fails finishes that step and stops. To stop the running step itself, its function has to accept the `AbortSignal` it is given and pass it on to the I/O:

```js
// Cancellable: the request is aborted the moment a sibling branch fails.
const fetchProfile = (userId) => Command((signal) => fetch(`/users/${userId}`, { signal }).then((r) => r.json()));

// Not cancellable: this runs to completion even after a sibling fails.
const fetchProfileUncancellable = (userId) => Command(() => fetch(`/users/${userId}`).then((r) => r.json()));
```

Outside a `Parallel`, the function is called with no arguments. A `Retry` inside a cancelled branch stops retrying.

Which branch failed first and cancelled the others depends on timing, so it is recorded with the trace. A replay of a cancelled `Parallel` returns the same failure production did, and stops each other branch where production stopped it, rather than letting whichever branch the replay reaches first decide. If the branch that cancelled the others no longer fails, or the `Parallel` no longer has that branch, the replay raises a `TimeParadox` naming it.

## Composing Larger Flows

`effectPipe` runs steps in a straight line. Branching and joining use the same pieces:

**A step can return a sub-pipeline.** `effectPipe(...)(value)` returns an Effect like any other, so a step can branch into another flow. A `Failure` in that flow stops the outer pipeline too:

```js
const processOrder = (order) => (order.isGift ? giftFlow(order) : standardFlow(order));

const fulfillment = effectPipe(validateOrder, processOrder, scheduleShipping);
```

**Use `Parallel` to join values that do not depend on each other.** When a later step needs several such values, fetch them at the same time. Without `next`, the results arrive as an array, in order:

```js
const loadCheckout = effectPipe(
    (input) => Parallel([fetchCart(input.cartId), fetchUser(input.userId)]),
    ([cart, user]) => Success({ cart, user, total: cartTotal(cart) })
);
```

**Join values that depend on each other locally.** When step B needs step A's result and step C needs both, pass both forward in one value. A small pipeline inside the step does this without nested callbacks:

```js
const applyLoyaltyDiscount = (orderId) =>
    effectPipe(
        fetchOrder,
        (order) => effectPipe(fetchCustomer, (customer) => Success({ order, customer }))(order.customerId),
        ({ order, customer }) => Success(discountedTotal(order, customer))
    )(orderId);
```

**Pass only what the next steps need.** Avoid one object that collects everything computed so far. When a step's input is all it gets, it cannot depend on a value from far upstream without showing it, stale fields do not linger, and two steps cannot clash over the same key. Data also lives only as long as the flow needs it, which matters for credentials and personal data. In TypeScript, it keeps the pipeline type-checked: if an upstream step changes what it returns, the step that reads the value fails to compile instead of getting `undefined` at runtime.

## Which Errors Are Data

Pure Effect has no catch, on purpose. A flow's outcomes are of two kinds, and each is written differently.

**An outcome the flow handles is data.** A Command's `next` receives the result and can return any Effect, including a fallback pipeline. When the I/O can reject, catch the error inside the Command's function and return it as a value:

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
            .catch((error) => ({ ok: false, code: error.code, message: error.message }));
    return Command(cmdFetchLivePrice, (r) => (r.ok ? Success({ ...r.price, stale: false }) : fetchCachedPrice(sku)));
};
```

The failed attempt is recorded as that Command's result, with the error's `code` and `message`, so a replay takes the same fallback branch. Copy the fields you need rather than returning the error itself: a trace keeps data, not objects, so an error stored inside a result loses its properties (see [Recording in Production](#recording-in-production)).

**A `Failure` means abort.** It stops the flow and goes back to the code that called `runEffect`, which decides what it means: an HTTP status, a queue retry, an alert. Nothing inside the flow can catch a `Failure`, so a reader never has to look elsewhere for a handler.

Rule of thumb: if you would handle it, return it as a value; if you would only report it, return a `Failure`. The one exception is retry exhaustion, which happens inside `Retry`; handle it with the `onExhausted` option in [Retrying Transient Failures](#retrying-transient-failures).

**Catch or retry, not both.** `Retry` only reacts to a function that throws. If you catch a 503 inside the function and return it as a value, then wrap the step in `Retry`, it makes one call and never retries. Catch the error when the flow should handle it as data; let it throw when `Retry` should try again.

```js
// Handled as data: one call, and `next` decides what the miss means.
Command(
    function cmdFetchPrice() {
        return pricing
            .get(sku)
            .then((price) => ({ ok: true, price }))
            .catch((error) => ({ ok: false, code: error.code, message: error.message }));
    },
    (r) => (r.ok ? Success(r.price) : fetchCachedPrice(sku))
);

// Retried: the function lets the rejection out, so the interpreter sees an I/O fault.
Retry(
    Command(function cmdFetchPrice() {
        return pricing.get(sku);
    }),
    { attempts: 3 }
);
```

`runEffect` tells these cases apart:

| what happened | what it is | what `Retry` does | what `onExhausted` sees |
| --- | --- | --- | --- |
| a step returned `Failure(...)`, or an `onBeforeCommand` hook threw | an abort | nothing; it propagates at once, unwrapped | nothing |
| a Command's function threw | an I/O fault | retries it | the exhaustion, once the attempts are gone |
| a `next` function or a pure step threw, or the flow is malformed | a bug | nothing; it is thrown, not returned | nothing |
| an `onStep` hook threw after the Command's function succeeded | a bug | nothing; it is thrown, not returned | nothing |

In short, **you can recover from an error your I/O produced, but you cannot catch a `Failure` a step returned.** Only the code that called `runEffect` acts on it. For the same reason, do not throw business errors from a Command's function: a throw there tells `Retry` that the I/O broke, and `Retry` will try again. A throw anywhere else in the flow is treated as a bug: `runEffect` rejects with the thrown error instead of returning a `Failure`.

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

Value types are checked through the pipeline too, so a step that reads a field the previous step does not return is a compile error. This only works while every step uses the value it receives. A step written as `() => doSomething(outer)` ignores it, and the types stop being checked at that point.

`effectPipe` is typed for up to 20 steps. A pipeline is itself a step, so a longer one nests, which is usually easier to read anyway: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => { ... });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

## Why Pure Effect

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, built on the same idea: record what every step returned and replay it. Those engines store the history on a server and resume workflows automatically after a crash. Pure Effect leaves storage and restarts to your application, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full ecosystem with fibers, streaming, schema validation, structured concurrency, and more, with a steep learning curve and its own vocabulary. Pure Effect takes only the idea of describing side effects as data, and does less: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers or streaming, use Effect-TS.

**vs. plain async/await with mocks:** A mock can pass every test while behaving differently from the real driver. Here, business logic never does I/O, so there is nothing to mock.

**When to use something else:** If your code does little async I/O, or testing and debugging production are not problems for you, plain async/await is simpler.

## API Reference

### Building blocks

#### `Success(value)`

Returns `{ type: 'Success', value }`.

#### `Failure(error, initialInput?)`

Returns `{ type: 'Failure', error, initialInput }`. Stops the pipeline immediately.

#### `Command(cmdFn, nextFn?, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmd`: A function (sync or async) that performs the side effect. Inside a `Parallel` branch it is called with an `AbortSignal` that fires when a sibling branch fails; elsewhere it is called with no arguments.
- `next`: Receives the result of `cmd` and returns the next Effect. Optional, defaulting to `(result) => Success(result)`.
- `meta`: Optional metadata, passed to `onBeforeCommand`. A string `meta.name` becomes the Command's identity. Otherwise, the name of the function is used (`cmd.name`).

**Every Command needs a name.** Test assertions, trace entries, replay matching, and telemetry spans all use it. It is chosen in this order:

```js
Command(cmdFn, next, { name: 'chargeCard' }); // 1. meta.name, independent of how cmdFn was written
Command(function cmdChargeCard() {
    return api.charge();
}, next); // 2. the function's own name
Command(() => api.charge(), next); // 3. neither, so 'anonymous'
```

Use `meta.name` in code that gets minified, since minifiers rename functions and would rename every step in every trace. Otherwise, naming the function is fine, and is what the examples do.

#### `Ask(nextFn)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`.

#### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`.

- `options.attempts`: Max retries, not counting the first try (default: `3`). Must be a positive integer; anything else, including `0`, throws a `TypeError`. To handle an outcome without retrying, branch on it in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.
- `options.delay`: Ms before the first retry (default: `100`).
- `options.backoff`: Multiplier applied to the delay on each attempt (default: `1`, flat).
- `options.onExhausted(error)`: Runs a fallback Effect when every attempt has failed, receiving `{ retryExhausted, lastError, attempts }`. The fallback's success feeds `next`; its failure propagates unwrapped. Per-use only. See [Retrying Transient Failures](#retrying-transient-failures).

#### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`. Runs all effects at the same time. `next` receives the array of success values, in order, and is optional, defaulting to `(values) => Success(values)` as with `Command`. The first branch to fail cancels the others and its `Failure` is returned; `next` is not called. When several branches fail in the same tick, the first in array order wins. Each branch's Commands receive an `AbortSignal` as their only argument, so I/O that accepts it can be stopped while running; see [Running Effects in Parallel](#running-effects-in-parallel).

The second argument can be `next` or the options, so `Parallel(effects, { limit: 5 })` works.

- `limit`: the most branches running at once. Results and recorded paths stay in array order, so a limit changes only the pacing. A value that is not a positive integer throws a `TypeError`.
- `settled`: run every branch to the end and pass `next` one outcome per branch, `Success` or `Failure`, in array order. No branch cancels the others, and the `Parallel` never fails because of a branch. An `EffectTypeError` still escapes, because a malformed flow is a bug, not a branch outcome.

### Building pipelines

#### `effectPipe(...functions)`

Composes functions into a sequential pipeline. Each function receives the unwrapped `Success` value from the previous step, and a `Failure` from any step stops the pipeline.

A step does not have to use the value it receives. In JavaScript, closing over something from the enclosing scope is fine:

```js
// The last step ignores what came before and uses the enclosing input instead.
const registerUserFlow = (input) => effectPipe(validateRegistration, () => saveUser(input))(input);
```

In TypeScript, types stop being checked at that step, because a function that ignores its parameter puts no constraint on the step before it. See [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context). Passing the value through every step keeps the whole pipeline checked, which is why the Quick Start does it.

One shape to avoid in either language:

```js
(value) => {
    sendWelcomeEmail(value); // built and thrown away: the email is never sent
    return Success(value);
};
```

A Command is only data, so one that is created and not returned never runs, and any `Failure` it would have produced is lost. Return the Command, and have its `next` return the value the rest of the pipeline needs.

### Running a flow

#### `runEffect(effect, context?, callConfig?)`

Walks the flow, runs each Command with `async/await`, resolves `Ask` with the supplied `context`, and returns the final `Success` or `Failure`.

- `context`: Passed to `Ask`'s next function and to `onBeforeCommand`. `context.flowName` names the workflow in telemetry.
- `callConfig`: Per-call `onStep`, `onRun`, and `onBeforeCommand`, added to the `configureEffect` wiring unless `inherit: false`, which ignores that wiring for the run. A `retry` key throws a `TypeError`: retry options are per-use, passed to `Retry`. See [`configureEffect`](#configureeffectconfigs).
- `onRun` fires once per `runEffect` call. Retry attempts run inside that one span.

A step that returns something other than an Effect is a bug, so `runEffect` throws an `EffectTypeError` naming the step instead of returning a `Failure`:

```
Step 'validateRegistration' returned a plain object. Return Success, Failure, Command, Ask,
Retry, or Parallel: a plain value has to be wrapped, as in Success(value).
```

The same check catches a missing `return`, a Command's next function returning a plain value, a step or next function written as `async` (it returns a Promise, so do the awaited work in a Command instead), and `runEffect(flow)` where `runEffect(flow(input))` was meant. A Command whose function throws is still a `Failure`. A throw from a `next` function or a pure step is also a bug, and `runEffect` rejects with the error as thrown.

#### `configureEffect(...configs)`

- `onRun(effect, pipeline, flowName)` wraps the entire workflow; must `await pipeline()`.
- `onStep(name, type, op)` wraps each Command; must `await op()` and return its result. Returning a value _without_ calling `op()` is how replay works. A throw after `op()` succeeded is a bug in the hook: the run rejects, and `Retry` does not run the Command again. A throw without calling `op()` counts as the Command failing.
- `onStep` also wraps each `Parallel`, with `name` and `type` both `'Parallel'`. Its `op()` runs the branches, so a hook must call it; a hook that returns without calling it makes the run reject with a `TypeError`. Telemetry gets one span per `Parallel`, with the spans of its branches' Commands inside it.
- `onBeforeCommand(command, context)` fires before each Command; throw to abort. The run returns a `Failure` carrying the thrown error, and `Retry` does not retry it.

It only configures hooks. Retry options are passed to `Retry(effect, options)`, and a `retry` key here throws a `TypeError`.

Each call adds a layer of hooks on top of those already installed and returns a function that removes that layer. Passing several configurations to one call is the same as calling it once for each, so these two forms are equivalent:

```js
configureEffect(telemetryHooks(), recordingHooks({ sink }));

// or, as two layers:
configureEffect(telemetryHooks());
configureEffect(recordingHooks({ sink }));
```

This is the order the hooks run in during one `runEffect`:

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
```

Removing a layer removes only that layer, even if others were installed after it, so a library can add its own hooks and remove them later without affecting the application's. Calling `configureEffect()` with no arguments removes every layer. A call whose arguments are all `undefined`, such as a conditional `configureEffect(flag ? hooks : undefined)`, installs nothing and removes nothing.

```js
const remove = configureEffect(telemetryHooks());
// ... later
remove();
```

**Per-call hooks.** By default, the hooks in a `callConfig` are merged with the configured ones by the same rules: configured wrappers go outside, and configured `onBeforeCommand` hooks run first. `inherit: false` leaves the configured hooks out of the run. With configured hooks `C` and a call `K` that supplies only `onStep`:

```
                  inherit: true (default)        inherit: false

onRun             C.onRun                        (none)
onBeforeCommand   C.onBeforeCommand              (none)
onStep            C.onStep( K.onStep( cmd ) )    K.onStep
```

`recordEffect` inherits, so recording inside an application that already has tracing still produces spans. `replayEffect` passes `inherit: false` unless `hooks: true`.

### Recording and replay

#### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`. Pass `onStep` to `runEffect` or `configureEffect` to record what every Command returned.

Each entry is `{ command, path, result, durationMs }`, or `{ command, path, error, durationMs }` when the Command threw, so a trace also shows which step was slow. `path` is the Command's position in the flow, which is what a replay matches on. Each `Parallel` adds one entry, `{ command: 'Parallel', path, result }`, whose result says which branch, if any, cancelled the others: `{ cancelled: false }`, `{ cancelled: true, branch: 0 }`, or `branch: null` when an enclosing `Parallel` cancelled it. `redact` is not called for it, since it holds no data from your flow. Results are copied when recorded, so a later step that changes a returned object does not change the trace, and copied again when a replay hands them to the flow. Values that cannot be copied, such as an object holding a function, are stored by reference instead. The copy keeps data but not classes; see [Recording in Production](#recording-in-production). Recording never changes the outcome of a run: if `redact` throws, the step is recorded as `'[redaction failed]'` and the flow carries on.

- `options.redact(value, name, kind)`: Removes sensitive data from a trace. It receives every value the trace stores, and `kind` says which one it is:

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

For `'result'` and `'error'`, `name` is the Command's name; for `'initialInput'` and `'context'`, it is the kind. Redacting `initialInput` rarely breaks replay, since Commands are not run; it matters only if a step branches on the removed field. Redacting `context` breaks `Ask` replay if a step reads what you removed.

- `options.maxEntries`: Cap trace length; overflow is counted in `dropped`.
- `options.stack`: Record stack traces for thrown errors (off by default).

#### `recordEffect(flowFn, initialInput, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. Accepts `recorder` options plus `context` and `version`. For tests and scripts; in an application install `recorder().onStep` via `configureEffect` instead.

#### `replayEffect(effect, traceOrResolver, options?)`

Replays a flow, feeding recorded results to Commands instead of running them. Returns `{ result, unreached }`: the flow's outcome, and the recorded entries the flow never asked for (empty when every step was reached). A flow that stops early raises no `TimeParadox`, so `unreached` is where that shows up. With a resolver, only `{ result }` is returned, since a resolver cannot list what it holds.

- `traceOrResolver`: a trace (or bare entries array) to replay directly, or a resolver function for traces stored in some other shape. A resolver returns `{ result }`, `{ error }`, or `undefined` if the step is unrecorded. A resolver is also asked about each `Parallel`, with `step.type` set to `'Parallel'`: answering with `{ result }` holding the recorded cancellation replays it as production decided, and anything else replays that `Parallel` by timing, as before. A malformed trace rejects with a `ReplayError`.
- `options.context`: context for `Ask`; pass the recorded context.
- `options.onMissing`: `'throw'` (default) fails on an unrecorded step; `'execute'` runs the real Command, giving a recorded prefix with a live tail.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the configured hooks, so they see the replayed steps, a configured recorder included. When off, the configured hooks are skipped, so a replay cannot reach a telemetry backend or a trace sink.
- `options.onResolved(step, outcome)`: observe each replayed step.

A trace whose entries carry no `path` (written by hand, or recorded before paths existed) is matched by position, which works for a sequential flow; a `Parallel` step in such a trace is refused with a `ReplayError`, since the order branches finish in cannot tell them apart.

#### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates each step with its recorded duration, naming any recorded steps that were never reached and warning when the trace's `version` differs from `options.version`. Returns the flow's outcome; for the unreached entries as data, use `replayEffect`. Takes `options.context` to override the trace's, and `options.log` in place of `console.log`.

## Limitations

- **`Retry` repeats everything it wraps, including a Command's `next`.** When a Command's function throws, every Command inside the `Retry` runs again, including the ones that already succeeded. If a retried Command's `next` continues the flow, everything after it is retried too. Give a retried Command the default `next` and continue in a later pipeline step, or make sure every Command it reaches is safe to run more than once. A `Failure` a step returned is not retried at all, so a function that catches its own error and returns it as a value is never retried: see [Which Errors Are Data](#which-errors-are-data).
- **Cancelling a `Parallel` branch cannot stop everything.** A cancelled branch starts no new Commands, and a function that uses the `AbortSignal` it is given can be stopped while running. A function that ignores the signal runs to completion, so a branch whose _first_ Command is a write can still write after another branch has failed. `Parallel` waits for every branch to finish before returning, so no cancelled work is still running after the `Failure` is returned.
- **A `Failure` carries everything.** It holds the full error and the `initialInput` that `effectPipe` attached, and neither is trimmed, because tests and debugging need both. `redact` keeps sensitive data out of a **trace**. Keeping it out of your **logs** is up to you: log `result.error` rather than the whole `Failure`. The same goes for the outcomes a settled `Parallel` passes to `next`, which carry the same input; for a login or registration flow, that input holds credentials.
- **Replay checks the path, not the values.** Replaying an old trace cannot check a fix that changes what a flow computes, because every Command's result comes from the recording: the replay hands the step the value from before the fix, reports `Success`, and flags nothing. It can check a fix that changes which Commands run. A removed step shows up in `unreached` only if it was the last step the flow reached; removed from the middle, it shifts the later paths and the replay stops at a `TimeParadox`.
- **A trace keeps data, not objects.** Recorded results come back without their classes: a money object or a database entity as a plain object, a `Buffer` as a plain byte array, and an error inside a result without properties such as `code`. Through JSON, a `Date` also comes back as a string and a `Map` as `{}`. A flow whose `next` calls a method on a result, or branches on one of those properties, replays differently from production. Return plain data from Commands; see [Recording in Production](#recording-in-production).
- **Replay reproduces what one flow saw, not timing.** A stale read replays exactly. A race between two concurrent requests does not, because a trace records one flow. `Parallel` branches replay with the results each branch saw, and a cancelled `Parallel` with the branch that cancelled it, but not the order they ran in, so replay cannot settle a race between branches that share state.
- **Configuration belongs to one copy of the library.** `configureEffect` stores hooks in module state, so two copies of the library in one process (from a dual ESM and CJS setup, two versions in the dependency tree, or a worker thread) each have their own. Hooks configured in one do not apply to the other, and nothing warns you.
- **A Command needs a name.** `meta.name` survives minification. `cmd.name` does not, unless the minifier is set to keep function names.
