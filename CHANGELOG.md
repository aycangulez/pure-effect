# Changelog

All notable changes to pure-effect are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and from 1.0.0 the project follows [Semantic Versioning](https://semver.org/). Before 1.0.0 a minor version could change behaviour; each such change is marked below.

## [Unreleased]

### Changed

- **A `Failure` carries only its error, and the flow's input goes to `onRun`.** Every `Failure` carried `initialInput`, the input the flow was called with, so a `Failure` from a flow compared unequal to the same one from a step tested alone, and logging a `Failure`, or the outcomes a settled `Parallel` hands `next`, logged the input too, which for a registration is its credentials. A `Failure` is now `{ type: 'Failure', error }` wherever it comes from, `Failure` takes one argument, and no part of a flow carries the input. An `onRun` hook receives it as a fourth argument, `onRun(effect, op, flowName, initialInput)`, for a flow `effectPipe` built, and a hook that calls another passes it on. An `onRun` hook that read `effect.initialInput` reads that argument instead, and code that read `result.initialInput` uses the input it called the flow with. An assertion written as `Failure(error, input)` still passes, since the second argument is ignored, but TypeScript refuses it.
- **A hook configuration is checked.** `configureEffect` and a per-call `callConfig` ignored a key they do not read, so a misspelt `onstep` switched its hook off without a word, and accepted a hook that is not a function, so `onStep: 42` turned every Command into an I/O fault that `Retry` retried and reported as exhausted, without the Command ever running. A key other than `onStep`, `onRun` and `onBeforeCommand` (and `inherit` in a `callConfig`), a hook that is not a function, and a configuration that is not an object now throw a `TypeError`: from `configureEffect` before anything is installed, and from `runEffect` before the run. Only `undefined` leaves a configuration or a hook out: `null`, `false`, `0` and `''`, which `configureEffect` skipped, now throw as well, as the types already refused them.
- **An option value a function cannot use throws, and `Retry` and `Parallel` check theirs where they are built.** An option's name was checked and its value was not, except `Retry`'s, which threw a `TypeError` only when the `Retry` ran, after the Commands ahead of it. So `Parallel(batch, { settled: 'false' })` ran the batch settled, `recorder({ maxEntries: null })` kept no entries, `stack: 'no'` recorded stacks, `Retry(effect, { onExhausted: fetchCachedPrice(sku) })`, the Effect rather than a function returning it, ran with no fallback, and `replayEffect`'s `hooks: 'false'` was refused as `callConfig.inherit`. `Retry`'s `attempts`, `delay`, `backoff` and `onExhausted`, and `Parallel`'s `limit` and `settled`, now throw an `EffectTypeError` where the node is built, and again if they are changed before it runs; `recorder`, `recordEffect`, `replayEffect` and `timeTravel` throw a `TypeError` naming the option. A test that expected a `TypeError` from `runEffect` for a bad `attempts`, `delay`, `backoff` or `limit` now gets an `EffectTypeError` from the constructor. `maxEntries` takes a positive integer or `Infinity`, so `0` and a numeric string are refused too. An option set to `undefined` still keeps its default.
- **A replay of a flow that changed shape around a `Retry` or `Parallel` stops at a `TimeParadox`.** A step added in front of a recorded `Retry` or `Parallel`, a step removed in front of one, and a Command newly wrapped in `Retry` all asked for a path the trace never had, so the replay ended in a `ReplayError` for a missing step, and `onMissing: 'execute'` ran the reshaped steps for real. Such a replay now ends in a `TimeParadox` at the position where the trace recorded another kind of node, with `expected` and `actual` naming each side, and runs nothing live. A step past the end of the recording is still a missing step.

### Fixed

- **Recording no longer changes a run through a value it cannot clone.** A value `structuredClone` refuses, such as an instance of a class with an arrow-function field, was kept as it was rather than copied, so `redact` was handed the object the run held, and one that deleted a field in place, as `delete value.password` does, changed what the run's `next` received. The trace held that live object too, so a later change to it rewrote what the trace said the step returned, and a replay from memory handed the flow the same object. Such a value is now rebuilt as plain data, as `structuredClone` rebuilds an instance it can copy, and only a function or a getter that throws is kept as it is. A replay from memory gets that plain data, as one from JSON does, so a context holding a logger replays without the logger's methods.
- **A `Resolver` that throws, or answers with anything but an outcome or `undefined`, rejects the replay.** Either counted as the Command failing: a `Resolver` that answered `null` for a step it had no record of made a `Retry` ask again for attempts production never made and then run its fallback, so the replay reported a `Success` production never had, and one that answered `{}` replayed the Command as returning `undefined`. The replay now rejects with what the `Resolver` threw, or with a `TypeError` naming the step and the answer, as it does for a throw from `onResolved`. A `Resolver` that answered a `Parallel`'s step with `null` replayed it by timing and is refused too; `undefined` still means no record.
- **A value the recorder cannot record is left out of the trace and marked, and a replay stops there.** A value `redact` threw on was stored as `'[redaction failed]'`, and a replay handed that string to the flow as what production saw, so a `redact` that read a field of a lookup that found nothing replayed the lookup as one that found something, with no error. A value the recorder could not copy, such as a thrown error whose `cause` getter throws, lost its whole entry: the trace lacked a step production ran, `dropped` stayed 0, and a replay under `onMissing: 'execute'` ran the step again for real. Such a step's entry now holds no `result` or `error` and is marked with why, `unrecorded: 'redact'` or `unrecorded: 'copy'`, and a replay stops at it with a `ReplayError` naming the cause, even under `onMissing: 'execute'`. An `initialInput` or `context` the recorder cannot record is left out, and the trace's new `unrecorded` field says why, as in `{ context: 'copy' }`; `timeTravel` refuses a trace without its input, and `replayEffect` one without its context unless `options.context` is passed. The run still keeps its own outcome. A trace recorded before this change still holds the string.
- **An input or context the recorder cannot copy no longer decides the run.** `toTrace` threw on a getter that throws when read, such as a lazy client's, although a part that cannot be copied is documented as kept as it is, so `recordEffect` rejected before running the flow, and the reference recording wiring vetoed the run's first Command and failed the run. Such a property is now kept as it is, and `toTrace` never throws: an input or context whose copy fails outright, such as a `Proxy` that refuses to list its keys, is left out and marked `unrecorded`, so `recordEffect` runs the flow and the wiring lets the run go on and warns through `onWarning`.
- **An error `redact` rebuilt replays as an `Error`.** A `redact` that returned a fresh object for a thrown error, such as `{ name: value.name, message: value.message }`, dropped the mark that told a replay the value was an `Error`, so production handed the flow an `Error` and the replay a plain object, with nothing to say so. The recorder now keeps any object `redact` returns for a thrown `Error` marked as one, and drops the fields it left `undefined`, as JSON does, so a replay from memory matches one from storage. A value that is not an object, such as `'[redacted]'`, is stored and replayed as it is.
- **An option or hook set to `undefined` compiles under `exactOptionalPropertyTypes`.** Such an option keeps its default, as the README says, but with that compiler flag on the declarations refused it, so `Retry(command, { attempts: config.attempts })`, with `attempts` read from configuration as `number | undefined`, failed to compile, and so did a TypeScript project that copied the recording example, which passes `redact` and `stack` on as it gets them. The options of `Retry`, `Parallel`, `recorder`, `recordEffect`, `replayEffect` and `timeTravel`, the hooks given to `configureEffect` or a `callConfig`, `inherit`, and the `flowName` of a context or of `toTrace` now take `undefined`. The telemetry example no longer sets a span status `message` to `undefined`, which OpenTelemetry's types refuse under the same flag.

## [0.17.0] - 2026-10-06

### Changed

- **Inside a `Parallel`, a Command's function gets the `AbortSignal` only if it takes a parameter.** Every function was handed the signal, so one passed by name whose first parameter has a default value read the signal in its place: `Command(nanoid)` returned an empty ID inside a `Parallel` and a full one outside, and a helper with a default page size got the signal as its page size. The signal now goes only to a function that declares a parameter, counted as `Function.length` counts them, which leaves out parameters with default values, so such a function keeps its default everywhere. A function that reads the signal through a parameter with a default value or through `...args`, or that a wrapper hides behind a `length` of 0, is no longer given it, and runs to completion when its branch is cancelled, as a function that ignores the signal does; write it as `(signal) => ...`. A plain first parameter that a function treats as optional still takes the signal, as before.
- **An `options` argument refuses a name it does not read.** `Retry`, `Parallel`, `recorder`, `recordEffect`, `replayEffect` and `timeTravel` ignored any other name, so a misspelt or borrowed one ran with the default and nothing said so: `Parallel(batch, { concurrency: 4 })`, the name p-limit uses, ran with no limit, `{ settle: true }` ran fail-fast so one bad record cancelled the batch, and `{ attemps: 5 }` got 3 attempts. Such a name now throws, naming it and the options the function reads; `Retry` and `Parallel` throw an `EffectTypeError` as the flow is built, the others a `TypeError`. TypeScript already refused most of them in an object literal written in the call. An option set to `undefined` is still accepted.
- **The message for a step a trace lacks says what `onMissing: 'execute'` would run.** It advised `'execute'` where the Commands only read, so a replay that met a newly added lookup could run it that way, and every step after it, which had moved to a new path, ran live too. The message now says so, and advises `'execute'` only where every Command the flow can still reach goes to a test double or only reads.

### Fixed

- **An `onStep` hook that calls `op()` without awaiting it can no longer replace a Command's result with `undefined`.** A hook that returned `undefined` in place of the Command's value made the run reject, but the check ran as soon as the hook returned, while a Command that took any time was still running, so a found user still reached `next` as `undefined` and the flow took the branch for a missing one. The interpreter now waits for a Command the hook left running before it judges the step: the run rejects if the Command returned a value, a throw from it is an I/O fault, as it is for a hook that awaited `op`, and nothing is left running unobserved.
- **`timeTravel` warns about unreached steps after a flow's own error named like a replay error.** It recognized its own replay errors by name, so a flow that ended on an error of its own named `ReplayError` or `TimeParadox` lost the warning about recorded steps it never reached. It now recognizes only the errors the library raises.

## [0.16.0] - 2026-10-01

### Added

- **`commandName` gives a Command's name as a trace records it:** `meta.name`, else the function's name, else `'anonymous'`. A test that walks a flow checks each step with it. Reading `step.cmd.name`, as the README's tests did, could not check a Command named through `meta.name` whose function is an inline arrow, since such a function has no name. Anything but a Command throws an `EffectTypeError`.
- **`timeTravel` warns about anonymous steps.** A trace whose steps include any named `'anonymous'`, usually inline arrow Commands, gets a warning in the narration, since a replay tells steps apart by name and two such steps that trade places after a refactor replay without complaint.
- **`recordEffect`'s trace keeps the input and context types.** `TraceLog` takes the input and context as type parameters, and `recordEffect` and `recorder().toTrace` fill them in, so `replayEffect(flow(trace.initialInput), trace)` needs no cast straight after recording. A trace read back from storage is typed as before.
- **`EffectValue`, `EffectError` and `EffectContext` read the value, error and context of an Effect**, as in `EffectError<ReturnType<typeof checkoutFlow>>`. `Parallel`'s declaration is built on them, alongside `ParallelBranches`, `ParallelValues` and `ParallelContext`.

### Changed

- **`replayEffect` refuses `onMissing: 'execute'` on a trace that dropped entries.** A trace whose `dropped` is above 0 now rejects with a `ReplayError` before anything runs; replay it without the option to stop at the first step it lacks, or record the flow with a higher `maxEntries`. The message for a missing step now says whether the cap may have dropped it, and `'execute'` is documented for Commands that reach test doubles or only read.
- **An error union survives a pipeline without return annotations.** A step that cannot return a `Failure`, such as a Command with the default `next`, a Command whose `next` only succeeds, or a pure step that only returns `Success`, declared its error as `unknown`, which absorbed every other step's. So the Quick Start written in TypeScript typed `result.error` as `unknown`, and so did every pipeline that retried a Command in the recommended shape. Such a step now declares `never`, and the union holds the `Failure`s the steps can return: `Retry(Command(fn))` declares `RetryExhaustedError` alone, and a `Retry` whose fallback cannot fail declares nothing of its own. A `Command` call that gives some type arguments, such as `Command<User | null>(fetchJson, next)`, keeps the types it had, since TypeScript infers none of the others in such a call. A `Command` without a `next` takes only its result's type as a type argument. `Ask` and `Retry` given only some type arguments, as in `Ask<Product>(...)`, now refuse a step that can fail; give every type argument or none. A variable that holds the results of two different flows, which both used to type as `FailureState<unknown>`, may need a wider annotation. A Command whose function throws still ends the run with a `Failure` the union does not name, so where a flow's declared error is now only strings, or nothing, `result.error instanceof Error` stops compiling: copy the error into a variable typed `unknown` first, as in `const error: unknown = result.error`.
- **A `Parallel` declares its branches' errors.** Its branches were typed with one shared error that nothing inferred, so every `Parallel` declared `unknown`, and so did every pipeline holding one, including every loop written as the README writes it. A `Parallel` now declares each branch's error together with what `next` can return, and each outcome a settled `Parallel` hands `next` carries its own branch's error. A settled `Parallel` declares only `next`'s error, since a branch's failure reaches `next` as an outcome rather than escaping. `ParallelOutcomes` takes the branches instead of the values and one error, so `ParallelOutcomes<[User, Order], MyError>` is now written `ParallelOutcomes<[Effect<User, MyError>, Effect<Order, MyError>]>`, and `ParallelState` takes a sixth, optional parameter for the branches' error. `Parallel`'s type parameter is now the branches rather than their values, so an explicit `Parallel<[number]>(...)` stops compiling; leave it to be inferred.
- **The type declarations need TypeScript 5.1 or later.** The new `Parallel` declaration relies on 5.1, the first version that treats a mapped type over the branches as an array. TypeScript 5.1 is now checked on every change.
- **`Failure` keeps the literal type of its error.** Its type parameter is `const`, so `Failure('invalid_email')` is typed `'invalid_email'` rather than `string`, and an inferred error union stays exact with no `as const`. An object error is typed as readonly with literal properties, which is still assignable to a mutable object type, and an array error as a readonly tuple, which a mutable array type does not accept. A value typed `string` stays `string`.
- **A `next` that can only fail no longer widens a step's value.** `Command` with an explicit `next` declared its function's result as its value when `next` could only fail, and `Ask`, `Parallel` and `effectPipe` declared `unknown`, so a step that either succeeds or compensates and then fails, as in `ok ? Success(order) : Command(refund, () => Failure('declined'))`, did not compile in a pipeline, and a compensation written as a sub-pipeline failed the same way. Such a `next` now declares `never`, which adds nothing to the step's value.
- **`Parallel` refuses a third argument after its options.** Nothing reads a third argument once the options come second, so `Parallel(effects, { limit: 1 }, next)` ran without its `next` and handed the branch values on as they were, which only TypeScript refused. It now throws an `EffectTypeError` that gives the order, and so does a second options object passed there. `undefined` or `null` in that place still counts as absent.
- **An error for a `next` that returned something other than an Effect names whose `next` it was.** It said only that the flow or a continuation had returned it, so finding the culprit meant reading every `next`. It now reads, for example, `The next of Command 'cmdChargeCard' returned the number 2`, naming a Command by its name and an `Ask` or `Parallel` by its type.
- **Node 22 or later.** `engines` says `>=22`, where it said `>=18`: Node 18 and 20 have reached their end of life, and the tests run on 22, 24 and 26. Nothing in the library needs a newer Node, so code on an older one keeps running, but it is no longer tested there.

### Fixed

- **A `Parallel` requires the context its branches read.** The same shared type made its context `unknown`, so `runEffect` accepted a flow with no context, or the wrong one, whenever only a `Parallel`'s branches read it, and `Ask` then got an empty object: a query filtered on `ctx.tenant` received `undefined`. A `Parallel` now needs every context its branches and its `next` read, as a pipeline needs its steps', whether the branches are listed, built with `map`, settled, or inside a pipeline.
- **A function that returns `Failure`s of different shapes compiles without an annotation.** A pipeline step, a `next` given to `Command`, `Ask` or `Parallel`, or an `onExhausted` fallback that could fail with, say, `Failure('cart_empty')` and `Failure({ code: 'invalid_quantity', sku })` did not compile unless its return type was written out. Such a function is now typed from its whole return, so its errors join into a union, each kept as written, and its values join the same way. Explicit type arguments type a call as before. A step that returns something other than an Effect is now reported as not assignable to `AnyEffect`, the type every step returns.
- **A stored trace imported as a JSON module type-checks.** `TraceEntry.threw` was declared `true`, and a JSON import widens `true` to `boolean`, so `replayEffect(flow(incident.initialInput), incident)` with `incident` imported from a trace file was refused whenever the trace held a failed step, which is how the README turns an incident into a regression test. It is declared `boolean` now; the recorder still writes only `true`.
- **A typed context accepts `flowName`.** `runEffect`, `recordEffect`, `replayEffect` and `timeTravel` refused `{ tenant, flowName }` for a flow whose context type does not declare `flowName`, though that key is how a run is named in traces and spans, so the README's `recordEffect` example did not compile against a typed flow. The context they take is now `RunContext`, the flow's context with an optional `flowName`.
- **A test walking a flow through a `Retry` can hand its `next` what the retried Command returned.** A `Retry` that starts a pipeline typed its `next` as taking the pipeline's final value, although it receives the retried Command's, so such a walk did not compile without a cast. `RetryState` takes a fourth, optional parameter for the value `next` receives, which defaults to the first.

## [0.15.0] - 2026-09-27

### Added

- **`timeTravel` and the reference recording wiring warn about a trace with no input.** A recorder installed as a hook reads the input off the flow, where only `effectPipe` puts it, so a flow whose outermost node is a bare `Command`, `Ask`, `Retry` or `Parallel` recorded none, and `timeTravel` rebuilt it from `undefined` without saying so. `timeTravel` now logs a warning when a trace holds no `initialInput`, and `recordingHooks` reports the first kept trace of such a flow through a new `onWarning` option, once per flow, which defaults to `console.warn`.

### Changed

- **The building blocks check their arguments when the flow is built.** `Command`, `Ask`, `Retry`, `Parallel` and `effectPipe` throw an `EffectTypeError` naming the mistake for an argument they cannot use, before any of the flow's I/O runs. `Command(db.findUser(email))` made the query while the flow was being built and then counted as an I/O fault, so a `Retry` around it ran it again and a replay repeated it; `Command(fn, { name })` ran the function, charging the card, before the run rejected with `effect.next is not a function`; and an `effectPipe` step that was `undefined` failed only when the flow reached it. A flow that passed such an argument now throws where it is built. A `null` next counts as omitted in `Command`, as it does in `Parallel`.
- **An `onStep` hook that calls `op` and returns nothing makes the run reject.** A hook that awaited `op()` and forgot to return its result handed the flow `undefined` in place of the Command's value, so a metrics hook written that way turned an email that was taken into one that was free and saved a duplicate account, while a recorder installed inside it kept the real answer and the trace contradicted production. The run now rejects with a `TypeError` naming the Command when a hook returns `undefined` after the Command's function returned a value. A hook that returns a copy of the result, one that never calls `op`, as replay does, and one wrapping a Command that itself returned `undefined` are unaffected.
- **`Retry` treats an option set to `undefined` as unset, and refuses a wait it cannot keep.** An undefined option overrode its default, so `attempts: config.attempts` with the key absent threw, and `backoff: undefined` made every wait after the first `NaN` milliseconds, which is no wait: a flapping dependency was called back to back. An undefined option now keeps its default, and a `delay` or `backoff` that is not a finite number of 0 or more throws a `TypeError` when the `Retry` runs, as `attempts` already did. A `Retry` given `delay: -1`, `NaN`, or a string such as `'250'` now throws instead of waiting no time.
- **A replay that refuses to run an unrecorded step no longer recommends `onMissing: 'execute'` without a warning.** The message said to pass it, but a step with no entry may be one production never ran: a Command that an `onBeforeCommand` hook vetoed leaves no entry, so following that advice while replaying a rate-limited run performed the I/O the limiter had refused and replayed as `Success`. The message now says so, and names the option for a trace that was cut short, as by `maxEntries`.

### Fixed

- **A Command whose error's `cause` chain loops back is recorded.** Serializing the error followed the cause forever, and the stack overflow was dropped with the recorder's other failures, so the step vanished from the trace, `dropped` still said 0, and the replay reported a missing entry instead of the failure. A chain that comes back to an error it passed through is now cut there, and the step is recorded like any other.
- **An error whose `name` or `cause` was assigned replays as the same error.** `e.name = 'TimeoutError'` and `Object.assign(error, { name })` make `name` an own enumerable property, and revival always made it non-enumerable, so the README's check `assert.deepEqual(replayed, result)` failed on a plain `Error`. `e.cause = inner`, the idiom from before the `cause` option, lost the cause entirely: it was copied as the raw `Error`, which JSON stores as `{}`. Both now come back as the Command threw them.
- **`Parallel` keeps its options when `next` is passed as `undefined` or `null`.** The options were read from the second argument whenever it was not a function, so a call that forwarded an absent `next`, as in `Parallel(branches, config.summarize, { limit: 5, settled: true })`, lost them silently: every branch started at once, and one failing branch cancelled the rest of the batch instead of reaching `next` as an outcome. A skipped `next` now leaves the options third, where the documented signature `Parallel(effects, next?, options?)` puts them.

## [0.14.0] - 2026-09-24

### Added

- **`Parallel` takes options: `limit` and `settled`.** `Parallel(effects, { limit: 5 })` keeps at most five branches in flight, for a dependency that rate limits; results and recorded paths stay in array order, so a limit changes pacing and nothing else. `Parallel(effects, { settled: true })` runs every branch to completion and hands `next` one outcome per branch, `Success` or `Failure`, in array order, so a batch survives one bad record instead of being cancelled mid-flow by it. An `EffectTypeError` still escapes a settled `Parallel`, because a malformed flow is a bug rather than a branch outcome. The second argument is `next` or the options, whichever it looks like, so existing calls are untouched and neither form needs a placeholder.
- **`effectPipe` is typed for up to 20 steps.** It was 8, and a ninth step was a compile error. A pipeline is itself a step, so a longer one still nests: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Changed

- **`Retry` reacts to an I/O fault, not to an abort.** A `Failure` a step returned now propagates immediately, unretried and unwrapped, and `onExhausted` never sees it; only a Command whose function threw is retried. Previously both were retried, so a guard returning `Failure('email already in use')` cost four database round trips for an answer that could not change and arrived wrapped in `{ retryExhausted, lastError, attempts }`, and `onExhausted` could answer a deliberate abort and report `Success`. The rule this settles: you can recover from an error your I/O produced, and you cannot catch an abort. A value thrown by a Command's function is an I/O fault by definition, which is what the README already asked for when it said a domain outcome is returned rather than thrown.
- **A throw from a Command's `next` or a pure step rejects the run.** It used to become a `Failure`, and inside a `Retry` it was treated as an I/O fault, so a `TypeError` in pure code after a Command that had succeeded ran that Command again. It is now a bug in the flow, as a throw from any other continuation already was, and `runEffect` rejects with the error as thrown. A test or caller that expected a `Failure` for such a throw sees a rejection instead.
- **`onStep` also wraps each `Parallel`.** A `Parallel` is now one step, with `name` and `type` both `'Parallel'`, whose `op` runs the branches and returns which branch, if any, cancelled the others, even when a branch threw: the run rejects with the throw once the hook has returned. A hook must call `op` for it; one that returns without calling it makes the run reject with a `TypeError`. Telemetry gets a span per `Parallel` with its branches' Command spans inside it, and a trace gains one entry per `Parallel`, `{ command: 'Parallel', path, result }`, which `redact` is not asked about.
- **An `onStep` hook that throws after its Command succeeded rejects the run.** It used to count as the Command failing, so inside a `Retry` a telemetry hook whose exporter failed once a charge had gone through ran the charge again on every attempt. The Command's work is done at that point, so the throw is now a bug in the hook and `runEffect` rejects with it, as it does for a throw from `next`. A hook that throws without calling `op` still counts as the Command failing, which is how replay reports a recorded error.
- **`Retry`'s `attempts` must be a positive integer.** `0` now throws a `TypeError` naming the alternatives rather than meaning run once, because a `Retry` that does not retry is not a `Retry`. It was also the one spelling that turned `onExhausted` into a plain catch at no cost. To handle an outcome without retrying, branch on it as data in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.
- **A throwing `onBeforeCommand` is an abort.** The run still returns a `Failure` carrying the thrown error, but `Retry` no longer retries it and `onExhausted` never sees it, which is what the documented "throw to abort" meant.
- **The type declarations check a flow's context across the whole pipeline, and require it where it is read.** Each `effectPipe` step now has its own context type and the pipeline's is all of them together, so a step that reads no context no longer erases a later step's: a pipeline that validated its input before looking up a tenant accepted any context, including a wrong one. `runEffect` and `recordEffect` require a context when the flow reads one, where the runtime would have handed `Ask` an empty object. Code that passed no context, or the wrong one, to such a flow stops compiling.
- **A `settled` known only as a `boolean` matches no `Parallel` overload.** A shared options object widens `settled: true` to `boolean`, and so does a caller's `ParallelOptions`; either matched the overload that types `next` as the values, so a batch compiled while it read outcome objects as values. Write `settled: true` inline or add `as const`. An options variable typed `ParallelOptions` for its `limit` alone stops compiling too; type it `{ limit: number }` instead.
- **Hook types match what the runtime passes.** `onStep`'s `path`, `onRun`'s `flowName`, and a replay step's `path` are declared as present, since the runtime always passes them, so a wrapper that calls another `onStep` without passing `path` on stops compiling, where it used to record a trace that could not replay a `Parallel`. `onBeforeCommand` may be a plain function, since a guard that throws to abort needs no `async`. `recordEffect` checks its input against the flow's.
- **`op` always returns a promise.** A hook's `op()` handed back a synchronous Command's value as it was, although the declared type and the README's "must `await op()`" both say it returns a promise, so a hook written as `op().then(...)` compiled and then rejected every run with a synchronous Command. A hook that called `op()` without awaiting it and used the value directly now gets a promise.

### Fixed

- **A step that threw `undefined` replays as a throw after its trace has been through JSON.** A trace entry said a step threw by having an `error` key, and `JSON.stringify` drops a key whose value is `undefined`, so a Command that rejected with no reason, as `reject()` does, or whose error `redact` replaced with `undefined`, came back from storage as a step that returned `undefined`. The replay reported `Success` for a run that failed, a `Retry` that ran out of attempts replayed as succeeding at once, and under `onMissing: 'execute'` the replay ran the next Command live. Entries for a step that threw now carry `threw: true`. An entry with an `error` and no `threw`, as earlier traces have, still replays as a throw.
- **Recording no longer changes the run when `redact` edits a value in place.** `redact` was handed the live value: a Command's result before its `next` received it, a thrown error before the caller did, and the input and context the flow's Commands read. A redact written as `delete value.password` therefore saved users without a password and failed every correct login, but only while recording was installed. `redact` now receives a copy. A value that cannot be copied whole, such as a context holding a logger, is copied around the parts that cannot be copied, which are kept as they are, where the whole value used to be kept by reference; so a Command that writes to such a context no longer rewrites the trace either.
- **A trace records the input and context the run received.** `recordEffect` and the reference recording wiring copied the flow's input and the context only when the trace was packaged, after the run, so a Command that wrote to either rewrote what the trace said production received. An ORM save that assigns the new id to the object it is handed, as TypeORM and Mongoose do, recorded the input with that id, and the unchanged flow replayed down another branch as a `TimeParadox`; a Command that wrote to the context made the replay take another branch with no warning at all. Both are now redacted and copied as the run starts. `recorder().toTrace` copies what it is given when it is called, so a recorder you wire yourself should call it before the run too.
- **A replay from a trace uses the context the trace recorded.** `replayEffect` used an empty context unless it was handed one, although the trace carries the context production ran with and `timeTravel` already used it. A caller who passed only the flow and the trace, as the README's replays do, replayed an `Ask` check the other way: an approval that succeeded in production replayed as `Failure('forbidden')`, with no `TimeParadox` to flag it. A `context` passed in still wins, and a `Resolver`, which has no recorded context, still defaults to `{}`.
- **A replay that cannot answer a step no longer reports `Success`.** A `ReplayError` or `TimeParadox` became a domain `Failure` while the flow was still running, so `Retry`'s `onExhausted` caught it and a settled `Parallel` folded it into its outcomes. A truncated trace, which is what a recorder with `maxEntries` produces, then replayed as a `Success` whose branches each carried the replay error as though production had returned it, and a `Retry` reported a fallback that never ran. Both now reach `replayEffect`'s boundary and come back as the `Failure` it has always returned. An `EffectTypeError` still propagates, since a malformed flow is a bug in the flow rather than a problem with the trace.
- **A cancelled `Parallel` replays with the failure production returned.** Which branch fails first and cancels the others depends on timing, and it was not recorded, so a replay reached its own decision: a checkout whose charge was declined replayed as the `AbortError` of the stock reservation it had cancelled, and a branch production stopped between two steps could ask for a step that was never recorded and fail the replay. The decision is now recorded, and a replay reproduces it: the recorded branch's failure is the result, and every other branch stops where its recording stops. That includes a `Parallel` cancelled by a branch whose own code threw, so the trace of a run that crashed inside one replays the same throw. If that branch no longer fails, or the `Parallel` no longer has it, the replay raises a `TimeParadox` naming it. A trace recorded before this replays as it did.
- **An `async` step no longer crashes the process.** An `async` step or `next` returns a Promise, which is reported as an `EffectTypeError`. When the step also threw, its Promise rejected with nothing attached, so Node exited on an unhandled rejection after the caller had already caught the `EffectTypeError`. The rejection is now handled, and the message names the Promise and says to do the awaited work in a Command, where it used to call it a plain object and ask for `Success(value)`, which the step already returned.
- **A cancelled branch no longer starts a Command after a slow `onBeforeCommand`.** A `Parallel` branch was checked for cancellation before a Command's interceptor ran and not after, so an interceptor that waits, such as a rate limiter, let the Command start after a sibling had already failed. It is checked again once the interceptor returns.
- **A `Parallel` branch that throws cancels its siblings and waits for them.** An error thrown inside a branch, such as an `EffectTypeError`, used to reject the run at once and leave the other branches running with nothing observing them; under `limit` it also stopped that worker. The branch now cancels the others the way a failing branch does, every branch settles, and then the first thrown error by array order is rethrown.
- **A cancelled branch no longer waits out its retry backoff.** A Command that honours its `AbortSignal` rejects the moment a sibling fails, and the `Retry` around it then started its backoff on a signal that had already fired, whose abort listener never ran, so the `Parallel` reported its failure only once the full delay had passed. The backoff now ends at once when the branch is already cancelled.
- **An `onResolved` that throws stops the replay instead of changing its outcome.** A throw from `replayEffect`'s `onResolved` counted as the replayed Command failing, so a `Retry` asked for an attempt production never made and the replay reported a retry exhaustion. The replay now stops, and `replayEffect` rejects with the observer's error. `timeTravel`'s narration printed each step with `JSON.stringify`, which throws on a `BigInt` or a circular result, and it hit the same path; it now falls back to plain text for such a value, and the replay's outcome is the one production had.
- **A replay no longer changes the trace it replays.** Recorded results were handed to the flow as the trace's own objects, so a step that mutated its result rewrote the recording, and replaying the same trace twice could give two different answers; a caller mutating a replayed `Failure`'s error did the same. Each replay now receives a copy.
- **`RetryExhaustedError`'s `lastError` is typed `unknown`.** `Retry` declared it as the wrapped steps' error type, which it can never hold now that a `Failure` a step returns is not retried: `lastError` is always what a Command's function threw. So `const e: 'flaky' = result.error.lastError` compiled and held an `Error` at runtime. Narrow `lastError` where you use it. `RetryExhaustedError<T>` still works as an annotation when you know what your function throws.
- **`onMissing: 'execute'` works when replaying from a trace.** A step the trace did not hold raised a `ReplayError` before the option was consulted, so the documented recorded prefix with a live tail only worked with a `Resolver`. A missing step now runs live under `'execute'`. Under the default `'throw'` the error still names the missing path and now also names the option. A step recorded under another name is still a `TimeParadox`, and a step production never ran because its `Parallel` branch was cancelled is still not run.
- **An `AggregateError`'s `errors` survives a trace.** It is non-enumerable, like `message`, so a recorded error kept the name and an often empty message and lost the list that says what failed: a refused connection to `localhost` recorded as `AggregateError` with no addresses. Each entry is now serialized and revived like `cause`, and the revived error carries them as a non-enumerable `errors`, as a native one does. An enumerable `errors`, such as a validation error's, is copied as before.
- **A settled `Parallel` outcome returned from `next` is an abort.** Returning one of the `Failure`s a settled `Parallel` hands `next`, as it is, inside a `Retry` used to be retried when the pipeline was called without an input and passed on when it was called with one, because whether a `Failure` was an I/O fault rode on the object as a hidden mark that composition sometimes dropped. The interpreter now keeps that distinction to itself, so every `Failure` your code holds is plain data and any `Failure` a step returns is an abort.

### Removed

- **Global `retry` defaults.** `configureEffect({ retry })` and a per-call `runEffect(..., { retry })` both throw a `TypeError` now: retry options are per-use, passed to `Retry(effect, options)`. How often a dependency misbehaves is a property of that dependency rather than of the process, and a shared `const flakyNetwork = { attempts: 3, backoff: 2 }` handed to each `Retry` covers the repeated case explicitly.

## [0.13.0] - 2026-09-22

### Changed

- **`configureEffect` is additive.** Installing hooks no longer switches off hooks someone else installed: each call adds a layer on top of those already there and returns a function that removes that one layer, wherever it sits by then. Layers merge the way several configurations passed to one call always did: `onStep` and `onRun` nest with the earliest layer outermost, `onBeforeCommand` interceptors run in installation order, and `retry` merges with later layers winning. Calling it with no arguments removes every layer, while a call whose arguments are all `undefined` installs and removes nothing. Previously a later call replaced the hooks an earlier one had installed, and the returned function put back whatever had been configured before it.
- **A per-call `callConfig` merges over the hooks already installed** instead of replacing them one at a time, with the call innermost. Passing an `onStep` to `runEffect` used to switch the configured `onStep` off for that run, which is how `recordEffect` inside an application that already had tracing silently produced runs with no spans.
- **Every `Failure` carries the input the flow was called with**, however deep it came from. A `Failure` escaping a `Parallel` branch, a `Retry` fallback, or a sub-pipeline previously carried that subtree's own input or none.
- A Command continuation that returns nothing, at any position in a pipeline, rejects with an `EffectTypeError` naming the missing return, rather than resolving to a `Failure` carrying a bare `TypeError`.
- A `Success` no longer carries `initialInput`, so `assert.deepEqual(result, Success(v))` holds for every flow rather than only those whose last step returned a `Success` directly.

### Added

- **`runEffect`'s third argument takes `inherit`, a boolean.** `true`, the default, is the merge above; `false` leaves the installed hooks out of the run entirely, so anything the call does not set falls back to the library defaults, `retry` included. Anything other than a boolean throws a `TypeError`.
- A GitHub Actions workflow runs the test gate on Node 18 through 24, plus Prettier's format check.

### Fixed

- **`replayEffect` under the default `hooks: false` still applies global `retry` defaults.** Ignoring the installed hooks for a replay dropped `retry` along with them, so a `Retry` that production ran under a configured `attempts` exhausted early on replay and reported a `Failure` production never saw.

## [0.12.0] - 2026-09-04

### Changed

- **`replayEffect` returns `{ result, unreached }`** for a trace and `{ result }` for a `Resolver`, mirroring `recordEffect`'s `{ result, trace }`. `unreached` is the recorded entries the flow never asked for: a flow that stops issuing Commands before its recording ends mismatches nothing, so no `TimeParadox` fires and the replay can end in `Success` with steps left over. Previously the bare outcome was returned.
- **The `strict` replay option is removed.** Every trace since 0.9.0 carries paths, which are order-independent and paradox-detecting, so the option had nothing left to choose. A path-less trace is matched positionally, and a `Parallel` step in one is refused with a `ReplayError`.

### Fixed

- Revived errors define `name` and `cause` as non-enumerable own properties, as a native `Error` keeps them, so `assert.deepEqual(replayed, result)` holds for a `Failure` carrying a plain error.

## [0.11.0] - 2026-09-01

### Added

- **`Retry(effect, { onExhausted })`** runs a fallback Effect when every attempt has failed, instead of returning the structured exhaustion `Failure`. The fallback's success feeds `next` and its failure propagates unwrapped. It executes under the retry's own path prefix so replays reproduce it, a cancelled `Parallel` branch skips it, and `fastRetry` rewrites it. Per-use only: the global `retry` defaults cannot carry one.
- `Parallel`'s `next` is optional, defaulting to `(values) => Success(values)`, matching `Command`.
- README sections **Composing Larger Flows** and **Which Errors Are Data**, documenting sub-pipeline branching, joining results from `Parallel`, local joins, and why there is no catch.

### Fixed

- Serialized errors carry `cause` recursively. It is non-enumerable on `Error`, so traces silently dropped it.
- `Retry`'s declared error type matches what `runEffect` returns: `RetryExhaustedError<E>` without `onExhausted`, the fallback's own error type with it. The declaration previously claimed `E`.

## [0.10.0] - 2026-08-28

### Added

- **`Parallel` cancels its other branches when one fails.** The first branch to fail aborts an `AbortController` scoped to that `Parallel` and linked to any enclosing one. Cancelling is a request rather than a guarantee: a cancelled branch starts no further Commands, and a Command function that accepts the `AbortSignal` it is passed can be cut off in flight. Inside a `Parallel` the function is called as `cmd(signal)`; anywhere else it is called with no argument. `Parallel` still awaits every branch before returning, and the triggering `Failure` is returned rather than a cancellation.

## [0.9.0] - 2026-08-08

### Added

- **Time-travel debugging**: `recorder(options)` returns an `onStep` hook and a trace packager; `recordEffect(flow, input)` runs a flow for real and returns `{ result, trace }`; `replayEffect(effect, traceOrResolver)` replays a flow from a trace or a `Resolver` with no I/O; `timeTravel(flow, trace)` is a narrated replay with timings and divergence warnings. Every recorded step carries a `path`, its position in the flow, and a `durationMs`.
- `Command(cmd, next, meta)`: a non-empty `meta.name` is the Command's identity, then `cmd.name`, then `'anonymous'`, so an inline arrow or a minified function can still be named in a trace.
- `Command`'s `next` is optional, defaulting to `(result) => Success(result)`.
- `configureEffect` accepts several configurations and merges them, and returns a function that puts back whatever was configured before.
- A pipeline step returning something other than an Effect throws an `EffectTypeError` naming the step, instead of failing later with a bare `TypeError`.
- `examples/recording-example.js`, a reference for production recording with one recorder per run in an `AsyncLocalStorage` scope. Both examples are covered by tests.

## [0.8.0] - 2026-05-03

### Added

- **`Parallel(effects, next)`** runs several flows at the same time with the same context. The first `Failure` by array index is returned; otherwise `next` receives the array of unwrapped success values.

## [0.7.0] - 2026-05-02

### Added

- **`Retry(effect, options)`** repeats the flow it wraps on failure with `attempts`, `delay`, and `backoff`, handled natively by `runEffect`. On exhaustion it returns `Failure({ retryExhausted: true, lastError, attempts })`. `configureEffect({ retry })` sets global defaults.
- `runEffect(effect, context, callConfig)`: per-call configuration overriding the global hooks and retry defaults.
- A `Ctx` type parameter flows through every Effect type and `effectPipe`, so `runEffect` checks the supplied context against what `Ask` reads.

### Changed

- `initialInput` is threaded through the pipeline by `chain` rather than attached after the flow is built.

### Fixed

- `onRun` fires once per `runEffect` call rather than once per `Retry` attempt.

## [0.6.0] - 2026-05-01

### Added

- **`Ask(next)`** reads the `context` passed to `runEffect` from any pipeline step, for ambient values such as tenant id or auth info.

## [0.5.0] - 2026-04-27

### Added

- **TypeScript declarations** in `index.d.ts` with full generics: `Success<T>`, `Failure<E>`, `Command`, `effectPipe` overloads, and `runEffect`'s return type. Type-level tests run under `tsd` as part of `npm test`.

## [0.4.0] - 2026-03-31

### Added

- `Command(cmd, next, meta)`: a `meta` object carried on the Command for hooks to read.
- `runEffect(effect, context)`: a context object passed to `onBeforeCommand`.
- `onBeforeCommand` hook, intercepting each Command before it runs.

### Changed

- `configureTelemetry` is renamed `configureEffect`.

## [0.3.0] - 2026-02-21

### Added

- `configureTelemetry({ onStep, onRun })`: hooks wrapping each Command and each run, with an OpenTelemetry example.

## [0.2.0] - 2025-11-29

### Added

- JSDoc type annotations throughout `index.js`.

## [0.1.2] - 2025-11-27

### Changed

- README revisions.

## [0.1.0] - 2025-11-24

### Added

- Initial release: `Success`, `Failure`, `Command`, `effectPipe`, and `runEffect`.

[0.17.0]: https://github.com/aycangulez/pure-effect/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/aycangulez/pure-effect/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/aycangulez/pure-effect/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/aycangulez/pure-effect/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/aycangulez/pure-effect/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/aycangulez/pure-effect/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/aycangulez/pure-effect/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/aycangulez/pure-effect/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/aycangulez/pure-effect/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/aycangulez/pure-effect/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/aycangulez/pure-effect/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/aycangulez/pure-effect/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/aycangulez/pure-effect/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/aycangulez/pure-effect/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aycangulez/pure-effect/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aycangulez/pure-effect/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/aycangulez/pure-effect/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/aycangulez/pure-effect/releases/tag/v0.1.0
