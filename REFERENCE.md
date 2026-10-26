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

- `cmd`: the function, sync or async, that does the I/O. Inside a `Parallel` branch, one that declares a parameter without a default value gets an `AbortSignal` that fires when a sibling fails; see [Cancellation and the signal](#cancellation-and-the-signal).
- `next`: receives `cmd`'s result and returns the next Effect; by default `(result) => Success(result)`. Whatever `cmd` returns is the result, an Effect included: a `Failure` it returns reaches `next` as a value and stops nothing.
- `meta`: metadata passed to `onBeforeCommand`, with any keys your hooks need. A non-empty string `meta.name` names the Command; any other `name` is ignored, and the function's name is used. With no `next`, `meta` can come second, as in `Command(cmdFn, { name: 'chargeCard' })`. Given both second and third, the Command throws.

**Every Command needs a name**, which tests, traces, replay matching and telemetry all use. It is `meta.name`, else the function's name, else `'anonymous'`:

```js
Command(cmdFn, next, { name: 'chargeCard' }); // 1. meta.name, independent of how cmdFn was written
Command(cmdFn, { name: 'chargeCard' }); // 1. the same, for a Command with no next
Command(function cmdChargeCard() {
    return api.charge();
}, next); // 2. the function's own name
Command(() => api.charge(), next); // 3. neither, so 'anonymous', which a replay refuses
```

- Use `meta.name` in code that gets minified, since a minifier renames functions and with them every step in every trace.
- Otherwise naming the function is enough. An arrow assigned to a `const` first, as in `const cmdChargeCard = () => api.charge()`, takes the `const`'s name.
- An inline arrow does not. A replay tells steps apart by name, so two `'anonymous'` Commands that a refactor swapped would each be handed the other's recorded result. A replay therefore stops at a Command with no name, in a `Failure` holding a `ReplayError` whose `path` says where; a live run is unaffected.
- To replay a trace recorded while a Command was unnamed, give it `meta.name: 'anonymous'`, which counts as a name.

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

#### The fallback

Every attempt and the fallback are recorded, so a replay repeats the same failures and the same fallback, without the delays. A fallback never starts in a `Parallel` branch that has already been cancelled. With `onExhausted` set, the fallback's error type takes the place of `RetryExhaustedError` in the TypeScript error union.

#### Exhaustion in TypeScript

In TypeScript, a `Retry` adds `RetryExhaustedError` to the error union, beside the errors of the steps it wraps. `lastError` is typed `unknown`, since it is whatever the Command's function threw, so check it before using it, for example with `instanceof Error`. Tell your own error classes apart by `name`, as in `lastError instanceof Error && lastError.name === 'HttpError'`: a replay hands back a plain `Error`, so `instanceof HttpError` would take another branch there and stop at a `TimeParadox`.

#### What an attempt runs again

`Retry` repeats everything it wraps, including a Command's `next`. Commands that already succeeded run again, and a retried Command whose `next` continues the flow repeats the rest of the flow with it. Wrap only the Command that fails, and continue in a later step; see [Retrying Transient Failures](README.md#retrying-transient-failures). A function that catches its own error is never retried; see [Which Errors Are Data](README.md#which-errors-are-data).

### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`. Runs the branches at the same time and hands `next` their values in order; by default `(values) => Success(values)`. See [Running Effects in Parallel](README.md#running-effects-in-parallel).

- The first branch to fail cancels the others, and its `Failure` is the result, with `next` skipped. Which branch that is depends on timing, so it is recorded, and a replay returns the same one.
- A branch's Command gets an `AbortSignal` to pass to its I/O when its function declares a parameter without a default value; see [Cancellation and the signal](#cancellation-and-the-signal).
- The second argument is `next` or the options, so `Parallel(effects, { limit: 5 })` works; after the options, a third argument throws, as does a fourth after `next` and the options.
- `limit`: the most branches running at once, a positive integer. Results and recorded paths stay in array order, so it changes only the pacing.
- `settled`: run every branch to the end and hand `next` one `Success` or `Failure` per branch, in array order, so no branch cancels the others or fails the `Parallel`. A bug still rejects the run: a step or `next` that throws, or returns something other than an Effect, is not a branch outcome.

#### `settled`, `limit` and outcomes

In TypeScript, write `settled: true` where you call `Parallel`, or mark a shared options object `as const`. Since `settled` decides what `next` receives, a value the compiler only knows as `true` or `false` is refused.

The outcomes are plain `Success` and `Failure` objects. Returning one of them from `next` is the same as returning any other `Failure`: the flow stops, and `Retry` does not run it again.

`limit` caps how many branches run at once; the rest start as others finish. Results and recorded paths stay in array order, so a limit changes only the pacing, and a trace recorded with a limit replays the same without one. A `limit` that is not a positive integer throws an `EffectTypeError` where the `Parallel` is built.

#### Cancellation and the signal

A cancelled branch starts no new Commands, but a function that ignores its `AbortSignal`, or is never given one, runs to the end. So a branch whose _first_ Command is a write can still write after another branch has failed. `Parallel` waits for every branch before it returns. A `Retry` inside a cancelled branch stops retrying. Outside a `Parallel`, a Command's function is called with no arguments. Since the signal is then `undefined`, TypeScript types it `AbortSignal | undefined`, and under `exactOptionalPropertyTypes` pass it to `fetch` as `{ signal: signal ?? null }`.

A function gets the signal only when it declares a parameter without a default value. One written as `(...args)` or `({ signal } = {})`, or wrapped by a helper that hides its parameters, gets none, so once started it runs to the end. A parameter with a default value does not count, so `Command(nanoid)`, whose size is written `size = 21`, works everywhere.

That rule catches a function passed by name whose first parameter is optional and has no default. `function listUsers(page) { page ??= 1; return db.users(page); }` gets the signal as its page inside a `Parallel`, and nothing outside one. Wrap such a function, as in `Command(() => listUsers())`. In TypeScript, a function whose first parameter cannot be an `AbortSignal` does not compile as a Command.

#### Undoing under `settled`

A settled `Parallel` cancels nothing, so both steps always run to the end, and the undoing starts once both have finished. The undo steps are part of the flow, so a trace records them and a replay repeats them. An undo step that fails ends the flow with its own error rather than the original one; wrap it in `Retry` if it can fail for a moment.

Under `settled`, a branch whose Command throws reaches `next` as a `Failure`, so the undo still runs. When one call follows another instead, as a shipment follows a charge, the later Command's function has to catch its own error and return it as data: a throw stops the flow before its `next` runs, and the charge stays. [Translating `try`/`catch`](README.md#translating-trycatch) shows that shape.

#### Loops

A generator flow's `for` loop and a `Parallel` over the list record differently, so a trace recorded from one replays against the other as a `TimeParadox`. When a Command's function gets a whole list by paging, a trace records the finished list as that step's result, and a replay hands the list back without replaying the pages. A `Retry` around the Command starts again from the first page.

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

In TypeScript, most of these do not compile; see [Generator flows](#generator-flows).

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

- `context`: what `Ask` reads, also passed to `onBeforeCommand`. Anything but an object or `null` makes `runEffect` reject with a `TypeError` before the run, and the `context` option of `recordEffect`, `replayEffect` and `timeTravel` is checked the same way.
- `callConfig`: `onStep`, `onRun` and `onBeforeCommand` for this call only, added to the configured hooks, or used alone with `inherit: false`; see [Hooks](README.md#hooks).
- `callConfig.flowName`: a string naming the run, which `onRun` receives, so a recorder's trace and a telemetry span carry it. Left out, the name is `''`. `configureEffect` refuses it, since a name belongs to one run.
- A throw from a Command's function, or an `onBeforeCommand` veto, ends the run with a `Failure` holding the error thrown; under a `Retry` that gave up, it holds `{ retryExhausted, lastError, retries }`.
- A malformed flow, or a throw from a `next` or a pure step, is a bug. The call that builds the flow throws it before the first Command, and `runEffect` rejects with it after.

#### The context

A trace records the context once, as the run starts, but `Ask` hands the flow the object you passed. A change made to it during a run reaches the live run and not the trace, so a replay sees the value as it was at the start. So a value that can change while a run is under way, such as a switch an operator can flip to stop a batch, belongs in a Command, whose result the trace records each time. A context whose properties throw when read, as a lazy client's can, leaves the whole context out, and a replay then needs it passed in.

### `configureEffect(...configs)`

Adds a layer of hooks for the whole process and returns a function that removes that layer only. See [Hooks](README.md#hooks).

- Several configurations passed to one call form one layer.
- `configureEffect()` with no arguments removes every layer, and a call whose arguments are all `undefined` changes nothing.
- Throws a `TypeError`, before installing anything, for a configuration that is not an object, a key other than the three below (`retry` included), or a hook that is not a function (`null` included).
- `onRun(op, flowName, initialInput, context)`: wraps the whole run once, retries included. It must `await op()` and return its result; anything but a `Success` or `Failure` rejects the run with a `TypeError`. `flowName` is the run's `callConfig.flowName`, or `''`. `initialInput` is what the flow was called with when `effectPipe` or `effectGen` built it, and `undefined` otherwise. `context` is what `Ask` reads, `{}` when the run was given none. Pass all three on to any hook it calls.
- `onStep(name, type, op, path)`: wraps each Command, and each `Parallel` with `name` and `type` both `'Parallel'`. It must `await op()` and return its result, and pass `path` on to any hook it calls, since a replay matches steps on it.
    - For a Command, `op()` returns a promise, even for a synchronous function. Returning a value without calling `op()` answers for the Command, which is how replay works, and throwing without calling it counts as the Command failing.
    - A throw after `op()` succeeded, or `undefined` in place of its value (a forgotten `return` or `await`), is a bug in the hook: the run rejects, and `Retry` does not run the Command again.
    - For a `Parallel`, `op()` runs the branches, so a hook must call it or the run rejects with a `TypeError`. It returns which branch, if any, cancelled the others, and how many branches there were and whether it was settled, as in `{ cancelled: true, branch: 0, branches: 2, settled: false }`. A branch that threw adds `threw: true`.
- `onBeforeCommand(command, context)`: runs before each Command. A throw vetoes the Command: the run returns a `Failure` carrying the thrown error, and `Retry` does not retry it. A vetoed Command leaves no entry in a trace, so a replay of that run fails where it was vetoed; see [Errors no branch returned](#errors-no-branch-returned).

#### Per-call hooks

Hooks passed as `runEffect`'s third argument are merged with the configured ones by the same rules: the configured wrappers run outside them, and the configured `onBeforeCommand` hooks run first. `inherit: false` leaves the configured hooks out. With configured hooks `C` and a call `K` that supplies only `onStep`:

```
                  inherit: true (default)        inherit: false

onRun             C.onRun                        (none)
onBeforeCommand   C.onBeforeCommand              (none)
onStep            C.onStep( K.onStep( cmd ) )    K.onStep
```

`recordEffect` inherits, so recording inside an application that already traces still produces spans. `replayEffect` passes `inherit: false` unless `hooks: true`.

## Recording and replay

### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`, a hook that records every step of a run, passed as `runEffect(flow, context, { onStep })`. Give each run its own recorder: one shared by a whole application mixes requests into one trace, which a replay refuses. `recordEffect` and the [flight recorder](#pure-effectflight-recorder) both do this for you.

- `onStep`: the hook. Recording never changes a run's outcome.
- `entries`: the steps recorded so far, one per Command and one per `Parallel`. A replay matches each on its `path`, the step's position in the flow.

```text
{ command, path, result, durationMs }                                    a Command that returned
{ command, path, threw: true, error, durationMs }                        a Command that threw
{ command: 'Parallel', path, result: { cancelled, branch, branches, settled }, durationMs }
                                                                         which branch, if any, cancelled the others, how many
                                                                         branches there were, and whether it was settled;
                                                                         'threw: true' in 'result' when a branch threw
{ command, path, unrecorded, durationMs }                                a Command whose result or error could not be recorded,
                                                                         because 'redact' threw on it or the 'copy' failed
```

- An older entry with `error` and no `threw` still counts as a throw.
- `toTrace(meta)`: the entries as a trace, with `meta`'s `initialInput`, `context`, `flowName` and `version`, copied into the form JSON stores when it is called. If a Command can change the input or the context, as an ORM save that adds an id does, call it before the run as well, as `recordEffect` does.
- `options.redact(value, name, kind)`: returns what the trace stores in place of `value`. `kind` is `'result'`, `'error'`, `'initialInput'` or `'context'`, and `name` is the Command's name, or the kind. See [Keeping secrets out of a trace](README.md#keeping-secrets-out-of-a-trace).
- `options.maxEntries`: the most entries a trace keeps; the rest are counted in `dropped`, and a replay stops at the first step the trace lacks.
- `options.stack`: record stack traces for thrown errors (off by default).
- A value `redact` throws on or returns `undefined` for, or one JSON cannot hold, is left out and marked `unrecorded`: on its entry, or for the input and context in the trace's `unrecorded`, as in `{ context: 'copy' }`. A replay stops there with a `ReplayError` rather than hand the flow a stand-in. An error `redact` returns `undefined` for is recorded as a throw with nothing to show. See [What a trace keeps](#what-a-trace-keeps) for what a copy keeps.

#### What `redact` gets

`redact` gets a copy in the form the trace stores, so changing it in place is safe, and what it returns is stored in that form too. A thrown `Error` arrives as a plain object holding its `name`, `message` and own fields, and any object returned for it replays as an `Error`.

### `recordEffect(effect, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. The trace holds the flow's input when `effectPipe` or `effectGen` built it, so `timeTravel` can build the flow again. Accepts `recorder` options plus `context`, `flowName` and `version`; without a `context`, the trace records the empty one the run gets, which `redact` is not handed. For tests and scripts; to record an application without changing call sites, use the [flight recorder](#pure-effectflight-recorder), which gives each run its own recorder.

- A run whose own code throws makes it reject without a trace. The flight recorder keeps the trace of such a run; see [`pure-effect/flight-recorder`](#pure-effectflight-recorder).

### `replayEffect(effect, traceOrResolver, options?)`

Runs a flow with each Command answered from a trace instead of run, and returns `{ result, unreached }`: the flow's outcome, and the recorded steps it never asked for. See [Time-Travel Debugging](README.md#time-travel-debugging).

- A flow that no longer matches the trace ends in a `Failure` whose `error` is a `TimeParadox`, or a `ReplayError` for a step the trace lacks. Neither is thrown, so a test checks `error.name`. In TypeScript, a result's error includes `Error`, which both are, so cast it directly, as in `result.error as ReplayFault`; `ReplayFault` types `name` and the fields locating the stop, such as `path`.
- A malformed trace rejects with a `ReplayError`.
- A Command with no name, neither `meta.name` nor a function name, stops the replay in a `Failure` holding a `ReplayError` with its `path` and `command: 'anonymous'`, with a trace or a resolver; see [`Command`](#commandcmdfn-nextfn-meta).
- `traceOrResolver`: a trace, its bare entries, or a resolver: a function that answers each step with `{ result }`, `{ error }`, or `undefined` for a step it has no record of. See [Testing a whole flow](README.md#testing-a-whole-flow) and [Replaying from your own storage](README.md#replaying-from-your-own-storage).
- Any other answer from a resolver, `null` included, or a throw from it, rejects the replay. With a resolver, `unreached` is absent.
- A resolver is also asked about each `Parallel`, with `step.type` set to `'Parallel'`. Answering with the recorded cancellation as `{ result }` replays it as production decided, and a recorded decision whose number of branches or `settled` differs from the flow's is a `TimeParadox`. Answering `undefined` or `{ error }` replays it by timing.
- `options.context`: the context for `Ask`, by default the one the trace recorded. A resolver has none, so pass one if the flow reads `Ask`: a replay that reaches an `Ask` with no context, from a resolver or a trace that recorded none, stops with a `ReplayError`. A trace whose context could not be recorded refuses to replay without one.
- `options.onMissing`: `'throw'` (default) stops at a step the trace lacks; `'execute'` runs its Command for real, so use it only where Commands reach test doubles or only read.
- A trace that dropped entries refuses `'execute'`. A flow that changed shape, as when a Command is newly wrapped in `Retry` or moved into a new `Parallel` branch, stops at a `TimeParadox` even under `'execute'`. An attempt past the last one the trace recorded for its `Retry` never runs live either: it is a `TimeParadox` when the trace holds the fallback Command the `Retry` gave up to, and otherwise a `ReplayError`, since a hook that vetoed that attempt leaves the same trace.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the configured hooks, a configured recorder included, so they see the replayed steps. Off, a replay cannot reach a telemetry backend or a trace sink.
- `options.onResolved(step, outcome)`: observes each replayed step. A throw stops the replay, and `replayEffect` rejects with it; it never changes an outcome.
- A trace whose entries have no `path`, written by hand or recorded before paths existed, is matched in order, and a Command inside a `Parallel` is refused with a `ReplayError`.

#### What ends a replay

A step the trace lacks ends the replay in a `Failure` holding a `ReplayError`. A trace lacks a step that comes after the end of the recording, one a hook vetoed in production, and one the recorder dropped under `maxEntries`. An empty `unreached` catches a removed step only when it is the last one the flow reaches. Remove a step from the middle and every later step moves to a different path, so the replay stops at a `TimeParadox`, and `unreached` lists the steps it never got to.

#### How errors come back

A replayed `Failure` compares equal to the recorded one when the Command threw a plain `Error`. It comes back with its message, name, cause, custom properties and an `AggregateError`'s list of errors, even a `name` or `cause` set after it was created. An error of any other class, built-in ones included, comes back as a plain `Error` carrying that class's name. So `deepEqual` from `node:assert/strict` refuses the replayed `TypeError` that `fetch` rejects with when the network fails. Where a Command can throw one, compare `error.name` and `error.message` instead.

#### Timing

A stale read replays exactly. A race between two requests does not, because a trace records one flow. Nor does a race between branches that share state: branches replay with the results they saw, not the order they ran in. A cancelled generator branch can stop one step later in a replay; see [Replaying a cancelled `Parallel`](#replaying-a-cancelled-parallel).

### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates it as a tree of the flow, each Command under the `Parallel` branch or `Retry` attempt it ran in, with its recorded duration to a tenth of a millisecond (`<0.1ms` for a faster step). Returns `{ result, unreached }`, as `replayEffect` does for a trace.

- Names any recorded steps that were never reached.
- Warns when the trace's `version` differs from `options.version`, and when steps are named `'anonymous'`.
- Refuses a trace whose input could not be recorded, since the flow is rebuilt from it.
- `options.context` overrides the trace's; `options.log` replaces `console.log`.

### `pure-effect/flight-recorder`

The flight recorder, a second entry point, records every run of an application with one recorder per run: `import { enableRecording, recordingHooks } from 'pure-effect/flight-recorder'`. For one run in a test or a script, use `recordEffect`. It needs `AsyncLocalStorage` from `node:async_hooks`, so it runs in Node, Deno, Bun, and Cloudflare Workers with `nodejs_compat`, not in a browser. In TypeScript, it needs `moduleResolution` set to `node16`, `nodenext` or `bundler`.

- `recordingHooks(options?)`: returns the configuration that records each run, to pass to `configureEffect` beside your other hooks.
- `enableRecording(options?)`: installs that configuration, and returns a function that removes it.

Options, each optional:

- `sink`: receives each kept trace, to write to S3 or a database. Hand slow writes to a queue rather than awaiting them inside a request.
- `keep`: decides which runs reach the sink, from the outcome and the trace's entries. See below.
- `redact`: scrubs every value before it enters the trace, as `recorder`'s does.
- `maxEntries`: caps a trace's length, 500 by default.
- `stack`: records stack traces for thrown errors.
- `version`: a commit or build id attached to each trace, so `timeTravel` warns when it replays a trace against another build.
- `onSinkError`: receives an error thrown by `keep` or `sink`. Defaults to `console.error`.
- `onWarning`: receives a warning, once per flow, about a kept trace that will not replay as recorded. Defaults to `console.warn`.

What the flight recorder does with each run:

- **Which runs it keeps.** `keep` decides, from the run's outcome and its trace's entries. By default it keeps a run that ended in a `Failure` or in which a Command threw, as one that succeeded on a retry or went to a dead-letter fallback did, and discards the rest after holding them in memory. A settled `Parallel` hands its failures to `next`, an `onBeforeCommand` veto among them, so a batch whose items failed or were vetoed ends in a `Success` with nothing thrown; keep it with a `keep` that reads the result, such as `(result, entries) => result.type === 'Failure' || result.value.failed > 0`. Return `true` to keep everything, or sample.
- **When your own code throws.** A `TypeError` after an API changed the shape of its response, say, makes the run reject. `keep` is offered a `Failure` carrying the thrown error, so by default its trace is kept, and replaying it reproduces the throw. A step before the flow's first Command runs when the flow is built, outside `runEffect`, so its throw reaches no hook and is not recorded. That run did no I/O, so its input reproduces it.
- **What a trace holds.** `redact` runs before anything enters the trace, including the stored `initialInput` and `context`. A value it throws on, or one JSON cannot hold, such as a `BigInt`, is left out and marked `unrecorded`, and a replay stops there. Everything else is already in the form JSON holds, so the sink can write it to S3 or a database column with `JSON.stringify`.
- **How long a trace gets.** `maxEntries` caps it and reports the overflow as `dropped`, and a capped trace replays only up to the first step it lacks.
- **When storage fails.** If `keep` or the sink throws, for example because storage is unreachable, the run keeps its own outcome and the error goes to `onSinkError`, which defaults to `console.error`.
- **What it warns about.** The flight recorder warns through `onWarning`, once per flow, when it keeps a trace that was capped, one holding values it could not record, or one whose steps include any named `'anonymous'`.

The flight recorder takes the input from `onRun`, which is handed it only for a flow `effectPipe` or `effectGen` built, so build the outermost flow with one of them. A flow that starts with a bare `Command`, `Ask`, `Retry`, or `Parallel` records no input, and `timeTravel` would rebuild it from `undefined`. A one-step pipeline is enough, as in `runEffect(effectPipe(loadProfile)(userId))`. It warns through `onWarning`, which defaults to `console.warn`, the first time it keeps a trace of such a flow, and `timeTravel` warns when it replays one.

The flight recorder takes the context from `onRun` too, as the run starts, so a run that stops before its first Command, such as one a permission check refuses, still records it.

### What a trace keeps

A value is copied into the form JSON stores when it is recorded, and again each time a replay hands it to the flow, so neither a later step nor a replay can change what the trace says, and a replay from memory gets what a replay from storage gets. The copy keeps values but not classes:

| Recorded                            | Replayed as                                         |
| ----------------------------------- | --------------------------------------------------- |
| a money object or a database entity | a plain object, without its methods                 |
| a `Date`                            | a string                                            |
| a `Map` or a `Set`                  | `{}`                                                |
| a `Buffer`                          | `{ type: 'Buffer', data }`                          |
| `undefined` in an array             | `null`                                              |
| an error returned inside a result   | its own fields, such as `code`, without its message |

A reference back to an object the value is inside of, as between an HTTP client's request and response, is cut. A value JSON cannot hold at all, such as a `BigInt` or an object whose getter throws, is left out of the trace and marked `unrecorded` before `redact` sees it. So a context holding a lazy client is left out whole.

## TypeScript

### Typing what a Command returns

To type what a Command's function returns, such as a JSON response, write the function's result type, as in `Command((): Promise<User | null> => fetchJson(url), next)`. `Command<User | null>(…)` also compiles, but with some type arguments given TypeScript infers none of the others, so that Command's errors are typed `unknown`, which hides the rest of the union.

### A result's error

- `runEffect`, `recordEffect` and `replayEffect` type a `Failure`'s error as the union the flow's steps declare plus `Error`, for what a Command's function threw or an `onBeforeCommand` veto threw. A settled `Parallel` types each outcome's error the same way. A step's own `Effect<T, E, Ctx>` keeps only `E`.
- `result.error instanceof Error` narrows to `Error`, and its other side to the declared union, so the check comes before reading a field of a domain error. A domain error shaped like an `Error`, with a `name` and a `message`, stays on the union's side.
- A domain error that is a class extending `Error` lands on the `Error` side too, so check for it with its own `instanceof` first.
- A thrown value that is not an `Error`, as `throw 'boom'` is, is typed `Error` but fails the check at runtime, so throw `Error`s.
- Under a `Retry`, a throw becomes `RetryExhaustedError` once the attempts run out, so an `Error` there comes from an `onBeforeCommand` veto.

### Literals in `Success` and `Failure`

`Failure` keeps a literal exactly as written, but `Success` widens it, as TypeScript does for any object: `Success({ status: 'queued' })` holds a `status` of type `string`. A later step that tells values apart by such a field then refuses it, often several steps from where the value was built. So give the type there, as in `Success<Queued>({ status: 'queued', jobId })`.

### `effectPipe`'s length

`effectPipe` is typed for up to 20 steps. A pipeline is itself a step, so a longer one nests, which is usually easier to read anyway: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Context

Every step's context counts, so a pipeline needs all the contexts its steps read, even when the first step reads none, and a `Parallel` needs every context its branches read. `runEffect` requires a context whenever the flow reads one, since the flow would otherwise get an empty object. Left out, it is reported as TypeScript's `Expected 2-3 arguments, but got 1` (`Expected 2 arguments` from `recordEffect`), which means the context is missing. It checks one passed as a variable against what the flow reads, as it checks one written in place, so a variable whose type lacks a field the flow reads does not compile. `recordEffect`, `replayEffect` and `timeTravel` check a context the same way, and `replayEffect` given a resolver requires one, since a resolver holds none.

Name the context `Ask()` reads as `Ask<AppContext>()`. Given a function, `Ask`'s first type argument is the value instead, so `Ask<AppContext>((ctx) => ...)` types `ctx` as `unknown` and reports `'ctx' is of type 'unknown'`. Annotate the parameter, `Ask((ctx: AppContext) => ...)`, and the rest is inferred, or give all three: `Ask<Value, Error, AppContext>`.

### Generator flows

`yield* x` without `step`, a bare `yield` of an Effect, reading a property of a step, and an `async function*` do not compile; the error for a bare `yield` ends by naming `yield* step(effect)`, and a body that returns an untyped value keeps its steps' errors. Returning a step or a Promise compiles, so that a generic helper returning a value of its type parameter does too, and fails when it runs. `yield step(x)` without the star does, and fails when it runs.

### Walking a flow in a test

For a step that returns its Command directly, as in `ensureEmailAvailable(input).next(found)`, `next` is checked against what the Command's function returns. So where [Testing Without Mocks](README.md#testing-without-mocks) passes `{ id: 1 }` for a user that was found, a TypeScript test passes a whole user, of the type `db.findUser` returns. A Command reached any other way, by walking the whole flow or through an `Ask`'s `next`, accepts any value, since its type does not say which Command it is.
