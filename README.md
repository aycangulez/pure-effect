# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![CI](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Read request values, such as the tenant, from any step with `Ask`, without passing them along
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks, with a reference integration to copy
- Zero dependencies, about 12 KB minified and gzipped
- Works in JavaScript on Node 22 or later, and in TypeScript 5.1 or later (full generics, bundled `.d.ts`)

## Table of Contents

- **Getting started:** [Installation](#installation) · [The Core](#the-core) · [Quick Start](#quick-start) · [Coming from async/await](#coming-from-asyncawait) · [Writing Flows as Generators](#writing-flows-as-generators) · [Testing Without Mocks](#testing-without-mocks) · [Rules for Writing a Flow](#rules-for-writing-a-flow)
- **Building flows:** [Passing Runtime Context](#passing-runtime-context) · [Retrying Transient Failures](#retrying-transient-failures) · [Running Effects in Parallel](#running-effects-in-parallel) · [Composing Larger Flows](#composing-larger-flows) · [Writing Loops](#writing-loops) · [Which Errors Are Data](#which-errors-are-data) · [Generator Flows in Depth](#generator-flows-in-depth) · [Parallel in Depth](#parallel-in-depth) · [TypeScript](#typescript-typed-errors-and-context)
- **Recording and replay:** [Time-Travel Debugging](#time-travel-debugging) · [Recording in Production](#recording-in-production) · [Hooks](#hooks) · [Replay in Depth](#replay-in-depth)
- **Reference:** [Why Pure Effect](#why-pure-effect) · [API Reference](#api-reference) · [Limitations](#limitations)

The seven sections under Getting started are enough to write and test a flow. Come back to the rest when a flow needs it: retries, loops, steps that run at the same time, TypeScript, or recording.

## Installation

```
npm install pure-effect
```

## The Core

Every flow is built from these:

| Piece | What it is |
| --- | --- |
| `Success(value)` | A step that succeeded, carrying its value on to the next step. |
| `Failure(error)` | A step that stops the flow, carrying its error to the caller. |
| `Command(cmd, next)` | A call to make, and a function that turns its answer into the next step. |
| `effectPipe(...)`, `effectGen(...)` | Join steps into a flow: as a pipeline, or written like `async` code with `yield* step(...)`. |
| `runEffect(flow)` | Runs the flow, the only place the calls are made, and returns a `Success` or a `Failure`. |

Everything else adds to these. `Ask` reads request values, `Retry` and `Parallel` wrap steps, and recording and replay watch `runEffect` make its calls.

## Quick Start

Five steps take you from a plain `async` function to a tested flow. The example registers a user.

**1. Describe each call as a Command.** A Command holds a call to make, and a `next` function that turns its answer into the next step. Building one makes no call.

```js
import { Success, Failure, Command, Retry, effectPipe, effectGen, step, runEffect } from 'pure-effect';

// Name each Command's function: traces, replay and telemetry refer to the Command by it.
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
```

Keep a Command's function to the one call. Tests never run it, so nothing else in it gets tested.

**2. Join the steps into a flow.** A step with no I/O returns `Success` or `Failure` itself. `effectPipe` hands each step the value the step before it produced.

```js
// Pure. No I/O, instantly testable.
const validateRegistration = (input) => {
    if (!input.email.includes('@')) return Failure('Invalid email.');
    if (input.password.length < 8) return Failure('Password too short.');
    return Success(input);
};

// Validation runs as the flow is built. No I/O happens until runEffect.
const registerUserFlow = (input) => effectPipe(validateRegistration, ensureEmailAvailable, saveUser)(input);
```

The same flow can be written as a generator, with `yield* step(...)` where `async` code writes `await`. [Writing Flows as Generators](#writing-flows-as-generators) covers what to know.

```js
const registerUserFlowGen = effectGen(function* (input) {
    yield* step(validateRegistration(input));
    yield* step(ensureEmailAvailable(input));
    return yield* step(saveUser(input));
});
```

**3. Return a `Failure`, and throw only when trying again could help.** The two ways to fail do different things:

- An outcome the flow decides, such as an invalid email or one already in use, is a `Failure` a step returns. The flow stops there, and nothing retries it.
- A call that broke, such as a timeout or a dropped connection, is an error the Command's function throws. `Retry` makes the call again:

```js
// Up to three calls. Wrap only the Command: Retry runs everything it wraps again.
const saveUserWithRetry = (input) => Retry(saveUser(input), { retries: 2 });
```

Either way, the caller gets a `Failure` once the flow gives up. A call that throws outside a `Retry` ends the run in a `Failure` holding the error it threw.

After a `Retry` gives up, the `Failure` holds `{ retryExhausted, lastError, retries }`, with the last error thrown as `lastError`. When a call throws an error the flow should decide on, such as a declined card, catch it inside the Command's function and return it; [Which Errors Are Data](#which-errors-are-data) shows how.

**4. Test it without mocks.** A flow is plain objects. Hand a step the answer you choose and check what it returns:

```js
// The email is taken, so the flow stops here. No database was touched.
const taken = ensureEmailAvailable({ email: 'taken@test.com', password: 'password123' }).next({ id: 1 });
assert.deepEqual(taken, Failure('Email already in use.'));
```

[Testing Without Mocks](#testing-without-mocks) shows each kind of test, and how to run a whole flow with no I/O.

**5. Run it.** `runEffect` makes the calls and returns a `Success` or a `Failure`. It is the only place a call is made, so it sits at the edge of your app:

```js
async function registerUser(input) {
    const result = await runEffect(registerUserFlow(input));

    if (result.type === 'Success') {
        console.log('User created:', result.value);
    } else {
        console.error('Error:', result.error);
    }
}
```

That is a whole flow. [Rules for Writing a Flow](#rules-for-writing-a-flow) lists the twelve rules that cover most of what goes wrong, and [Time-Travel Debugging](#time-travel-debugging) shows how to record a run in production and replay it on your machine. In TypeScript, [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context) covers typing a flow's errors and context, handling every error, and testing a flow.

## Coming from async/await

A flow does what `async`/`await` code does, as data. Instead of making a call and waiting for it, a step returns a Command: which call to make, and what to do with the answer. Each thing you would write with `async`/`await` has an equivalent.

Where the two styles differ:

| `async`/`await` | Generator flow | Pipeline |
| --- | --- | --- |
| `await db.findUser(email)` | `yield* step(findUser(email))` | `Command(cmdFindUser, next)` |
| the code after the `await` | the next `yield*` | the Command's `next` |
| an `if` on a result | a step that returns `Success` or `Failure` | a branch in `next` |
| `return value` | `return value` | `Success(value)` |
| `throw` to stop | a step that returns `Failure(error)` | `Failure(error)` |
| a `for` loop with an `await` inside | the same loop, with `yield*` | `Parallel(list.map(...), { limit: 1 })` |
| a call that needs two earlier results | two variables | a named step that passes both on |

The rest are the same in both styles, and a generator flow runs each one with `yield* step(...)`:

- `try`/`catch` around a call: a catch inside the Command's function
- a loop that retries a call: `Retry`
- `await Promise.all([...])`: `Parallel`
- a loop that keeps going past a failure: `Parallel` with `settled: true`
- a value from the request: `Ask`
- `Date.now()` or a random ID: a Command

`cmdFindUser` is the named function `() => db.findUser(email)`, and `findUser` stands for a step that returns the Command, as `ensureEmailAvailable` does in the Quick Start. A `catch` around `yield*` can log and rethrow, but it cannot recover; see [Which Errors Are Data](#which-errors-are-data).

One rule is behind both columns: each decision lives in a small step function that receives the answer it depends on and returns `Success` or `Failure`, so a test can call it directly. A pipeline joins those steps with `effectPipe`; a generator flow puts them in order with `yield*`. An `if` around a `yield*` works, but it can be tested only by walking the whole flow, so keep the body to putting steps in order. A `for` loop that runs a step for each item decides nothing, so it is fine.

The Quick Start's `registerUserFlow` is this function, translated row by row: each `await` became a Command, the code after it became that Command's `next`, and each `throw` became a `Failure`.

```js
async function registerUserAsync(input) {
    if (!input.email.includes('@')) throw new Error('Invalid email.');
    const found = await db.findUser(input.email);
    if (found) throw new Error('Email already in use.');
    return db.saveUser(input);
}
```

The difference shows in the tests. To reach the branch where the email is taken, a test of `registerUserAsync` has to replace `db.findUser` and `db.saveUser` with mocks, run the function, and put them back. The flow's test hands the one step the answer, `ensureEmailAvailable(input).next({ id: 1 })`, with nothing to replace or put back. The mocks do check one thing that test cannot: the arguments each call received, which [Testing Without Mocks](#testing-without-mocks) leaves to an integration test.

You can switch one function at a time. Keep its name and parameters, run the flow in its body, and turn a `Failure` back into a throw, so the code that calls it does not change:

```js
// Callers still await registerUserAsync and catch what it throws.
async function registerUserAsync(input) {
    const result = await runEffect(registerUserFlow(input));
    // A step's Failure holds the error as written, here a string; a Command's function threw an Error.
    if (result.type === 'Failure') throw result.error instanceof Error ? result.error : new Error(result.error);
    return result.value;
}

await assert.rejects(registerUserAsync({ email: 'bad-email', password: '123' }), { message: 'Invalid email.' });
```

If the flow has a `Retry`, a `Failure` from one that gave up holds `{ retryExhausted, lastError, retries }`; throw its `lastError` to rethrow what the call threw, as the old function did.

A loop becomes a step that gets the list and a `Parallel` over it, as the table shows; [Writing Loops](#writing-loops) translates one.

## Writing Flows as Generators

A generator flow is written like `async` code, with `yield* step(...)` where `async` code writes `await`. `effectGen` turns it into the same Commands a pipeline builds, so recording, replay, `Retry`, `Parallel` and the tests in [Testing Without Mocks](#testing-without-mocks) work the same for both. The Quick Start's `registerUserFlowGen` is one. The same steps in the same order record the same paths in either form, so a trace recorded from a pipeline replays against its generator version. A loop written as a `for` loop rather than a `Parallel` records differently; see [Writing Loops](#writing-loops).

### Where a generator helps

A generator earns its keep when a later step needs the results of more than one earlier step. Here the welcome email needs both the saved user and the workspace created for them, and each is a variable:

```js
const onboardUser = effectGen(function* (input) {
    const user = yield* step(registerUserFlowGen(input));

    const cmdCreateWorkspace = () => db.createWorkspace(user.id);
    const workspace = yield* step(Command(cmdCreateWorkspace));

    const cmdSendWelcome = () => mailer.sendWelcome(user.email, workspace.name);
    yield* step(Command(cmdSendWelcome));

    return { user, workspace };
});

const onboarded = await runEffect(onboardUser(input));
assert.equal(onboarded.value.workspace.ownerId, onboarded.value.user.id);
```

A pipeline would need a step that passes the user and the workspace on together; see [Composing Larger Flows](#composing-larger-flows). Keep decisions in step functions all the same, as `registerUserFlowGen` does, so each can be tested on its own.

The body can run more than once: for each `Retry` attempt and each run, as an `async` function does when called again, and when a test walks a second branch. So keep it to its own variables, and get `Date.now()` or a random ID from a Command, so a replay gets the recorded one. [Generator Flows in Depth](#generator-flows-in-depth) covers when it runs again, how a `catch` or `finally` in it behaves when a step stops the flow, and the mistakes `effectGen` catches.

## Testing Without Mocks

A flow is plain objects, so a test can check what it will do without running it. Validation runs as soon as the flow is built, so testing it needs nothing else:

```js
const badInput = { email: 'bad-email', password: '123' };
assert.deepEqual(registerUserFlow(badInput), Failure('Invalid email.'));
```

Next, test the steps. Hand a step an answer and check what it returns:

```js
const input = { email: 'test@test.com', password: 'password123' };

// The email is free, so the step passes the input on.
assert.deepEqual(ensureEmailAvailable(input).next(null), Success(input));

// The email is taken, so the flow stops here.
assert.deepEqual(ensureEmailAvailable(input).next({ id: 1 }), Failure('Email already in use.'));
```

Then test the flow: the right calls, in the right order. Handing each Command's `next` the answer you choose, and checking the step it returns, is called walking the flow; nothing runs. `commandName` gives the name a Command is recorded under:

```js
import { commandName } from 'pure-effect';

const step1 = registerUserFlow(input);
assert.equal(commandName(step1), 'cmdFindUser');

const step2 = step1.next(null); // pretend no user was found
assert.equal(commandName(step2), 'cmdSaveUser');
// The database was never touched.
```

Write both kinds: only a step test sees the value passed from one step to the next. Suppose the email guard returned `Success(true)` instead of `Success(input)`. The step test would fail. The flow test would still pass, since the calls and their order are unchanged, while the flow saved `true` instead of the user.

A walk meets a `Retry` or a `Parallel` as a step of its own. A `Retry` holds the step it repeats as `effect`, a `Parallel` holds its branches as `effects`, and the `next` of either is the rest of the flow. The walks in [Writing Loops](#writing-loops) and [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails) go through each.

A generator flow is tested the same way. Its decisions are in step functions, which get the step tests, and a walk or a whole-flow run works on `registerUserFlowGen` as it does on `registerUserFlow`. A walk straight through runs the body once, and walking a second branch runs it again.

[Testing a whole flow](#testing-a-whole-flow) shows how to run a whole flow in a test instead, `Retry` and `Parallel` included, with no I/O.

Tests cannot see inside a Command's function without running it. If `cmdFindUser` said `db.findUser(input.name)` instead of `input.email`, every test on this page would still pass. Keep those functions to a single call, and let an integration test cover them, with the services passed in as [Passing Runtime Context](#passing-runtime-context) shows.

In TypeScript, a walk needs a check at each step that the step is a Command; [Testing a flow in TypeScript](#testing-a-flow-in-typescript) has a helper that makes that one line.

### Testing a whole flow

To run a whole flow in a test instead of walking it, `Retry` and `Parallel` included, hand `replayEffect` a function that answers each Command. Nothing is called and no retry waits. The function gets each step the flow asks for, with its `name`, and returns `{ result }` for the Command to return, `{ error }` for it to throw, or `undefined` for a step it has no answer for, which ends the replay in a `Failure` holding a `ReplayError`:

```js
import { replayEffect } from 'pure-effect';

const answers = { cmdFindUser: null, cmdSaveUser: { id: 1, ...input } };
const answer = (step) => (step.name in answers ? { result: answers[step.name] } : undefined);
const { result } = await replayEffect(registerUserFlow(input), answer);
assert.deepEqual(result, Success({ id: 1, ...input }));
```

Answering `{ error }` is how a test reaches a `Retry`'s next attempt or its `onExhausted` fallback. An answer takes the place of the Command's function, its `catch` included: for a function that catches an error and returns it, answer with what it returns, not `{ error }`. To answer each attempt differently, give a name a list of answers and hand them out in turn. Here the Quick Start's `saveUserWithRetry` fails once, then goes through:

```js
const answers = { cmdSaveUser: [{ error: new Error('connection reset') }, { result: { id: 1, ...input } }] };
const inTurn = (step) => answers[step.name]?.shift();
const { result } = await replayEffect(saveUserWithRetry(input), inTurn);
assert.deepEqual(result, Success({ id: 1, ...input }));
```

The function is also asked about each `Parallel`, under the name `'Parallel'`; answering `undefined` lets its branches run as written. A step also carries its `path`, its position in the flow, which [Reading a trace](#reading-a-trace) explains; answer by path to tell apart two Commands with the same name.

## Rules for Writing a Flow

Twelve rules cover most of what goes wrong. The same rules ship in the package as `RULES.md`, with an index of where each task is covered.

<!-- rules:start -->

1. **Put every call that does I/O inside a Command, and keep its function to that one call:** `Command(() => db.findUser(email))`, never `step(db.findUser(email))`. Tests never run the function, so anything else in it goes untested. See [Testing Without Mocks](#testing-without-mocks).
2. **Name every Command,** with a named function such as `const cmdFindUser = () => ...`, or with `meta.name`. Traces, replay and telemetry use the name, and a minifier can strip a function's name. See [`Command`](#commandcmdfn-nextfn-meta).
3. **Put each decision in a step function** that receives one value and returns `Success`, `Failure` or the next Command, so a test can call it directly. See [Coming from async/await](#coming-from-asyncawait).
4. **Return an outcome the caller should see as `Failure(error)`; never throw it.** A `Failure` stops the flow, is never retried, and only the code that calls `runEffect` acts on it. See [Which Errors Are Data](#which-errors-are-data).
5. **A `catch` in a generator flow cannot recover.** It can log and rethrow, and it sees a `FlowStopped` error saying where the flow stopped, not the original. To handle an error, catch it inside the Command's function and return it as data. See [How a generator flow stops](#how-a-generator-flow-stops).
6. **Let a Command's function throw only when `Retry` should try again.** An error it catches and returns is data, and `Retry` never sees it. To retry some errors and not others, rethrow the first kind and return the second. A throw also skips any undo the Command's `next` would have run. See [Which Errors Are Data](#which-errors-are-data).
7. **Wrap only the Command that fails in `Retry`, and continue in a later step.** `Retry` runs everything it wraps again, the Command's `next` included. `retries: 2` means up to three calls, and `onExhausted` is where you give up. See [Retrying Transient Failures](#retrying-transient-failures).
8. **Write a loop as a step that gets the list, then `Parallel(list.map(f), { limit: 1 })`.** `limit` caps how many run at once, and `settled: true` keeps going past a failure. A generator flow can use a `for` loop with `yield*`. See [Writing Loops](#writing-loops).
9. **Get the time, random IDs and anything else that changes between runs from a Command.** A replay then gets the recorded value, and a generator body, which can run more than once, sees the same value each time. See [What runs once, and what runs again](#what-runs-once-and-what-runs-again).
10. **Return plain data from Commands, and keep the context to plain values.** A trace stores JSON, so a `Date` comes back as a string. Reach a service from the Command's function, and hand it to the function that builds the flow. See [Passing Runtime Context](#passing-runtime-context).
11. **Clean up in a `try`/`finally` around `runEffect`,** not inside the flow. See [How a generator flow stops](#how-a-generator-flow-stops).
12. **Check a replay's error, not only its type.** A replay of a flow that changed shape ends in a `Failure` holding a `TimeParadox`, the error naming where the flow and the trace part ways, so a test that only expects a `Failure` passes by accident. See [Time-Travel Debugging](#time-travel-debugging).

<!-- rules:end -->

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
    if (result.type === 'Success') return res.json(result.value);
    // A Failure holds the full error, so send the client only an error meant for it.
    // Answer the errors the flow returns by name, and anything else, such as a database outage, as a server error.
    if (result.error === 'Product not found.') return res.status(400).json({ error: result.error });
    res.status(500).json({ error: 'Checkout failed.' });
});
```

Recording stores the context alongside the trace, so `Ask` replays with the values the original request saw. It is copied once per run. So a value that can change while a run is under way, such as a switch an operator can flip to stop a batch, belongs in a Command, whose result the trace records each time.

Keep the context to plain values such as IDs, flags and settings. Recording copies it into every trace, so a database client or connection pool in it puts its connection string there. One whose properties throw when read, as a lazy client's can, leaves the whole context out, and a replay then needs it passed in. Reach a service from the Command's function, as `findProduct` reaches `db`. To run a flow against fakes or a test database, have the function that builds it take the services, and pass them in the test:

```js
// Takes its catalog, so a test can run it against a fake.
const makeFindProduct = (catalog) => (productId) => {
    const cmdFindProduct = () => catalog.findProduct(productId);
    return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('Product not found.')));
};

// The fake answers by the ID it receives, so the test also checks what the Command's function sends.
const findInFakeCatalog = makeFindProduct({ findProduct: async (id) => (id === 'abc' ? { id } : null) });
assert.deepEqual(await runEffect(findInFakeCatalog('abc')), Success({ id: 'abc' }));
assert.deepEqual(await runEffect(findInFakeCatalog('xyz')), Failure('Product not found.'));
```

A walk or a replay never runs a Command's function, so this is the test that catches one passing the wrong value.

## Retrying Transient Failures

`Retry` runs part of a flow again when a Command's function throws. A `Failure` a step returned is not retried: the flow decided to stop, so the `Failure` passes on at once, unchanged. Options are given where `Retry` is used, since they describe one dependency; to reuse settings, share an object:

```js
const flakyNetwork = { retries: 3, delay: 200, backoff: 2 };
Retry(fetchPrice(sku), flakyNetwork);
```

The settings are a plain object, so a test can check them without running anything. The `Retry` wraps only the Command, and the decision about its answer comes in the next step, outside the `Retry`:

```js
import { Success, Failure, Command, Retry, effectPipe } from 'pure-effect';

const fetchWeather = (city) => {
    const cmdFetchWeather = () =>
        fetch(`https://example-weather-api.com/v1/current?city=${city}`).then((r) => r.json());
    // Four calls in all, waiting 200ms, 400ms, then 800ms.
    return Retry(Command(cmdFetchWeather), { retries: 3, delay: 200, backoff: 2 });
};

const requireWeather = (data) => (data.error ? Failure(data.error) : Success(data));
const weatherFlow = (city) => effectPipe(fetchWeather, requireWeather)(city);

const weatherFn = fetchWeather('Tokyo');
assert.equal(weatherFn.type, 'Retry');
assert.equal(weatherFn.options.retries, 3);
```

**Wrap the Command that fails, not the pipeline.** Each attempt runs everything inside the `Retry` again, including Commands that already succeeded:

```js
// Dangerous: a flaky receipt step charges the customer again on every attempt.
Retry(effectPipe(chargeCard, sendReceipt)(order), { retries: 3 });

// Correct: only the step that fails transiently is retried.
effectPipe(chargeCard, (charge) => Retry(sendReceipt(charge), { retries: 3 }))(order);
```

Wrapping a pipeline is safe only when every Command in it is idempotent (safe to run more than once).

**Wrapping one Command is not always enough.** A Command's `next` is inside the `Retry` too, so a `next` that continues the flow puts everything after it inside the `Retry` as well:

```js
// Dangerous: `next` continues the booking, so every later step is inside the Retry.
Retry(
    Command(cmdHoldSeat, (seat) => chargeCard(trip, seat)),
    { retries: 2 }
);
```

If a later Command's function throws, the `Retry` holds the seat and charges the card again. With two of these nested, a failure in the last step of a booking charges the card nine times. Instead, give the retried Command its default `next` and continue in a later step, outside the `Retry`:

```js
// Safe: the tree the Retry repeats is that one Command.
effectPipe(
    () => Retry(Command(cmdHoldSeat), { retries: 2 }),
    (seat) => chargeCard(trip, seat)
);
```

When every attempt fails, `runEffect` returns a `Failure` with this error:

```text
{ retryExhausted: true, lastError: <the last error>, retries: 3 }
```

In TypeScript, a `Retry` adds `RetryExhaustedError` to the error union, beside the errors of the steps it wraps. `lastError` is typed `unknown`, since it is whatever the Command's function threw, so check it before using it, for example with `instanceof Error`.

**Use `onExhausted` to fall back when every attempt fails.** The fallback runs in place of the `Failure`. If it succeeds, its value continues down the pipeline; if it fails, its own `Failure` is returned as is. The fallback can be any Effect, such as a Command that reads a cache, or `Success(defaultValue)`:

```js
const fetchPrice = (sku) =>
    Retry(fetchLivePrice(sku), {
        retries: 3,
        onExhausted: (err) => fetchCachedPrice(sku) // err = { retryExhausted, lastError, retries }
    });
```

Every attempt and the fallback are recorded, so a replay repeats the same failures and the same fallback, without the delays. A fallback never starts in a `Parallel` branch that has already been cancelled. With `onExhausted` set, the fallback's error type takes the place of `RetryExhaustedError` in the TypeScript error union.

### Waiting as long as the server asks

`Retry` waits a fixed `delay`, so it cannot wait as long as a server names, as a rate limit's `Retry-After` does. Catch that answer inside the Command's function and return it as data, as [Which Errors Are Data](#which-errors-are-data) shows, then have `next` return a Command that waits that long, followed by the same request again. A replay answers the wait from the trace like any other Command, so it does not wait.

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

Without `settled`, one failing branch cancels the rest and becomes the result of the whole `Parallel`, so one bad record can stop a batch halfway through. With `settled: true`, every branch runs to the end, and `next` receives one `Success` or `Failure` per branch, in order. A failed record is then something you can count instead of the end of the job. In TypeScript, write `settled: true` where you call `Parallel`, or mark a shared options object `as const`. Since `settled` decides what `next` receives, a value the compiler only knows as `true` or `false` is refused.

```js
Parallel(subscriptions.map(billOne), (outcomes) => Success(outcomes.map(summarize)), { limit: 5, settled: true });
```

A `Failure` in the list holds only its error, so match outcomes to records by their position in the list. To report them, read `value` from a `Success` and `error` from a `Failure`:

```js
Parallel(work, (outcomes) => Success(outcomes.map((o) => (o.type === 'Success' ? o.value : o.error.message))), {
    settled: true
});
```

The outcomes are plain `Success` and `Failure` objects. Returning one of them from `next` is the same as returning any other `Failure`: the flow stops, and `Retry` does not run it again.

**Collecting some failures and stopping on others.** `settled` decides for every failure at once. Sometimes a batch should note a missing record and go on, but stop everything when its credentials expire. Leave `settled` off and decide in each branch: return what should be collected as a value inside a `Success`, and what should stop the batch as a `Failure`, which cancels the other branches:

```js
// A missing user is counted; an expired token stops the batch.
const fetchProfile = (userId) => {
    const cmdFetchProfile = () => api.getProfile(userId); // resolves to { status, body }
    return Command(cmdFetchProfile, (response) => {
        if (response.status === 401) return Failure('auth_expired');
        if (response.status === 404) return Success({ userId, found: false });
        return Success({ userId, found: true, profile: response.body });
    });
};

const fetchProfiles = (userIds) => Parallel(userIds.map(fetchProfile), { limit: 4 });

const profiles = fetchProfiles(['u1', 'u2']);
assert.deepEqual(profiles.effects[0].next({ status: 404 }), Success({ userId: 'u1', found: false }));
assert.deepEqual(profiles.effects[1].next({ status: 401 }), Failure('auth_expired'));
```

A Command whose function throws, such as on a network error, also stops the batch. Wrap it in `Retry` if the error is likely to pass, or catch it in the function and return it as data if it should be counted; see [Which Errors Are Data](#which-errors-are-data).

`limit` caps how many branches run at once; the rest start as others finish. Results and recorded paths stay in array order, so a limit changes only the pacing, and a trace recorded with a limit replays the same without one. A `limit` that is not a positive integer throws an `EffectTypeError` where the `Parallel` is built.

**Cancelling is a request, not a guarantee.** A cancelled branch starts no new Commands: a three-step branch whose first step is running when a sibling fails finishes that step and stops. To stop the running step itself, its function has to take the `AbortSignal` as a parameter, written without a default value, and pass it on to the I/O:

```js
// Cancellable: the request is aborted the moment a sibling branch fails.
const fetchProfile = (userId) => Command((signal) => fetch(`/users/${userId}`, { signal }).then((r) => r.json()));

// Not cancellable: this runs to completion even after a sibling fails.
const fetchProfileUncancellable = (userId) => Command(() => fetch(`/users/${userId}`).then((r) => r.json()));
```

Outside a `Parallel`, the function is called with no arguments. A `Retry` inside a cancelled branch stops retrying.

A function gets the signal only when it declares a parameter without a default value. One written as `(...args)` or `({ signal } = {})`, or wrapped by a helper that hides its parameters, gets none, so once started it runs to the end. A parameter with a default value does not count, so `Command(nanoid)`, whose size is written `size = 21`, works everywhere.

That rule catches a function passed by name whose first parameter is optional and has no default. `function listUsers(page) { page ??= 1; return db.users(page); }` gets the signal as its page inside a `Parallel`, and nothing outside one. Wrap such a function, as in `Command(() => listUsers())`. In TypeScript, a function whose first parameter cannot be an `AbortSignal` does not compile as a Command.

### Undoing what succeeded when a branch fails

Without `settled`, the failing branch's `Failure` is the whole result, and the values of the branches that succeeded are dropped. Sometimes one of them did something that has to be undone, such as charging a card for an order whose stock then ran out. The code that called `runEffect` no longer has the charge to refund. Use `settled: true`, so `next` sees every outcome, and have it return the steps that undo whatever succeeded, followed by the failure:

```js
const reserveStock = (order) => {
    const cmdReserveStock = () => inventory.reserve(order.items);
    return Command(cmdReserveStock, (r) => (r.ok ? Success(r.reservationId) : Failure('out_of_stock')));
};

const chargeOrder = (order) => {
    const cmdChargeOrder = () => payments.charge(order.customerId, order.total);
    return Command(cmdChargeOrder, (c) => (c.ok ? Success(c.chargeId) : Failure('card_declined')));
};

const releaseStock = (reservationId) => {
    const cmdReleaseStock = () => inventory.release(reservationId);
    return Command(cmdReleaseStock);
};

const refundCharge = (chargeId) => {
    const cmdRefundCharge = () => payments.refund(chargeId);
    return Command(cmdRefundCharge);
};

// Passes both results on, or undoes whichever step succeeded and then fails.
const reserveAndCharge = (order) =>
    Parallel(
        [reserveStock(order), chargeOrder(order)],
        ([reservation, charge]) => {
            if (reservation.type === 'Failure') {
                const undo = charge.type === 'Success' ? [refundCharge(charge.value)] : [];
                return Parallel(undo, () => Failure(reservation.error));
            }
            if (charge.type === 'Failure') {
                return Parallel([releaseStock(reservation.value)], () => Failure(charge.error));
            }
            return Success({ order, reservationId: reservation.value, chargeId: charge.value });
        },
        { settled: true }
    );
```

`next` is a plain function, so each case is tested by handing it the outcomes, with no I/O:

```js
const order = { id: 'order_1', customerId: 'cus_1', items: [], total: 120 };

// The card was charged, then the stock ran out: the flow refunds the charge and fails.
const undoing = reserveAndCharge(order).next([Failure('out_of_stock'), Success('ch_1')]);
assert.equal(commandName(undoing.effects[0]), 'cmdRefundCharge');
assert.deepEqual(undoing.next([null]), Failure('out_of_stock'));

// Both succeeded, so there is nothing to undo.
assert.deepEqual(
    reserveAndCharge(order).next([Success('res_1'), Success('ch_1')]),
    Success({ order, reservationId: 'res_1', chargeId: 'ch_1' })
);
```

A settled `Parallel` cancels nothing, so both steps always run to the end, and the undoing starts once both have finished. The undo steps are part of the flow, so a trace records them and a replay repeats them. An undo step that fails ends the flow with its own error rather than the original one; wrap it in `Retry` if it can fail for a moment.

Under `settled`, a branch whose Command throws reaches `next` as a `Failure`, so the undo still runs. When one call follows another instead, as a shipment follows a charge, the later Command's function has to catch its own error and return it as data: a throw stops the flow before its `next` runs, and the charge stays. [Translating `try`/`catch`](#translating-trycatch) shows that shape.

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

**Join values that depend on each other in a named step.** When step B needs step A's result and step C needs both, write a small step that runs B and passes both forward in one value. Give it a name, and the pipeline reads as a list of steps:

```js
// Fetches the order's customer and passes on both.
const withCustomer = (order) => effectPipe(fetchCustomer, (customer) => Success({ order, customer }))(order.customerId);

const applyLoyaltyDiscount = (orderId) =>
    effectPipe(fetchOrder, withCustomer, ({ order, customer }) => Success(discountedTotal(order, customer)))(orderId);
```

When the lookup is written in place rather than reused, the Command's own `next` does the join, with no pipeline inside the step: `Command(() => db.findCustomer(order.customerId), (customer) => Success({ order, customer }))`.

**Pass only what the next steps need.** Avoid one object that collects everything computed so far. When a step's input is all it gets, it cannot depend on a value from far upstream without showing it, stale fields do not linger, and two steps cannot clash over the same key. Data also lives only as long as the flow needs it, which matters for credentials and personal data. In TypeScript, it keeps the pipeline type-checked: if an upstream step changes what it returns, the step that reads the value fails to compile instead of getting `undefined` at runtime.

In a generator flow, most of this comes for free. A step that branches into another flow is yielded like any other, as in `yield* step(processOrder(order))`. Values that do not depend on each other are joined with `const [cart, user] = yield* step(Parallel([fetchCart(input.cartId), fetchUser(input.userId)]))`. Values that do are variables, with no step to pass them on together; see [Where a generator helps](#where-a-generator-helps). Keep each decision in a step function that takes only what it needs, as the advice above says for a pipeline's steps.

### Ending a flow early without an error

Not every early end is an error. A webhook that has already handled an event should answer `duplicate` and do nothing else. A pipeline stops only at a `Failure`, so the step that decides ends the flow by what it returns: a `Success` holding the result, or the rest of the flow. Make it the last step of its pipeline, since a `Success` anywhere else passes on to the next step:

```js
const requireOrderId = (event) => (event.orderId ? Success(event) : Failure('Missing order ID.'));

// The rest of the flow, for an event seen for the first time.
const markOrderPaid = (event) => {
    const cmdMarkOrderPaid = () => orderStore.markPaid(event.orderId);
    return Command(cmdMarkOrderPaid, () => Success({ status: 'processed' }));
};

// Claiming the event decides: a duplicate ends the flow here, with a result rather than an error.
const claimEvent = (event) => {
    const cmdClaimEvent = () => eventLog.claim(event.eventId);
    return Command(cmdClaimEvent, (firstTime) => (firstTime ? markOrderPaid(event) : Success({ status: 'duplicate' })));
};

const handleEvent = (event) => effectPipe(requireOrderId, claimEvent)(event);

assert.deepEqual(
    await runEffect(handleEvent({ eventId: 'evt_1', orderId: 'order_1' })),
    Success({ status: 'processed' })
);
assert.deepEqual(
    await runEffect(handleEvent({ eventId: 'evt_seen', orderId: 'order_1' })),
    Success({ status: 'duplicate' })
);
assert.deepEqual(await runEffect(handleEvent({ eventId: 'evt_2' })), Failure('Missing order ID.'));
```

When the rest of the flow is longer, the step returns it as a pipeline of its own, as `processOrder` does above. In a generator flow, `return` ends the flow anywhere, but keep the decision in a step all the same: `return yield* step(claimEvent(event))`.

## Writing Loops

A loop is written in two parts: a step that gets the list, and a `Parallel` over it, with `limit: 1` so the items run one after another, as in a `for` loop. The `async` version is usually split the same way. Paying a customer's unpaid invoices in order, and stopping at the first that fails:

```js
async function payUnpaidAsync(customerId) {
    const invoices = await billing.findUnpaid(customerId);
    for (const invoice of invoices) {
        const receipt = await payments.charge(invoice);
        await mailer.sendReceipt(receipt);
    }
}

// First part: get the list.
const findUnpaidInvoices = (customerId) => {
    const cmdFindUnpaid = () => billing.findUnpaid(customerId);
    return Command(cmdFindUnpaid);
};

// Second part: the loop's body, a flow of its own for one invoice.
const chargeInvoice = (invoice) => {
    const cmdChargeInvoice = () => payments.charge(invoice);
    return Retry(Command(cmdChargeInvoice), { retries: 3 });
};

const sendReceipt = (receipt) => {
    const cmdSendReceipt = () => mailer.sendReceipt(receipt);
    return Command(cmdSendReceipt);
};

const payInvoice = (invoice) => effectPipe(chargeInvoice, sendReceipt)(invoice);

// The loop: one body per invoice, run one at a time.
const payAll = (invoices) => Parallel(invoices.map(payInvoice), { limit: 1 });

const payUnpaid = (customerId) => effectPipe(findUnpaidInvoices, payAll)(customerId);

// The flow starts by getting the list, and hands what it gets to the loop.
const flow = payUnpaid('cus_1');
assert.equal(commandName(flow), 'cmdFindUnpaid');
assert.equal(flow.next([{ id: 1 }, { id: 2 }]).effects.length, 2);

// The body is tested on its own: the Retry holds only the charge as its effect, and its next leads to the receipt.
const body = payInvoice({ id: 1 });
assert.equal(commandName(body.effect), 'cmdChargeInvoice');
assert.equal(commandName(body.next({ id: 'receipt_1' })), 'cmdSendReceipt');

// An empty list runs nothing.
assert.deepEqual(await runEffect(payAll([])), Success([]));
```

Each invoice is paid after the one before it has finished, and the first that fails stops the rest from starting, as in the `async` version. When the payments can overlap, a higher `limit` runs several at a time.

The loop's body is a flow built for one item, so it can hold as many steps as the body of a `for` loop. Put a `Retry` inside it, on the step that needs one, since a `Retry` runs everything it wraps again (see [Retrying Transient Failures](#retrying-transient-failures)). Around the whole loop it would charge the invoices already paid. Around the whole body, a receipt that failed to send would charge the card again.

The `Parallel`'s `next` receives what each body returned, in order, so a total or a summary of the loop goes there: `Parallel(invoices.map(payInvoice), (receipts) => Success(receipts.length), { limit: 1 })`. To keep going past a failure, as a `try`/`catch` inside the loop would, add `settled: true`: every invoice is tried, and `next` receives one `Success` or `Failure` per invoice. See [Running Effects in Parallel](#running-effects-in-parallel).

In a generator flow, the same loop can be a `for` loop over the list, with the body's steps inside it:

```js
const payUnpaidGen = effectGen(function* (customerId) {
    const invoices = yield* step(findUnpaidInvoices(customerId));
    for (const invoice of invoices) yield* step(payInvoice(invoice));
});

// Every charge is declined, so both forms give up on the first invoice once its retries run out, with the same Failure.
const answers = {
    cmdFindUnpaid: { result: [{ id: 1 }, { id: 2 }] },
    cmdChargeInvoice: { error: new Error('declined') }
};
const answer = (asked) => answers[asked.name];
const fromLoop = await replayEffect(payUnpaidGen('cus_1'), answer);
const fromParallel = await replayEffect(payUnpaid('cus_1'), answer);
assert.equal(fromLoop.result.error.retryExhausted, true);
assert.deepEqual(fromLoop.result, fromParallel.result);
```

It stops at the first invoice that fails, as the `Parallel` with `limit: 1` does. Use the `Parallel` instead when payments can overlap, with a higher `limit`. Use it too when the loop has to keep going past a failure, with `settled: true`, since a `catch` in the body cannot recover. The two forms record differently, so a trace recorded from one replays against the other as a `TimeParadox`.

Sometimes getting the list is a loop of its own. Paging through an API with a cursor is one: each request needs the cursor from the page before, so the requests cannot be listed in advance. Write that loop as an ordinary `async` function, call it from one Command, and map over the list it returns, as above:

```js
async function fetchAllOrders() {
    const orders = [];
    let cursor = null;
    do {
        const page = await api.listOrders(cursor);
        orders.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return orders;
}

const listAllOrders = () => {
    const cmdListAllOrders = () => fetchAllOrders();
    return Command(cmdListAllOrders);
};
```

To the flow, the whole loop is one step. A trace records the finished list as that step's result, and a replay hands the list back without replaying the pages. A `Retry` around the Command starts again from the first page. A flow test cannot see inside it, so, like any Command's function, it is left to an integration test. This is rule 1 applied to a loop: the Command's function is the one call, `fetchAllOrders()`, and the loop lives in a function of its own that an integration test covers.

The loop belongs in the flow only when the flow has to decide something on each pass, such as stopping at the first order that matches, or saving each page as it arrives. Then the Command's `next` returns the Command for the next page instead of a `Success`, until there are no more pages.

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

The failed attempt is recorded as that Command's result, with the error's `code` and `message`, so a replay takes the same fallback branch. Copy the fields you need rather than returning the error itself: a trace keeps data, not objects, so an error stored inside a result loses its message (see [Recording in Production](#recording-in-production)).

**A `Failure` stops the flow.** It goes back to the code that called `runEffect`, which decides what it means: an HTTP status, a queue retry, an alert. Nothing inside the flow can catch a `Failure`, so a reader never has to look elsewhere for a handler.

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
    { retries: 3 }
);
```

To retry some errors and not others, do both in one function: return the errors the flow handles, and rethrow the rest so `Retry` tries again. Here a charge the gateway refuses is handled, and anything else, such as a timeout, is retried:

```js
const chargeAmount = (amount) => {
    const cmdChargeAmount = () =>
        gateway.charge(amount).catch((error) => {
            if (error.code === 'invalid_amount') return { refused: true, code: error.code };
            throw error; // may pass on a later try
        });
    return Retry(Command(cmdChargeAmount), { retries: 2 });
};

// A later step turns the handled error into the flow's outcome.
const requireCharge = (charge) => (charge.refused ? Failure(`Charge refused: ${charge.code}`) : Success(charge));
const pay = (amount) => effectPipe(chargeAmount, requireCharge)(amount);

assert.deepEqual(await runEffect(pay(0)), Failure('Charge refused: invalid_amount'));
assert.deepEqual(await runEffect(pay(25)), Success({ chargeId: 'ch_1', amount: 25 }));
```

`runEffect` tells these cases apart:

| what happened | what it is | what `Retry` does | what `onExhausted` sees | what the caller's `Failure` holds |
| --- | --- | --- | --- | --- |
| a step returned `Failure(...)`, or an `onBeforeCommand` hook threw | a stop | nothing; it propagates at once, unwrapped | nothing | the error returned or thrown |
| a Command's function threw | an I/O fault | retries it | the exhaustion, once the attempts are gone | the error thrown, or, once a `Retry` gives up, `{ retryExhausted, lastError, retries }` |
| a `next` function or a pure step threw, or the flow is malformed | a bug | nothing; it is thrown, not returned | nothing | nothing; `runEffect` rejects |

In short, **you can recover from an error your I/O produced, but you cannot catch a `Failure` a step returned.** Only the code that called `runEffect` acts on it. For the same reason, do not throw business errors from a Command's function: a throw there tells `Retry` that the I/O broke, and `Retry` will try again. A throw anywhere else in the flow is a bug, and is thrown as it is rather than returned as a `Failure`. `runEffect` rejects with it, or, from a step before the first Command, the call that builds the flow throws it.

### Translating `try`/`catch`

A `catch` around `yield*` can log and rethrow, but it cannot recover, and it sees a `FlowStopped` error rather than the original. So each `try`/`catch` in an `async` function moves to where its error happens. The four common shapes:

- **Carry on past a failed call.** Catch inside the Command's function and return the error as data, as below.
- **Undo the calls that succeeded when one running beside them fails.** Run the calls in a `Parallel` with `settled: true`, and have its `next` undo the ones that succeeded; see [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails).
- **Undo an earlier call when a later one fails.** Catch inside the later Command's function and return the error as data, and have its `next` return the Command that undoes the earlier one, as in the second example below. A later Command that throws instead stops the flow before its `next` runs, so nothing is undone.
- **Retry, then give up.** Wrap the Command in `Retry`, and put what the `catch` did after the last try in `onExhausted`; see [Retrying Transient Failures](#retrying-transient-failures).

A welcome email whose failure the flow reports but does not stop for:

```js
// Takes the mailer, so a test can hand it one that fails.
const makeSendWelcome = (mailer) => (user) => {
    const cmdSendWelcome = () =>
        mailer
            .sendWelcome(user.email)
            .then(() => ({ sent: true }))
            .catch((error) => ({ sent: false, reason: error.message }));
    return Command(cmdSendWelcome);
};

const failingMailer = {
    sendWelcome: async () => {
        throw new Error('smtp down');
    }
};
const welcome = await runEffect(makeSendWelcome(failingMailer)({ email: 'test@test.com' }));
assert.deepEqual(welcome, Success({ sent: false, reason: 'smtp down' }));
```

A reservation made after a charge, which refunds the charge when the reservation fails:

```js
const refundCharge = (charge, reason) => {
    const cmdRefundCharge = () => payments.refund(charge.chargeId);
    return Command(cmdRefundCharge, () => Failure(`Reservation failed: ${reason}`));
};

const reserveStock = (charge) => {
    const cmdReserveStock = () =>
        warehouse
            .reserve(charge.orderId)
            .then(() => ({ reserved: true }))
            .catch((error) => ({ reserved: false, reason: error.message }));
    return Command(cmdReserveStock, (reservation) =>
        reservation.reserved ? Success(charge) : refundCharge(charge, reservation.reason)
    );
};

const reservation = await runEffect(reserveStock({ orderId: 'order_1', chargeId: 'ch_1' }));
assert.deepEqual(reservation, Failure('Reservation failed: out of stock'));
```

### A malformed flow

A flow that is not made of Effects is a bug, so it throws an `EffectTypeError` that says where, rather than returning a `Failure`. The steps before a flow's first Command run as it is built. So a mistake in one of them is thrown by the call that builds the flow, as `registerUserFlow(input)` would throw if its first step returned a plain object:

```
Step 'validateRegistration' returned a plain object. Return Success, Failure, Command, Ask,
Retry, or Parallel: a plain value has to be wrapped, as in Success(value).
```

A mistake after the first Command makes `runEffect` reject. That covers a missing `return`, a `next` that returns a plain value, a step or `next` written as `async` (do the awaited work in a Command instead), and `runEffect(flow)` where `runEffect(flow(input))` was meant. The building blocks check their arguments where they are built, before their own I/O runs. Each of these throws an `EffectTypeError` there:

- `Command(db.findUser(email))`, which makes the call while the flow is built
- `Command(fn, { name })`, with the metadata in `next`'s place
- a `Parallel` or `effectPipe` given the wrong thing

One built inside a `next` is checked when that `next` runs.

## Generator Flows in Depth

What [Writing Flows as Generators](#writing-flows-as-generators) leaves out: when a body runs again, what a `catch` or `finally` in it can do, and the mistakes `effectGen` catches.

### What runs once, and what runs again

A run goes through the body once, top to bottom, as `async` code does. Running the flow again starts the body from the top, as calling an `async` function again does. Each `Retry` attempt, each run of one flow value, and each `Parallel` branch holding it gets a fresh build, so every Command in it sees the same values. A test that hands an earlier step a second answer, to walk another branch, runs the body again from the top too, feeding it the answers before that step:

```js
const flow = registerUserFlowGen(input);
assert.equal(commandName(flow), 'cmdFindUser');

// The first answer finds a user, so the flow stops there.
assert.deepEqual(flow.next({ id: 1 }), Failure('Email already in use.'));

// A second answer to the same step runs the body again from the top, and this time it goes on to save.
assert.equal(commandName(flow.next(null)), 'cmdSaveUser');
```

So keep the body to its own variables. A body run again for a walk has to ask for the same steps in the same order, and one that asks for a different one stops with an `EffectTypeError` naming both. `Date.now()`, a random ID, or a variable outside the body can change between runs. Get the first two from a Command, as a pipeline does, so a replay gets the recorded value. Pass the third in the flow's input.

### How a generator flow stops

`return` ends the flow. A plain value is its `Success`, `return Failure(error)` stops it with that error, and returning a Command or any other Effect runs it, as `return fetch(url)` does in an `async` function. A `throw` in the body is a bug, as one in a pipeline step is, and `runEffect` rejects with it.

When a step stops the flow, because its Command threw or it returned a `Failure`, the body's `catch` and `finally` blocks run, as they would for an `await` that rejected. The `catch` gets an error saying where the flow stopped, not the original, which stays the flow's `Failure`. So it cannot branch on the original's fields: `e.code` and the like are `undefined`, and `e.name` is `FlowStopped`. It can log, but it cannot recover:

```js
const unreliableDb = {
    saveUser: async () => {
        throw new Error('connection reset');
    }
};

const saveUser = effectGen(function* (user) {
    try {
        const cmdSaveUser = () => unreliableDb.saveUser(user);
        return yield* step(Command(cmdSaveUser));
    } catch (error) {
        // Runs when the save throws. It can log, and it has to let the error pass.
        throw error;
    }
});

const result = await runEffect(saveUser({ id: 1 }));
assert.equal(result.error.message, 'connection reset');
```

A `catch` that returns or carries on, one that throws a different error, and a `finally` that runs another step all stop the run with an `EffectTypeError` that says so:

```js
const saveLater = effectGen(function* (user) {
    try {
        const cmdSaveUser = () => unreliableDb.saveUser(user);
        return yield* step(Command(cmdSaveUser));
    } catch {
        return 'saved later';
    }
});

await assert.rejects(runEffect(saveLater({ id: 1 })), /kept going after Command 'cmdSaveUser' stopped it/);
```

Handle an error the flow expects inside the Command's function, and return it as data for the body to branch on; recover from one that keeps happening with `Retry`'s `onExhausted`. See [Which Errors Are Data](#which-errors-are-data). Cleanup for the whole run goes in a `try`/`finally` around `runEffect`, as it does for a pipeline.

A body's `finally` does not always run. It does not run when a bug or a `TimeParadox` rejects the run. In a `Parallel` where one branch threw, another branch that stops for its own reason before the rejection reaches it may still run its `catch` and `finally`, depending on timing.

A step in a body's `finally` is not supported. It runs when the body ends normally, and is refused when a step stopped the body. But if an error is passing through the body when its `finally` reaches a step, and the flow is cancelled before that step starts, the error is lost.

### Mistakes it catches

| Written | What happens |
| --- | --- |
| `yield step(x)`, without the star | an `EffectTypeError`: write `yield*` |
| `yield x` | an `EffectTypeError`: write `yield* step(x)` |
| `yield* x`, without `step` | the engine's `TypeError`, which on V8 becomes an `EffectTypeError` saying to write `yield* step(x)` |
| `const found = step(x)`, then `found.id` | an `EffectTypeError`: `step(...)` was used as a value |
| `[...step(x)]` or `for (const v of step(x))` | an `EffectTypeError`: `step(...)` was iterated outside `yield*` |
| `step(db.findUser(email))` | an `EffectTypeError`: put the call in a Command |
| `effectGen(async function* () {})` | an `EffectTypeError`: write `function*` |

In TypeScript, most of these do not compile; see [TypeScript](#typescript-typed-errors-and-context).

## Parallel in Depth

What [Running Effects in Parallel](#running-effects-in-parallel) leaves out: errors no branch returned, and how a cancelled `Parallel` replays.

### Errors no branch returned

A `Failure` among a settled `Parallel`'s outcomes can also hold an error the branch never returned: what one of its Commands threw, or what an `onBeforeCommand` hook vetoed it with. Neither is in the branch's declared error type. So give the code that reads the outcomes a case for an error it does not recognise, as for a run's result (see [TypeScript](#typescript-typed-errors-and-context)). Otherwise it falls into the last error it expects, and reports a vetoed charge as a declined card.

Fewer such errors reach the outcomes when a branch returns what it can as data. Catch an error the flow can handle inside the Command's function and return it (see [Which Errors Are Data](#which-errors-are-data)). To stop a batch, read the operator's switch in a Command whose `next` returns a `Failure`, rather than vetoing in `onBeforeCommand`:

```js
// Read before each charge, so a switch flipped mid-batch stops the charges that have not started.
const cmdBillingHalted = () => flags.get('billing.halted');
const billUnlessHalted = (subscription) =>
    Command(cmdBillingHalted, (halted) => (halted ? Failure('halted') : billOne(subscription)));

Parallel(subscriptions.map(billUnlessHalted), (outcomes) => Success(outcomes.map(summarize)), {
    limit: 5,
    settled: true
});
```

The halt is then one of the branch's declared errors, typed like a declined card, and the trace records each read of the switch, so the batch replays. A vetoed Command leaves no entry in the trace, so a replay of a vetoed batch fails at the first veto.

Bugs in the flow are not collected. An `EffectTypeError`, thrown for a malformed flow, and an error thrown by a `next` function or a pure step both still escape a settled `Parallel`, after the other branches are cancelled.

### Replaying a cancelled `Parallel`

Which branch failed first and cancelled the others depends on timing, so it is recorded with the trace. A replay of a cancelled `Parallel` returns the same failure production did, and stops each other branch where production stopped it, rather than letting whichever branch the replay reaches first decide. The same holds when the branch that cancelled the others was a `next` function or a pure step that threw: the replay throws the same error.

If the branch that cancelled the others no longer fails, or the `Parallel` no longer has that branch, the replay ends in a `TimeParadox` naming it. The trace also records how many branches each `Parallel` had, so a replay of one that has gained or lost a branch ends in a `TimeParadox` before any of its branches run.

A generator flow in a cancelled branch can run its `catch` and `finally` one step later in a replay than it did in production. A trace marks where a branch stopped only by its Commands. So a branch cancelled during a `Retry`'s wait, just before an `Ask`, or at a `Retry` or `Parallel` with no Command in it replays as though it stopped at its next Command.

## TypeScript: Typed Errors and Context

The bundled declarations need TypeScript 5.1 or later.

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

The annotations are optional. Without them, the union holds whatever each step can pass to `Failure`, each error kept exactly as written, whether a string or an object. A step that cannot fail, such as a Command without a `next`, adds nothing.

**The union covers only the `Failure`s your steps return.** A Command whose function throws, or that an `onBeforeCommand` hook vetoes, also ends the run with a `Failure`, and its error is not in the union. So where the result is handled, give it one fallback, such as a `default` in a `switch` over `result.error`, and treat what reaches it as a server error. The same goes for the outcomes a settled `Parallel` hands `next`. One fallback covers the whole flow: catch inside a Command's function only what the flow can handle, and let the rest throw, which is also what lets `Retry` act on it.

To check for a thrown error, copy it into a variable typed `unknown` first, as in `const error: unknown = result.error`. TypeScript refuses `instanceof Error` on an error type made only of strings, or on a flow that declares none.

To type what a Command's function returns, such as a JSON response, write the function's result type, as in `Command((): Promise<User | null> => fetchJson(url), next)`. `Command<User | null>(…)` also compiles, but with some type arguments given TypeScript infers none of the others, so that Command's errors are typed `unknown`, which hides the rest of the union.

Value types are checked through the pipeline too, so a step that reads a field the previous step does not return is a compile error. This only works while every step uses the value it receives. A step written as `() => doSomething(outer)` ignores it, and the types stop being checked at that point.

`Failure` keeps a literal exactly as written, but `Success` widens it, as TypeScript does for any object: `Success({ status: 'queued' })` holds a `status` of type `string`. A later step that tells values apart by such a field then refuses it, often several steps from where the value was built. So give the type there, as in `Success<Queued>({ status: 'queued', jobId })`.

`effectPipe` is typed for up to 20 steps. A pipeline is itself a step, so a longer one nests, which is usually easier to read anyway: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Handling every error

A `switch` over a flow's error union can make TypeScript refuse a case you forgot. Check first for a thrown error, which reaches `result.error` without being in the union, and end the `switch` with a `never`, so a case added to the union later is a compile error until it is handled. TypeScript narrows a `switch` only over a union, so with a single error type, leave out the `default`:

```ts
type BillingError = { type: 'NoSubscription' } | { type: 'CardDeclined'; code: string };

const result = await runEffect(billTenant(tenantId), context);
if (result.type === 'Failure') {
    const thrown: unknown = result.error;
    if (thrown instanceof Error) return serverError(thrown); // a Command's function threw
    switch (result.error.type) {
        case 'NoSubscription':
            return skipTenant();
        case 'CardDeclined':
            return notifyDecline(result.error.code);
        default: {
            const unhandled: never = result.error;
            return serverError(unhandled);
        }
    }
}
```

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => { ... });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

Every step's context counts, so a pipeline needs all the contexts its steps read, even when the first step reads none, and a `Parallel` needs every context its branches read. `runEffect` requires a context whenever the flow reads one, since the flow would otherwise get an empty object. It checks one passed as a variable against what the flow reads, as it checks one written in place, so a variable whose type lacks a field the flow reads does not compile. `recordEffect`, `replayEffect` and `timeTravel` check a context the same way, and `replayEffect` given a resolver requires one, since a resolver holds none.

### Generator flows

`effectGen` infers everything from the body. Each `yield*` is typed by its own step, the error union collects every step's errors and every `Failure` the body returns, and the context collects what every step reads:

```ts
const registerUser = effectGen(function* (input: { email: string }) {
    const found = yield* step(findUser(input.email)); // User | null
    if (found) return Failure('EMAIL_TAKEN');
    return yield* step(saveUser(input));
});
// (input: { email: string }) => Effect<User, 'EMAIL_TAKEN' | the errors findUser and saveUser declare>
```

`yield* x` without `step`, reading a property of a step, and an `async function*` do not compile, and a body that returns an untyped value keeps its steps' errors. Returning a step or a Promise compiles, so that a generic helper returning a value of its type parameter does too, and fails when it runs. `yield step(x)` without the star does, and fails when it runs. Name the context `Ask()` reads as `Ask<AppContext>()`. Given a function, `Ask`'s first type argument is the value instead, so annotate the parameter: `Ask((ctx: AppContext) => ...)`.

### A flow with no input

A flow takes its input as one parameter. For one that needs none, such as a nightly job that gets everything from its Commands, type the parameter `void`, so the flow is called with no argument. In a pipeline, that is the first step's parameter. Without it, `nightlyReport()` fails to compile with "Expected 1 arguments, but got 0":

```ts
const nightlyReport = effectGen(function* (_input: void) {
    const users = yield* step(listUsers());
    return users.length;
});

const result = await runEffect(nightlyReport());

// The same as a pipeline.
const nightlyCount = effectPipe(
    (_input: void) => listUsers(),
    (users) => Success(users.length)
);

const counted = await runEffect(nightlyCount());
```

### Testing a flow in TypeScript

A flow is typed as any kind of step it could start with, since validation may already have returned a `Success` or a `Failure`. So `.cmd` and `.next` compile only after the test checks that the step is a Command. `node:assert`'s `assert(step.type === 'Command')` is such a check, and TypeScript follows it. Jest's and Vitest's `expect` is not, so a walk needs a check at every step, and a small helper makes that one line per step with any test framework:

```ts
import assert from 'node:assert/strict';
import { commandName } from 'pure-effect';
import type { Effect } from 'pure-effect';

// Fails unless the step is the Command named, and returns it typed as one.
function assertCommand<T, E, C>(step: Effect<T, E, C>, name: string) {
    assert(step.type === 'Command', `expected ${name}, got ${step.type}`);
    assert.equal(commandName(step), name);
    return step;
}

const step1 = assertCommand(registerUserFlow(input), 'cmdFindUser');
assertCommand(step1.next(null), 'cmdSaveUser');
```

For a step that returns its Command directly, as in `ensureEmailAvailable(input).next(found)`, `next` is checked against what the Command's function returns. So where [Testing Without Mocks](#testing-without-mocks) passes `{ id: 1 }` for a user that was found, a TypeScript test passes a whole user, of the type `db.findUser` returns. A Command reached any other way, by walking the whole flow or through an `Ask`'s `next`, accepts any value, since its type does not say which Command it is.

## Time-Travel Debugging

Record what each Command returned, then feed those results back into the flow to retrace the path a request took, with no database or network.

Record a run with `recordEffect`, and `replayEffect` hands each Command what it returned the first time. That is how a run recorded in production replays on your machine, with nothing connected:

```js
import { recordEffect, replayEffect } from 'pure-effect';

// A real run returns its result, and a trace of what each Command returned.
const { result: live, trace } = await recordEffect(registerUserFlow(input));

// Anywhere else, with nothing connected, the same flow gets the same answers.
const { result: replayed } = await replayEffect(registerUserFlow(trace.initialInput), trace);
assert.deepEqual(replayed, live);
```

In production, record each run with a version and a flow name, and replay its trace anywhere with `timeTravel`, which narrates each step:

```js
import { recordEffect, replayEffect, timeTravel } from 'pure-effect';

// Record a real run. The context's flowName names the flow in the trace.
const { result, trace } = await recordEffect(checkoutFlow(input), {
    version: process.env.BUILD_ID,
    context: { flowName: 'checkout' }
});

// Later, somewhere else, with nothing connected:
await timeTravel(checkoutFlow, trace);
```

```
Replaying 'checkout' (3 recorded steps)
Initial input: {
  "cartId": "cart_abc123",
  "promoCode": "FREE_YEAR_VIP"
}
Step 1: cmdFetchCart returned in 41.277ms {
  "totalAmount": "120.00"
}
Step 2: cmdValidatePromo returned in 26.814ms {
  "isValid": true,
  "discountValue": 100
}
Step 3: cmdChargeCard threw in 181.507ms {
  "code": "invalid_amount",
  "name": "Error",
  "message": "Amount must be non-zero."
}
Replay finished with state: Failure
Error: {
  "code": "invalid_amount",
  "name": "Error",
  "message": "Amount must be non-zero."
}
```

A production incident becomes a regression test, with no mocks:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test checks that the flow still takes the recorded path and handles the recorded outcomes the same way. It does not check the values the flow computes, since every result comes from the recording; see [What a replay cannot check](#what-a-replay-cannot-check). If a refactor reorders or replaces a step, the replay ends in a `Failure` whose error is a `TimeParadox` naming where it diverged. It is not thrown, so a test that expects a `Failure` should check the error too, as this one checks its `code`.

A step the trace lacks ends the replay in a `Failure` holding a `ReplayError`. A trace lacks a step that comes after the end of the recording, one a hook vetoed in production, and one the recorder dropped under `maxEntries`.

A flow that stops issuing Commands before the recording ends (for example, a fix that skips the charge) produces no `TimeParadox`, and the replay can end in `Success` with recorded steps left over. `replayEffect` returns those steps as `unreached`, so a test can assert which ones it expects to skip:

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

For every other recording, `unreached` should be empty, so a fix that skips a step by accident fails the test. This works when the removed step is the last one the flow reaches. Remove a step from the middle and every later step moves to a different path, so the replay stops at a `TimeParadox`, and `unreached` lists the steps it never got to. [Proving a fix that changes the flow's shape](#proving-a-fix-that-changes-the-flows-shape) shows how to test such a fix.

A test can also run a whole flow with no recording at all, answering each Command itself; see [Testing a whole flow](#testing-a-whole-flow).

### Reading a trace

A trace is plain JSON. This one is from a checkout whose card charge timed out once and then went through:

```text
{
  "flowName": "checkout",
  "version": "b42",
  "initialInput": { "cartId": "cart_1" },
  "context": { "flowName": "checkout" },
  "dropped": 0,
  "trace": [
    { "command": "cmdFetchCart", "path": "0", "result": { "total": 120 }, "durationMs": 41.3 },
    { "command": "cmdChargeCard", "path": "1r0/0", "threw": true,
      "error": { "__error": true, "name": "Error", "message": "gateway timeout", "code": "ETIMEDOUT" }, "durationMs": 5002.1 },
    { "command": "cmdChargeCard", "path": "1r1/0", "result": { "chargeId": "ch_1" }, "durationMs": 181.5 }
  ]
}
```

`trace` holds one entry per step, in the order the steps finished; [`recorder`](#recorderoptions) lists each kind of entry. A replay matches each step by its `path`, its position in the flow, and a `TimeParadox` names the path where the flow and the trace part ways:

- A number counts the Commands, `Retry`s and `Parallel`s the flow reached, from `0`. A `Success` or an `Ask` between them adds nothing.
- `r` and a number is one attempt of the `Retry` at that position, `r0` being the first try, and `rf` is its `onExhausted` fallback.
- `p` and a number is one branch of the `Parallel` at that position, from `p0`. The `Parallel` has an entry of its own, at a path such as `2p`, which records whether a branch cancelled the others.
- `/` goes one level in. `1r1/0` is the first step of the second try of the `Retry` at position 1. `2p1/0` is the first step of the second branch of the `Parallel` at position 2.

### What a replay cannot check

A replay proves that the flow asks for the same Commands in the same order and handles the same answers. Every result comes from the recording, so it cannot check:

- **What the flow computes.** Fix how a refund amount is calculated and replay the bad run: the charge step still gets the old amount from the recording. The replay reports `Success`, returns the value from before the fix, and flags nothing. Test a value change against the pure step that computes it.
- **A fix inside a Command's function.** The function never runs, so an old trace hands the flow what it returned or threw before the fix. Catch a duplicate-key error inside the function and return it as data, and the old trace still replays the throw. Cover such a fix with an integration test.
- **The arguments a Command was called with.** A trace records results only. Given the recorded input and results, the flow does the same thing again, so replaying up to a step rebuilds its arguments for a debugger, but a test cannot assert on them. Storing them would also double what `redact` has to cover, since arguments are usually the sensitive part of a call.

When a Command's result changes shape, rename the Command. A trace matches it by name. So under the old name, an old trace hands the new code a result in the old shape, which it can take for another answer without any `TimeParadox`.

## Recording in Production

`recordEffect` suits tests and scripts, where one call covers the whole run. To record an application without changing any call site, install the hooks once at startup. The two files imported below ship in the package's `examples` folder, `node_modules/pure-effect/examples`, and in the repository's [examples folder](https://github.com/aycangulez/pure-effect/blob/main/examples); copy them into your project.

```js
import { randomUUID } from 'node:crypto';
import { configureEffect } from 'pure-effect';
import { recordingHooks } from './recording-example.js';
import { telemetryHooks } from './opentelemetry-example.js';

configureEffect(
    telemetryHooks(),
    recordingHooks({
        sink: (trace) => putObject(`traces/${trace.flowName}/${randomUUID()}.json`, JSON.stringify(trace)),
        // Attached to each trace, so timeTravel warns when it replays one against another build.
        version: process.env.BUILD_ID,
        // A replay runs validation again on the stored input, so the stand-in keeps the password rule's verdict.
        redact: (value, name, kind) =>
            kind === 'initialInput' ? { ...value, password: value.password.length >= 8 ? '[redacted]' : '' } : value,
        maxEntries: 500,
        keep: (result) => result.type === 'Failure' // the default; keep everything, or sample
    })
);
```

What the example does with each run:

- **Which runs it keeps.** `keep` decides. By default it keeps a run that ended in a `Failure`, and discards a successful one after holding it in memory.
- **When your own code throws.** A `TypeError` after an API changed the shape of its response, say, makes the run reject. `keep` is offered a `Failure` carrying the thrown error, so by default its trace is kept, and replaying it reproduces the throw. A step before the flow's first Command runs when the flow is built, outside `runEffect`, so its throw reaches no hook and is not recorded. That run did no I/O, so its input reproduces it.
- **What a trace holds.** `redact` runs before anything enters the trace, including the stored `initialInput` and `context`. A value it throws on, or one JSON cannot hold, such as a `BigInt`, is left out and marked `unrecorded`, and a replay stops there. Everything else is already in the form JSON holds, so the sink can write it to S3 or a database column with `JSON.stringify`.
- **How long a trace gets.** `maxEntries` caps it and reports the overflow as `dropped`, and a capped trace replays only up to the first step it lacks.
- **When storage fails.** If `keep` or the sink throws, for example because storage is unreachable, the run keeps its own outcome and the error goes to `onSinkError`, which defaults to `console.error`.
- **What it warns about.** The example warns through `onWarning`, once per flow, when it keeps a trace that was capped, one holding values it could not record, or one whose steps include any named `'anonymous'`.

The example takes the input from `onRun`, which is handed it only for a flow `effectPipe` or `effectGen` built, so build the outermost flow with one of them. A flow that starts with a bare `Command`, `Ask`, `Retry`, or `Parallel` records no input, and `timeTravel` would rebuild it from `undefined`. A one-step pipeline is enough, as in `runEffect(effectPipe(loadProfile)(userId))`. The example warns through `onWarning`, which defaults to `console.warn`, the first time it keeps a trace of such a flow, and `timeTravel` warns when it replays one.

The example also takes the context from the run's first Command, so a run that stops before any Command, for example at an `Ask` check, records no context. Such a run did no I/O, so running the flow again with its input and the context from your logs reproduces it.

**A trace keeps data, not objects.** A value is copied into the form JSON stores when it is recorded, and copied again each time a replay hands it to the flow. So neither a later step nor a replay can change what the trace says, and a replay from memory gets what a replay from storage gets. The copy keeps values but not classes:

| Recorded                            | Replayed as                                         |
| ----------------------------------- | --------------------------------------------------- |
| a money object or a database entity | a plain object, without its methods                 |
| a `Date`                            | a string                                            |
| a `Map` or a `Set`                  | `{}`                                                |
| a `Buffer`                          | `{ type: 'Buffer', data }`                          |
| `undefined` in an array             | `null`                                              |
| an error returned inside a result   | its own fields, such as `code`, without its message |

A reference back to an object the value is inside of, as between an HTTP client's request and response, is cut. A value JSON cannot hold at all, such as a `BigInt` or an object whose getter throws, is left out of the trace and marked `unrecorded` before `redact` sees it. So a context holding a lazy client is left out whole.

So return plain data from a Command's function. Turn a class instance into a plain object before returning it, with a small named function you can test on its own, as in `() => db.findCart(id).then(cartToData)`. Rebuild the object in `next` if the flow needs its methods. When you catch an error to return it as data, copy the fields the flow branches on, as in `.catch((error) => ({ ok: false, code: error.code }))`, rather than returning the error itself.

### Keeping secrets out of a trace

`redact` sees everything a trace stores: each result, each thrown error, the flow's input and the context, told apart by `kind`. It gets a copy in the form the trace stores, so changing it in place is safe, and what it returns is stored in that form too. A thrown `Error` arrives as a plain object holding its `name`, `message` and own fields, and any object returned for it replays as an `Error`.

Check a value before replacing a field in it, since `{ ...value, email: '[redacted]' }` turns a `null` into an object and the replay takes the other branch:

```js
// Masks a field only where there is one, so a lookup that found nothing still records null.
const mask = (value, field) =>
    value && typeof value === 'object' && field in value ? { ...value, [field]: '[redacted]' } : value;

const redact = (value, name, kind) => {
    if (kind === 'initialInput') return mask(value, 'cardNumber');
    if (kind === 'context') return mask(value, 'authToken');
    if (kind === 'error') return mask(value, 'attempted');
    return name === 'cmdFetchUser' ? mask(value, 'email') : value;
};
recorder({ redact });

assert.equal(redact(null, 'cmdFetchUser', 'result'), null); // still nothing found
assert.equal(redact('card_declined', 'cmdCharge', 'error'), 'card_declined'); // still a string
```

A replay rebuilds the flow from the redacted input and context. So a field a step checks, such as a password, needs a stand-in the check treats the same way, as the example at the top of this section does. A context field an `Ask` reads should stay.

## Hooks

Hooks see every run, and recording, replay and the telemetry example are built on them. There are three: `onRun` wraps a whole run, `onStep` wraps each Command and each `Parallel`, and `onBeforeCommand` runs before each Command and can veto it by throwing. A hook that only watches must `await` what it wraps and return its result; [`configureEffect`](#configureeffectconfigs) lists each hook's arguments.

`configureEffect` adds a layer of hooks for the whole process and returns a function that removes it. Removing a layer removes only that layer, even when others were installed after it, so a library can add and remove its own hooks without touching the application's:

```js
const remove = configureEffect(telemetryHooks(), recordingHooks({ sink }));
// the same as configureEffect(telemetryHooks()) followed by configureEffect(recordingHooks({ sink }))
remove();
```

Layers run in the order they were installed, the first outermost, so a result or a thrown error unwinds from the innermost hook out:

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

**Knowing which request a step belongs to.** `onStep` and `onRun` get no context, so a hook that logs per request finds the request the way the rest of your logging does. An `AsyncLocalStorage` scope entered around `runEffect` reaches every hook the run calls, and the recording example uses one to give each run its own recorder:

```js
import { AsyncLocalStorage } from 'node:async_hooks';

const requestScope = new AsyncLocalStorage();
const stepLog = [];

// Logs each step with its request and duration, and returns what the step returned.
const removeStepLog = configureEffect({
    onStep: async (name, type, op, path) => {
        const started = performance.now();
        try {
            return await op();
        } finally {
            const { requestId } = requestScope.getStore() ?? {};
            stepLog.push({ requestId, name, path, ms: performance.now() - started });
        }
    }
});

await requestScope.run({ requestId: 'req_1' }, () => runEffect(registerUserFlow(input)));
assert.deepEqual(
    stepLog.map((line) => [line.requestId, line.name]),
    [
        ['req_1', 'cmdFindUser'],
        ['req_1', 'cmdSaveUser']
    ]
);
removeStepLog();
```

A Command that `onBeforeCommand` vetoes never reaches `onStep`, so log a veto where you make it. In tests, call `configureEffect()` with no arguments in a `beforeEach`, so a test that fails before removing its hooks does not leave them installed for the next.

**Per-call hooks.** `runEffect`'s third argument takes hooks for that call only. They are merged with the configured ones by the same rules: the configured wrappers run outside them, and the configured `onBeforeCommand` hooks run first. `inherit: false` leaves the configured hooks out. With configured hooks `C` and a call `K` that supplies only `onStep`:

```
                  inherit: true (default)        inherit: false

onRun             C.onRun                        (none)
onBeforeCommand   C.onBeforeCommand              (none)
onStep            C.onStep( K.onStep( cmd ) )    K.onStep
```

`recordEffect` inherits, so recording inside an application that already traces still produces spans. `replayEffect` passes `inherit: false` unless `hooks: true`.

## Replay in Depth

What [Time-Travel Debugging](#time-travel-debugging) leaves out: proving a fix that changes a flow's shape, keeping a replay faithful, and replaying from storage other than a trace.

### Proving a fix that changes the flow's shape

A fix that removes or moves a step in the middle of a flow changes the path of every step after it, so its old trace stops at a `TimeParadox`. Here the incident is a checkout that tried to charge a free cart, and the fix skips the charge, so the save moves to where the charge was:

```js
const fetchCart = (cartId) => {
    const cmdFetchCart = () => carts.find(cartId);
    return Command(cmdFetchCart);
};

const chargeCart = (cart) => {
    const cmdChargeCard = () => gateway.charge(cart.total);
    return Command(cmdChargeCard, () => Success(cart));
};

const saveOrder = (cart) => {
    const cmdSaveOrder = () => orderStore.save(cart);
    return Command(cmdSaveOrder);
};

// Production ran this, and recorded the charge failing.
const checkoutBefore = (cartId) => effectPipe(fetchCart, chargeCart, saveOrder)(cartId);
const { trace: incident } = await recordEffect(checkoutBefore('cart_free'));

// The fix: no charge when there is nothing to charge.
const chargeIfDue = (cart) => (cart.total === 0 ? Success(cart) : chargeCart(cart));
const checkoutFixed = (cartId) => effectPipe(fetchCart, chargeIfDue, saveOrder)(cartId);

// Against the old trace, the fixed flow stops where the save took the charge's place.
const { result: paradox } = await replayEffect(checkoutFixed(incident.initialInput), incident);
assert.equal(paradox.error.name, 'TimeParadox');
```

Prove such a fix in three parts. Test the decision that changed, as a pure step. Then walk the fixed flow from the incident's input, handing each step the answer production got for it, for as long as the fix leaves the steps as they were:

```js
import { commandName } from 'pure-effect';

// The decision that changed: a free cart is not charged.
assert.deepEqual(chargeIfDue({ id: 'cart_free', total: 0 }), Success({ id: 'cart_free', total: 0 }));

// Given the cart production fetched, the fixed flow saves the order without charging it.
const fetchedCart = incident.trace.find((entry) => entry.command === 'cmdFetchCart').result;
const first = checkoutFixed(incident.initialInput);
assert.equal(commandName(first), 'cmdFetchCart');
assert.equal(commandName(first.next(fetchedCart)), 'cmdSaveOrder');
```

The walk takes production's answers only up to the change. Past it, each recorded answer belongs to a step that has moved, so the trace has nothing more to say about the fixed flow. Last, once the fix ships, record the incident again, so its regression test is a plain replay once more.

### Keeping a replay faithful

Put anything that varies between runs inside a Command. For replay, the current time or a random ID counts as I/O. In a Command it is recorded and replayed like any other result. A step that calls `Date.now()` directly gets a new value on every replay, and drifts from the trace.

To check a flow, record it, replay the trace, and compare the outcomes. A step that computes a fresh value shows up as a different final value, or as a `TimeParadox` if it changes which Commands run. A trace holds each result in the form JSON stores it, so this also catches a result your storage cannot keep, such as a `Date` the flow calls a method on:

```js
const { result, trace } = await recordEffect(registerUserFlow(input));
const { result: replayed } = await replayEffect(registerUserFlow(input), trace);
assert.deepEqual(replayed, result); // fails if a step computed a fresh value, or a result did not survive storage
```

A `Failure` compares the same way when the Command threw a plain `Error`. It comes back with its message, name, cause, custom properties and an `AggregateError`'s list of errors, even a `name` or `cause` set after it was created. An error of any other class, built-in ones included, comes back as a plain `Error` carrying that class's name. So `deepEqual` from `node:assert/strict` refuses the replayed `TypeError` that `fetch` rejects with when the network fails. Where a Command can throw one, compare `error.name` and `error.message` instead.

### Replaying from your own storage

`replayEffect` also accepts a resolver function instead of a trace, so you can replay from OpenTelemetry spans, a log pipeline, or a database table, not only from the JSON that `recorder` produces. Whatever you store needs each step's `path`, which `onStep` receives, and its result; the telemetry example records neither, since it keeps values off spans.

```js
// A resolver answers one question: what did production get back for this step? Look the step up by its path, its
// position in the flow. `step.index` counts steps in the order they finished, which shifts around a Parallel.
const outputs = new Map(mySpans.map((span) => [span.attributes.path, span.attributes.output]));
const resolve = (step) => (outputs.has(step.path) ? { result: outputs.get(step.path) } : undefined);
await replayEffect(checkoutFlow(input), resolve);
```

## Why Pure Effect

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, built on the same idea: record what every step returned and replay it. Those engines store the history on a server and resume workflows automatically after a crash. Pure Effect leaves storage and restarts to your application, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full ecosystem with fibers, streaming, schema validation, structured concurrency, and more, with a steep learning curve and its own vocabulary. Pure Effect takes only the idea of describing side effects as data, and does less: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers or streaming, use Effect-TS.

**vs. plain async/await with mocks:** A mock can pass every test while behaving differently from the real driver. Here, business logic never does I/O, so there is nothing to mock.

**When to use something else:** If your code does little async I/O, or testing and debugging production are not problems for you, plain async/await is simpler.

## API Reference

Every `options` argument and hook configuration below throws for a name it does not read or a value it cannot use, so a misspelt option fails instead of running with its default. `Retry` and `Parallel` throw an `EffectTypeError` where they are built.

### Building blocks

#### `Success(value)`

Returns `{ type: 'Success', value }`.

#### `Failure(error)`

Returns `{ type: 'Failure', error }`. Stops the pipeline immediately.

#### `Command(cmdFn, nextFn?, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmd`: the function, sync or async, that does the I/O. Inside a `Parallel` branch, one that declares a parameter without a default value gets an `AbortSignal` that fires when a sibling fails; see [Running Effects in Parallel](#running-effects-in-parallel).
- `next`: receives `cmd`'s result and returns the next Effect; by default `(result) => Success(result)`.
- `meta`: metadata passed to `onBeforeCommand`, with any keys your hooks need. A non-empty string `meta.name` names the Command; any other `name` is ignored, and the function's name is used.

**Every Command needs a name**, which tests, traces, replay matching and telemetry all use. It is `meta.name`, else the function's name, else `'anonymous'`:

```js
Command(cmdFn, next, { name: 'chargeCard' }); // 1. meta.name, independent of how cmdFn was written
Command(function cmdChargeCard() {
    return api.charge();
}, next); // 2. the function's own name
Command(() => api.charge(), next); // 3. neither, so 'anonymous'
```

- Use `meta.name` in code that gets minified, since a minifier renames functions and with them every step in every trace.
- Otherwise naming the function is enough. An arrow assigned to a `const` first, as in `const cmdChargeCard = () => api.charge()`, takes the `const`'s name.
- An inline arrow does not. A replay cannot tell two `'anonymous'` Commands apart, so a refactor that swaps them replays without complaint, each handed the other's recorded result.

#### `commandName(command)`

Returns a Command's name, chosen in the order above, so a test checks a step by the name its trace would record: `assert.equal(commandName(step), 'cmdFindUser')`. Anything but a Command throws an `EffectTypeError`.

#### `Ask(nextFn?)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`. With no argument, the flow gets the context itself, as `yield* step(Ask())` reads it.

#### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`. See [Retrying Transient Failures](#retrying-transient-failures).

- `options.retries`: tries after the first, a positive integer (default `3`), so `2` makes at most three calls. Anything else throws, `0` included: to handle an outcome without retrying, branch on it in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.
- `options.delay`: milliseconds before the first retry, a finite number of 0 or more (default `100`).
- `options.backoff`: the multiplier applied to the delay on each attempt, a finite number of 0 or more (default `1`, flat).
- `options.onExhausted(error)`: a fallback Effect to run when every attempt has failed, given `{ retryExhausted, lastError, retries }`. Its success feeds `next`; its failure is returned unwrapped. Per use only.
- An option set to `undefined` keeps its default.

#### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`. Runs the branches at the same time and hands `next` their values in order; by default `(values) => Success(values)`. See [Running Effects in Parallel](#running-effects-in-parallel).

- The first branch to fail cancels the others, and its `Failure` is the result, with `next` skipped. Which branch that is depends on timing, so it is recorded, and a replay returns the same one.
- Each branch's Commands get an `AbortSignal` to pass to their I/O.
- The second argument is `next` or the options, so `Parallel(effects, { limit: 5 })` works; after the options, a third argument throws, as does a fourth after `next` and the options.
- `limit`: the most branches running at once, a positive integer. Results and recorded paths stay in array order, so it changes only the pacing.
- `settled`: run every branch to the end and hand `next` one `Success` or `Failure` per branch, in array order, so no branch cancels the others or fails the `Parallel`. A bug still rejects the run: a step or `next` that throws, or returns something other than an Effect, is not a branch outcome.

### Building pipelines

#### `effectPipe(...functions)`

Composes steps into a pipeline: each step gets the previous step's `Success` value, and a `Failure` from any step stops it. A step may ignore the value it gets and close over the enclosing scope instead, which is fine in JavaScript:

```js
// The last step ignores what came before and uses the enclosing input instead.
const registerUserFlow = (input) => effectPipe(validateRegistration, () => saveUser(input))(input);
```

In TypeScript, type checking stops at that step, since a function that ignores its parameter constrains nothing before it. Passing the value through every step, as the [Quick Start](#quick-start) does, keeps the whole pipeline checked; see [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context).

In either language, a Command a step builds and does not return never runs, and any `Failure` it would have produced is lost:

```js
(value) => {
    sendWelcomeEmail(value); // built and thrown away: the email is never sent
    return Success(value);
};
```

Return the Command, and have its `next` return the value the rest of the pipeline needs.

#### `effectGen(body)`

Returns a flow function, `(input) => Effect`, from a generator function, `function* (input) { ... }`. See [Writing Flows as Generators](#writing-flows-as-generators).

- Calling it runs the body up to its first `yield*`, so a `Failure` before the first step comes back at once, as a pipeline's does.
- `return value` is `Success(value)`, `return Failure(error)` stops the flow, and a returned Effect runs.
- When a step stops the flow, the body's `catch` and `finally` blocks run; a `catch` that recovers or throws another error, or a `finally` that runs a step, rejects the run.
- An `async function*`, and a body that yields anything but `yield* step(effect)`, throws an `EffectTypeError`.

#### `step(effect)`

Wraps an Effect for `yield*` inside `effectGen`, which gives back its value: `const user = yield* step(findUser(email))`. Anything but an Effect throws an `EffectTypeError`, and so does using the result any other way than `yield*`.

### Running a flow

#### `runEffect(effect, context?, callConfig?)`

Runs a flow and resolves with its `Success` or `Failure`. See [Which Errors Are Data](#which-errors-are-data).

- `context`: what `Ask` reads, also passed to `onBeforeCommand`. `context.flowName` names the run in traces and telemetry. Anything but an object or `null` makes `runEffect` reject with a `TypeError` before the run, and the `context` option of `recordEffect`, `replayEffect` and `timeTravel` is checked the same way.
- `callConfig`: `onStep`, `onRun` and `onBeforeCommand` for this call only, added to the configured hooks, or used alone with `inherit: false`; see [Hooks](#hooks).
- A throw from a Command's function, or an `onBeforeCommand` veto, ends the run with a `Failure` holding the error thrown; under a `Retry` that gave up, it holds `{ retryExhausted, lastError, retries }`.
- A malformed flow, or a throw from a `next` or a pure step, is a bug. The call that builds the flow throws it before the first Command, and `runEffect` rejects with it after.

#### `configureEffect(...configs)`

Adds a layer of hooks for the whole process and returns a function that removes that layer only. See [Hooks](#hooks).

- Several configurations passed to one call form one layer.
- `configureEffect()` with no arguments removes every layer, and a call whose arguments are all `undefined` changes nothing.
- Throws a `TypeError`, before installing anything, for a configuration that is not an object, a key other than the three below (`retry` included), or a hook that is not a function (`null` included).
- `onRun(effect, pipeline, flowName, initialInput)`: wraps the whole run once, retries included. It must `await pipeline()` and return its result; anything but a `Success` or `Failure` rejects the run with a `TypeError`. `initialInput` is what the flow was called with when `effectPipe` or `effectGen` built it, and `undefined` otherwise; pass it on to any hook it calls.
- `onStep(name, type, op, path)`: wraps each Command, and each `Parallel` with `name` and `type` both `'Parallel'`. It must `await op()` and return its result, and pass `path` on to any hook it calls, since a replay matches steps on it.
    - For a Command, `op()` returns a promise, even for a synchronous function. Returning a value without calling `op()` answers for the Command, which is how replay works, and throwing without calling it counts as the Command failing.
    - A throw after `op()` succeeded, or `undefined` in place of its value (a forgotten `return` or `await`), is a bug in the hook: the run rejects, and `Retry` does not run the Command again.
    - For a `Parallel`, `op()` runs the branches, so a hook must call it or the run rejects with a `TypeError`. It returns which branch, if any, cancelled the others, and how many branches there were and whether it was settled, as in `{ cancelled: true, branch: 0, branches: 2, settled: false }`. A branch that threw adds `threw: true`.
- `onBeforeCommand(command, context)`: runs before each Command. A throw vetoes the Command: the run returns a `Failure` carrying the thrown error, and `Retry` does not retry it. A vetoed Command leaves no entry in a trace, so a replay of that run fails where it was vetoed; see [Errors no branch returned](#errors-no-branch-returned).

### Recording and replay

#### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`, a hook that records every step of a run, passed as `runEffect(flow, context, { onStep })`. Give each run its own recorder: one shared by a whole application mixes requests into one trace, which a replay refuses. `recordEffect` and the [recording example](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js) both do this for you.

- `onStep`: the hook. Recording never changes a run's outcome.
- `entries`: the steps recorded so far, one per Command and one per `Parallel`. A replay matches each on its `path`, the step's position in the flow.

```text
{ command, path, result, durationMs }                                    a Command that returned
{ command, path, threw: true, error, durationMs }                        a Command that threw
{ command: 'Parallel', path, result: { cancelled, branch, branches } }   which branch, if any, cancelled the others,
                                                                         and how many branches there were
{ command, path, unrecorded, durationMs }                                a Command whose result or error could not be recorded,
                                                                         because 'redact' threw on it or the 'copy' failed
```

- An older entry with `error` and no `threw` still counts as a throw.
- `toTrace(meta)`: the entries as a trace, with `meta`'s `initialInput`, `context`, `flowName` and `version`, copied into the form JSON stores when it is called. If a Command can change the input or the context, as an ORM save that adds an id does, call it before the run as well, as `recordEffect` does.
- `options.redact(value, name, kind)`: returns what the trace stores in place of `value`. `kind` is `'result'`, `'error'`, `'initialInput'` or `'context'`, and `name` is the Command's name, or the kind. See [Keeping secrets out of a trace](#keeping-secrets-out-of-a-trace).
- `options.maxEntries`: the most entries a trace keeps; the rest are counted in `dropped`, and a replay stops at the first step the trace lacks.
- `options.stack`: record stack traces for thrown errors (off by default).
- A value `redact` throws on or returns `undefined` for, or one JSON cannot hold, is left out and marked `unrecorded`: on its entry, or for the input and context in the trace's `unrecorded`, as in `{ context: 'copy' }`. A replay stops there with a `ReplayError` rather than hand the flow a stand-in. An error `redact` returns `undefined` for is recorded as a throw with nothing to show. See [Recording in Production](#recording-in-production) for what a copy keeps.

#### `recordEffect(effect, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. The trace holds the flow's input when `effectPipe` or `effectGen` built it, so `timeTravel` can build the flow again. Accepts `recorder` options plus `context` and `version`; without a `context`, the trace records the empty one the run gets, which `redact` is not handed. For tests and scripts; to record an application without changing call sites, use the wiring in [`examples/recording-example.js`](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js), which gives each run its own recorder.

#### `replayEffect(effect, traceOrResolver, options?)`

Runs a flow with each Command answered from a trace instead of run, and returns `{ result, unreached }`: the flow's outcome, and the recorded steps it never asked for. See [Time-Travel Debugging](#time-travel-debugging).

- A flow that no longer matches the trace ends in a `Failure` whose `error` is a `TimeParadox`, or a `ReplayError` for a step the trace lacks. Neither is thrown, so a test checks `error.name`.
- A malformed trace rejects with a `ReplayError`.
- `traceOrResolver`: a trace, its bare entries, or a resolver: a function that answers each step with `{ result }`, `{ error }`, or `undefined` for a step it has no record of. See [Testing a whole flow](#testing-a-whole-flow) and [Replaying from your own storage](#replaying-from-your-own-storage).
- Any other answer from a resolver, `null` included, or a throw from it, rejects the replay. With a resolver, `unreached` is absent.
- A resolver is also asked about each `Parallel`, with `step.type` set to `'Parallel'`. Answering with the recorded cancellation as `{ result }` replays it as production decided, and anything else replays it by timing.
- `options.context`: the context for `Ask`, by default the one the trace recorded. A resolver has none, so pass one if the flow reads `Ask`: a replay that reaches an `Ask` with no context, from a resolver or a trace that recorded none, stops with a `ReplayError`. A trace whose context could not be recorded refuses to replay without one.
- `options.onMissing`: `'throw'` (default) stops at a step the trace lacks; `'execute'` runs its Command for real, so use it only where Commands reach test doubles or only read.
- A trace that dropped entries refuses `'execute'`. A flow that changed shape, as when a Command is newly wrapped in `Retry` or moved into a new `Parallel` branch, stops at a `TimeParadox` even under `'execute'`.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the configured hooks, a configured recorder included, so they see the replayed steps. Off, a replay cannot reach a telemetry backend or a trace sink.
- `options.onResolved(step, outcome)`: observes each replayed step. A throw stops the replay, and `replayEffect` rejects with it; it never changes an outcome.
- A trace whose entries have no `path`, written by hand or recorded before paths existed, is matched in order, and a Command inside a `Parallel` is refused with a `ReplayError`.

#### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates each step with its recorded duration. Returns `{ result, unreached }`, as `replayEffect` does for a trace.

- Names any recorded steps that were never reached.
- Warns when the trace's `version` differs from `options.version`, and when steps are named `'anonymous'`.
- Refuses a trace whose input could not be recorded, since the flow is rebuilt from it.
- `options.context` overrides the trace's; `options.log` replaces `console.log`.

## Limitations

- **`Retry` repeats everything it wraps, including a Command's `next`.** Commands that already succeeded run again, and a retried Command whose `next` continues the flow repeats the rest of the flow with it. Wrap only the Command that fails, and continue in a later step; see [Retrying Transient Failures](#retrying-transient-failures). A function that catches its own error is never retried; see [Which Errors Are Data](#which-errors-are-data).
- **Cancelling a `Parallel` branch cannot stop a call already running.** A cancelled branch starts no new Commands, but a function that ignores its `AbortSignal`, or is never given one, runs to the end. So a branch whose _first_ Command is a write can still write after another branch has failed. `Parallel` waits for every branch before it returns; see [Running Effects in Parallel](#running-effects-in-parallel).
- **Inside a `Parallel`, a Command's function that takes a parameter gets the `AbortSignal` in it.** So `Command(listUsers)`, where `listUsers(page)` treats `page` as optional, gets the signal as its page inside a `Parallel` and nothing outside one. Wrap such a function, as in `Command(() => listUsers())`; see [Running Effects in Parallel](#running-effects-in-parallel).
- **`redact` covers a trace, not a result.** A `Failure` holds the full error, and an error can quote what a Command sent, as a database's duplicate-key error quotes the key. Keeping it out of your logs is up to you.
- **Replay checks the path, not the values.** Every result comes from the recording, so a replay cannot check a fix that changes what a flow computes. A step removed from the middle of a flow stops the replay at a `TimeParadox`; see [What a replay cannot check](#what-a-replay-cannot-check).
- **A trace keeps data, not objects.** A replayed value is what JSON stores: a class instance loses its methods, a `Date` becomes a string, and a thrown error comes back as a plain `Error`, so check `error.name` rather than `instanceof`. Return plain data from Commands; see [Recording in Production](#recording-in-production).
- **Replay reproduces what one flow saw, not timing.** A stale read replays exactly. A race between two requests does not, because a trace records one flow. Nor does a race between branches that share state: branches replay with the results they saw, not the order they ran in. A cancelled generator branch can stop one step later in a replay; see [Replaying a cancelled `Parallel`](#replaying-a-cancelled-parallel).
- **Configuration belongs to one copy of the library.** Hooks live in module state, so two copies in one process (a dual ESM and CJS setup, two versions in the dependency tree, or a worker thread) do not share them, and nothing warns you.
- **A Command needs a name that survives minification.** `meta.name` does. `cmd.name` does not, unless the minifier keeps function names.
- **A generator flow's body can run more than once,** and code in it that changes something outside it, such as a counter or a log line, does so again; see [What runs once, and what runs again](#what-runs-once-and-what-runs-again).
- **A generator body's `finally` does not always run.** It does not run when a bug or a `TimeParadox` rejects the run. Put cleanup in a `try`/`finally` around `runEffect`; see [How a generator flow stops](#how-a-generator-flow-stops).
