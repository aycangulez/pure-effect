# Pure Effect Reference

The exact rules and the API, by feature. [README.md](README.md) teaches each feature; this file is where to look a rule up.

**Contents:** [Building blocks](#building-blocks) · [Building flows](#building-flows) · [Running a flow](#running-a-flow) · [Recording and replay](#recording-and-replay) · [TypeScript](#typescript)

Every `options` argument and hook configuration below throws for a name it does not read or a value it cannot use, so a misspelt option fails instead of running with its default. `Retry` and `Parallel` throw an `EffectTypeError` where they are built.

## Building blocks

### `Success(value)`

Returns `{ type: 'Success', value }`.

### `Failure(error)`

Returns `{ type: 'Failure', error }`. Stops the pipeline immediately.

### `Command(cmdFn, nextFn?, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmd`: the function, sync or async, that does the I/O. Inside a `Parallel` branch, one that declares a parameter without a default value gets an `AbortSignal` that fires when a sibling fails; see [Running Effects in Parallel](README.md#running-effects-in-parallel).
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

### `commandName(command)`

Returns a Command's name, chosen in the order above, so a test checks a step by the name its trace would record: `assert.equal(commandName(step), 'cmdFindUser')`. Anything but a Command throws an `EffectTypeError`.

### `Ask(nextFn?)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`. With no argument, the flow gets the context itself, as `yield* step(Ask())` reads it.

### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`. See [Retrying Transient Failures](README.md#retrying-transient-failures).

- `options.retries`: tries after the first, a positive integer (default `3`), so `2` makes at most three calls. Anything else throws, `0` included: to handle an outcome without retrying, branch on it in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.
- `options.delay`: milliseconds before the first retry, a finite number of 0 or more (default `100`). A wait that `backoff` grows past about 24.8 days, the longest `setTimeout` holds, is capped there.
- `options.backoff`: the multiplier applied to the delay on each attempt, a finite number of 0 or more (default `1`, flat).
- `options.onExhausted(error)`: a fallback Effect to run when every attempt has failed, given `{ retryExhausted, lastError, retries }`. Its success feeds `next`; its failure is returned unwrapped. Per use only.
- An option set to `undefined` keeps its default.

### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`. Runs the branches at the same time and hands `next` their values in order; by default `(values) => Success(values)`. See [Running Effects in Parallel](README.md#running-effects-in-parallel).

- The first branch to fail cancels the others, and its `Failure` is the result, with `next` skipped. Which branch that is depends on timing, so it is recorded, and a replay returns the same one.
- A branch's Command gets an `AbortSignal` to pass to its I/O when its function declares a parameter without a default value; see [Running Effects in Parallel](README.md#running-effects-in-parallel).
- The second argument is `next` or the options, so `Parallel(effects, { limit: 5 })` works; after the options, a third argument throws, as does a fourth after `next` and the options.
- `limit`: the most branches running at once, a positive integer. Results and recorded paths stay in array order, so it changes only the pacing.
- `settled`: run every branch to the end and hand `next` one `Success` or `Failure` per branch, in array order, so no branch cancels the others or fails the `Parallel`. A bug still rejects the run: a step or `next` that throws, or returns something other than an Effect, is not a branch outcome.

#### Errors no branch returned

A `Failure` among a settled `Parallel`'s outcomes can also hold an error the branch never returned: what one of its Commands threw, or what an `onBeforeCommand` hook vetoed it with. Neither is in the branch's declared error type. So give the code that reads the outcomes a case for an error it does not recognise, as for a run's result (see [TypeScript](README.md#typescript-typed-errors-and-context)). Otherwise it falls into the last error it expects, and reports a vetoed charge as a declined card.

Fewer such errors reach the outcomes when a branch returns what it can as data. Catch an error the flow can handle inside the Command's function and return it (see [Which Errors Are Data](README.md#which-errors-are-data)). To stop a batch, read the operator's switch in a Command whose `next` returns a `Failure`, rather than vetoing in `onBeforeCommand`:

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

#### Replaying a cancelled `Parallel`

Which branch failed first and cancelled the others depends on timing, so it is recorded with the trace. A replay of a cancelled `Parallel` returns the same failure production did, and stops each other branch where production stopped it, rather than letting whichever branch the replay reaches first decide. The same holds when the branch that cancelled the others was a `next` function or a pure step that threw: the replay throws the same error.

If the branch that cancelled the others no longer fails, or the `Parallel` no longer has that branch, the replay ends in a `TimeParadox` naming it. The trace also records how many branches each `Parallel` had, so a replay of one that has gained or lost a branch ends in a `TimeParadox` before any of its branches run.

A generator flow in a cancelled branch can run its `catch` and `finally` one step later in a replay than it did in production. A trace marks where a branch stopped only by its Commands. So a branch cancelled during a `Retry`'s wait, just before an `Ask`, or at a `Retry` or `Parallel` with no Command in it replays as though it stopped at its next Command.

## Building flows

### `effectPipe(...functions)`

Composes steps into a pipeline: each step gets the previous step's `Success` value, and a `Failure` from any step stops it. The pipeline is called with one input; pass several values as one object. A step may ignore the value it gets and close over the enclosing scope instead, which is fine in JavaScript:

```js
// The last step ignores what came before and uses the enclosing input instead.
const registerUserFlow = (input) => effectPipe(validateRegistration, () => saveUser(input))(input);
```

In TypeScript, type checking stops at that step, since a function that ignores its parameter constrains nothing before it. Passing the value through every step, as the [Quick Start](README.md#quick-start) does, keeps the whole pipeline checked; see [TypeScript: Typed Errors and Context](README.md#typescript-typed-errors-and-context).

In either language, a Command a step builds and does not return never runs, and any `Failure` it would have produced is lost:

```js
(value) => {
    sendWelcomeEmail(value); // built and thrown away: the email is never sent
    return Success(value);
};
```

Return the Command, and have its `next` return the value the rest of the pipeline needs.

### `effectGen(body)`

Returns a flow function, `(input) => Effect`, from a generator function, `function* (input) { ... }`. See [Writing Flows as Generators](README.md#writing-flows-as-generators).

- Calling it runs the body up to its first `yield*`, so a `Failure` before the first step comes back at once, as a pipeline's does.
- `return value` is `Success(value)`, `return Failure(error)` stops the flow, and a returned Effect runs.
- When a step stops the flow, the body's `catch` and `finally` blocks run; a `catch` that recovers or throws another error, or a `finally` that runs a step, rejects the run.
- An `async function*`, and a body that yields anything but `yield* step(effect)`, throws an `EffectTypeError`.
- A flow takes one input, so a generator function that declares more than one parameter throws an `EffectTypeError`; pass several values as one object.

### `step(effect)`

Wraps an Effect for `yield*` inside `effectGen`, which gives back its value: `const user = yield* step(findUser(email))`. Anything but an Effect throws an `EffectTypeError`, and so does using the result any other way than `yield*`.

#### What runs once, and what runs again

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

#### How a generator flow stops

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

Handle an error the flow expects inside the Command's function, and return it as data for the body to branch on; recover from one that keeps happening with `Retry`'s `onExhausted`. See [Which Errors Are Data](README.md#which-errors-are-data). Cleanup for the whole run goes in a `try`/`finally` around `runEffect`, as it does for a pipeline.

A body's `finally` does not always run. It does not run when a bug or a `TimeParadox` rejects the run. In a `Parallel` where one branch threw, another branch that stops for its own reason before the rejection reaches it may still run its `catch` and `finally`, depending on timing.

A step in a body's `finally` is not supported. It runs when the body ends normally, and is refused when a step stopped the body. But if an error is passing through the body when its `finally` reaches a step, and the flow is cancelled before that step starts, the error is lost.

#### Mistakes it catches

| Written | What happens |
| --- | --- |
| `yield step(x)`, without the star | an `EffectTypeError`: write `yield*` |
| `yield x` | an `EffectTypeError`: write `yield* step(x)` |
| `yield* x`, without `step` | the engine's `TypeError`, which on V8 becomes an `EffectTypeError` saying to write `yield* step(x)` |
| `const found = step(x)`, then `found.id` | an `EffectTypeError`: `step(...)` was used as a value |
| `step(x)` with no `yield*`, as a statement or in `if (step(x))` | an `EffectTypeError`: `step(...)` was called without `yield*` |
| `[...step(x)]` or `for (const v of step(x))` | an `EffectTypeError`: `step(...)` was iterated outside `yield*` |
| `step(db.findUser(email))` | an `EffectTypeError`: put the call in a Command |
| `effectGen(async function* () {})` | an `EffectTypeError`: write `function*` |
| `effectGen(function* (batch, options) {})` | an `EffectTypeError`: a flow takes one input, so pass one object, as in `function* ({ batch, limit })` |

In TypeScript, most of these do not compile; see [TypeScript](README.md#typescript-typed-errors-and-context).

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

## Running a flow

### `runEffect(effect, context?, callConfig?)`

Runs a flow and resolves with its `Success` or `Failure`. See [Which Errors Are Data](README.md#which-errors-are-data).

- `context`: what `Ask` reads, also passed to `onBeforeCommand`. `context.flowName` names the run in traces and telemetry. Anything but an object or `null` makes `runEffect` reject with a `TypeError` before the run, and the `context` option of `recordEffect`, `replayEffect` and `timeTravel` is checked the same way.
- `callConfig`: `onStep`, `onRun` and `onBeforeCommand` for this call only, added to the configured hooks, or used alone with `inherit: false`; see [Hooks](README.md#hooks).
- A throw from a Command's function, or an `onBeforeCommand` veto, ends the run with a `Failure` holding the error thrown; under a `Retry` that gave up, it holds `{ retryExhausted, lastError, retries }`.
- A malformed flow, or a throw from a `next` or a pure step, is a bug. The call that builds the flow throws it before the first Command, and `runEffect` rejects with it after.

### `configureEffect(...configs)`

Adds a layer of hooks for the whole process and returns a function that removes that layer only. See [Hooks](README.md#hooks).

- Several configurations passed to one call form one layer.
- `configureEffect()` with no arguments removes every layer, and a call whose arguments are all `undefined` changes nothing.
- Throws a `TypeError`, before installing anything, for a configuration that is not an object, a key other than the three below (`retry` included), or a hook that is not a function (`null` included).
- `onRun(effect, pipeline, flowName, initialInput)`: wraps the whole run once, retries included. It must `await pipeline()` and return its result; anything but a `Success` or `Failure` rejects the run with a `TypeError`. `initialInput` is what the flow was called with when `effectPipe` or `effectGen` built it, and `undefined` otherwise; pass it on to any hook it calls.
- `onStep(name, type, op, path)`: wraps each Command, and each `Parallel` with `name` and `type` both `'Parallel'`. It must `await op()` and return its result, and pass `path` on to any hook it calls, since a replay matches steps on it.
    - For a Command, `op()` returns a promise, even for a synchronous function. Returning a value without calling `op()` answers for the Command, which is how replay works, and throwing without calling it counts as the Command failing.
    - A throw after `op()` succeeded, or `undefined` in place of its value (a forgotten `return` or `await`), is a bug in the hook: the run rejects, and `Retry` does not run the Command again.
    - For a `Parallel`, `op()` runs the branches, so a hook must call it or the run rejects with a `TypeError`. It returns which branch, if any, cancelled the others, and how many branches there were and whether it was settled, as in `{ cancelled: true, branch: 0, branches: 2, settled: false }`. A branch that threw adds `threw: true`.
- `onBeforeCommand(command, context)`: runs before each Command. A throw vetoes the Command: the run returns a `Failure` carrying the thrown error, and `Retry` does not retry it. A vetoed Command leaves no entry in a trace, so a replay of that run fails where it was vetoed; see [Errors no branch returned](#errors-no-branch-returned).

## Recording and replay

### `recorder(options?)`

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
- `options.redact(value, name, kind)`: returns what the trace stores in place of `value`. `kind` is `'result'`, `'error'`, `'initialInput'` or `'context'`, and `name` is the Command's name, or the kind. See [Keeping secrets out of a trace](README.md#keeping-secrets-out-of-a-trace).
- `options.maxEntries`: the most entries a trace keeps; the rest are counted in `dropped`, and a replay stops at the first step the trace lacks.
- `options.stack`: record stack traces for thrown errors (off by default).
- A value `redact` throws on or returns `undefined` for, or one JSON cannot hold, is left out and marked `unrecorded`: on its entry, or for the input and context in the trace's `unrecorded`, as in `{ context: 'copy' }`. A replay stops there with a `ReplayError` rather than hand the flow a stand-in. An error `redact` returns `undefined` for is recorded as a throw with nothing to show. See [Recording in Production](README.md#recording-in-production) for what a copy keeps.

### `recordEffect(effect, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. The trace holds the flow's input when `effectPipe` or `effectGen` built it, so `timeTravel` can build the flow again. Accepts `recorder` options plus `context` and `version`; without a `context`, the trace records the empty one the run gets, which `redact` is not handed. For tests and scripts; to record an application without changing call sites, use the wiring in [`examples/recording-example.js`](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js), which gives each run its own recorder.

- A run whose own code throws makes it reject without a trace. The recording example keeps the trace of such a run; see [Recording in Production](README.md#recording-in-production).

### `replayEffect(effect, traceOrResolver, options?)`

Runs a flow with each Command answered from a trace instead of run, and returns `{ result, unreached }`: the flow's outcome, and the recorded steps it never asked for. See [Time-Travel Debugging](README.md#time-travel-debugging).

- A flow that no longer matches the trace ends in a `Failure` whose `error` is a `TimeParadox`, or a `ReplayError` for a step the trace lacks. Neither is thrown, so a test checks `error.name`. In TypeScript, cast the error through `unknown`, as in `result.error as unknown as ReplayFault`, since the result's type is the flow's own errors; `ReplayFault` types `name` and the fields locating the stop, such as `path`.
- A malformed trace rejects with a `ReplayError`.
- `traceOrResolver`: a trace, its bare entries, or a resolver: a function that answers each step with `{ result }`, `{ error }`, or `undefined` for a step it has no record of. See [Testing a whole flow](README.md#testing-a-whole-flow) and [Replaying from your own storage](README.md#replaying-from-your-own-storage).
- Any other answer from a resolver, `null` included, or a throw from it, rejects the replay. With a resolver, `unreached` is absent.
- A resolver is also asked about each `Parallel`, with `step.type` set to `'Parallel'`. Answering with the recorded cancellation as `{ result }` replays it as production decided, and anything else replays it by timing.
- `options.context`: the context for `Ask`, by default the one the trace recorded. A resolver has none, so pass one if the flow reads `Ask`: a replay that reaches an `Ask` with no context, from a resolver or a trace that recorded none, stops with a `ReplayError`. A trace whose context could not be recorded refuses to replay without one.
- `options.onMissing`: `'throw'` (default) stops at a step the trace lacks; `'execute'` runs its Command for real, so use it only where Commands reach test doubles or only read.
- A trace that dropped entries refuses `'execute'`. A flow that changed shape, as when a Command is newly wrapped in `Retry` or moved into a new `Parallel` branch, stops at a `TimeParadox` even under `'execute'`. An attempt past the last one the trace recorded for its `Retry` never runs live either: it is a `TimeParadox` when the trace holds the fallback Command the `Retry` gave up to, and otherwise a `ReplayError`, since a hook that vetoed that attempt leaves the same trace.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the configured hooks, a configured recorder included, so they see the replayed steps. Off, a replay cannot reach a telemetry backend or a trace sink.
- `options.onResolved(step, outcome)`: observes each replayed step. A throw stops the replay, and `replayEffect` rejects with it; it never changes an outcome.
- A trace whose entries have no `path`, written by hand or recorded before paths existed, is matched in order, and a Command inside a `Parallel` is refused with a `ReplayError`.

### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates it as a tree of the flow, each Command under the `Parallel` branch or `Retry` attempt it ran in, with its recorded duration to a tenth of a millisecond (`<0.1ms` for a faster step). Returns `{ result, unreached }`, as `replayEffect` does for a trace.

- Names any recorded steps that were never reached.
- Warns when the trace's `version` differs from `options.version`, and when steps are named `'anonymous'`.
- Refuses a trace whose input could not be recorded, since the flow is rebuilt from it.
- `options.context` overrides the trace's; `options.log` replaces `console.log`.

## TypeScript

### Typing what a Command returns

To type what a Command's function returns, such as a JSON response, write the function's result type, as in `Command((): Promise<User | null> => fetchJson(url), next)`. `Command<User | null>(…)` also compiles, but with some type arguments given TypeScript infers none of the others, so that Command's errors are typed `unknown`, which hides the rest of the union.

### Literals in `Success` and `Failure`

`Failure` keeps a literal exactly as written, but `Success` widens it, as TypeScript does for any object: `Success({ status: 'queued' })` holds a `status` of type `string`. A later step that tells values apart by such a field then refuses it, often several steps from where the value was built. So give the type there, as in `Success<Queued>({ status: 'queued', jobId })`.

### `effectPipe`'s length

`effectPipe` is typed for up to 20 steps. A pipeline is itself a step, so a longer one nests, which is usually easier to read anyway: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Context

Every step's context counts, so a pipeline needs all the contexts its steps read, even when the first step reads none, and a `Parallel` needs every context its branches read. `runEffect` requires a context whenever the flow reads one, since the flow would otherwise get an empty object. Left out, it is reported as TypeScript's `Expected 2-3 arguments, but got 1` (`Expected 2 arguments` from `recordEffect`), which means the context is missing. It checks one passed as a variable against what the flow reads, as it checks one written in place, so a variable whose type lacks a field the flow reads does not compile. `recordEffect`, `replayEffect` and `timeTravel` check a context the same way, and `replayEffect` given a resolver requires one, since a resolver holds none.

### Generator flows

`yield* x` without `step`, reading a property of a step, and an `async function*` do not compile, and a body that returns an untyped value keeps its steps' errors. Returning a step or a Promise compiles, so that a generic helper returning a value of its type parameter does too, and fails when it runs. `yield step(x)` without the star does, and fails when it runs. Name the context `Ask()` reads as `Ask<AppContext>()`. Given a function, `Ask`'s first type argument is the value instead, so annotate the parameter: `Ask((ctx: AppContext) => ...)`.

### Walking a flow in a test

For a step that returns its Command directly, as in `ensureEmailAvailable(input).next(found)`, `next` is checked against what the Command's function returns. So where [Testing Without Mocks](README.md#testing-without-mocks) passes `{ id: 1 }` for a user that was found, a TypeScript test passes a whole user, of the type `db.findUser` returns. A Command reached any other way, by walking the whole flow or through an `Ask`'s `next`, accepts any value, since its type does not say which Command it is.
