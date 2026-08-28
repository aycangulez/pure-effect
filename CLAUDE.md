# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                          # run all tests
npx mocha test/all.js --grep "pattern"            # run a single test by name
npm run format                                    # Prettier over index.js, index.d.ts, examples/*.js, test/all.js, README.md, CLAUDE.md
npx tsd                                           # type-level gate; the only check that reads index.d.ts
npx esbuild index.js --minify --format=esm | gzip -9 | wc -c    # the size the README claims
```

No build or lint step: the library ships as plain ES modules with no transpilation. Formatting is Prettier, configured in `.prettierrc`; match it when editing.

The README's badge and feature bullet both state a minified-and-gzipped ceiling, currently under 4 KB. Re-measure with the command above after adding anything to `index.js`, because the badge is a static `img.shields.io/badge/` URL with the number written into it rather than a live query, so it cannot correct itself.

**Markdown prose has no hard line breaks.** Write each paragraph and each list item as one line and let the editor soft-wrap; never wrap prose at a column. Hard breaks make later edits reflow whole paragraphs, turning a one-word change into a multi-line diff. `proseWrap: never` enforces this, so `npm run format` unwraps any prose that arrives wrapped. Even so, write it unwrapped in the first place rather than relying on the sweep, since a wrapped paragraph reads as an intended shape until something reflows it. Fenced code blocks are untouched by the setting, and table rows stay one per line; only prose joins.

**No em dashes.** The `—` character does not appear anywhere in this repository: not in `README.md`, not in this file, not in JSDoc, code comments, test names, or assertion messages. Reach for the punctuation that carries the actual relationship instead of a dash that blurs it. A colon when the second half explains or names the first. Parentheses for an aside the sentence could survive without. A semicolon between two linked independent clauses. A comma for a light pause or a trailing "which" clause. A full stop when the clause can stand on its own, which is usually the honest fix for a dash joining two complete thoughts. Nothing enforces this mechanically, so it is on the author; `grep -rn "—" --include="*.js" --include="*.ts" --include="*.md" .` checks a change before it lands. Table cells that need a "not applicable" placeholder use `n/a`.

## Architecture

**pure-effect** is a zero-dependency effect system for JavaScript implementing the "Functional Core, Imperative Shell" pattern. Business logic returns plain data structures instead of executing side effects, enabling testing without mocks. The same property makes runs recordable and replayable: because a flow is inert data until the interpreter walks it, a recorded run can be fed back through the interpreter with no I/O at all.

### Core abstractions (all in `index.js`)

| Export | Shape | Purpose |
| --- | --- | --- |
| `Success(value)` | `{ type: 'Success', value }` | Wraps a successful result |
| `Failure(error, initialInput)` | `{ type: 'Failure', error, initialInput }` | Short-circuits the pipeline |
| `Command(cmdFn, nextFn, meta)` | `{ type: 'Command', cmd, next, meta }` | Defers a side effect for the interpreter; `meta.name` sets the Command's identity |
| `Ask(nextFn)` | `{ type: 'Ask', next }` | Reads the `context` passed to `runEffect`; passes it to `nextFn` |
| `Retry(effect, options)` | `{ type: 'Retry', effect, options, next }` | Wraps any Effect tree with retry-on-failure semantics; handled natively by the interpreter |
| `Parallel(effects, next)` | `{ type: 'Parallel', effects, next }` | Runs multiple Effect trees concurrently; the first branch to fail cancels its siblings and its Failure is returned; context flows into all branches |
| `effectPipe(...fns)` | n/a | Composes functions into a sequential pipeline via `chain` |
| `runEffect(effect, context, callConfig?)` | async | Interpreter: traverses the effect tree, executes Commands; resolves `Ask` and `Retry`; per-call `callConfig` overrides global defaults |
| `configureEffect(...configs)` | n/a | Sets process-wide telemetry hooks (`onStep`, `onRun`, `onBeforeCommand`) and global `retry` defaults; merges several configurations into one wiring; returns a restore function; overridden by per-call `callConfig` |

The recording and replay exports are a 2x2 rather than four loose helpers: `recorder` and `replayEffect` are the capabilities, at the hook and tree level, while `recordEffect` and `timeTravel` are the flow-level pair that also own trace metadata. That metadata is why the conveniences exist and should not be cut as mere sugar: `initialInput` lets a flow be rebuilt, `context` lets `Ask` resolve on replay, and `version` makes a stale trace detectable. A caller who assembles a trace by hand and forgets `context` gets one that silently diverges. `timeTravel` is presentation over `replayEffect` and could be rebuilt from `onResolved` in about ten lines, but it stays: the one-line form is what makes the feature graspable.

`Command(cmd, next, meta)` keeps that parameter list, and `next` is optional because most of Commands in this repo pass their result straight through: it defaults to `(result) => Success(result)`.

A Command's identity is resolved by the internal `commandName(eff)`: a non-empty string `meta.name`, else `cmd.name`, else `'anonymous'`. That identity is used in three places at once, which is why it has its own function rather than being inlined at the call site: trace entries are keyed on it, strict replay matching compares it against the recorded name, and telemetry spans are titled with it. `meta.name` exists because the previous rule, `cmd.name` alone, made the flagship feature depend on syntax: an inline arrow silently recorded as `'anonymous'`, and any minifier that mangles function names renamed every step of every trace. Both failures are silent, which is the worst property an identity can have. `cmd.name` remains supported and is what the examples use, since naming the thunk reads well and needs no second argument.

Anything that is not an Effect is rejected by `asEffect` / `effectTypeError` with a message naming its source, and the distinction they encode is deliberate: a malformed flow is a bug and throws, while a Command that rejects is a domain outcome and becomes a `Failure`. The interpreter's catch rethrows `EffectTypeError` specifically so a flow bug cannot masquerade as a business error. Two details are important. `chain` validates the return of each pipeline step, which is the only place the offending step's name is known (`fn.name`), so that is where the useful message comes from. And the interpreter's `while` condition guards on `eff &&` before reading `eff.type`, because a continuation returning `undefined` otherwise threw a bare TypeError from the condition itself, outside any handler.

Before this, every one of those mistakes was silent or cryptic: forgetting `Success()` gave `Cannot read properties of undefined (reading 'type')` with no step named, a continuation returning a plain value made `runEffect` resolve to that value so `result.type === 'Success'` quietly took the else branch, and `runEffect(flow)` without an input resolved to the function itself.

### Recording and replay (all in `index.js`)

| Export | Purpose |
| --- | --- |
| `recorder(options?)` | Returns `{ onStep, entries, toTrace }`; the `onStep` hook records every Command's result or error. Options: `redact`, `maxEntries`, `stack` |
| `recordEffect(flowFn, initialInput, opts?)` | Runs a flow for real while recording; returns `{ result, trace }`. Convenience for tests and scripts |
| `replayEffect(effect, traceOrResolver, opts?)` | Replays a tree, feeding recorded outcomes to Commands instead of executing them. Takes a trace or a `Resolver`. Options: `context`, `strict`, `fastRetry`, `hooks`, `onMissing`, `onResolved` |
| `timeTravel(flowFn, traceLog, options?)` | Narrated replay: rebuilds the flow from the recorded input, logs each step, warns on version mismatch and unreached steps |

`fromTrace(traceLog, { strict })`, which builds a `Resolver` over the reference trace format, is **internal**, and `replayEffect` is its only caller. Deliberately not exported: a caller whose traces live in another shape writes a `Resolver` instead, and a caller who only wants to watch a replay uses `onResolved`. Between them those cover every known need, so exporting it would only widen the public surface. The one thing neither covers is _rewriting_ outcomes from a reference-format trace (substituting one step's result, or chaining a fallback), since `onResolved` is an observer whose return value is ignored. Export it again if that comes up; nothing depends on it staying private.

See **Time-travel debugging** below for the invariants these depend on, and the README for each option in full.

### Data flow

```
effectPipe(f1, f2, f3)(input)
  → returns tree of Success / Failure / Command / Ask / Retry / Parallel values
  → f1 runs eagerly here; initialInput is threaded through chain so every
    node in the tree carries it without post-construction mutation

runEffect(tree, context, callConfig?)
  → per-call callConfig merges over global configureEffect defaults
  → executes Commands async, passes results into next(result), repeats
  → resolves Ask by calling next(context), continues
  → resolves Retry via an inner execute() loop (not recursive runEffect),
    so onRun fires exactly once per runEffect call regardless of attempts;
    on exhaustion returns Failure({ retryExhausted: true, lastError, attempts })
  → resolves Parallel by running all effects via Promise.all with the same
    context; if any effect returns Failure, returns the first Failure by
    array index and skips next; otherwise calls next with the array of
    unwrapped success values
  → resolves to final Success or Failure

replayEffect(tree, traceOrResolver, options?)
  → a trace goes through fromTrace(trace, { strict }); a function is used as the
    Resolver as-is (typeof check: an entries array is data, so it takes the
    trace path); a malformed trace rejects with a ReplayError
  → installs an onStep that answers each step from resolve(step) instead of
    calling op(), so eff.cmd is never applied and its I/O never happens
  → { result } → handed to the Command's next(result)
  → { error }  → thrown, so the interpreter produces a Failure
  → undefined  → throws a ReplayError unless onMissing: 'execute'
  → otherwise delegates to runEffect, so Ask / Retry / Parallel behave
    exactly as they do in production
```

The `chain` combinator (internal) drives composition: `Success` passes its value to the next function, `Failure` short-circuits, `Command` defers execution, `Ask` wraps its continuation so the chain propagates through it, `Retry` wraps its continuation via object spread (same pattern as `Ask`). `chain` accepts an optional `initialInput` parameter; `effectPipe` passes the pipeline's starting value through every `chain` call so that `initialInput` is stamped on all nodes, including mid-pipeline `Failure`s, without mutation. `runEffect` loops through the tree with a `while` loop rather than recursion.

`configureEffect` options (all overridable per-call via `runEffect`'s third argument):

- `onStep`: fires on every Command execution; wraps the `cmd` call (use for per-command tracing)
- `onRun`: fires once per `runEffect` call; wraps the whole workflow (use for top-level spans); receives `context.flowName` as the third argument; does **not** fire again for Retry attempts
- `onBeforeCommand`: intercepts each Command before execution; receives the Command and the `context` passed to `runEffect`
- `retry`: global Retry defaults `{ attempts, delay, backoff }`; per-use options passed to `Retry(effect, options)` merge on top (defaults: `attempts: 3`, `delay: 100ms`, `backoff: 1` flat)

There is one slot per hook, and `configureEffect` merges the configurations of a single call but does not accumulate across calls: a later call replaces the previous wiring, an unset key returns that slot to its default, and calling it with nothing resets everything. A per-call `callConfig.onStep` likewise displaces the global one for that run, which is why `recordEffect` records without tracing. Recording and tracing both want `onStep`, so they go into one call: `configureEffect(telemetryHooks(), recordingHooks({ sink }))`. Anything that installs hooks on a caller's behalf will silently clobber whatever was there, which is why recording is a reference file rather than a library export. Note the asymmetry: `runEffect`'s third argument takes a single configuration, so merging is only available on the global path. That was the accepted cost of folding the merge into `configureEffect` rather than exporting it.

The raw hooks are powerful: a hook decides whether the Command runs at all, which is how replay suppresses I/O, and anything it throws becomes the flow's outcome. That power is wrong for anything that only watches, and it caused two real bugs here: the tracing example serialized its input before calling `pipeline()`, so a cyclic input left flows unexecuted, and `recorder` let a throwing `redact` turn a successful run into a `Failure` carrying the redaction bug while recording an entry that claimed the Command had thrown. The internal `observeSteps(handler)` now holds that contract in one place: `op` always runs, its result is always returned, its error always propagates, and anything the observer throws is dropped. Keep it minimal and unexported. `recorder` is its only caller and needs only `onStep`, so there is no `onRun` branch and no error-reporting channel, and an exported second route to the raw hooks would widen the surface for integrations nobody has written. It briefly was exported, as `observe`, with both branches; that cost 270 bytes gzipped for one internal call site and no consumer, which is the same argument that removed `tap`.

Trace entries carry `durationMs`, rounded to microseconds, because `observeSteps` measures the span around `op` anyway and nothing else recorded timings. `timeTravel` narrates it, but only under `strict` matching, since per-Command queues do not map a replayed step back to a recorded position.

`configureEffect` returns a function that restores the wiring in place when it was called, captured as a snapshot of the resolved runners rather than of the options, and it reverts only while that wiring is still installed. The guard matters because the first version reverted unconditionally: two callers installing and releasing in interleaved order silently discarded each other's hooks, which is the same class of silent clobbering the restore function was added to prevent. It exists because the global was otherwise write-only: there is no getter, so anything that installed hooks clobbered its host permanently and could not put things back, which made the global unusable from a test, a scoped experiment, or a library wrapping this one. Restoring is a snapshot and not a stack, so a restore that runs after a later `configureEffect` reverts to the older wiring and discards the newer one. The two are not interchangeable: `restore()` returns to whatever was installed before, while a bare `configureEffect()` asserts a known-clean slate. Suites here want the clean slate, so they reset; `restore()` is for code that installs hooks over someone else's wiring and has to hand it back.

That global state is also why the test suite needs care. Hooks outlive a suite, so every `describe` that could inherit another's wiring guards with `beforeEach`. The `Core` suite went unguarded for a while and was safe only because it is declared first, which is positional luck rather than isolation: a suite added above it, or a future split into several files, would silently change what it runs with.

The internal `chainHooks` does that merging, and it relies on `onStep` and `onRun` being wrappers around an `op`: nesting them composes, with the first configuration outermost, so a thrown Command unwinds from the last back to the first. `onBeforeCommand` is an observer, so interceptors run in sequence instead. Keep those semantics if the hook shapes ever change. It was briefly exported; folding it into `configureEffect` removed an export and reads better at the call site, since a merge is only ever useful on the way into a configuration.

### Sharp edges pinned by tests

Three semantics are surprising enough that `Documented sharp edges` in the test suite exists to keep them from changing silently, and each has a Limitations entry.

`Retry` repeats the entire wrapped tree on every attempt, including Commands that already succeeded, because the retry loop calls `execute(eff.effect)` again rather than resuming. `Retry(effectPipe(charge, receipt))` charges three times when the receipt step fails twice, and the run still reports `Success`. The semantics are defensible, since retry means run this tree again, but the README's "wraps any Effect tree" invites exactly the dangerous construction, so both the JSDoc and the Retry section now say to wrap the failing Command instead. If this is ever changed to resume rather than repeat, the pinning test is the one to read first.

`Parallel` cancellation is cooperative. The first branch to fail aborts an `AbortController` scoped to that `Parallel`, linked to the enclosing one so cancellation nests. Two levels of effect follow. A cancelled branch starts no further Commands, checked at the top of `execute`'s loop, which needs nothing from user code and is where most of the benefit is. Stopping the Command already in flight needs its thunk to accept the `AbortSignal` it is handed, which is why `cmd` is now called as `cmd(signal)` inside a `Parallel` and with no argument anywhere else: passing an argument only where it means something keeps a thunk written as `(x) => ...` from silently receiving one. A thunk that ignores the signal runs to completion, so a branch whose first Command is a write can still write after a sibling has failed, which is what the pinning test covers. `Parallel` still awaits every branch before returning, deliberately: returning early would leave cancelled work running unobserved after the Failure, with its rejections unhandled. The triggering branch is tracked separately from branches that failed because they were cancelled, so a cancellation never displaces the real error; when several branches fail in the same tick the first by array order wins, which is the older documented behaviour and is pinned.

Every `Failure` carries `initialInput`, stamped by `chain`, alongside the full error. Neither is trimmed and neither should be: a test asserting on a Failure and a developer reading one both need the whole thing. PII control is split deliberately. `redact` is the single mechanism for a trace, and the shell owns what reaches logs, so the guidance is to log `result.error` rather than serialize a whole Failure.

`redact` therefore has to see everything a trace holds, and for a while it did not. It covered Command results only, so a caller who installed a correct redact still shipped `initialInput` verbatim, the `context` verbatim, and any custom property on a thrown error: in the registration flow that is the plaintext password in two places and the auth token in a third. It now receives results, serialized errors, and the trace's own `initialInput` and `context`, with a `kind` argument of `'result'`, `'error'`, `'initialInput'`, or `'context'` to tell them apart. Keep that coverage complete if the trace format grows another field, since a field redact cannot see is a field that leaks. An absent `initialInput` or `context` is left `undefined` rather than passed through, so a redact that spreads its argument cannot turn nothing into an empty object.

### Time-travel debugging

Because a flow is data, a production run can be recorded and replayed later. Recording is just an `onStep` hook, so it needs no change at call sites: install `recorder().onStep` via `configureEffect`, or pass it as per-call config. It shares the slot with tracing, so pass both configurations to one `configureEffect` call when both are wanted. `recordEffect` is the convenience wrapper for tests and scripts.

Four invariants hold the design together; breaking any of them breaks replay in a way tests may not catch:

- **Replay drives the real interpreter.** `replayEffect` calls `runEffect` rather than walking the tree itself, which is why `Ask`, `Retry`, and `Parallel` replay correctly and why replay semantics cannot drift from execution semantics. The interpreter's only execution point is `await localStepRunner(cmdName, 'Command', eff.cmd)`, which hands the Command thunk to `onStep` as `op` instead of calling it. Replay's `onStep` never invokes `op` unless `onMissing: 'execute'`, so **no side effect can occur by default**. Preserve that single-execution-point property: a Command executed anywhere else in the interpreter would be invisible to both recording and replay.
- **Path matching, with the two older modes kept for legacy traces.** Every step carries a `path`: its position in the Effect tree, numbered sequentially within a subtree, with each `Parallel` branch and each `Retry` attempt opening its own prefix (`0p1/0r2/0` is branch 1, retry attempt 2, first Command). A path depends only on the shape of the tree, never on the order branches finish in, so it is order-independent **and** paradox-detecting at the same time. `fromTrace` matches by path whenever every entry has one, and it does so whatever `strict` says, deliberately: a caller who passed `strict: false` to work around `Parallel` should get correct matching once their traces carry paths rather than keeping the mode that option existed to work around. Duplicate paths throw, since a collision would reintroduce the failure paths exist to prevent. The older modes remain only for traces recorded before paths existed: `strict: true` consumes entries positionally, `strict: false` resolves per-Command FIFO queues. **The name-queue mode is the bug paths fixed.** It paired a step with the next recorded entry of the same name, which is completion order, so two `Parallel` branches calling the same Command swapped results whenever replay timing differed from production, and the replay still reported `Success`. `strict` is ignored when a `Resolver` is passed, because that `Resolver` has already chosen its own matching.

- **The hook contract carries the path as a fourth parameter.** `onStep(name, type, op, path)`. Three-parameter hooks keep working, and `chainHooks` forwards the path through nested wrappers. A hand-rolled wrapper that calls `inner(name, type, op)` without forwarding `path` silently produces a trace with no paths, which then falls back to legacy positional matching: correct for sequential flows, and the old swapping bug for `Parallel`. Forward the fourth argument in anything that wraps `onStep`.
- **`fastRetry` exists because of merge order.** The interpreter merges per-use options over call config (`{ ...localRetryDefaults, ...eff.options }`), so a `callConfig.retry` cannot override a delay written at the call site. `zeroRetryDelays` therefore rewrites `Retry` nodes to `delay: 0, backoff: 1` lazily, through their `next` continuations; without it, replaying a flow that retried in production waits out the production backoff.
- **The outcome wrapper is load-bearing.** A `Resolver` returns `{ result }`, `{ error }`, or `undefined` for "not recorded". The wrapper keeps a Command that legitimately returned `undefined` (`{ result: undefined }`) distinct from having no recording, which is what makes the `onMissing` guard trustworthy.

Two further details: `hooks` defaults to `false`, so a replay cannot reach a telemetry backend or a guardrail that performs I/O; and errors cross the trace via `serializeError` / `reviveError` because `message` and `stack` are non-enumerable on `Error` and a plain `JSON.stringify` would silently drop them. Non-`Error` values pass through unchanged, so a Command that rejected with a string still replays as a string.

Recorded results are snapshotted by the internal `snapshot`, not stored by reference. Without it a later step that mutates a returned object rewrote what the trace said an earlier step returned, and because `toTrace` runs after the flow finishes, the mutation was already baked in by the time a sink serialized it: the trace recorded a value production never saw, and a replay fed that value back. It uses `structuredClone` where available, falls back to a JSON round trip, and falls back again to the reference for values that can be neither, since dropping the entry would be worse. Redaction runs first, so nothing sensitive is cloned before being stripped.

`TraceLog` is the reference trace format, not a contract: `replayEffect` also takes a `Resolver`, so any storage shape works by writing one.

`timeTravel` narrates through `replayEffect`'s `onResolved` hook rather than by wrapping a `Resolver`, which is why it can pass the trace straight through and why `fromTrace` needs no public export. Keep that split: `onResolved` is the seam for _observing_ a replay (logging, counting, step assertions), and a `Resolver` is the seam for _supplying_ outcomes. Narration that reaches for a `Resolver` is a sign the wrong seam is being used.

### TypeScript

Full generic type declarations are in `index.d.ts` and referenced via the `types` field in `package.json`. Type-level tests live in `test/types.test-d.ts` and run via `tsd` as part of `npm test`.

`index.d.ts` is hand-maintained beside `index.js`, so the two drift silently. Nothing but `tsd` reads it: `tsc --allowJs --checkJs` over `index.js` checks the JSDoc and never opens the declarations, and mocha does not typecheck at all. **Check `npm test` by exit code.** `tsd` failures print neither "passing" nor "failing", so piping the output through `grep -E "passing|failing"` hides them entirely, which is how `runEffect`'s declaration stayed deleted through several edits here while every other check reported green. It was removed as collateral by a slice that targeted an adjacent block, so after any structural edit to `index.d.ts`, compare the runtime exports against the declared ones rather than trusting the diff.

Raw `tsc` over `test/types.test-d.ts` is the wrong lens and will always report errors: `expectError(...)` blocks contain deliberate type errors that `tsd` requires to be errors.

`Effect<T, E, Ctx>` carries three type parameters: value type, error union, and context type. `Ctx` flows through `AskState`, `CommandState`, `RetryState`, and all `effectPipe` overloads. `Ask<T, E, Ctx>` types the context callback parameter, and `runEffect<T, E, Ctx>` enforces that the supplied context matches. `Ctx` defaults to `unknown` so existing code without context typing is unaffected.

Error unions need explicit return annotations. A step written as `(i: User): Effect<User, 'taken'> => ...` contributes `'taken'` to the pipeline's union, but the same step left to inference from a bare `Success(x) | Failure(y)` return type yields `E = unknown`, and one `unknown` absorbs every other member of the union, so `result.error` degrades to `unknown` for the whole pipeline. Annotate `Effect<T, E>` on any step whose error type is meant to survive, and write type-level examples that way.

The recording and replay exports are declared alongside the primitives (`ReplayStep`, `ReplayOutcome`, `Resolver`, `TraceEntry`, `TraceLog`, `RecorderOptions`, `TraceMeta`, `ReplayOptions<Ctx>`). Known gap: `test/types.test-d.ts` has no coverage for any of the replay exports; their declarations are checked only by `tsc` over the JSDoc in `index.js`. Add `tsd` assertions there when touching those types.

### Observability

`examples/opentelemetry-example.js` wires OpenTelemetry spans into `configureEffect`'s hooks: `onRun` opens one span per run, `onStep` a child span per Command. It is reference code, not part of the library, and it follows the same shape as the recording example: `telemetryHooks(options)` returns a configuration, `enableTelemetry(options)` installs it, and `startTelemetrySdk(options)` stands up an exporter. Nothing happens on import, which is deliberate: the SDK used to start and register a SIGTERM handler at module scope, so merely importing the file opened an exporter and every test run tried to reach `localhost:4318`.

Spans carry names, timings, and status; values belong in a trace. That split is why the example puts no Command input or output on a span: a trace already holds every result keyed by Command name, `redact` strips it before it leaves the process, and what remains can be replayed, whereas a span attribute can be redacted neither after the fact nor before an initial input carrying a password reaches the backend. Removing that recording also removed everything that had to guard it, which is what shrank the file from 94 code lines to 69.

Two constraints in that file are load-bearing. Telemetry must never decide whether business logic runs: the old version called `JSON.stringify(effect.initialInput)` before `pipeline()`, so an input holding a cycle, which any request object or database client has, threw out of `onRun` and left the flow unexecuted while `runEffect` rejected instead of resolving. And `onStep` must `await op()` and return its result, since returning without calling `op` is precisely how replay suppresses I/O, so the same mistake in a tracing hook would silently stop every Command.

`examples/recording-example.js` is the same kind of file for production recording: one recorder per run held in an `AsyncLocalStorage` scope, with `onBeforeCommand` capturing the context so a replay can resolve `Ask`. It stays out of the library for two reasons worth preserving. `node:async_hooks` would be the library's only import and a Node-only one, where `index.js` currently imports nothing and runs anywhere, and the policy it encodes (what to keep, where the sink is, what `redact` strips) belongs to the application. It exports `recordingHooks`, which returns a configuration, plus `enableRecording`, which installs it; the returning form is the composable one, since a self-installing helper would replace hooks the app already set. Both examples are covered by tests, so a change to the hook contract breaks them rather than letting them rot silently, and neither should be edited without running `npm test`.

### Tests

`test/all.js` contains all runtime tests and uses a user-registration domain as the running example. Tests assert on the _returned data structures_ (Commands, Failures) rather than on side effects, which is the core usage pattern to preserve. `registerUserFlow` is the same shape as the README's Quick Start, on purpose: `ensureEmailIsAvailable` is a `Command` whose `next` returns `Success(input)`, so the tests and the documentation cannot drift into demonstrating different idioms.

The `Recording and replay` suite builds flows whose Commands count their own invocations, which is how it asserts that a replay performs **zero** I/O, including a case that exercises every primitive at once. It also covers duplicate Command names, recorded-context `Ask`, retry replay and exhaustion, `Parallel` needing `strict: false`, replaying a trace directly and as a bare entries array, malformed traces rejecting with a `ReplayError`, divergence and exhausted traces, `onMissing`, redaction, `maxEntries` with `dropped`, recorder independence, and `timeTravel`'s narration, including a `Parallel` narration case, which proves `timeTravel` still forwards `strict` now that it no longer resolves the trace itself.

The `Malformed flows` suite covers the guard: the offending step named, a missing return called what it usually is, a continuation returning a plain value, a flow passed without its input, a flow bug thrown rather than folded into a `Failure`, and a thrown Command still becoming one. The `Command identity` suite pins the resolution order: `meta.name` winning over a named thunk, an inline arrow becoming identifiable through `meta.name`, both fallbacks, non-object and non-string metas ignored, and `meta.name` surviving the rebuild that `chain` performs on every pipe step so it reaches both a trace and a strict replay. The `Recorded step timings` suite reaches `observeSteps` through its only public consumer rather than testing an internal directly: durations recorded for both successful and thrown Commands, rounding, timings not disturbing replay, and an observation failure leaving the outcome alone. The `examples/opentelemetry-example.js` suite injects a stub tracer through the `tracer` option, which is why that option exists, and covers the cyclic input, values never reaching spans, span naming and nesting, error status on a thrown Command, and composition with recording. The `configureEffect merging` suite pins the composition semantics behaviourally rather than by inspecting a merged object: wrapper nesting order, unwind order on a thrown Command, interceptors all running, `retry` merging where attempts come from one configuration and the delay from another, slots left at their defaults, no accumulation across calls, a bare call resetting everything, and the restore function putting back a previous wiring, returning to no hooks, and reverting `retry` defaults. The `examples/recording-example.js` suite runs the reference wiring itself, covering a trace reaching the sink on failure, successes staying out of it, concurrent runs keeping separate traces, redaction before the sink, and recording composing with a telemetry hook.

`test/types.test-d.ts` contains type-level tests using `tsd`, verifying that generic type parameters flow correctly through `effectPipe` and `runEffect`.

### Example code in the README

README snippets are code readers copy, and no test covers them. Verify them by extracting the fenced blocks and running them against a stub `db`, not by reading them. A broken example survived review here precisely because it looked right: the flow ended in a bare `saveUser` after a guard that resolved to `Success(true)`, so `db.saveUser(true)` was called, the registration data never reached the database, and the run still reported `Success`. The tree-walking assertions in **Testing Without Mocks** passed the whole time, because `cmd.name` checks the shape and Command arguments live in a closure where nothing can assert on them.

Two shape rules keep documented pipelines honest, and the Quick Start is written to both:

- **Every step accepts and returns the piped value.** The email guard is a `Command` whose `next` returns `Success(input)` rather than `Success(true)`, so `saveUser` receives the registration data and the pipeline matches the sentence above it. Threading the value through a guard's own continuation costs nothing when the guard is already a Command, which is why no combinator is needed for it.
- **Prefer threading the value over `() => f(outer)`, but do not present it as a rule.** Closing over an outer variable runs correctly in JavaScript and costs nothing there, so the README says so plainly rather than implying breakage. The real cost is TypeScript: a step that ignores its parameter constrains nothing about what produced it, so changing an upstream output from `User` to `string` raises no error in that form and a compile error when a step consumes the value. Documented examples still thread the value, because that is what keeps a typed pipeline checked end to end, and because it reads as data flow. Note that JavaScript examples have no type safety net at all, which is how the `Success(true)` bug shipped: the equivalent TypeScript is rejected with `'boolean' is not assignable to 'User'`.
