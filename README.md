# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![CI](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Read request values, such as the tenant, from any step with `Ask`, without passing them along
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks, with a reference integration to copy
- Zero dependencies, about 14 KB minified and gzipped
- Works in JavaScript on Node 22 or later, and in TypeScript 5.1 or later (full generics, bundled `.d.ts`)

## Table of Contents

- **Getting started:** [Installation](#installation) · [The Core](#the-core) · [Quick Start](#quick-start) · [Coming from async/await](#coming-from-asyncawait) · [Writing Flows as Generators](#writing-flows-as-generators) · [Testing Without Mocks](#testing-without-mocks) · [Rules for Writing a Flow](#rules-for-writing-a-flow)
- **Building flows:** [Passing Runtime Context](#passing-runtime-context) · [Retrying Transient Failures](#retrying-transient-failures) · [Running Effects in Parallel](#running-effects-in-parallel) · [Composing Larger Flows](#composing-larger-flows) · [Writing Loops](#writing-loops) · [Handling Failure](guides/failures.md) · [TypeScript](guides/typescript.md)
- **Recording and replay:** [Time-Travel Debugging](guides/time-travel.md) · [Recording in Production](guides/recording.md) · [Hooks](guides/hooks.md) · [Tracing with OpenTelemetry](guides/hooks.md#tracing-with-opentelemetry)
- **Reference:** [Why Pure Effect](#why-pure-effect) · [Limitations](#limitations) · [REFERENCE.md](REFERENCE.md): the API and the exact rules

The sections under Getting started are enough to write and test a flow. Come back to the rest when a flow needs it.

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

Six steps take you from a plain `async` function to a tested flow you can replay. The example registers a user.

The examples are JavaScript. For TypeScript, [TypeScript: Typed Errors and Context](guides/typescript.md#typescript-typed-errors-and-context) shows how a flow's errors and context are typed.

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

A Command can also be named where it is built, which saves the separate `const`: `Command(() => db.saveUser(input), { name: 'cmdSaveUser' })`. With a `next`, the name goes third: `Command(() => db.findUser(input.email), next, { name: 'cmdFindUser' })`.

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

After a `Retry` gives up, the `Failure` holds `{ retryExhausted, lastError, retries }`, with the last error thrown as `lastError`. When a call throws an error the flow should decide on, such as a declined card, catch it inside the Command's function and return it; [Which Errors Are Data](guides/failures.md#which-errors-are-data) shows how.

**4. Test it without mocks.** A flow is plain objects. Hand a step the answer you choose and check what it returns:

```js
// The email is taken, so the flow stops here. No database was touched.
const taken = ensureEmailAvailable({ email: 'taken@test.com', password: 'password123' }).next({ id: 1 });
assert.deepEqual(taken, Failure('Email already in use.'));
```

[Testing Without Mocks](#testing-without-mocks) shows each kind of test, and how to run a whole flow with no I/O.

**5. Run it.** `runEffect` makes the calls and returns a `Success` or a `Failure`. It is the only place a call is made, so it sits at the edge of your app. A bug in a step before the first Command throws from `registerUserFlow(input)` itself, as the flow is built, so a `try` that should catch it goes around that call too:

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

**6. Replay it.** `recordEffect` runs the flow and keeps what each Command returned. `replayEffect` runs the flow again with those answers, with no database or network:

```js
import { recordEffect, replayEffect } from 'pure-effect';

// Keeps the password out of the trace, with a stand-in that still passes validation on replay.
const redact = (value, name, kind) => (kind === 'initialInput' ? { ...value, password: '[redacted]' } : value);
const { result: live, trace } = await recordEffect(registerUserFlow(input), { redact });
const { result: replayed } = await replayEffect(registerUserFlow(trace.initialInput), trace);
assert.deepEqual(replayed, live);
```

Record runs in production, and a failure replays on your machine; [Time-Travel Debugging](guides/time-travel.md#time-travel-debugging) shows how.

That is a whole flow. [Rules for Writing a Flow](#rules-for-writing-a-flow) lists the twelve rules that cover most of what goes wrong. In TypeScript, [TypeScript: Typed Errors and Context](guides/typescript.md#typescript-typed-errors-and-context) covers typing a flow's errors and context, handling every error, and testing a flow.

## Coming from async/await

A flow does what `async`/`await` code does, as data. Instead of making a call and waiting for it, a step returns a Command: which call to make, and what to do with the answer. Each thing you would write with `async`/`await` has an equivalent.

Where the two styles differ:

| `async`/`await` | Generator flow | Pipeline |
| --- | --- | --- |
| `await db.findUser(email)` | `yield* step(findUser(email))` | `Command(cmdFindUser, next)` |
| the code after the `await` | the next `yield*` | the Command's `next` |
| an `if` on a result | a step that returns `Success` or `Failure` | a branch in `next` |
| `return value` | `return value` | `Success(value)` |
| an early `return` | `return` | a step that returns `Success`, last in its pipeline; see [Ending a flow early](#ending-a-flow-early-without-an-error) |
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

Cleanup that a `finally` would do goes outside the flow, in a `try`/`finally` around `runEffect`.

`cmdFindUser` is the named function `() => db.findUser(email)`, and `findUser` stands for a step that returns the Command, as `ensureEmailAvailable` does in the Quick Start. A `catch` around `yield*` can log and rethrow, but it cannot recover; see [Which Errors Are Data](guides/failures.md#which-errors-are-data).

One rule is behind both columns: each decision lives in a small step function that receives the answer it depends on and returns `Success` or `Failure`. JavaScript cannot stop the code between two steps from doing I/O, so keeping decisions there makes a call that does I/O stand out, lets a test call each decision directly with no mock, and lets a replay run every decision again against the recorded answers. A flow has more small functions than its `async` version for that reason. A pipeline joins the steps with `effectPipe`; a generator flow puts them in order with `yield*`. An `if` around a `yield*` works, but it can be tested only by walking the whole flow, so keep the body to putting steps in order. A `for` loop that runs a step for each item decides nothing, so it is fine.

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

A `for` loop stays a `for` loop in a generator flow, and becomes a `Parallel` over the list in a pipeline, as the table shows; [Writing Loops](#writing-loops) translates one.

## Writing Flows as Generators

A generator flow is written like `async` code, with `yield* step(...)` where `async` code writes `await`. `effectGen` turns it into the same Commands a pipeline builds, so recording, replay, `Retry`, `Parallel` and the tests in [Testing Without Mocks](#testing-without-mocks) work the same for both. The Quick Start's `registerUserFlowGen` is one. The same steps in the same order record the same paths in either form, so a trace recorded from a pipeline replays against its generator version. A loop written as a `for` loop rather than a `Parallel` records differently; see [Writing Loops](#writing-loops).

### Choosing between the two forms

Both forms build the same flow, so pick the one that reads better for the flow at hand; a codebase can mix them, and a step function works in either. A pipeline reads as a list of named steps, each showing the one value it receives. A generator reads like `async` code, and an earlier result stays in scope as a variable. Here the welcome email needs both the saved user and the workspace created for them:

```js
import { commandName } from 'pure-effect';

const onboardUser = effectGen(function* (input) {
    const user = yield* step(registerUserFlowGen(input));

    const cmdCreateWorkspace = () => db.createWorkspace(user.id);
    const workspace = yield* step(Command(cmdCreateWorkspace));

    const cmdSendWelcome = () => mailer.sendWelcome(user.email, workspace.name);
    yield* step(Command(cmdSendWelcome));

    return { user, workspace };
});

// Hand each Command the answer you choose, as Testing Without Mocks shows; nothing runs.
const user = { id: 1, ...input };
const workspace = { id: 'ws_1', name: 'Personal' };
const creating = onboardUser(input).next(null).next(user); // no user found, then the saved user
assert.equal(commandName(creating), 'cmdCreateWorkspace');
const welcoming = creating.next(workspace);
assert.equal(commandName(welcoming), 'cmdSendWelcome');

// The user saved two steps back is still in scope at the end.
assert.deepEqual(welcoming.next({ sent: true }), Success({ user, workspace }));
```

A simple rule: if a step needs a result from further back than the step before it, use a generator. You can mix the two, so the rest of the flow can stay a pipeline. As a pipeline, a named step passes the user and the workspace on together; see [Composing Larger Flows](#composing-larger-flows). In either form, keep decisions in step functions, as `registerUserFlowGen` does, so each can be tested on its own.

The body can run more than once: for each `Retry` attempt and each run, as an `async` function does when called again, and when a test walks a second branch. So keep it to its own variables, and get `Date.now()` or a random ID from a Command, so a replay gets the recorded one. [REFERENCE.md](REFERENCE.md#what-runs-once-and-what-runs-again) covers when it runs again, how a `catch` or `finally` in it behaves when a step stops the flow, and the mistakes `effectGen` catches.

A `catch` around `yield*` can log and rethrow, but it cannot recover. To handle an error, catch it inside the Command's function and return it as data, as [Which Errors Are Data](guides/failures.md#which-errors-are-data) shows.

## Testing Without Mocks

A flow is plain objects, so a test can check what it will do without running it. The tests below use `registerUserFlow` and `ensureEmailAvailable` from the [Quick Start](#quick-start).

Validation runs as soon as the flow is built, so testing it needs nothing else:

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

A walk meets a `Retry` or a `Parallel` as a step of its own. A `Retry` holds the step it repeats as `effect`, a `Parallel` holds its branches as `effects`, and the `next` of either is the rest of the flow. The walks in [Writing Loops](#writing-loops) and [Undoing what succeeded when a branch fails](guides/failures.md#undoing-what-succeeded-when-a-branch-fails) go through each.

So a flow does not always start with a Command. One that reads the context first starts with an `Ask`, whose `next` takes the context. Check each step's `type` as the walk goes, since `commandName` takes only a Command:

```js
// Reads the tenant's region from the context, then retries the lookup.
const loadPlan = (tenantId) =>
    Ask((ctx) => {
        const cmdLoadPlan = () => db.findPlan(ctx.region, tenantId);
        return Retry(Command(cmdLoadPlan), { retries: 2 });
    });

const asked = loadPlan('t_1');
assert.equal(asked.type, 'Ask');
const retried = asked.next({ region: 'eu' }); // hand the Ask a context
assert.equal(retried.type, 'Retry');
assert.equal(commandName(retried.effect), 'cmdLoadPlan'); // the Command the Retry repeats
```

A generator flow is tested the same way. Its decisions are in step functions, which get the step tests, and a walk or a whole-flow run works on `registerUserFlowGen` as it does on `registerUserFlow`. A walk straight through runs the body once, and walking a second branch runs it again.

Tests cannot see inside a Command's function without running it. If `cmdFindUser` said `db.findUser(input.name)` instead of `input.email`, every test on this page would still pass. Keep those functions to a single call, and let an integration test cover them, with the services passed in as [Passing Runtime Context](#passing-runtime-context) shows.

In TypeScript, a walk needs a check at each step that the step is a Command; [Testing a flow in TypeScript](guides/typescript.md#testing-a-flow-in-typescript) has a helper that makes that one line.

### Testing a whole flow

To run a whole flow in a test instead of walking it, `Retry` and `Parallel` included, hand `replayEffect` the answer each Command gives. Nothing is called and no retry waits. `answers` from `pure-effect/testing` builds them from a table keyed by Command name:

```js
import { replayEffect } from 'pure-effect';
import { answers, assertStep } from 'pure-effect/testing';

const answer = answers({ cmdFindUser: { result: null }, cmdSaveUser: { result: { id: 1, ...input } } });
const { result } = await replayEffect(registerUserFlow(input), answer);
assert.deepEqual(assertStep(result, 'Success').value, { id: 1, ...input });
assert.deepEqual(answer.unused(), []);
```

Each entry in the table is one of three things:

- `{ result }` for the Command to return, or `{ error }` for it to throw. The Command gets it every time it is asked.
- A list of those, handed out in turn. This is how a test reaches a `Retry`'s next attempt or its `onExhausted` fallback.
- A function that gets the step and returns `{ result }`, `{ error }`, or `undefined`. Use it for anything a table cannot say.

An answer takes the place of the Command's function, its `catch` included. For a function that catches an error and returns it, answer with what it returns, not `{ error }`. Here the Quick Start's `saveUserWithRetry` fails once, then goes through:

```js
const answer = answers({ cmdSaveUser: [{ error: new Error('connection reset') }, { result: { id: 1, ...input } }] });
const { result } = await replayEffect(saveUserWithRetry(input), answer);
assert.deepEqual(result, Success({ id: 1, ...input }));
```

`assertStep(result, 'Success')` returns the result when the run succeeded. When it failed, it throws an error that names the `Failure`, which a bare `assert.equal(result.type, 'Success')` does not.

A Command the table does not name ends the replay in a `Failure` holding a `ReplayError`. The opposite mistake is an answer the flow never asked for, and it passes silently unless the test checks. `answer.unused()` lists each one, as `'cmdSaveUser: never asked for'` or `'cmdSaveUser: 1 of 2 answers left'`, and is `[]` when the replay used the whole table. An answer left in a list usually means a planned retry never happened. An entry never asked for means the flow stopped earlier than the test expected. Check `unused()` in a test that owns its whole table: one that spreads a shared table into its own sees the shared entries its scenario never reached.

The table is copied as it is built, so a list used up in one test is whole again in the next. A replay from answers has no `unreached` in its result, since that list compares a replay with a recording.

The branches of a `Parallel` usually ask for Commands with the same name. A step carries `branches`, the branch it is in at each `Parallel`, outermost first, so a function entry can answer each branch. Branch `i` is the `i`th effect given to the `Parallel`:

```js
const zones = ['nyc-1', 'nyc-2'];
const forecasts = { 'nyc-1': [{ result: [1, 2] }], 'nyc-2': [{ error: new Error('HTTP 503') }, { result: [3] }] };
const answerByZone = answers({
    cmdLoadZones: { result: zones },
    cmdFetchForecast: (step) => forecasts[zones[step.branches[0]]].shift()
});
```

`answers` returns an ordinary `Resolver`, so a test can also write one by hand: a function that gets each step, with its `name`, `path` and `branches`, and returns `{ result }`, `{ error }`, or `undefined`. A `Parallel` asks about its own decision too, under the name `'Parallel'`. A table leaves that name out, so the branches run as written.

## Rules for Writing a Flow

Twelve rules cover most of what goes wrong. The same rules ship in the package as `RULES.md`, with an index of where each task is covered.

<!-- rules:start -->

1. **Do all I/O inside a Command, and keep its function to that one call.** Write `const cmdFindUser = () => db.findUser(email)`, then `Command(cmdFindUser)`. Never pass the call itself, as in `step(db.findUser(email))`. Tests never run the Command's function, so any other code in it goes untested. The one exception is catching an error to return it as data (rule 6); cover that with an integration test. See [Testing Without Mocks](#testing-without-mocks).
2. **Name every Command.** Use a named function, such as `const cmdFindUser = () => ...`, or name it where you build it, as in `Command(() => db.findUser(email), { name: 'cmdFindUser' })`. Traces, replay and telemetry know a Command by its name. A replay stops at a Command without one, and a minifier can strip function names. See [`Command`](REFERENCE.md#commandcmdfn-nextfn-meta).
3. **Put each decision in a step function.** A step receives one value and returns `Success`, `Failure` or the next Command. A test can call it directly, without mocks. That is why a flow has more functions than its `async` version. See [Coming from async/await](#coming-from-asyncawait).
4. **Return an outcome the caller should see as `Failure(error)`; never throw it.** A `Failure` stops the flow and is never retried. Only the code that calls `runEffect` acts on it. See [Which Errors Are Data](guides/failures.md#which-errors-are-data).
5. **A `catch` in a generator flow cannot recover.** It can only log and rethrow. It sees a `FlowStopped` error saying where the flow stopped, not the original error. To handle an error, catch it inside the Command's function and return it as data. See [How a generator flow stops](REFERENCE.md#how-a-generator-flow-stops).
6. **Let a Command's function throw only when `Retry` should try again.** An error it catches and returns is data, and `Retry` never sees it. To retry only some errors, rethrow those and return the rest. A throw also skips any undo in the Command's `next`. See [Which Errors Are Data](guides/failures.md#which-errors-are-data).
7. **Wrap only the failing Command in `Retry`, and continue in a later step.** `Retry` runs everything it wraps again, the Command's `next` included. `retries: 2` means up to three calls. `onExhausted` is where you give up. See [Retrying Transient Failures](#retrying-transient-failures).
8. **Write a loop as a `for` loop with `yield*` in a generator flow.** In a pipeline, write `Parallel(list.map(f), { limit: 1 })`. In either form, use `Parallel` with a higher `limit` to run items at the same time, or with `settled: true` to keep going past a failure. See [Writing Loops](#writing-loops).
9. **Get the time, random IDs and other values that change between runs from a Command.** A value read once per request, such as its start time, can come from the context instead, which a trace also records. A replay then gets the recorded value. A generator body can run more than once, and it sees the same value each time. See [What runs once, and what runs again](REFERENCE.md#what-runs-once-and-what-runs-again).
10. **Return plain data from Commands, and keep the context to plain values.** A trace stores JSON, so a `Date` comes back as a string. Reach a service from the Command's function, and pass the service to the function that builds the flow. See [Passing Runtime Context](#passing-runtime-context).
11. **Clean up in a `try`/`finally` around `runEffect`, not inside the flow.** See [How a generator flow stops](REFERENCE.md#how-a-generator-flow-stops).
12. **In a replay test, check the error, not only its type.** If the flow's shape changed, the replay ends in a `Failure` holding a `TimeParadox`, which names where the flow and the trace part ways. If the flow asks for a step past the end of the recording, the error is a `ReplayError`. A test that only expects a `Failure` passes by accident. See [Time-Travel Debugging](guides/time-travel.md#time-travel-debugging).

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

In a generator flow, read the context once and keep it as a variable. The steps after it then need no `Ask` of their own:

```js
import { effectGen, step } from 'pure-effect';

const findProductGen = effectGen(function* (productId) {
    const ctx = yield* step(Ask());
    const cmdFindProduct = () => db[ctx.tenant].findProduct(productId);
    const product = yield* step(Command(cmdFindProduct));
    if (!product) return Failure('Product not found.');
    return product;
});
```

Recording stores the context alongside the trace, so `Ask` replays with the values the original request saw. That makes the context a fit for a request's own time, read once in the shell, as in `{ now: Date.now() }`. Time a flow reads as it goes, such as after a slow call, comes from a Command.

Keep the context to plain values such as IDs, flags and settings. Recording copies it into every trace, so a database client or connection pool in it puts its connection string there. Reach a service from the Command's function, as `findProduct` reaches `db`. To run a flow against fakes or a test database, have the function that builds it take the services, and pass them in the test:

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

Check permissions in the flow too. Read them with `Ask` in a step that runs before the first Command that writes anything. A refused request then stops before anything is half done. A hook can also refuse a Command, but it stops the run wherever it happens; see [Hooks](guides/hooks.md#hooks).

In TypeScript, [Typed context with `Ask`](guides/typescript.md#typed-context-with-ask) shows how to type the context.

Exact rules: [the context](REFERENCE.md#the-context).

## Retrying Transient Failures

`Retry` runs part of a flow again when a Command's function throws. A `Failure` a step returned is not retried: the flow decided to stop, so the `Failure` passes on at once, unchanged. Options are given where `Retry` is used, since they describe one dependency; to reuse settings, share an object:

```js
const flakyNetwork = { retries: 3, delay: 200, backoff: 2 };
Retry(fetchPrice(sku), flakyNetwork);
```

The settings are a plain object, so a test can check them without running anything.

You don't give `Retry` a `next`. It passes on what it wraps, unchanged. Wrap only the Command, and decide what to do with its answer in the next step of the pipeline, or the next `yield*`, outside the `Retry`:

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

A `next` that only returns a value is safe inside the `Retry`, as in `Command(cmdHoldSeat, (seat) => Success({ trip, seat }))`. Running it again changes nothing. The danger is a `next` that returns more Commands.

When every attempt fails, `runEffect` returns a `Failure` with this error:

```text
{ retryExhausted: true, lastError: <the last error>, retries: 3 }
```

**Use `onExhausted` to fall back when every attempt fails.** The fallback runs in place of the `Failure`. If it succeeds, its value continues down the pipeline; if it fails, its own `Failure` is returned as is. The fallback can be any Effect, such as a Command that reads a cache, or `Success(defaultValue)`:

```js
const fetchPrice = (sku) =>
    Retry(fetchLivePrice(sku), {
        retries: 3,
        onExhausted: (err) => fetchCachedPrice(sku) // err = { retryExhausted, lastError, retries }
    });
```

`Retry` only sees an error that the Command's function throws. A function that catches an error and returns it is never retried; see [Which Errors Are Data](guides/failures.md#which-errors-are-data).

In TypeScript, each `Retry` adds `RetryExhaustedError` to the flow's error union. If you write out a flow's error type yourself, include it.

Exact rules: [`Retry`](REFERENCE.md#retryeffect-options).

### Waiting as long as the server asks

A server that limits requests often says how long to wait, as a `Retry-After` header does. Give `delay` a function in place of a number. It gets what the last attempt threw and the number of the attempt about to run, `1` for the first retry, and returns the wait in milliseconds. So have the Command's function throw an error that carries the wait:

```js
// sendWebhook throws on a 429 or a 5xx. On a 429 the error carries the wait the server asked for, as retryAfterMs.
const deliverWebhook = (event) => {
    const cmdSendWebhook = () => sendWebhook(event);
    return Retry(Command(cmdSendWebhook), {
        retries: 4,
        // Waits as long as the server asked, or else 200ms, 400ms, 800ms, then 1600ms.
        delay: (error, attempt) => error.retryAfterMs ?? 200 * 2 ** (attempt - 1)
    });
};
```

The function works out every wait, so `backoff` beside it throws. It is ordinary code, not I/O: if it throws, or returns anything but a number of 0 or more, the run rejects instead of retrying. A replay does not wait, so it does not call the function; test it on its own, as you would a step.

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
// At most 5 branches run at once, for a gateway that rate limits. A limit applies to its own Parallel only:
// 3 batches at a time, each running 5 items at a time, is up to 15 calls at once.
Parallel(subscriptions.map(billOne), { limit: 5 });

// Every branch runs to completion, and `next` receives the outcomes rather than the values.
Parallel(subscriptions.map(billOne), { limit: 5, settled: true });
```

Without `settled`, one failing branch cancels the rest and becomes the result of the whole `Parallel`, so one bad record can stop a batch halfway through. With `settled: true`, every branch runs to the end, and `next` receives one `Success` or `Failure` per branch, in order. A failed record is then something you can count instead of the end of the job. In TypeScript, write `settled` as `true` or `false`, since it changes what `next` receives; to choose at runtime, branch on the flag and write each `Parallel`.

```js
Parallel(subscriptions.map(billOne), (outcomes) => Success(outcomes.map(summarize)), { limit: 5, settled: true });
```

A `Failure` in the list holds only its error, so match outcomes to records by their position in the list. To report them, read `value` from a `Success` and `error` from a `Failure`:

```js
Parallel(work, (outcomes) => Success(outcomes.map((o) => (o.type === 'Success' ? o.value : o.error.message))), {
    settled: true
});
```

In TypeScript, each outcome is a `SuccessState<T> | FailureState<E>`. Both types are exported, for a function that reads the outcomes.

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

A Command whose function throws, such as on a network error, also stops the batch. Wrap it in `Retry` if the error is likely to pass, or catch it in the function and return it as data if it should be counted; see [Which Errors Are Data](guides/failures.md#which-errors-are-data).

**Cancelling is a request, not a guarantee.** A cancelled branch starts no new Commands: a three-step branch whose first step is running when a sibling fails finishes that step and stops. To stop the running step itself, its function has to take the `AbortSignal` as a parameter, written without a default value, and pass it on to the I/O:

```js
// Cancellable: the request is aborted the moment a sibling branch fails.
const fetchProfile = (userId) => {
    const cmdFetchProfile = (signal) => fetch(`/users/${userId}`, { signal }).then((r) => r.json());
    return Command(cmdFetchProfile);
};

// Not cancellable: this runs to completion even after a sibling fails.
const fetchProfileUncancellable = (userId) => {
    const cmdFetchProfile = () => fetch(`/users/${userId}`).then((r) => r.json());
    return Command(cmdFetchProfile);
};
```

In TypeScript, write the parameter as optional: `(signal?: AbortSignal) =>`. Outside a `Parallel`, the function is called with no signal, so a required `signal: AbortSignal` does not compile.

A function passed by name gets the signal too. Inside a `Parallel`, `Command(listUsers)` calls `listUsers(signal)`. If `listUsers(page)` treats `page` as optional, it gets the signal as its page. Wrap such a function: `Command(() => listUsers())`.

Branches built by the same function share their Commands' names. A trace tells them apart by their path, so recording and replay work. A test that answers Commands by name, though, gives every branch the same answer. To answer each branch differently, give each Command its own `meta.name`, or answer by `path`. With no `next`, `meta` can come second: `Command(cmdQuote, { name: 'cmdQuote:ups' })`.

When one branch fails after another has already done something, such as charging a card, see [Undoing what succeeded when a branch fails](guides/failures.md#undoing-what-succeeded-when-a-branch-fails).

Exact rules: [`Parallel`](REFERENCE.md#paralleleffects-next-options).

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

**Pass only what the next steps need.** Avoid one object that collects everything computed so far. When a step's input is all it gets, it cannot depend on a value from far upstream without showing it, stale fields do not linger, and two steps cannot clash over the same key. Data also lives only as long as the flow needs it, which matters for credentials and personal data. In TypeScript, it keeps the pipeline type-checked: if an upstream step changes what it returns, the step that reads the value fails to compile instead of getting `undefined` at runtime.

In a generator flow, the same three patterns read as follows. A step that branches into another flow is yielded like any other, as in `yield* step(processOrder(order))`. Values that do not depend on each other are joined with `const [cart, user] = yield* step(Parallel([fetchCart(input.cartId), fetchUser(input.userId)]))`. Values that do are variables, with no step to pass them on together; see [Choosing between the two forms](#choosing-between-the-two-forms). Keep each decision in a step function that takes only what it needs, as the advice above says for a pipeline's steps.

### Ending a flow early without an error

Not every early end is an error. A webhook that has already handled an event should answer `duplicate` and do nothing else. A pipeline stops only at a `Failure`, so the step that decides ends the flow by what it returns: a `Success` holding the result, or the rest of the flow. Make it the last step of its pipeline, since a `Success` anywhere else passes on to the next step:

```js
const requireOrderId = (event) => (event.orderId ? Success(event) : Failure('Missing order ID.'));

// The rest of the flow, for an event seen for the first time.
const markOrderPaid = (event) => {
    const cmdMarkOrderPaid = () => orderStore.markPaid(event.orderId);
    return Command(cmdMarkOrderPaid, () => Success({ status: 'processed' }));
};

// Claiming the event decides: a duplicate ends the flow here, with a result rather than an error. The claim must check
// and record the event ID in one call, such as an insert that fails on a duplicate key; with a separate check and
// write, two deliveries arriving together would both see the event as new.
const claimEvent = (event) => {
    const cmdClaimEvent = () => eventLog.claim(event.eventId);
    return Command(cmdClaimEvent, (firstTime) => (firstTime ? markOrderPaid(event) : Success({ status: 'duplicate' })));
};

const handleEvent = (event) => effectPipe(requireOrderId, claimEvent)(event);

// Validation runs as the flow is built, so a missing order ID needs no I/O at all.
assert.deepEqual(handleEvent({ eventId: 'evt_2' }), Failure('Missing order ID.'));

const claim = handleEvent({ eventId: 'evt_1', orderId: 'order_1' });
assert.equal(commandName(claim), 'cmdClaimEvent');

// Seen before: the flow ends here with a result, not an error.
assert.deepEqual(claim.next(false), Success({ status: 'duplicate' }));

// First time: the rest of the flow runs.
const marking = claim.next(true);
assert.equal(commandName(marking), 'cmdMarkOrderPaid');
assert.deepEqual(marking.next({ paid: true }), Success({ status: 'processed' }));
```

When the rest of the flow is longer, the step returns it as a pipeline of its own, as `processOrder` does above. In a generator flow, `return` ends the flow anywhere, but keep the decision in a step all the same: `return yield* step(claimEvent(event))`.

A claim like this has to be released if a later step fails. Otherwise the provider's retry is answered as `duplicate`, and the event is never processed. A flow has no `finally`, so the release goes in one of two places:

- **In the flow, for a failure the flow handles as data.** Have the `next` that returns the `Failure` release the claim first, and give a `Retry` after the claim an `onExhausted` that does the same. See [Translating `try`/`catch`](guides/failures.md#translating-trycatch).
- **In the code that calls `runEffect`, for everything else,** such as a Command that throws. That code has the event, so it can release the claim when the run fails. Release only a claim this run made, for example one recorded with the delivery's own ID, as in `eventLog.release(event.eventId, deliveryId)` that deletes the claim only when `deliveryId` made it. Otherwise a duplicate delivery that fails would release the claim of one still running.

## Writing Loops

In a generator flow, a loop is a `for` loop with `yield*`, as in `async` code. Paying a customer's unpaid invoices in order, and stopping at the first that fails:

```js
const findUnpaidInvoices = (customerId) => {
    const cmdFindUnpaid = () => billing.findUnpaid(customerId);
    return Command(cmdFindUnpaid);
};

const chargeInvoice = (invoice) => {
    const cmdChargeInvoice = () => payments.charge(invoice);
    return Retry(Command(cmdChargeInvoice), { retries: 3 });
};

const sendReceipt = (receipt) => {
    const cmdSendReceipt = () => mailer.sendReceipt(receipt);
    return Command(cmdSendReceipt);
};

const payUnpaid = effectGen(function* (customerId) {
    const invoices = yield* step(findUnpaidInvoices(customerId));
    for (const invoice of invoices) {
        const receipt = yield* step(chargeInvoice(invoice));
        yield* step(sendReceipt(receipt));
    }
    return invoices.length;
});

// Hand each step its answer; nothing runs.
const flow = payUnpaid('cus_1');
assert.equal(commandName(flow), 'cmdFindUnpaid');
const charging = flow.next([{ id: 1 }, { id: 2 }]);
assert.equal(commandName(charging.effect), 'cmdChargeInvoice'); // the Retry holds the charge as its effect
const sending = charging.next({ id: 'receipt_1' });
assert.equal(commandName(sending), 'cmdSendReceipt');
assert.equal(commandName(sending.next({ sent: true }).effect), 'cmdChargeInvoice'); // the second invoice

// An empty list runs nothing.
assert.deepEqual(payUnpaid('cus_1').next([]), Success(0));
```

Each invoice is paid after the one before it has finished, and the first that fails stops the rest, as in the `async` version.

Put a `Retry` on the step that needs one, here the charge, since a `Retry` runs everything it wraps again (see [Retrying Transient Failures](#retrying-transient-failures)). Around the whole flow, it would charge the invoices already paid. Around the charge and the receipt together, a receipt that failed to send would charge the card again.

A `Parallel` over the list does two things a `for` loop cannot. `limit: 3` runs three invoices at the same time. `settled: true` tries every invoice and returns one `Success` or `Failure` for each, which a `catch` in the loop cannot do, since it cannot recover. Build the loop's body as a flow for one item, and map the list onto it:

```js
const payInvoice = (invoice) => effectPipe(chargeInvoice, sendReceipt)(invoice);

// In a generator flow, yield the Parallel in place of the loop.
const payEveryUnpaid = effectGen(function* (customerId) {
    const invoices = yield* step(findUnpaidInvoices(customerId));
    return yield* step(Parallel(invoices.map(payInvoice), { limit: 3, settled: true }));
});

// A pipeline writes every loop this way; limit: 1 runs one invoice at a time, as the for loop does.
const payAll = (invoices) => Parallel(invoices.map(payInvoice), { limit: 1 });
const payUnpaidInOrder = (customerId) => effectPipe(findUnpaidInvoices, payAll)(customerId);

// Both hold one branch per invoice once the list arrives.
const unpaid = [{ id: 1 }, { id: 2 }];
assert.equal(payEveryUnpaid('cus_1').next(unpaid).effects.length, 2);
assert.equal(payUnpaidInOrder('cus_1').next(unpaid).effects.length, 2);
```

A `for` loop and a `Parallel` record different paths, so a trace recorded before you switch one for the other ends its replay in a `TimeParadox`; record it again. See [Reading a trace](guides/time-travel.md#reading-a-trace).

### Paging

Sometimes getting the list is a loop of its own. Paging through an API with a cursor is one: each request needs the cursor from the page before. Fetch one page per pass:

```js
const fetchOrdersPage = (cursor) => {
    const cmdListOrders = () => api.listOrders(cursor);
    return Retry(Command(cmdListOrders), { retries: 3 });
};

const listAllOrders = effectGen(function* () {
    const orders = [];
    let cursor = null;
    do {
        const page = yield* step(fetchOrdersPage(cursor));
        orders.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return orders;
});

const secondPage = listAllOrders().next({ items: [{ id: 1 }], nextCursor: 'c2' });
assert.deepEqual(secondPage.next({ items: [{ id: 2 }], nextCursor: null }), Success([{ id: 1 }, { id: 2 }]));
```

Each page is a step of its own: the trace records each page, a `Retry` repeats only the page that failed, and a test walks the pages as above. A pipeline writes this loop as a Command whose `next` returns the Command for the next page, until there are none.

Exact rules: [loops](REFERENCE.md#loops).

## Why Pure Effect

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, built on the same idea: record what every step returned and replay it. Those engines store the history on a server and resume workflows automatically after a crash. Pure Effect leaves storage and restarts to your application, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full ecosystem with fibers, streaming, schema validation, structured concurrency, and more, with a steep learning curve and its own vocabulary. Pure Effect takes only the idea of describing side effects as data, and does less: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers or streaming, use Effect-TS.

**When to use something else:** If your code does little async I/O, or testing and debugging production are not problems for you, plain async/await is simpler.

## Limitations

- **`Retry` repeats everything it wraps, including a Command's `next`.** Commands that already succeeded run again, and a retried Command whose `next` continues the flow repeats the rest of the flow with it. See [what an attempt runs again](REFERENCE.md#what-an-attempt-runs-again).
- **Cancelling a `Parallel` branch cannot stop a call already running.** A cancelled branch starts no new Commands, but a function that ignores its `AbortSignal`, or is never given one, runs to the end. See [cancellation and the signal](REFERENCE.md#cancellation-and-the-signal).
- **Inside a `Parallel`, a Command's function that takes a parameter without a default value gets the `AbortSignal` in it.** So `Command(listUsers)`, where `listUsers(page)` treats `page` as optional, gets the signal as its page inside a `Parallel` and nothing outside one. Wrap such a function, as in `Command(() => listUsers())`; see [cancellation and the signal](REFERENCE.md#cancellation-and-the-signal).
- **`redact` covers a trace, not a result.** A `Failure` holds the full error, and an error can quote what a Command sent, as a database's duplicate-key error quotes the key. Keeping it out of your logs is up to you.
- **Replay checks the path, not the values.** Every result comes from the recording, so a replay cannot check a fix that changes what a flow computes. See [What a replay cannot check](guides/time-travel.md#what-a-replay-cannot-check).
- **A trace keeps data, not objects.** A replayed value is what JSON stores: a class instance loses its methods, a `Date` becomes a string, and a thrown error comes back as a plain `Error`, so check `error.name` rather than `instanceof`. See [what a trace keeps](REFERENCE.md#what-a-trace-keeps).
- **A trace records the input as the run starts, and a step before the first Command has already run by then.** That step runs as the flow is built, so one that changes its input, as `input.count++` does, leaves the trace holding the changed input. Return a new value rather than change the one a step receives.
- **Replay reproduces what one flow saw, not timing.** See [timing](REFERENCE.md#timing).
- **Configuration and recording belong to one copy of the library.** Two copies in one process, such as two versions in the dependency tree, a linked package beside an installed one, or a worker thread, do not share hooks, and a flow built with one copy and run with another records no input, so its trace cannot be replayed. `import` and `require()` load the same copy.
