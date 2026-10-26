# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![CI](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Read request values, such as the tenant, from any step with `Ask`, without passing them along
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks, with a reference integration to copy
- Zero dependencies, about 13 KB minified and gzipped
- Works in JavaScript on Node 22 or later, and in TypeScript 5.1 or later (full generics, bundled `.d.ts`)

## Table of Contents

- **Getting started:** [Installation](#installation) · [The Core](#the-core) · [Quick Start](#quick-start) · [Coming from async/await](#coming-from-asyncawait) · [Writing Flows as Generators](#writing-flows-as-generators) · [Testing Without Mocks](#testing-without-mocks) · [Rules for Writing a Flow](#rules-for-writing-a-flow)
- **Building flows:** [Passing Runtime Context](#passing-runtime-context) · [Retrying Transient Failures](#retrying-transient-failures) · [Running Effects in Parallel](#running-effects-in-parallel) · [Composing Larger Flows](#composing-larger-flows) · [Writing Loops](#writing-loops) · [Which Errors Are Data](#which-errors-are-data) · [TypeScript](#typescript-typed-errors-and-context)
- **Recording and replay:** [Time-Travel Debugging](#time-travel-debugging) · [Recording in Production](#recording-in-production) · [Hooks](#hooks) · [Tracing with OpenTelemetry](#tracing-with-opentelemetry) · [Replay in Depth](#replay-in-depth)
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

Record runs in production, and a failure replays on your machine; [Time-Travel Debugging](#time-travel-debugging) shows how.

That is a whole flow. [Rules for Writing a Flow](#rules-for-writing-a-flow) lists the twelve rules that cover most of what goes wrong. In TypeScript, [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context) covers typing a flow's errors and context, handling every error, and testing a flow.

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

`cmdFindUser` is the named function `() => db.findUser(email)`, and `findUser` stands for a step that returns the Command, as `ensureEmailAvailable` does in the Quick Start. A `catch` around `yield*` can log and rethrow, but it cannot recover; see [Which Errors Are Data](#which-errors-are-data).

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

A `catch` around `yield*` can log and rethrow, but it cannot recover. To handle an error, catch it inside the Command's function and return it as data, as [Which Errors Are Data](#which-errors-are-data) shows.

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

A walk meets a `Retry` or a `Parallel` as a step of its own. A `Retry` holds the step it repeats as `effect`, a `Parallel` holds its branches as `effects`, and the `next` of either is the rest of the flow. The walks in [Writing Loops](#writing-loops) and [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails) go through each.

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

Each `shift()` takes an answer off its list, so a table is used up by the test that reads it: build a fresh one in each test. A replay from a resolver also has no `unreached` in its result, since that list compares a replay with a recording.

The function is also asked about each `Parallel`, under the name `'Parallel'`; answering `undefined` lets its branches run as written. A step also carries its `path`, its position in the flow, which [Reading a trace](#reading-a-trace) explains; answer by path to tell apart two Commands with the same name.

## Rules for Writing a Flow

Twelve rules cover most of what goes wrong. The same rules ship in the package as `RULES.md`, with an index of where each task is covered.

<!-- rules:start -->

1. **Do all I/O inside a Command, and keep its function to that one call.** Write `const cmdFindUser = () => db.findUser(email)`, then `Command(cmdFindUser)`. Never pass the call itself, as in `step(db.findUser(email))`. Tests never run the Command's function, so any other code in it goes untested. The one exception is catching an error to return it as data (rule 6); cover that with an integration test. See [Testing Without Mocks](#testing-without-mocks).
2. **Name every Command.** Use a named function, such as `const cmdFindUser = () => ...`, or `Command(cmd, { name: 'cmdFindUser' })`. Traces, replay and telemetry know a Command by its name. A replay stops at a Command without one, and a minifier can strip function names. See [`Command`](REFERENCE.md#commandcmdfn-nextfn-meta).
3. **Put each decision in a step function.** A step receives one value and returns `Success`, `Failure` or the next Command. A test can call it directly, without mocks. That is why a flow has more functions than its `async` version. See [Coming from async/await](#coming-from-asyncawait).
4. **Return an outcome the caller should see as `Failure(error)`; never throw it.** A `Failure` stops the flow and is never retried. Only the code that calls `runEffect` acts on it. See [Which Errors Are Data](#which-errors-are-data).
5. **A `catch` in a generator flow cannot recover.** It can only log and rethrow. It sees a `FlowStopped` error saying where the flow stopped, not the original error. To handle an error, catch it inside the Command's function and return it as data. See [How a generator flow stops](REFERENCE.md#how-a-generator-flow-stops).
6. **Let a Command's function throw only when `Retry` should try again.** An error it catches and returns is data, and `Retry` never sees it. To retry only some errors, rethrow those and return the rest. A throw also skips any undo in the Command's `next`. See [Which Errors Are Data](#which-errors-are-data).
7. **Wrap only the failing Command in `Retry`, and continue in a later step.** `Retry` runs everything it wraps again, the Command's `next` included. `retries: 2` means up to three calls. `onExhausted` is where you give up. See [Retrying Transient Failures](#retrying-transient-failures).
8. **Write a loop as a `for` loop with `yield*` in a generator flow.** In a pipeline, write `Parallel(list.map(f), { limit: 1 })`. In either form, use `Parallel` with a higher `limit` to run items at the same time, or with `settled: true` to keep going past a failure. See [Writing Loops](#writing-loops).
9. **Get the time, random IDs and other values that change between runs from a Command.** A value read once per request, such as its start time, can come from the context instead, which a trace also records. A replay then gets the recorded value. A generator body can run more than once, and it sees the same value each time. See [What runs once, and what runs again](REFERENCE.md#what-runs-once-and-what-runs-again).
10. **Return plain data from Commands, and keep the context to plain values.** A trace stores JSON, so a `Date` comes back as a string. Reach a service from the Command's function, and pass the service to the function that builds the flow. See [Passing Runtime Context](#passing-runtime-context).
11. **Clean up in a `try`/`finally` around `runEffect`, not inside the flow.** See [How a generator flow stops](REFERENCE.md#how-a-generator-flow-stops).
12. **In a replay test, check the error, not only its type.** If the flow's shape changed, the replay ends in a `Failure` holding a `TimeParadox`, which names where the flow and the trace part ways. If the flow asks for a step past the end of the recording, the error is a `ReplayError`. A test that only expects a `Failure` passes by accident. See [Time-Travel Debugging](#time-travel-debugging).

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

Check permissions in the flow too. Read them with `Ask` in a step that runs before the first Command that writes anything. A refused request then stops before anything is half done. A hook can also refuse a Command, but it stops the run wherever it happens; see [Hooks](#hooks).

In TypeScript, [Typed context with `Ask`](#typed-context-with-ask) shows how to type the context.

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

`Retry` only sees an error that the Command's function throws. A function that catches an error and returns it is never retried; see [Which Errors Are Data](#which-errors-are-data).

In TypeScript, each `Retry` adds `RetryExhaustedError` to the flow's error union. If you write out a flow's error type yourself, include it.

Exact rules: [`Retry`](REFERENCE.md#retryeffect-options).

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

A Command whose function throws, such as on a network error, also stops the batch. Wrap it in `Retry` if the error is likely to pass, or catch it in the function and return it as data if it should be counted; see [Which Errors Are Data](#which-errors-are-data).

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

Exact rules: [`Parallel`](REFERENCE.md#paralleleffects-next-options).

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

// Each undo step checks its answer, so an undo that did not happen is a Failure, not lost.
const releaseStock = (reservationId) => {
    const cmdReleaseStock = () => inventory.release(reservationId);
    return Command(cmdReleaseStock, (r) => (r.released ? Success(reservationId) : Failure('release_failed')));
};

const refundCharge = (chargeId) => {
    const cmdRefundCharge = () => payments.refund(chargeId);
    return Command(cmdRefundCharge, (r) => (r.refunded ? Success(chargeId) : Failure('refund_failed')));
};

// Runs every undo, then fails with the original error and any undo that failed.
const undoAll = (undos, error) =>
    Parallel(
        undos,
        (outcomes) => {
            const undoFailed = outcomes.filter((o) => o.type === 'Failure').map((o) => o.error);
            return Failure(undoFailed.length > 0 ? { error, undoFailed } : error);
        },
        { settled: true }
    );

// Passes both results on, or undoes whichever step succeeded and then fails.
const reserveAndCharge = (order) =>
    Parallel(
        [reserveStock(order), chargeOrder(order)],
        ([reservation, charge]) => {
            if (reservation.type === 'Failure') {
                return charge.type === 'Success'
                    ? undoAll([refundCharge(charge.value)], reservation.error)
                    : reservation;
            }
            if (charge.type === 'Failure') return undoAll([releaseStock(reservation.value)], charge.error);
            return Success({ order, reservationId: reservation.value, chargeId: charge.value });
        },
        { settled: true }
    );
```

`undoAll` takes any number of undo steps and runs them as a settled `Parallel`, so an undo that fails cancels none of the others. Without `settled`, it would cancel the rest and replace the original error. Add `limit: 1` to run them one at a time, in the order listed.

`next` is a plain function, so each case is tested by handing it the outcomes, with no I/O:

```js
const order = { id: 'order_1', customerId: 'cus_1', items: [], total: 120 };

// The card was charged, then the stock ran out: the flow refunds the charge and fails.
const undoing = reserveAndCharge(order).next([Failure('out_of_stock'), Success('ch_1')]);
assert.equal(commandName(undoing.effects[0]), 'cmdRefundCharge');
assert.deepEqual(
    undoing.next([Failure('refund_failed')]),
    Failure({ error: 'out_of_stock', undoFailed: ['refund_failed'] })
);

// Both succeeded, so there is nothing to undo.
assert.deepEqual(
    reserveAndCharge(order).next([Success('res_1'), Success('ch_1')]),
    Success({ order, reservationId: 'res_1', chargeId: 'ch_1' })
);
```

Exact rules: [undoing under `settled`](REFERENCE.md#undoing-under-settled).

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

- **In the flow, for a failure the flow handles as data.** Have the `next` that returns the `Failure` release the claim first, and give a `Retry` after the claim an `onExhausted` that does the same. See [Translating `try`/`catch`](#translating-trycatch).
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

A `for` loop and a `Parallel` record different paths, so a trace recorded before you switch one for the other ends its replay in a `TimeParadox`; record it again. See [Reading a trace](#reading-a-trace).

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

The failed attempt is recorded as that Command's result, with the error's `code` and `message`, so a replay takes the same fallback branch. Copy the fields you need rather than returning the error itself: a trace keeps data, not objects, so an error stored inside a result loses its message (see [What a trace keeps](REFERENCE.md#what-a-trace-keeps)).

A thrown error loses its class in a replay. It comes back as a plain `Error` that keeps its `name`. So wherever you check a thrown error, such as in `onExhausted` or in the run's result, check its `name` or `code`, not `instanceof`.

**A `Failure` stops the flow.** It goes back to the code that called `runEffect`, which decides what it means: an HTTP status, a queue retry, an alert. Nothing inside the flow can catch a `Failure`, so a reader never has to look elsewhere for a handler.

Rule of thumb: if you would handle it, return it as a value; if you would only report it, return a `Failure`. The one exception is retry exhaustion, which happens inside `Retry`; handle it with the `onExhausted` option in [Retrying Transient Failures](#retrying-transient-failures).

**Catch or retry, not both.** `Retry` only reacts to a function that throws. If you catch a 503 inside the function and return it as a value, then wrap the step in `Retry`, it makes one call and never retries. Catch the error when the flow should handle it as data, as `fetchPrice` above does; let it throw when `Retry` should try again:

```js
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

A throw anywhere else in the flow is a bug: `runEffect` rejects with it, or, from a step before the first Command, the call that builds the flow throws it. Nor does a Command's function return `Failure(...)`: whatever it returns is its result, so a returned `Failure` reaches `next` as a value and the flow keeps going. Return the data and let a step decide, as `requireCharge` does above.

Exact rules: [a malformed flow](REFERENCE.md#a-malformed-flow).

### Translating `try`/`catch`

A `catch` around `yield*` can log and rethrow, but it cannot recover, and it sees a `FlowStopped` error rather than the original. So each `try`/`catch` in an `async` function moves to where its error happens. The four common shapes:

- **Carry on past a failed call.** Catch inside the Command's function and return the error as data, as below.
- **Undo the calls that succeeded when one running beside them fails.** Run the calls in a `Parallel` with `settled: true`, and have its `next` undo the ones that succeeded; see [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails).
- **Undo an earlier call when a later one fails.** Catch inside the later Command's function and return the error as data, and have its `next` return the Command that undoes the earlier one, as in the second example below. A later Command that throws instead stops the flow before its `next` runs, so nothing is undone. A `Retry` that gives up never reaches the Command's `next` either. So when the later Command is under `Retry`, give it no `next`, have `onExhausted` return the failure as data, and decide in the step after the `Retry`. Every failure then reaches one place that undoes, as in the third example below.
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
    return Command(cmdRefundCharge, (r) => {
        const error = `Reservation failed: ${reason}`;
        return Failure(r.refunded ? error : { error, undoFailed: ['refund_failed'] });
    });
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

A courier booked after the charge, under `Retry`. Giving up answers like a refusal, so one step decides both, and refunds the charge with the `refundCharge` above:

```js
const bookCourier = (charge) => {
    const cmdBookCourier = () => courier.book(charge.orderId); // { ok: false } for a refusal; throws on a timeout
    return Retry(Command(cmdBookCourier), { onExhausted: () => Success({ ok: false, reason: 'courier unavailable' }) });
};

const confirmBooking = (charge, booking) => (booking.ok ? Success(booking) : refundCharge(charge, booking.reason));

assert.equal(commandName(confirmBooking({ chargeId: 'ch_1' }, { ok: false, reason: 'no slots' })), 'cmdRefundCharge');
```

In a generator flow, the body only puts them in order: `const booking = yield* step(bookCourier(charge))`, then `yield* step(confirmBooking(charge, booking))`. When several earlier calls need undoing, hand the deciding step their undo steps, latest first, and have it return `undoAll` with them, as in [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails).

## TypeScript: Typed Errors and Context

The bundled declarations need TypeScript 5.1 or later.

### Error union across pipeline steps

Each step in `effectPipe` carries its own error type. The compiler collects them into a union automatically:

```ts
type ValidationError = 'invalid_email' | 'weak_password';
type ApiError = 'network_timeout' | 'rate_limited';

const validate = (input: { email: string }): Effect<{ email: string }, ValidationError> =>
    input.email.includes('@') ? Success(input) : Failure('invalid_email');
const submit = (input: { email: string }): Effect<{ id: number }, ApiError> => submitSignup(input);

const result = await runEffect(effectPipe(validate, submit)({ email: 'user@example.com' }));
if (result.type === 'Failure') {
    result.error; // 'invalid_email' | 'weak_password' | 'network_timeout' | 'rate_limited'
}
```

The annotations are optional. Without them, the union holds whatever each step can pass to `Failure`, each error kept exactly as written, whether a string or an object, so `Failure('invalid_email')` needs no `as const`, and errors of different shapes join into one union with no type argument. A step that cannot fail, such as a Command without a `next`, adds nothing.

If you do annotate a step, give the error type too. `Effect<User>` leaves the error as `unknown`, and `unknown` swallows the rest of the union, so the whole flow's error becomes `unknown`. That holds for a step written inline too, as in `(outcomes): Effect<Outcome> => ...`. For a step that cannot fail, write `Effect<Outcome, never>`. TypeScript also treats an annotated step as able to return any kind of Effect, so code that calls it directly checks `result.type === 'Failure'` before reading `result.error`; an `else` after a check for `'Success'` is not enough.

Annotating also makes hovers and error messages easier to read. Without it, they list every `Failure(...)` the flow can return. With it, they show the type you named, as `validate` and `submit` do above.

**A result's error also holds `Error`, for what a Command's function threw.** A Command whose function throws, or that an `onBeforeCommand` hook vetoes, ends the run with a `Failure` holding what was thrown, so `result.error` is typed as your steps' union plus `Error`, and so is each outcome a settled `Parallel` hands `next`. Check for it first with `result.error instanceof Error` and treat it as a server error; what remains is the union your steps declare, and TypeScript refuses to read a field of it until the check is there. One check covers the whole flow: catch inside a Command's function only what the flow can handle, and let the rest throw, which is also what lets `Retry` act on it.

Value types are checked through the pipeline too, so a step that reads a field the previous step does not return is a compile error. This only works while every step uses the value it receives. A step written as `() => doSomething(outer)` ignores it, and the types stop being checked at that point.

Exact rules: [TypeScript](REFERENCE.md#typescript).

### Handling every error

A `switch` over a flow's error union can make TypeScript refuse a case you forgot. Check first for a thrown error with `instanceof Error`, and end the `switch` with a `never`, so a case added to the union later is a compile error until it is handled. TypeScript narrows a `switch` only over a union, so with a single error type, leave out the `default` and its `never`; the check for a thrown error stays the fallback:

```ts
type BillingError = { type: 'NoSubscription' } | { type: 'CardDeclined'; code: string };

async function billAndReport(tenantId: string) {
    const result = await runEffect(billTenant(tenantId));
    if (result.type === 'Success') return billed(result.value);
    if (result.error instanceof Error) return serverError(result.error); // a Command's function threw
    if ('retryExhausted' in result.error) return retryLater(result.error.retries); // the charge kept failing
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

`billTenant` retries its charge, so its union also holds `RetryExhaustedError`, for a call that kept failing until the `Retry` gave up; its `retryExhausted` field tells it apart. When the union also holds strings, check `typeof result.error === 'object'` before the `in`, which TypeScript accepts only on an object.

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => {
        const cmdFindProduct = () => catalog.find(ctx.tenant, productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('not_found')));
    });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

Given a function, `Ask`'s first type argument is the value, not the context, so `Ask<AppContext>((ctx) => ...)` leaves `ctx` typed `unknown`. Give all three, as above, or annotate the parameter, `Ask((ctx: AppContext) => ...)`, and let the rest be inferred.

Exact rules: [context in TypeScript](REFERENCE.md#context).

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

Exact rules: [generator flows in TypeScript](REFERENCE.md#generator-flows).

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

A flow is typed as any kind of step it could start with, since validation may already have returned a `Success` or a `Failure`. So `.cmd` and `.next` compile only after the test checks that the step is a Command. `node:assert`'s `assert(step.type === 'Command')` is such a check, and TypeScript follows it. Jest's and Vitest's `expect` is not, so a walk needs a check at every step, and two small helpers make that one line per step with any test framework. `assertStep` checks the kind of step, and `assertCommand` checks a Command's name too:

```ts
import assert from 'node:assert/strict';
import { commandName } from 'pure-effect';
import type { Effect } from 'pure-effect';

// Fails unless the step is of the kind given, and returns it typed as one. It takes undefined for a Parallel's branch read by index.
function assertStep<T, E, C, K extends Effect<T, E, C>['type']>(step: Effect<T, E, C> | undefined, type: K) {
    assert(step?.type === type, `expected a ${type}, got ${step?.type}`);
    return step as Extract<Effect<T, E, C>, { type: K }>;
}

// Fails unless the step is the Command named, and returns it typed as one.
function assertCommand<T, E, C>(step: Effect<T, E, C> | undefined, name: string) {
    const command = assertStep(step, 'Command');
    assert.equal(commandName(command), name);
    return command;
}

const step1 = assertCommand(registerUserFlow(input), 'cmdFindUser');
assertCommand(step1.next(null), 'cmdSaveUser');

// A Retry holds its Command as effect, and the step after it is the Retry's next, not the Command's.
const retry = assertStep(saveUserWithRetry(input), 'Retry');
assertCommand(retry.effect, 'cmdSaveUser');
assertStep(retry.next({ id: 1 }), 'Success');
```

Exact rules: [walking a flow in a test](REFERENCE.md#walking-a-flow-in-a-test).

### Replaying in TypeScript

A replay test needs three things the types leave to you: a table of answers, the input of a trace read back from storage, and the error a replay stops with.

```ts
import assert from 'node:assert/strict';
import { replayEffect } from 'pure-effect';
import type { ReplayFault, ReplayOutcome, Resolver, TraceLog } from 'pure-effect';

type Signup = { email: string; password: string };

// Answers by Command name, handed out in turn. Typed as ReplayOutcome lists, the table needs no cast.
const answers: Record<string, ReplayOutcome[]> = {
    cmdFindUser: [{ result: null }],
    cmdSaveUser: [{ result: { id: 1, email: 'ada@example.com' } }]
};
const inTurn: Resolver = (asked) => answers[asked.name]?.shift();
const answered = await replayEffect(registerUserFlow({ email: 'ada@example.com', password: 'password123' }), inTurn);
assert.equal(answered.result.type, 'Success');

// A stored trace's input is whatever type you give it, and a trace can hold none.
const stored: TraceLog<Signup> = JSON.parse(await readTrace('incident-8f3a'));
if (stored.initialInput === undefined) throw new Error('the trace holds no input to rebuild the flow from');
const { result } = await replayEffect(registerUserFlow(stored.initialInput), stored);

// A replay that stops ends in a Failure holding a TimeParadox or a ReplayError, each an Error: check its name, then cast.
const stopped = result.type === 'Failure' && result.error instanceof Error ? result.error : undefined;
if (stopped && (stopped.name === 'TimeParadox' || stopped.name === 'ReplayError')) {
    const fault = stopped as ReplayFault;
    assert.fail(`the replay stopped at ${fault.path}: ${fault.message}`);
}
```

Exact rules: [`replayEffect`](REFERENCE.md#replayeffecteffect-traceorresolver-options).

## Time-Travel Debugging

Record what each Command returned, then feed those results back into the flow to retrace the path a request took, with no database or network.

Record a run with `recordEffect`, and `replayEffect` hands each Command what it returned the first time. A production run replays the same way, from the trace the [flight recorder](#recording-in-production) keeps, with nothing connected:

```js
import { recordEffect, replayEffect } from 'pure-effect';

// A real run returns its result, and a trace of what each Command returned.
const { result: live, trace } = await recordEffect(registerUserFlow(input));

// Anywhere else, with nothing connected, the same flow gets the same answers.
const { result: replayed } = await replayEffect(registerUserFlow(trace.initialInput), trace);
assert.deepEqual(replayed, live); // holds while results are plain data and errors plain Errors; see Keeping a replay faithful
```

Record each run with a version and a flow name, and replay its trace anywhere with `timeTravel`, which narrates each step. Here `recordEffect` records one run; to record every run of an application, use the flight recorder, in [Recording in Production](#recording-in-production):

```js
import { recordEffect, replayEffect, timeTravel } from 'pure-effect';

// Record a real run. flowName names the flow in the trace.
const { result, trace } = await recordEffect(checkoutFlow(input), {
    version: process.env.BUILD_ID,
    flowName: 'checkout'
});

// Later, somewhere else, with nothing connected. Given the build, timeTravel warns when the trace came from another one.
await timeTravel(checkoutFlow, trace, { version: process.env.BUILD_ID });
```

```
Replaying 'checkout': 3 recorded steps
Initial input: {
  "cartId": "cart_abc123",
  "promoCode": "FREE_YEAR_VIP"
}
├─ cmdFetchCart returned in 41.3ms {"totalAmount":"120.00"}
├─ cmdValidatePromo returned in 26.8ms {"isValid":true,"discountValue":100}
└─ cmdChargeCard threw in 181.5ms {"code":"invalid_amount","name":"Error","message":"Amount must be non-zero."}
Replay finished with state: Failure
Error: {
  "code": "invalid_amount",
  "name": "Error",
  "message": "Amount must be non-zero."
}
```

`timeTravel` takes the function that builds the flow, not the flow itself, and calls it with the recorded input. If that function also needs services, pass one that takes only the input, as in `timeTravel((input) => makeCheckout(services)(input), trace)`.

A production incident becomes a regression test, with no mocks:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test checks that the flow still takes the recorded path and handles the recorded outcomes the same way. It does not check the values the flow computes, since every result comes from the recording; see [What a replay cannot check](#what-a-replay-cannot-check). If a refactor reorders or replaces a step, the replay ends in a `Failure` whose error is a `TimeParadox` naming where it diverged. It is not thrown, so a test that expects a `Failure` should check the error too, as this one checks its `code`.

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

For every other recording, `unreached` should be empty, so a fix that skips a step by accident fails the test. A fix that removes or moves a step in the middle of the flow shifts every later step's path, so the old trace no longer replays as it is; [Proving a fix that changes the flow's shape](#proving-a-fix-that-changes-the-flows-shape) shows how to test it.

A test can also run a whole flow with no recording at all, answering each Command itself; see [Testing a whole flow](#testing-a-whole-flow).

Exact rules: [`replayEffect`](REFERENCE.md#replayeffecteffect-traceorresolver-options).

### Reading a trace

A trace is plain JSON. This one is from a checkout whose card charge timed out once and then went through:

```text
{
  "flowName": "checkout",
  "version": "b42",
  "initialInput": { "cartId": "cart_1" },
  "context": {},
  "dropped": 0,
  "trace": [
    { "command": "cmdFetchCart", "path": "0", "result": { "total": 120 }, "durationMs": 41.3 },
    { "command": "cmdChargeCard", "path": "1r0/0", "threw": true,
      "error": { "__error": true, "name": "Error", "message": "gateway timeout", "code": "ETIMEDOUT" }, "durationMs": 5002.1 },
    { "command": "cmdChargeCard", "path": "1r1/0", "result": { "chargeId": "ch_1" }, "durationMs": 181.5 }
  ]
}
```

`trace` holds one entry per step, in the order the steps finished; [`recorder`](REFERENCE.md#recorderoptions) lists each kind of entry. A replay matches each step by its `path`, its position in the flow, and a `TimeParadox` names the path where the flow and the trace part ways:

- A number counts the Commands, `Retry`s and `Parallel`s the flow reached, from `0`. A `Success` or an `Ask` between them adds nothing.
- `r` and a number is one attempt of the `Retry` at that position, `r0` being the first try, and `rf` is its `onExhausted` fallback.
- `p` and a number is one branch of the `Parallel` at that position, from `p0`. The `Parallel` has an entry of its own, at a path such as `2p`, which records whether a branch cancelled the others.
- `/` goes one level in. `1r1/0` is the first step of the second try of the `Retry` at position 1. `2p1/0` is the first step of the second branch of the `Parallel` at position 2.

### What a replay cannot check

A replay proves that the flow asks for the same Commands in the same order and handles the same answers. Every result comes from the recording, so it cannot check:

- **What the flow computes.** Fix how a refund amount is calculated and replay the bad run: the charge step still gets the old amount from the recording. The replay reports `Success`, returns the value from before the fix, and flags nothing. Test a value change against the pure step that computes it.
- **A fix inside a Command's function.** The function never runs, so an old trace hands the flow what it returned or threw before the fix. Catch a duplicate-key error inside the function and return it as data, and the old trace still replays the throw. Cover such a fix with an integration test.
- **The arguments a Command was called with.** A trace records results only. Given the recorded input and results, the flow does the same thing again, so replaying up to a step rebuilds its arguments for a debugger, but a test cannot assert on them. Storing them would also double what `redact` has to cover, since arguments are usually the sensitive part of a call.
- **A step a hook vetoed.** A veto leaves no entry in the trace, so the replay stops at that step with a `ReplayError`.
- **A field `redact` replaced, if a step checks it.** The replay rebuilds the flow from the redacted input, so the check can decide differently. See [Keeping secrets out of a trace](#keeping-secrets-out-of-a-trace).

When a Command's result changes shape, rename the Command. A trace matches it by name. So under the old name, an old trace hands the new code a result in the old shape, which it can take for another answer without any `TimeParadox`.

## Recording in Production

Pick the recording function by the job:

- One run, in a test or a script: `recordEffect`.
- Every run of an application: `enableRecording`, from `pure-effect/flight-recorder`.
- Reading a trace back: `replayEffect` or `timeTravel`.

To build your own wiring instead, start from [`recorder`](REFERENCE.md#recorderoptions).

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

To install it beside other hooks, such as the [telemetry example](#tracing-with-opentelemetry)'s, pass `recordingHooks` to `configureEffect` instead. It takes the same options, and [Hooks](#hooks) shows how hooks installed together run.

The flight recorder keeps the trace of a run that failed or in which a Command threw, passes every value through `redact`, caps a trace at `maxEntries`, reports a storage failure to `onSinkError`, and warns once per flow about a trace that has no input, was capped, is missing values, or has steps named `'anonymous'`.

A trace stores every value as JSON, so return plain data from Commands; [Keeping a replay faithful](#keeping-a-replay-faithful) shows how.

Exact rules: [the flight recorder](REFERENCE.md#pure-effectflight-recorder).

### Keeping secrets out of a trace

`redact` sees everything a trace stores: each result, each thrown error, the flow's input and the context, told apart by `kind`.

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
// Pass it as the redact option of enableRecording, recordEffect or recorder.

assert.equal(redact(null, 'cmdFetchUser', 'result'), null); // still nothing found
assert.equal(redact('card_declined', 'cmdCharge', 'error'), 'card_declined'); // still a string
```

A replay rebuilds the flow from the redacted input and context. So a field a step checks, such as a password, needs a stand-in the check treats the same way, as the `redact` in [Recording in Production](#recording-in-production) does. A context field an `Ask` reads should stay.

Some checks have no such stand-in. A webhook's signature check needs the real signature and the secret. Make that check a Command, as in `const cmdVerifySignature = () => verifySignature(event, secret)`. The trace then records its verdict, and a replay uses the recorded verdict instead of checking the redacted field again.

Exact rules: [what `redact` gets](REFERENCE.md#what-redact-gets).

## Hooks

Hooks see every run, and recording, replay and the [telemetry example](#tracing-with-opentelemetry) are built on them. There are three: `onRun` wraps a whole run, `onStep` wraps each Command and each `Parallel`, and `onBeforeCommand` runs before each Command and can veto it by throwing. A hook that only watches must `await` what it wraps and return its result; [`configureEffect`](REFERENCE.md#configureeffectconfigs) lists each hook's arguments.

Use a veto as a guardrail, not as part of the flow's logic. A veto stops the whole run. The trace has no entry for the vetoed Command, so a replay of that run fails there. Put a decision the flow should handle in a step instead. Check a permission with `Ask` before the first Command writes anything, so a refusal leaves nothing half done. To turn off a supplier, read the switch in a Command and let its `next` fall back or return a `Failure`. The trace then records the switch, and a replay makes the same decision; [Errors no branch returned](REFERENCE.md#errors-no-branch-returned) shows one.

`configureEffect` adds a layer of hooks for the whole process and returns a function that removes it. Removing a layer removes only that layer, even when others were installed after it, so a library can add and remove its own hooks without touching the application's:

```js
// recordingHooks comes from pure-effect/flight-recorder; telemetryHooks from the telemetry example.
const remove = configureEffect(telemetryHooks(), recordingHooks({ sink }));
// One layer whose hooks run as two calls' layers would; remove() removes both.
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
│     ├─ telemetry.onStep
│     │  └─ recording.onStep             closest to the Command
│     │     └─ cmd()
│     │  ┌─ recording.onStep returns     a result, or a thrown error, unwinds
│     ├─ telemetry.onStep returns        from the inside out
│     │
│  ┌─ recording.onRun returns
├─ telemetry.onRun returns
```

Neither the telemetry example nor the flight recorder has an `onBeforeCommand` hook. One you add runs before `onStep` for each Command. If several layers have one, they run in the order the layers were installed.

**Knowing which request a step belongs to.** `onRun` gets the run's context, but `onStep` does not, so a hook that logs each step per request finds the request the way the rest of your logging does. An `AsyncLocalStorage` scope entered around `runEffect` reaches every hook the run calls, and the flight recorder uses one to give each run its own recorder:

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

A Command that `onBeforeCommand` vetoes never reaches `onStep`, so log a veto where you make it. The run's `Failure` holds what the hook threw. Throw an error with a `code`, as in `Object.assign(new Error('Missing permission.'), { code: 'FORBIDDEN' })`, so the code that calls `runEffect` can answer it, with a 403 say, without matching the message.

In tests, call `configureEffect()` with no arguments in a `beforeEach`, so a test that fails before removing its hooks does not leave them installed for the next. A bare call removes every layer, your app's own hooks included. So when a test needs the app's hooks, such as a server's permission check or its recording, install them after the reset, in the same `beforeEach`, not once in a `before`. Nothing warns when they are missing: the run just goes ahead without them.

**Per-call hooks.** `runEffect`'s third argument takes hooks for that call only, and the run's `flowName`.

Exact rules: [per-call hooks](REFERENCE.md#per-call-hooks).

## Tracing with OpenTelemetry

The telemetry example opens a span for each run, a child span for each Command, and one for each `Parallel` around its branches' spans. Spans carry names, timings and status, never values, so nothing a step returns reaches your tracing backend.

It is reference code you copy, not an entry point you import. It ships in the package's `examples` folder, `node_modules/pure-effect/examples`, and in the repository's [examples folder](https://github.com/aycangulez/pure-effect/blob/main/examples); copy it into your project.

In a TypeScript project, copy its `.d.ts` beside it, which types the import, so the project needs no `allowJs`. Without `allowJs`, though, `tsc` does not copy a `.js` file into its output folder. If your compiled code runs from that folder, copy the example's `.js` there as part of the build, or the import fails at runtime with `ERR_MODULE_NOT_FOUND`.

The telemetry example needs `@opentelemetry/api` installed, and its `.d.ts` does not compile without it. Its `startTelemetrySdk` loads `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/sdk-trace-base` only when it is called, so a project that starts the SDK itself needs none of them. If you start OpenTelemetry that way, also register a context manager, such as `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`. Without one, each Command's span is a separate root instead of a child of the run's span.

```js
import { enableTelemetry, startTelemetrySdk } from './opentelemetry-example.js';

await startTelemetrySdk({ serviceName: 'checkout' }); // or start the OpenTelemetry SDK yourself
enableTelemetry(); // installs telemetryHooks(); returns a function that removes them
```

Telemetry and the flight recorder work together as two layers: call `enableTelemetry()` and `enableRecording()` once each. Or install `telemetryHooks()` and `recordingHooks()` in one `configureEffect` call, as [Hooks](#hooks) shows, in place of both, never beside them, or each run is traced or recorded twice.

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

**A trace keeps data, not objects.** A value is copied into the form JSON stores when it is recorded, and copied again each time a replay hands it to the flow. Return plain data from a Command's function. Turn a class instance into a plain object before returning it, with a small named function you can test on its own, as in `() => db.findCart(id).then(cartToData)`. Rebuild the object in `next` if the flow needs its methods. When you catch an error to return it as data, copy the fields the flow branches on, as in `.catch((error) => ({ ok: false, code: error.code }))`, rather than returning the error itself.

To check a flow, record it, replay the trace, and compare the outcomes. A step that computes a fresh value shows up as a different final value, or as a `TimeParadox` if it changes which Commands run. A trace holds each result in the form JSON stores it, so this also catches a result your storage cannot keep, such as a `Date` the flow calls a method on:

```js
const { result, trace } = await recordEffect(registerUserFlow(input));
const { result: replayed } = await replayEffect(registerUserFlow(input), trace);
assert.deepEqual(replayed, result); // fails if a step computed a fresh value, or a result did not survive storage
```

Exact rules: [how errors come back](REFERENCE.md#how-errors-come-back).

### Replaying from your own storage

`replayEffect` also accepts a resolver function instead of a trace, so you can replay from OpenTelemetry spans, a log pipeline, or a database table, not only from the JSON that `recorder` produces. Whatever you store needs each step's `path`, which `onStep` receives, and its result. The telemetry example puts the path on each span as `effect.path`, but not the result, since it keeps values off spans. So spans you replay from need the result added, stored here as `output`. Pass it through your `redact` first, since a tracing backend keeps what it receives:

```js
// A resolver answers one question: what did production get back for this step? Look the step up by its path, its
// position in the flow. `step.index` counts steps in the order they finished, which shifts around a Parallel.
const outputs = new Map(mySpans.map((span) => [span.attributes['effect.path'], span.attributes.output]));
const resolve = (step) => (outputs.has(step.path) ? { result: outputs.get(step.path) } : undefined);
await replayEffect(checkoutFlow(input), resolve);
```

## Why Pure Effect

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, built on the same idea: record what every step returned and replay it. Those engines store the history on a server and resume workflows automatically after a crash. Pure Effect leaves storage and restarts to your application, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full ecosystem with fibers, streaming, schema validation, structured concurrency, and more, with a steep learning curve and its own vocabulary. Pure Effect takes only the idea of describing side effects as data, and does less: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers or streaming, use Effect-TS.

**When to use something else:** If your code does little async I/O, or testing and debugging production are not problems for you, plain async/await is simpler.

## Limitations

- **`Retry` repeats everything it wraps, including a Command's `next`.** Commands that already succeeded run again, and a retried Command whose `next` continues the flow repeats the rest of the flow with it. See [what an attempt runs again](REFERENCE.md#what-an-attempt-runs-again).
- **Cancelling a `Parallel` branch cannot stop a call already running.** A cancelled branch starts no new Commands, but a function that ignores its `AbortSignal`, or is never given one, runs to the end. See [cancellation and the signal](REFERENCE.md#cancellation-and-the-signal).
- **Inside a `Parallel`, a Command's function that takes a parameter without a default value gets the `AbortSignal` in it.** So `Command(listUsers)`, where `listUsers(page)` treats `page` as optional, gets the signal as its page inside a `Parallel` and nothing outside one. Wrap such a function, as in `Command(() => listUsers())`; see [cancellation and the signal](REFERENCE.md#cancellation-and-the-signal).
- **`redact` covers a trace, not a result.** A `Failure` holds the full error, and an error can quote what a Command sent, as a database's duplicate-key error quotes the key. Keeping it out of your logs is up to you.
- **Replay checks the path, not the values.** Every result comes from the recording, so a replay cannot check a fix that changes what a flow computes. See [What a replay cannot check](#what-a-replay-cannot-check).
- **A trace keeps data, not objects.** A replayed value is what JSON stores: a class instance loses its methods, a `Date` becomes a string, and a thrown error comes back as a plain `Error`, so check `error.name` rather than `instanceof`. See [what a trace keeps](REFERENCE.md#what-a-trace-keeps).
- **A trace records the input as the run starts, and a step before the first Command has already run by then.** That step runs as the flow is built, so one that changes its input, as `input.count++` does, leaves the trace holding the changed input. Return a new value rather than change the one a step receives.
- **Replay reproduces what one flow saw, not timing.** See [timing](REFERENCE.md#timing).
- **Configuration belongs to one copy of the library.** Hooks live in module state, so two copies in one process (a dual ESM and CJS setup, two versions in the dependency tree, or a worker thread) do not share them, and nothing warns you.
