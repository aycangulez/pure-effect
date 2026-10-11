# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![CI](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aycangulez/pure-effect/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Inject context without touching function signatures
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks
- Zero dependencies, about 11 KB minified and gzipped
- Works in JavaScript, and in TypeScript 5.1 or later (full generics, bundled `.d.ts`)

## Table of Contents

- **Getting started:** [Installation](#installation) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Testing Without Mocks](#testing-without-mocks) · [Coming from async/await](#coming-from-asyncawait) · [Writing Flows as Generators](#writing-flows-as-generators)
- **Recording and replay:** [Time-Travel Debugging](#time-travel-debugging) · [Recording in Production](#recording-in-production) · [Hooks](#hooks)
- **Building flows:** [Passing Runtime Context](#passing-runtime-context) · [Retrying Transient Failures](#retrying-transient-failures) · [Running Effects in Parallel](#running-effects-in-parallel) · [Composing Larger Flows](#composing-larger-flows) · [Writing Loops](#writing-loops) · [Which Errors Are Data](#which-errors-are-data) · [Generator Flows in Depth](#generator-flows-in-depth) · [TypeScript](#typescript-typed-errors-and-context)
- **Reference:** [Why Pure Effect](#why-pure-effect) · [Load Tests](#load-tests) · [API Reference](#api-reference) · [Limitations](#limitations)

The six sections under Getting started are enough to write and test a flow. Come back to the rest when a flow needs it: recording, retries, loops, steps that run at the same time, or TypeScript.

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

The same flow can be written as a generator, with `yield* step(...)` where `async` code writes `await`. [Writing Flows as Generators](#writing-flows-as-generators) covers what to know.

```js
import { effectGen, step } from 'pure-effect';

const registerUserFlowGen = effectGen(function* (input) {
    yield* step(validateRegistration(input));
    yield* step(ensureEmailAvailable(input));
    return yield* step(saveUser(input));
});
```

## How It Works

A flow is a chain of pairs: an I/O call, and a `next` function that receives its answer and returns the next Command, a Success, or a Failure. `runEffect` walks the chain in a loop. A generator flow builds the same Commands: `effectGen` runs your function up to each `yield*` and continues it with the answer.

Recording and replay hook into the one place where a Command's function is called. Recording writes down each answer. Replay supplies the recorded answer instead of making the call, so a replayed flow does no I/O.

Building a flow runs the pure steps right away: `registerUserFlow(badInput)` returns the validation `Failure` synchronously, so the tests below do not need `runEffect`. Only Commands need it.

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

Then test the flow: the right calls, in the right order. `commandName` gives the name a Command is recorded under:

```js
import { commandName } from 'pure-effect';

const step1 = registerUserFlow(input);
assert.equal(commandName(step1), 'cmdFindUser');

const step2 = step1.next(null); // pretend no user was found
assert.equal(commandName(step2), 'cmdSaveUser');
// The database was never touched.
```

Write both kinds: only a step test sees the value passed from one step to the next. If the email guard returned `Success(true)` instead of `Success(input)`, the step test would fail, but the flow test would still pass, since the calls and their order are unchanged, while the flow saved `true` instead of the user.

A walk meets a `Retry` or a `Parallel` as a step of its own. A `Retry` holds the step it repeats as `effect`, a `Parallel` holds its branches as `effects`, and the `next` of either is the rest of the flow. The walks in [Writing Loops](#writing-loops) and [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails) go through each.

To run the whole flow instead of walking it, `Retry` and `Parallel` included, hand `replayEffect` a function that answers each Command by name. Nothing is called and no retry waits; answering `{ error }` makes that Command throw, which is how a test reaches a `Retry`'s fallback:

```js
import { replayEffect } from 'pure-effect';

const answers = { cmdFindUser: null, cmdSaveUser: { id: 1, ...input } };
const answer = (step) => (step.name in answers ? { result: answers[step.name] } : undefined);
const { result } = await replayEffect(registerUserFlow(input), answer);
assert.deepEqual(result, Success({ id: 1, ...input }));
```

Hand it a recorded run instead, and each Command gets what it returned the first time. That is how a run recorded in production replays on your machine, with nothing connected:

```js
import { recordEffect } from 'pure-effect';

// A real run returns its result, and a trace of what each Command returned.
const { result: live, trace } = await recordEffect(registerUserFlow, input);

// Anywhere else, with nothing connected, the same flow gets the same answers.
const { result: replayed } = await replayEffect(registerUserFlow(trace.initialInput), trace);
assert.deepEqual(replayed, live);
```

[Time-Travel Debugging](#time-travel-debugging) turns such a trace into a regression test, and [Recording in Production](#recording-in-production) records every run of an application.

Tests cannot see inside a Command's function without running it. If `cmdFindUser` said `db.findUser(input.name)` instead of `input.email`, every test on this page would still pass. Keep those functions to a single call, and let an integration test cover them, with the services passed in as [Passing Runtime Context](#passing-runtime-context) shows.

In TypeScript, a walk needs a check at each step that the step is a Command; [Testing a flow in TypeScript](#testing-a-flow-in-typescript) has a helper that makes that one line.

## Coming from async/await

A flow does what `async`/`await` code does, as data: instead of making a call and waiting for it, a step returns a Command that says which call to make and what to do with the answer. Each thing you would write with `async`/`await` has an equivalent:

| `async`/`await` | Generator flow | Pipeline |
| --- | --- | --- |
| `await db.findUser(email)` | `yield* step(findUser(email))` | `Command(() => db.findUser(email), next)` |
| the code after the `await` | the next `yield*` | the Command's `next` |
| an `if` on a result | a step that returns `Success` or `Failure` | a branch in `next` |
| `return value` | `return value` | `Success(value)` |
| `throw` to stop | a step that returns `Failure(error)` | `Failure(error)` |
| `try`/`catch` around a call | a catch inside the Command's function | the same |
| a loop that retries a call | `yield* step(Retry(...))` | `Retry(...)` |
| `await Promise.all([...])` | `yield* step(Parallel([...]))` | `Parallel([...])` |
| a `for` loop with an `await` inside | the same loop, with `yield*` | `Parallel(list.map(...), { limit: 1 })` |
| a loop that keeps going past a failure | `Parallel(..., { settled: true })` | the same |
| a call that needs two earlier results | two variables | a named step that passes both on |
| a value from the request | `yield* step(Ask())` | `Ask` |
| `Date.now()` or a random ID | a Command | a Command |

`findUser` stands for a step that returns the Command, as `ensureEmailAvailable` does in the Quick Start. A `catch` around `yield*` can log and rethrow, but it cannot recover; see [Which Errors Are Data](#which-errors-are-data).

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

The difference shows in the tests. To reach the branch where the email is taken, a test of `registerUserAsync` has to replace the database's methods, run the function, and put them back, here with Node's built-in mocks:

```js
import { mock } from 'node:test';

const input = { email: 'test@test.com', password: 'password123' };

mock.method(db, 'findUser', async () => ({ id: 1 }));
const saveUser = mock.method(db, 'saveUser', async (user) => user);

await assert.rejects(registerUserAsync(input), { message: 'Email already in use.' });
assert.equal(saveUser.mock.callCount(), 0);
mock.restoreAll();
```

The flow's test of the same branch hands one step the answer, with nothing to replace, wait for, or put back:

```js
assert.deepEqual(ensureEmailAvailable(input).next({ id: 1 }), Failure('Email already in use.'));
```

Each step is a place a test can start, so a branch is tested by calling the step it lives in, where a test of an `async` function runs everything before the branch, with every call on the way replaced. The mocks do check one thing these tests cannot: the arguments each call received, which [Testing Without Mocks](#testing-without-mocks) leaves to an integration test.

You can switch one function at a time: keep its name and parameters, run the flow in its body, and turn a `Failure` back into a throw, so the code that calls it does not change. The mocked test above passes against this version too:

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

A loop becomes a step that gets the list and a `Parallel` over it, as the table shows; [Writing Loops](#writing-loops) translates one.

## Writing Flows as Generators

A generator flow is written like `async` code, with `yield* step(...)` where `async` code writes `await`. `effectGen` turns it into the same Commands a pipeline builds, so recording, replay, `Retry`, `Parallel` and the tests above work the same for both. The Quick Start's `registerUserFlowGen` is one. The same steps in the same order record the same paths in either form, so a trace recorded from a pipeline replays against its generator version. A loop written as a `for` loop rather than a `Parallel` records differently; see [Writing Loops](#writing-loops).

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

The body can run more than once: under a `Retry`, when one flow value is run twice, and when a test walks a second branch. So keep it to its own variables, and get `Date.now()` or a random ID from a Command. [Generator Flows in Depth](#generator-flows-in-depth) covers when it runs again, how a `catch` or `finally` in it behaves when a step stops the flow, and the mistakes `effectGen` catches.

### Testing a generator flow

Test each step function by handing it an answer, as [Testing Without Mocks](#testing-without-mocks) does, since the generator only puts the steps in order. Then run the whole flow with each Command answered by name, as for a pipeline:

```js
const answers = { cmdFindUser: null, cmdSaveUser: { id: 1, ...input } };
const answerByName = (asked) => (asked.name in answers ? { result: answers[asked.name] } : undefined);
const { result } = await replayEffect(registerUserFlowGen(input), answerByName);
assert.deepEqual(result, Success({ id: 1, ...input }));
```

Walking the flow step by step works as it does for a pipeline: a walk straight through runs the body once, and walking a second branch runs it again.

## Time-Travel Debugging

Record what each Command returned, then feed those results back into the flow to retrace the path a request took, with no database or network.

```js
import { recordEffect, replayEffect, timeTravel } from 'pure-effect';

// Record a real run. The context's flowName names the flow in the trace.
const { result, trace } = await recordEffect(checkoutFlow, input, {
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

A production incident becomes a regression test, with no mocks or fixtures:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test checks that the flow still takes the recorded path and handles the recorded outcomes the same way. It does not check the values the flow computes, since every result comes from the recording; see [What a replay cannot check](#what-a-replay-cannot-check). If a refactor reorders or replaces a step, the replay ends in a `Failure` whose error is a `TimeParadox` naming where it diverged. It is not thrown, so a test that expects a `Failure` should check the error too, as this one checks its `code`. A step the trace lacks ends the replay in a `Failure` holding a `ReplayError`. A trace lacks a step that comes after the end of the recording, one a hook vetoed in production, and one the recorder dropped under `maxEntries`.

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

For every other recording, `unreached` should be empty, so a fix that skips a step by accident fails the test. This works when the removed step is the last one the flow reaches. Remove a step from the middle and every later step moves to a different path, so the replay stops at a `TimeParadox`, and `unreached` lists the steps it never got to.

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
- `/` goes one level in: `1r1/0` is the first step of the second try of the `Retry` at position 1, and `2p1/0` is the first step of the second branch of the `Parallel` at position 2.

### What a replay cannot check

A replay proves that the flow asks for the same Commands in the same order and handles the same answers. Every result comes from the recording, so it cannot check:

- **What the flow computes.** Fix how a refund amount is calculated and replay the bad run, and the charge step still gets the old amount from the recording: the replay reports `Success`, returns the value from before the fix, and flags nothing. Test a value change against the pure step that computes it.
- **A fix inside a Command's function.** The function never runs, so an old trace hands the flow what it returned or threw before the fix: catch a duplicate-key error inside the function and return it as data, and the old trace still replays the throw. Cover such a fix with an integration test.
- **The arguments a Command was called with.** A trace records results only. Given the recorded input and results, the flow does the same thing again, so replaying up to a step rebuilds its arguments for a debugger, but a test cannot assert on them. Storing them would also double what `redact` has to cover, since arguments are usually the sensitive part of a call.

When a Command's result changes shape, rename the Command. A trace matches it by name, so under the old name an old trace hands the new code a result in the old shape, which it can take for another answer without any `TimeParadox`.

### Keeping a replay faithful

Put anything that varies between runs inside a Command. For replay, the current time or a random ID counts as I/O: in a Command it is recorded and replayed like any other result, while a step that calls `Date.now()` directly gets a new value on every replay and drifts from the trace. To check a flow, record it, replay the trace, and compare the outcomes: a step that computes a fresh value shows up as a different final value, or as a `TimeParadox` if it changes which Commands run. A trace holds each result in the form JSON stores it, so this also catches a result your storage cannot keep, such as a `Date` the flow calls a method on:

```js
const { result, trace } = await recordEffect(registerUserFlow, input);
const { result: replayed } = await replayEffect(registerUserFlow(input), trace);
assert.deepEqual(replayed, result); // fails if a step computed a fresh value, or a result did not survive storage
```

A `Failure` compares the same way when the Command threw a plain `Error`, which comes back with its message, name, cause, custom properties and an `AggregateError`'s list of errors, even a `name` or `cause` set after it was created. An error of any other class, built-in ones included, comes back as a plain `Error` carrying that class's name, so `deepEqual` from `node:assert/strict` refuses the replayed `TypeError` that `fetch` rejects with when the network fails. Where a Command can throw one, compare `error.name` and `error.message` instead.

### Replaying from your own storage

`replayEffect` also accepts a resolver function instead of a trace, so you can replay from OpenTelemetry spans, a log pipeline, or a database table, not only from the JSON that `recorder` produces. Whatever you store needs each step's `path`, which `onStep` receives, and its result; the telemetry example records neither, since it keeps values off spans.

```js
// A resolver answers one question: what did production get back for this step? Look the step up by its path, its
// position in the flow. `step.index` counts steps in the order they finished, which shifts around a Parallel.
const outputs = new Map(mySpans.map((span) => [span.attributes.path, span.attributes.output]));
const resolve = (step) => (outputs.has(step.path) ? { result: outputs.get(step.path) } : undefined);
await replayEffect(checkoutFlow(input), resolve);
```

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
        // A replay runs validation again on the stored input, so the stand-in keeps the password rule's verdict.
        redact: (value, name, kind) =>
            kind === 'initialInput' ? { ...value, password: value.password.length >= 8 ? '[redacted]' : '' } : value,
        maxEntries: 500,
        keep: (result) => result.type === 'Failure' // the default; keep everything, or sample
    })
);
```

What the example does with each run:

- **Which runs it keeps.** `keep` decides, and by default keeps a run that ended in a `Failure`; successful runs are held in memory and then discarded. When your own code throws, such as a `TypeError` after an API changed the shape of its response, the run rejects. `keep` is offered a `Failure` carrying the thrown error, so by default its trace is kept. Replaying that trace reproduces the throw. A step before the flow's first Command runs when the flow is built, outside `runEffect`, so its throw reaches no hook and is not recorded; that run did no I/O, so its input reproduces it.
- **What a trace holds.** `redact` runs before anything enters the trace, including the stored `initialInput` and `context`. A value it throws on, or one JSON cannot hold, such as a `BigInt`, is left out of the trace, which marks where with `unrecorded`, and a replay stops there. Everything else is already in the form JSON holds, so the sink can write it to S3 or a database column with `JSON.stringify`.
- **How long a trace gets.** `maxEntries` caps it and reports the overflow as `dropped`, and a capped trace replays only up to the first step it lacks.
- **When storage fails.** If `keep` or the sink throws, for example because storage is unreachable, the run keeps its own outcome and the error goes to `onSinkError`, which defaults to `console.error`.
- **What it warns about.** The example warns through `onWarning`, once per flow, when it keeps a trace that was capped, one holding values it could not record, or one whose steps include any named `'anonymous'`.

The example takes the input from `onRun`, which is handed it only for a flow `effectPipe` built, so build the outermost flow with `effectPipe`. A flow that starts with a bare `Command`, `Ask`, `Retry`, or `Parallel` records no input, and `timeTravel` would rebuild it from `undefined`. A one-step pipeline is enough, as in `runEffect(effectPipe(loadProfile)(userId))`. The example warns through `onWarning`, which defaults to `console.warn`, the first time it keeps a trace of such a flow, and `timeTravel` warns when it replays one.

The example also takes the context from the run's first Command, so a run that stops before any Command, for example at an `Ask` check, records no context. Such a run did no I/O, so running the flow again with its input and the context from your logs reproduces it.

**A trace keeps data, not objects.** A value is copied into the form JSON stores when it is recorded, and copied again each time a replay hands it to the flow, so neither a later step nor a replay can change what the trace says, and a replay from memory gets what a replay from storage gets. The copy keeps values but not classes: a money object or a database entity comes back as a plain object without its methods, a `Date` as a string, a `Map` or a `Set` as `{}`, a `Buffer` as `{ type: 'Buffer', data }`, `undefined` in an array as `null`, and an error returned inside a result with its own fields, such as `code`, but without its message. A reference back to an object the value is inside of, as between an HTTP client's request and response, is cut. A value JSON cannot hold at all, such as a `BigInt` or an object whose getter throws, is left out of the trace and marked `unrecorded` before `redact` sees it, so a context holding a lazy client is left out whole.

So return plain data from a Command's function. Turn a class instance into a plain object before returning it, with a small named function you can test on its own, as in `() => db.findCart(id).then(cartToData)`, and rebuild the object in `next` if the flow needs its methods. When you catch an error to return it as data, copy the fields the flow branches on, as in `.catch((error) => ({ ok: false, code: error.code }))`, rather than returning the error itself.

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

A replay rebuilds the flow from the redacted input and context, so a field a step checks, such as a password, needs a stand-in the check treats the same way, as the example at the top of this section does, and a context field an `Ask` reads should stay.

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

Recording stores the context alongside the trace, so `Ask` replays with the values the original request saw. It is copied once per run, so read a value that can change while a run is under way, such as a switch an operator can flip to stop a batch, in a Command, whose result the trace records each time.

Keep the context to plain values such as IDs, flags and settings. Recording copies it into every trace, so a database client or connection pool in it puts its connection string in the trace, and one whose properties throw when read, as a lazy client's can, leaves the whole context out, so a replay needs it passed in. Reach a service from the Command's function, as `findProduct` reaches `db`. To run a flow against fakes or a test database, have the function that builds it take the services, and pass them in the test:

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
const flakyNetwork = { attempts: 3, delay: 200, backoff: 2 };
Retry(fetchPrice(sku), flakyNetwork);
```

The settings are a plain object, so a test can check them without running anything:

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

**Wrap the Command that fails, not the pipeline.** Each attempt runs everything inside the `Retry` again, including Commands that already succeeded:

```js
// Dangerous: a flaky receipt step charges the customer again on every attempt.
Retry(effectPipe(chargeCard, sendReceipt)(order), { attempts: 3 });

// Correct: only the step that fails transiently is retried.
effectPipe(chargeCard, (charge) => Retry(sendReceipt(charge), { attempts: 3 }))(order);
```

Wrapping a pipeline is safe only when every Command in it is idempotent (safe to run more than once).

**Wrapping one Command is not always enough.** A Command's `next` is inside the `Retry` too, so a `next` that continues the flow puts everything after it inside the `Retry` as well:

```js
// Dangerous: `next` continues the booking, so every later step is inside the Retry.
Retry(
    Command(cmdHoldSeat, (seat) => chargeCard(trip, seat)),
    { attempts: 2 }
);
```

If a later Command's function throws, the `Retry` holds the seat and charges the card again. With two of these nested, a failure in the last step of a booking charges the card nine times. Instead, give the retried Command its default `next` and continue in a later step, outside the `Retry`:

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

In TypeScript, a `Retry` adds `RetryExhaustedError` to the error union, beside the errors of the steps it wraps. `lastError` is typed `unknown`, since it is whatever the Command's function threw, so check it before using it, for example with `instanceof Error`.

**Use `onExhausted` to fall back when every attempt fails.** The fallback runs in place of the `Failure`. If it succeeds, its value continues down the pipeline; if it fails, its own `Failure` is returned as is. The fallback can be any Effect, such as a Command that reads a cache, or `Success(defaultValue)`:

```js
const fetchPrice = (sku) =>
    Retry(fetchLivePrice(sku), {
        attempts: 3,
        onExhausted: (err) => fetchCachedPrice(sku) // err = { retryExhausted, lastError, attempts }
    });
```

Every attempt and the fallback are recorded, so a replay repeats the same failures and the same fallback, without the delays. A fallback never starts in a `Parallel` branch that has already been cancelled. With `onExhausted` set, the fallback's error type takes the place of `RetryExhaustedError` in the TypeScript error union.

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

Without `settled`, one failing branch cancels the rest and becomes the result of the whole `Parallel`, so one bad record can stop a batch halfway through. With `settled: true`, every branch runs to the end and `next` receives one `Success` or `Failure` per branch, in order, so a failed record is something you can count instead of the end of the job. In TypeScript, write `settled: true` where you call `Parallel`, or mark a shared options object `as const`: since `settled` decides what `next` receives, a value the compiler only knows as `true` or `false` is refused.

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

**Collecting some failures and stopping on others.** `settled` decides for every failure at once. When a batch should note a missing record and go on, but stop everything when its credentials expire, leave `settled` off and decide in each branch: return what should be collected as a value inside a `Success`, and what should stop the batch as a `Failure`, which cancels the other branches:

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

### Undoing what succeeded when a branch fails

Without `settled`, the failing branch's `Failure` is the whole result, and the values of the branches that succeeded are dropped. When one of them did something that has to be undone, such as charging a card for an order whose stock then ran out, the code that called `runEffect` no longer has the charge to refund. Use `settled: true`, so `next` sees every outcome, and have it return the steps that undo whatever succeeded, followed by the failure:

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

### Errors no branch returned

A `Failure` among a settled `Parallel`'s outcomes can also hold an error the branch never returned: what one of its Commands threw, or what an `onBeforeCommand` hook vetoed it with. Neither is in the branch's declared error type, so give the code that reads the outcomes a case for an error it does not recognise, as for a run's result (see [TypeScript](#typescript-typed-errors-and-context)), rather than letting it fall into the last error it expects, which would report a vetoed charge as a declined card.

Fewer such errors reach the outcomes when a branch returns what it can as data. Catch an error the flow can handle inside the Command's function and return it (see [Which Errors Are Data](#which-errors-are-data)), and stop a batch by reading the operator's switch in a Command whose `next` returns a `Failure`, rather than by vetoing in `onBeforeCommand`:

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

Which branch failed first and cancelled the others depends on timing, so it is recorded with the trace. A replay of a cancelled `Parallel` returns the same failure production did, and stops each other branch where production stopped it, rather than letting whichever branch the replay reaches first decide. The same holds when the branch that cancelled the others was a `next` function or a pure step that threw: the replay throws the same error. If the branch that cancelled the others no longer fails, or the `Parallel` no longer has that branch, the replay ends in a `TimeParadox` naming it. The trace also records how many branches each `Parallel` had, so a replay of one that has gained or lost a branch ends in a `TimeParadox` before any of its branches run.

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
    return Retry(Command(cmdChargeInvoice), { attempts: 3 });
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

The loop's body is a flow built for one item, so it can hold as many steps as the body of a `for` loop. Put a `Retry` inside it, on the step that needs one, since a `Retry` runs everything it wraps again (see [Retrying Transient Failures](#retrying-transient-failures)): around the whole loop it would charge the invoices already paid, and around the whole body a receipt that failed to send would charge the card again.

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

It stops at the first invoice that fails, as the `Parallel` with `limit: 1` does. Use the `Parallel` instead when the loop is long, since a generator run keeps every step's result until it ends. Use it too when payments can overlap, with a higher `limit`, or when the loop has to keep going past a failure, with `settled: true`, since a `catch` in the body cannot recover. The two forms record differently, so a trace recorded from one replays against the other as a `TimeParadox`.

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

To the flow, the whole loop is one step. A trace records the finished list as that step's result, and a replay hands the list back without replaying the pages. A `Retry` around the Command starts again from the first page. A flow test cannot see inside it, so, like any Command's function, it is left to an integration test.

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

In short, **you can recover from an error your I/O produced, but you cannot catch a `Failure` a step returned.** Only the code that called `runEffect` acts on it. For the same reason, do not throw business errors from a Command's function: a throw there tells `Retry` that the I/O broke, and `Retry` will try again. A throw anywhere else in the flow is treated as a bug and thrown as it is instead of returned as a `Failure`: `runEffect` rejects with it, or, from a step before the first Command, the call that builds the flow throws it.

### A malformed flow

A flow that is not made of Effects is a bug, so it throws an `EffectTypeError` that says where, rather than returning a `Failure`. The steps before a flow's first Command run as it is built, so a mistake in one of them is thrown by the call that builds the flow, as `registerUserFlow(input)` would throw if its first step returned a plain object:

```
Step 'validateRegistration' returned a plain object. Return Success, Failure, Command, Ask,
Retry, or Parallel: a plain value has to be wrapped, as in Success(value).
```

A mistake after the first Command makes `runEffect` reject. That covers a missing `return`, a `next` that returns a plain value, a step or `next` written as `async` (do the awaited work in a Command instead), and `runEffect(flow)` where `runEffect(flow(input))` was meant. The building blocks check their arguments where they are built, before their own I/O runs, so `Command(db.findUser(email))`, which makes the call while the flow is built, `Command(fn, { name })`, with the metadata in `next`'s place, and a `Parallel` or `effectPipe` given the wrong thing each throw an `EffectTypeError` there; one built inside a `next` is checked when that `next` runs.

## Generator Flows in Depth

What [Writing Flows as Generators](#writing-flows-as-generators) leaves out: when a body runs again, what a `catch` or `finally` in it can do, and the mistakes `effectGen` catches.

### What runs once, and what runs again

A run goes through the body once, top to bottom, as `async` code does. Anything that uses the flow a second time runs it again from the top, since a generator cannot be copied: running one flow value again, or putting it in two branches of a `Parallel`, so build the flow from its input for each run; a `Retry` around the flow, which starts the body afresh for each attempt, as a retried `async` function does; and a test that hands an earlier step a second answer, to walk another branch:

```js
const flow = registerUserFlowGen(input);
assert.equal(commandName(flow), 'cmdFindUser');

// The first answer finds a user, so the flow stops there.
assert.deepEqual(flow.next({ id: 1 }), Failure('Email already in use.'));

// A second answer to the same step runs the body again from the top, and this time it goes on to save.
assert.equal(commandName(flow.next(null)), 'cmdSaveUser');
```

So keep the body to its own variables. When it runs again, it has to ask for the same steps in the same order, and a body that asks for a different one stops the run with an `EffectTypeError` naming both. `Date.now()`, a random ID, or a variable outside the body can change between runs: get the first two from a Command, as a pipeline does, and pass the third in the flow's input.

### How a generator flow stops

`return` ends the flow. A plain value is its `Success`, `return Failure(error)` stops it with that error, and returning a Command or any other Effect runs it, as `return fetch(url)` does in an `async` function. A `throw` in the body is a bug, as one in a pipeline step is, and `runEffect` rejects with it.

When a step stops the flow, because its Command threw or it returned a `Failure`, the body's `catch` and `finally` blocks run, as they would for an `await` that rejected. The `catch` gets an error saying where the flow stopped, not the original, which is the flow's `Failure`, so it cannot branch on the original's fields: `e.code` and the like are `undefined`, and `e.name` is `FlowStopped`. It can log, but it cannot recover:

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

The annotations are optional. Without them, the union holds whatever each step can pass to `Failure`, each error kept exactly as written, whether a string or an object, and a step that cannot fail, such as a Command without a `next`, adds nothing.

**The union covers only the `Failure`s your steps return.** A Command whose function throws, or that an `onBeforeCommand` hook vetoes, also ends the run with a `Failure`, and its error is not in the union. So where the result is handled, give it one fallback, such as a `default` in a `switch` over `result.error`, and treat what reaches it as a server error; the same goes for the outcomes a settled `Parallel` hands `next`. One fallback covers the whole flow: catch inside a Command's function only what the flow can handle, and let the rest throw, which is also what lets `Retry` act on it.

To check for a thrown error, copy it into a variable typed `unknown` first, as in `const error: unknown = result.error`, since TypeScript refuses `instanceof Error` on an error type made only of strings, or on a flow that declares none.

To type what a Command's function returns, such as a JSON response, write the function's result type, as in `Command((): Promise<User | null> => fetchJson(url), next)`. `Command<User | null>(…)` also compiles, but with some type arguments given TypeScript infers none of the others, so that Command's errors are typed `unknown`, which hides the rest of the union.

Value types are checked through the pipeline too, so a step that reads a field the previous step does not return is a compile error. This only works while every step uses the value it receives. A step written as `() => doSomething(outer)` ignores it, and the types stop being checked at that point.

`Failure` keeps a literal exactly as written, but `Success` widens it, as TypeScript does for any object: `Success({ status: 'queued' })` holds a `status` of type `string`. A later step that tells values apart by such a field then refuses it, often several steps from where the value was built, so give the type there, as in `Success<Queued>({ status: 'queued', jobId })`.

`effectPipe` is typed for up to 20 steps. A pipeline is itself a step, so a longer one nests, which is usually easier to read anyway: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => { ... });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

Every step's context counts, so a pipeline needs all the contexts its steps read, even when the first step reads none, and a `Parallel` needs every context its branches read. `runEffect` requires a context whenever the flow reads one, since the flow would otherwise get an empty object, and checks one passed as a variable against what the flow reads, as it checks one written in place, so a variable whose type lacks a field the flow reads does not compile. `recordEffect`, `replayEffect` and `timeTravel` check a context the same way, and `replayEffect` given a resolver requires one, since a resolver holds none.

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

`yield* x` without `step`, reading a property of a step, and an `async function*` do not compile, and a body that returns an untyped value keeps its steps' errors. Returning a step or a Promise compiles, so that a generic helper returning a value of its type parameter does too, and fails when it runs. `yield step(x)` without the star does, and fails when it runs. Name the context `Ask()` reads as `Ask<AppContext>()`.

### Testing a flow in TypeScript

A flow is typed as any kind of step it could start with, since validation may already have returned a `Success` or a `Failure`, so `.cmd` and `.next` compile only after the test checks that the step is a Command. `node:assert`'s `assert(step.type === 'Command')` is such a check, and TypeScript follows it. Jest's and Vitest's `expect` is not, so a walk needs a check at every step, and a small helper makes that one line per step with any test framework:

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

For a step that returns its Command directly, as in `ensureEmailAvailable(input).next(found)`, `next` is checked against what the Command's function returns, so where [Testing Without Mocks](#testing-without-mocks) passes `{ id: 1 }` for a user that was found, a TypeScript test passes a whole user, of the type `db.findUser` returns. A Command reached any other way, by walking the whole flow or through an `Ask`'s `next`, accepts any value, since its type does not say which Command it is.

## Why Pure Effect

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, built on the same idea: record what every step returned and replay it. Those engines store the history on a server and resume workflows automatically after a crash. Pure Effect leaves storage and restarts to your application, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full ecosystem with fibers, streaming, schema validation, structured concurrency, and more, with a steep learning curve and its own vocabulary. Pure Effect takes only the idea of describing side effects as data, and does less: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers or streaming, use Effect-TS.

**vs. plain async/await with mocks:** A mock can pass every test while behaving differently from the real driver. Here, business logic never does I/O, so there is nothing to mock.

**When to use something else:** If your code does little async I/O, or testing and debugging production are not problems for you, plain async/await is simpler.

## Load Tests

Timings are from Node 22 on a MacBook Pro with M4 Pro CPU:

**A web service under load.** A `node:http` service ran signup and checkout flows, where each checkout was a `Parallel` of a retried stock reservation and a card charge, with the OpenTelemetry and recording examples installed.

- 800 requests at once, across 4 tenants: every response and every recorded trace belonged to its own request, and no tenant, user, or request ID crossed between runs.
- The ~3,500 telemetry spans formed 800 request traces, with every span inside its own request's trace.
- Side effects matched the outcomes: 320 charges and 320 orders, and 80 declined cards stopped 30 stock reservations that were still running.
- 30,000 runs in a row kept memory between 10 and 11 MB, and left nothing running afterwards.
- A background worker that ran 20,000 jobs in one flow, looping through a Command's `next`, finished in under ~400 ms without holding on to memory.
- Stopping the server with flows still running, or clients hanging up mid-request: every flow that had started finished and was recorded, with no unhandled rejections.

**Batches and parallel work.**

- A settled `Parallel` over 200 records with `limit: 7` never had more than 7 records in flight, and returned the outcomes in order.
- 5,000 branches in one `Parallel` ran in ~25 ms.
- Running a Command through `runEffect` costs about 0.2 microseconds, against 0.06 for a plain `await`.

## API Reference

Every `options` argument and hook configuration below throws for a name it does not read or a value it cannot use, so a misspelt option fails instead of running with its default. `Retry` and `Parallel` throw an `EffectTypeError` where they are built.

### Building blocks

#### `Success(value)`

Returns `{ type: 'Success', value }`.

#### `Failure(error)`

Returns `{ type: 'Failure', error }`. Stops the pipeline immediately.

#### `Command(cmdFn, nextFn?, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmd`: the function, sync or async, that does the I/O. Inside a `Parallel` branch, a function that takes a parameter gets an `AbortSignal` in it that fires when a sibling fails; one with no parameters, or only parameters with default values, gets none, and so does every function outside a `Parallel` (see [Limitations](#limitations)).
- `next`: receives `cmd`'s result and returns the next Effect; by default `(result) => Success(result)`.
- `meta`: metadata passed to `onBeforeCommand`. A string `meta.name` names the Command.

**Every Command needs a name**, which tests, traces, replay matching and telemetry all use. It is `meta.name`, else the function's name, else `'anonymous'`:

```js
Command(cmdFn, next, { name: 'chargeCard' }); // 1. meta.name, independent of how cmdFn was written
Command(function cmdChargeCard() {
    return api.charge();
}, next); // 2. the function's own name
Command(() => api.charge(), next); // 3. neither, so 'anonymous'
```

Use `meta.name` in code that gets minified, since a minifier renames functions and with them every step in every trace. Otherwise naming the function is enough, as the examples do: an arrow assigned to a `const` first, as in `const cmdChargeCard = () => api.charge()`, takes the `const`'s name. An inline arrow does not, and a replay cannot tell two `'anonymous'` Commands apart, so a refactor that swaps them replays without complaint, each handed the other's recorded result.

#### `commandName(command)`

Returns a Command's name, chosen in the order above, so a test checks a step by the name its trace would record: `assert.equal(commandName(step), 'cmdFindUser')`. Anything but a Command throws an `EffectTypeError`.

#### `Ask(nextFn?)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`. With no argument, the flow gets the context itself, as `yield* step(Ask())` reads it.

#### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`.

- `options.attempts`: Max retries, not counting the first try (default: `3`). Must be a positive integer; anything else, including `0`, throws. To handle an outcome without retrying, branch on it in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.
- `options.delay`: Ms before the first retry (default: `100`). Must be a finite number of 0 or more.
- `options.backoff`: Multiplier applied to the delay on each attempt (default: `1`, flat). Must be a finite number of 0 or more.

An option set to `undefined` keeps its default.

- `options.onExhausted(error)`: Runs a fallback Effect when every attempt has failed, receiving `{ retryExhausted, lastError, attempts }`. The fallback's success feeds `next`; its failure propagates unwrapped. Per-use only. See [Retrying Transient Failures](#retrying-transient-failures).

#### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`, which runs the branches at the same time and hands `next` their values in order; by default `(values) => Success(values)`. The first branch to fail cancels the others and its `Failure` is the result, with `next` skipped. Which branch that is depends on timing, so it is recorded, and a replay returns the same one. Each branch's Commands get an `AbortSignal` to pass to their I/O; see [Running Effects in Parallel](#running-effects-in-parallel).

The second argument is `next` or the options, so `Parallel(effects, { limit: 5 })` works; after the options, a third argument throws.

- `limit`: the most branches running at once, a positive integer. Results and recorded paths stay in array order, so it changes only the pacing.
- `settled`: run every branch to the end and hand `next` one `Success` or `Failure` per branch, in array order: no branch cancels the others or fails the `Parallel`. A bug still rejects the run, since a step or `next` that throws, or returns something other than an Effect, is not a branch outcome.

### Building pipelines

#### `effectPipe(...functions)`

Composes steps into a pipeline: each step gets the previous step's `Success` value, and a `Failure` from any step stops it. A step may ignore the value it gets and close over the enclosing scope instead, which is fine in JavaScript:

```js
// The last step ignores what came before and uses the enclosing input instead.
const registerUserFlow = (input) => effectPipe(validateRegistration, () => saveUser(input))(input);
```

In TypeScript, type checking stops at that step, since a function that ignores its parameter constrains nothing before it; passing the value through every step, as the [Quick Start](#quick-start) does, keeps the whole pipeline checked. See [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context).

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

Runs a flow and resolves with its `Success` or `Failure`.

- `context`: what `Ask` reads, also passed to `onBeforeCommand`. `context.flowName` names the run in traces and telemetry.
- `callConfig`: `onStep`, `onRun` and `onBeforeCommand` for this call only, added to the configured hooks, or used alone with `inherit: false`; see [Hooks](#hooks).
- A throw from a Command's function, or an `onBeforeCommand` veto, ends the run with a `Failure`. A malformed flow, or a throw from a `next` or a pure step, is a bug and is thrown: by the call that builds the flow when it comes before the first Command, and otherwise as a rejection of `runEffect`. See [Which Errors Are Data](#which-errors-are-data).

#### `configureEffect(...configs)`

Adds a layer of hooks for the whole process and returns a function that removes that layer only. Several configurations passed to one call form one layer. `configureEffect()` with no arguments removes every layer, and a call whose arguments are all `undefined` changes nothing. A configuration that is not an object, a key other than the three below, a `retry` key, and a hook that is not a function, `null` included, each throw a `TypeError` before anything is installed. See [Hooks](#hooks).

- `onRun(effect, pipeline, flowName, initialInput)`: wraps the whole run once, retries included. It must `await pipeline()` and return its result. `initialInput` is what the flow was called with when `effectPipe` built it, and `undefined` otherwise; pass it on to any hook it calls.
- `onStep(name, type, op, path)`: wraps each Command, and each `Parallel` with `name` and `type` both `'Parallel'`. It must `await op()` and return its result, and pass `path` on to any hook it calls, since a replay matches steps on it.
    - For a Command, `op()` returns a promise, even for a synchronous function. Returning a value without calling `op()` answers for the Command, which is how replay works, and throwing without calling it counts as the Command failing.
    - A throw after `op()` succeeded, or `undefined` returned in place of its value, as a hook that forgot its `return` or its `await` does, is a bug in the hook: the run rejects, and `Retry` does not run the Command again.
    - For a `Parallel`, `op()` runs the branches, so a hook must call it or the run rejects with a `TypeError`. It returns which branch, if any, cancelled the others, and how many branches there were, as in `{ cancelled: true, branch: 0, branches: 2 }`, even when a branch threw, which adds `threw: true`.
- `onBeforeCommand(command, context)`: runs before each Command. A throw vetoes the Command: the run returns a `Failure` carrying the thrown error, and `Retry` does not retry it. A vetoed Command leaves no entry in a trace, so a replay of that run fails where it was vetoed; see [Errors no branch returned](#errors-no-branch-returned).

### Recording and replay

#### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`, a hook that records every step of a run, passed as `runEffect(flow, context, { onStep })`. Give each run its own recorder: one shared by a whole application mixes requests into one trace, which a replay refuses. `recordEffect` and the [recording example](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js) both do this for you.

- `onStep`: the hook. Recording never changes a run's outcome.
- `entries`: the steps recorded so far, one per Command and one per `Parallel`. `path` is the step's position in the flow, which a replay matches on; an older entry with `error` and no `threw` still counts as a throw.

```text
{ command, path, result, durationMs }                                    a Command that returned
{ command, path, threw: true, error, durationMs }                        a Command that threw
{ command: 'Parallel', path, result: { cancelled, branch, branches } }   which branch, if any, cancelled the others,
                                                                         and how many branches there were
{ command, path, unrecorded, durationMs }                                a Command whose result or error could not be recorded,
                                                                         because 'redact' threw on it or the 'copy' failed
```

- `toTrace(meta)`: the entries as a trace, with `meta`'s `initialInput`, `context`, `flowName` and `version`, copied into the form JSON stores when it is called. If a Command can change the input or the context, as an ORM save that adds an id does, call it before the run for those and again afterwards for the entries, as `recordEffect` does.
- `options.redact(value, name, kind)`: returns what the trace stores in place of `value`. `kind` is `'result'`, `'error'`, `'initialInput'` or `'context'`, and `name` is the Command's name, or the kind. See [Keeping secrets out of a trace](#keeping-secrets-out-of-a-trace).
- `options.maxEntries`: the most entries a trace keeps; the rest are counted in `dropped`, and a replay stops at the first step the trace lacks.
- `options.stack`: record stack traces for thrown errors (off by default).
- A value `redact` throws on, or one JSON cannot hold, is left out and marked `unrecorded`, on its entry or, for the input and context, in the trace's `unrecorded`, as in `{ context: 'copy' }`. A replay stops there with a `ReplayError` rather than hand the flow a stand-in. See [Recording in Production](#recording-in-production) for what a copy keeps.

#### `recordEffect(flowFn, initialInput, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. Accepts `recorder` options plus `context` and `version`. For tests and scripts. To record an application without changing call sites, use the wiring in [`examples/recording-example.js`](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js), which gives each run its own recorder.

#### `replayEffect(effect, traceOrResolver, options?)`

Runs a flow with each Command answered from a trace instead of run, and returns `{ result, unreached }`: the flow's outcome, and the recorded steps it never asked for. A flow that no longer matches the trace ends in a `Failure` whose `error` is a `TimeParadox`, or a `ReplayError` for a step the trace lacks; neither is thrown, so a test checks `error.name`. A malformed trace rejects with a `ReplayError`. See [Time-Travel Debugging](#time-travel-debugging).

- `traceOrResolver`: a trace, its bare entries, or a resolver: a function that answers each step with `{ result }`, `{ error }`, or `undefined` for a step it has no record of. Any other answer, `null` included, or a throw from the resolver, rejects the replay. With a resolver, `unreached` is absent. See [Replaying from your own storage](#replaying-from-your-own-storage).
- A resolver is also asked about each `Parallel`, with `step.type` set to `'Parallel'`: answering with the recorded cancellation as `{ result }` replays it as production decided, and anything else replays it by timing.
- `options.context`: the context for `Ask`, by default the one the trace recorded. A resolver has none, so pass one if the flow reads `Ask`, and a trace whose context could not be recorded refuses to replay without one.
- `options.onMissing`: `'throw'` (default) stops at a step the trace lacks; `'execute'` runs its Command for real, so use it only where Commands reach test doubles or only read. A trace that dropped entries refuses `'execute'`, and a flow that changed shape, as when a Command is newly wrapped in `Retry` or moved into a new `Parallel` branch, stops at a `TimeParadox` even under `'execute'`.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the configured hooks, a configured recorder included, so they see the replayed steps. Off, a replay cannot reach a telemetry backend or a trace sink.
- `options.onResolved(step, outcome)`: observes each replayed step. A throw stops the replay, and `replayEffect` rejects with it; it never changes an outcome.
- A trace whose entries have no `path`, written by hand or recorded before paths existed, is matched in order, and a Command inside a `Parallel` is refused with a `ReplayError`.

#### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates each step with its recorded duration, naming any recorded steps that were never reached, and warning when the trace's `version` differs from `options.version` or when steps are named `'anonymous'`. Returns the flow's outcome; for the unreached entries as data, use `replayEffect`. A trace whose input could not be recorded is refused, since the flow is rebuilt from it. Takes `options.context` to override the trace's, and `options.log` in place of `console.log`.

## Limitations

- **`Retry` repeats everything it wraps, including a Command's `next`.** Each attempt runs every Command inside the `Retry` again, the ones that already succeeded included, and a retried Command whose `next` continues the flow takes the rest of the flow with it. Wrap only the Command that fails, and continue in a later step, as [Retrying Transient Failures](#retrying-transient-failures) shows. A function that catches its own error is never retried; see [Which Errors Are Data](#which-errors-are-data).
- **Cancelling a `Parallel` branch cannot stop everything.** A cancelled branch starts no new Commands, and a function that uses the `AbortSignal` it is given can be stopped while running. A function that ignores the signal runs to completion, so a branch whose _first_ Command is a write can still write after another branch has failed. So does a function that is never given the signal: one written as `(...args)` or `({ signal } = {})`, or wrapped by a helper that hides its parameters. `Parallel` waits for every branch to finish before returning, so no cancelled work is still running after the `Failure` is returned.
- **Inside a `Parallel`, a Command's function that takes a parameter gets the `AbortSignal` in it.** This catches a function passed by name whose first parameter is optional and has no default value. Inside a `Parallel` that parameter gets the signal, and outside one it gets nothing, so the same Command behaves differently in the two places: `function listUsers(page) { page ??= 1; return db.users(page); }` gets the signal as its page. A parameter with a default value does not count, so `Command(nanoid)`, whose size is written `size = 21`, works everywhere. Wrap such a function, as in `Command(() => listUsers())`. In TypeScript, a function whose first parameter cannot be an `AbortSignal` does not compile as a Command.
- **`redact` covers a trace, not a result.** A `Failure` holds the full error, untrimmed, because tests and debugging need all of it, and an error can quote what a Command sent, as a database's duplicate-key error quotes the key. `redact` keeps sensitive data out of a **trace**. Keeping it out of your **logs** is up to you.
- **Replay checks the path, not the values.** Every Command's result comes from the recording, so replaying an old trace cannot check a fix that changes what a flow computes, and a step removed from the middle of a flow stops the replay at a `TimeParadox` instead of showing in `unreached`; see [Time-Travel Debugging](#time-travel-debugging).
- **A trace keeps data, not objects.** A result replays as JSON stores it, so a class instance comes back without its methods and a `Date` as a string, and a thrown error comes back as a plain `Error` with its class's name, so a flow that checks `instanceof TypeError` replays differently; check `error.name` instead. Return plain data from Commands; see [Recording in Production](#recording-in-production).
- **Replay reproduces what one flow saw, not timing.** A stale read replays exactly. A race between two concurrent requests does not, because a trace records one flow. `Parallel` branches replay with the results each branch saw, and a cancelled `Parallel` with the branch that cancelled it, but not the order they ran in, so replay cannot settle a race between branches that share state. A generator flow in a branch a recorded cancellation stopped can run its `catch` and `finally` at a different step in a replay, since a trace marks where a branch stopped only by its Commands: one cancelled during a `Retry`'s wait, just before an `Ask`, or at a `Retry` or `Parallel` with no Command in it, replays as though it stopped at its next Command.
- **Configuration belongs to one copy of the library.** `configureEffect` stores hooks in module state, so two copies of the library in one process (from a dual ESM and CJS setup, two versions in the dependency tree, or a worker thread) each have their own. Hooks configured in one do not apply to the other, and nothing warns you.
- **A Command needs a name.** `meta.name` survives minification. `cmd.name` does not, unless the minifier is set to keep function names.
- **A generator flow's body can run more than once,** and code in it that changes something outside it, such as a counter or a log line, does so again; see [What runs once, and what runs again](#what-runs-once-and-what-runs-again).
- **A generator run keeps every step's result until it ends,** since running the body again needs them. A long loop that fetches large pages holds every page; write it as a pipeline whose `next` asks for the next page.
- **A generator body's `finally` does not always run.** It does not run when a bug or a `TimeParadox` rejects the run. In a `Parallel` where one branch threw, another branch that stops for its own reason before the rejection reaches it may still run its `catch` and `finally`, depending on timing. A step in a body's `finally` is not supported: it runs when the body ends normally and is refused when a step stopped the body, but if an error is passing through the body when its `finally` reaches a step, and the flow is cancelled before that step starts, the error is lost. Put cleanup in a `try`/`finally` around `runEffect`.
