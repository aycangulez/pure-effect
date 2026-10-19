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
- `onBeforeCommand(command, context)`: runs before each Command. A throw vetoes the Command: the run returns a `Failure` carrying the thrown error, and `Retry` does not retry it. A vetoed Command leaves no entry in a trace, so a replay of that run fails where it was vetoed; see [Errors no branch returned](README.md#errors-no-branch-returned).

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

The fine print of the bundled declarations.
