# Changelog

All notable changes to pure-effect are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and from 1.0.0 the project follows [Semantic Versioning](https://semver.org/). Before 1.0.0 a minor version could change behaviour; each such change is marked below.

## [0.14.0] - 2026-09-xx

### Added

- **`Parallel` takes options: `limit` and `settled`.** `Parallel(effects, { limit: 5 })` keeps at most five branches in flight, for a dependency that rate limits; results and recorded paths stay in array order, so a limit changes pacing and nothing else. `Parallel(effects, { settled: true })` runs every branch to completion and hands `next` one outcome per branch, `Success` or `Failure`, in array order, so a batch survives one bad record instead of being cancelled mid-flow by it. An `EffectTypeError` still escapes a settled `Parallel`, because a malformed flow is a bug rather than a branch outcome. The second argument is `next` or the options, whichever it looks like, so existing calls are untouched and neither form needs a placeholder.

### Changed

- **`Retry` reacts to an I/O fault, not to an abort.** A `Failure` a step returned now propagates immediately, unretried and unwrapped, and `onExhausted` never sees it; only a Command whose function threw is retried. Previously both were retried, so a guard returning `Failure('email already in use')` cost four database round trips for an answer that could not change and arrived wrapped in `{ retryExhausted, lastError, attempts }`, and `onExhausted` could answer a deliberate abort and report `Success`. The rule this settles: you can recover from an error your I/O produced, and you cannot catch an abort. A value thrown by a Command's function is an I/O fault by definition, which is what the README already asked for when it said a domain outcome is returned rather than thrown.
- **A throw from a Command's `next` or a pure step rejects the run.** It used to become a `Failure`, and inside a `Retry` it was treated as an I/O fault, so a `TypeError` in pure code after a Command that had succeeded ran that Command again. It is now a bug in the flow, as a throw from any other continuation already was, and `runEffect` rejects with the error as thrown. A test or caller that expected a `Failure` for such a throw sees a rejection instead.
- **An `onStep` hook that throws after its Command succeeded rejects the run.** It used to count as the Command failing, so inside a `Retry` a telemetry hook whose exporter failed once a charge had gone through ran the charge again on every attempt. The Command's work is done at that point, so the throw is now a bug in the hook and `runEffect` rejects with it, as it does for a throw from `next`. A hook that throws without calling `op` still counts as the Command failing, which is how replay reports a recorded error.
- **A throwing `onBeforeCommand` is an abort.** The run still returns a `Failure` carrying the thrown error, but `Retry` no longer retries it and `onExhausted` never sees it, which is what the documented "throw to abort" meant.
- **`Retry`'s `attempts` must be a positive integer.** `0` now throws a `TypeError` naming the alternatives rather than meaning run once, because a `Retry` that does not retry is not a `Retry`. It was also the one spelling that turned `onExhausted` into a plain catch at no cost. To handle an outcome without retrying, branch on it as data in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.

### Fixed

- **An `async` step no longer crashes the process.** An `async` step or `next` returns a Promise, which is reported as an `EffectTypeError`. When the step also threw, its Promise rejected with nothing attached, so Node exited on an unhandled rejection after the caller had already caught the `EffectTypeError`. The rejection is now handled, and the message names the Promise and says to do the awaited work in a Command, where it used to call it a plain object and ask for `Success(value)`, which the step already returned.
- **An `AggregateError`'s `errors` survives a trace.** It is non-enumerable, like `message`, so a recorded error kept the name and an often empty message and lost the list that says what failed: a refused connection to `localhost` recorded as `AggregateError` with no addresses. Each entry is now serialized and revived like `cause`, and the revived error carries them as a non-enumerable `errors`, as a native one does. An enumerable `errors`, such as a validation error's, is copied as before.
- **A replay no longer changes the trace it replays.** Recorded results were handed to the flow as the trace's own objects, so a step that mutated its result rewrote the recording, and replaying the same trace twice could give two different answers; a caller mutating a replayed `Failure`'s error did the same. Each replay now receives a copy.
- **A settled `Parallel` outcome returned from `next` is an abort.** Returning one of the `Failure`s a settled `Parallel` hands `next`, as it is, inside a `Retry` used to be retried when the pipeline was called without an input and passed on when it was called with one, because whether a `Failure` was an I/O fault rode on the object as a hidden mark that composition sometimes dropped. The interpreter now keeps that distinction to itself, so every `Failure` your code holds is plain data and any `Failure` a step returns is an abort.
- **A replay that cannot answer a step no longer reports `Success`.** A `ReplayError` or `TimeParadox` became a domain `Failure` while the flow was still running, so `Retry`'s `onExhausted` caught it and a settled `Parallel` folded it into its outcomes. A truncated trace, which is what a recorder with `maxEntries` produces, then replayed as a `Success` whose branches each carried the replay error as though production had returned it, and a `Retry` reported a fallback that never ran. Both now reach `replayEffect`'s boundary and come back as the `Failure` it has always returned. An `EffectTypeError` still propagates, since a malformed flow is a bug in the flow rather than a problem with the trace.
- **A `Parallel` branch that throws cancels its siblings and waits for them.** An error thrown inside a branch, such as an `EffectTypeError`, used to reject the run at once and leave the other branches running with nothing observing them; under `limit` it also stopped that worker. The branch now cancels the others the way a failing branch does, every branch settles, and then the first thrown error by array order is rethrown.

### Removed

- **Global `retry` defaults.** `configureEffect({ retry })` and a per-call `runEffect(..., { retry })` both throw a `TypeError` now: retry options are per-use, passed to `Retry(effect, options)`. How often a dependency misbehaves is a property of that dependency rather than of the process, and a shared `const flakyNetwork = { attempts: 3, backoff: 2 }` handed to each `Retry` covers the repeated case explicitly. The Limitations entry about a `callConfig` delay always losing to a per-use one goes with it, since there is no longer a second place for a delay to come from.

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
