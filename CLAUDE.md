# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. `AGENTS.md` is a symlink to it, so agents that read that name get the same guidance; edit this file, never the link.

This file holds the rules. `DESIGN.md` holds the reasons: how each part works, what broke before it worked that way, and the full case for every settled decision. Read the matching `DESIGN.md` section before changing how something works, and to see why each settled decision was made.

## Commands

```bash
npm test                                          # run all tests
npx mocha test/all.js --grep "pattern"            # run a single test by name
npm run format                                    # Prettier over index.js, index.d.ts, examples/*.js, scripts/*.js, test/all.js, test/types.test-d.ts, README.md, CLAUDE.md, DESIGN.md, CHANGELOG.md, CONTRIBUTING.md
npx tsd                                           # type-level gate over test/types.test-d.ts
npx tsc -p jsconfig.json                          # strict tsc over index.js, test/all.js, test/types.test-d.ts, examples/*.js, and scripts/*.js, reading index.d.ts as a consumer; the same config VS Code uses
npm run test:ts-minimum                           # compiles index.d.ts and test/types.test-d.ts with TypeScript 5.1, the oldest the declarations support
npm run generate                                  # rewrites effectPipe's overloads in index.d.ts from scripts/effect-pipe-overloads.js
npx esbuild index.js --minify --format=esm | gzip -9 | wc -c    # the size the README claims
npx stryker run                                   # mutation testing: mutates index.js, runs test/all.js against each mutant; report in reports/mutation/
npx stryker run --mutate "index.js:120-180"       # the same, limited to the lines a change touched
```

There is no build or lint step: the library ships as plain ES modules. Formatting is Prettier, configured in `.prettierrc`. CI (`.github/workflows/ci.yml`) runs `npm test` on Node 22, 24 and 26, Prettier's check, and `npm run test:ts-minimum`, on pull requests and on pushes to `main`; the TypeScript 5.1 check fetches 5.1 with `npx`, so it needs the network the first time. **Check `npm test` by its exit code**: a `tsd` failure prints neither "passing" nor "failing". After a structural edit to `index.d.ts`, compare the runtime exports against the declared ones rather than trusting the diff. `package.json` has a `files` list, so anything new that must ship is added there; `npm pack --dry-run` shows what would be published.

Mutation testing stays out of CI. Run it after changing `index.js` or its tests. Its survivors are not a to-do list: most are equivalent mutants (arrays sized in advance, a check after a retry backoff that the loop repeats) or message wording, and a few flip between runs because some tests depend on timing. Two gaps are deliberate: whether each nested `Parallel` removes its listener from the enclosing signal, and the wording of `timeTravel`'s narration. Before calling a survivor new, apply the mutant by hand to the old code and the new and run the suite: one that survives both is an old gap, not a regression.

## Where things go

- A rule goes here and in `CONTRIBUTING.md`, and its reason in `DESIGN.md`. `CONTRIBUTING.md` restates the rules for a human contributor and does not refer to this file, so it reads on its own. When a rule changes, change all three.
- A design verdict goes in `DESIGN.md`, with one line under Settled decisions here when it is settled.
- Nothing about this library lives in an agent's private memory. A design verdict, a critique accepted or rejected, or a preference about how to work here goes in this file or `DESIGN.md`, where every contributor can read it.
- This file stays under 32 KiB, and well under it. It is loaded into every session, and Codex reads only the first 32 KiB of `AGENTS.md`; a test fails past that. History and explanation go in `DESIGN.md`.
- `index.js` is one file in five sections, each a `#region` (Types, Building flows, Configuration, Running flows, and Recording and replay), listed in a contents comment at its top. A new definition goes in the section it serves, usually the one that calls it, and the contents comment changes when a section gains or loses something it names. Where two sections share a private protocol, as replay and the interpreter do, the comment at each end names the function at the other.

## House rules

- The size figure lives in one place, the README's feature bullet. Re-measure it with the command above after changing `index.js`, and reword it when the number moves. **A commit message and a changelog entry never mention the size.**
- A changelog entry and a commit message leave out documentation-only changes. A docs change that ships with a behaviour change goes unmentioned in both; one that ships alone gets no changelog entry, and its commit message says why the docs changed.
- Changelog entries are ordered by importance within each section, most important first: a breaking change before the rest, then what affects the most users or changes what their runs do.
- The README's `Load Tests` section is re-measured by nothing. A change to what it claims (isolation between concurrent runs, replay fidelity, memory held across runs, `Parallel`'s limit and ordering) means rerunning an equivalent experiment and updating the section, or cutting the claim.
- Markdown prose has no hard line breaks. Write each paragraph and list item as one line; code blocks and table rows are untouched.
- No jargon in the README. The names the library exports are not jargon (`Command`, `Retry`, `Parallel`, `Resolver`, `TimeParadox`, `onStep`, `backoff` and the rest); everything else gets the plain word. A flow, not an Effect tree. Part of a flow, not a node or a subtree. The Command's function, or `cmd`, not a thunk. Joining, not fan-in. Stops, not short-circuits. A request, not cooperative. Attached, not stamped. Does the same thing again, not deterministic. No catch, not no catch combinator. Runs at the same time, not concurrently, wherever nothing turns on the distinction. `grep -rniE "thunk|combinator|monad|kleisli|effect tree|fan-in|fan-out|short-circuit|cooperative|imperative shell|arity|stamp" README.md` should print nothing. A precise term may stay if the plain words follow it in the same breath, as `idempotent (safe to run more than once)` does. The precise words are fine everywhere else.
- The README's API Reference is a reference. Each entry gives the signature, what it returns, and one line per option, parameter or rule, and links to the guide section that teaches it rather than teaching it again. A new option gets one line there, and whatever more it needs goes in its guide section.
- The README's orientation sections, such as How It Works, stay a few plain sentences. To fill a gap, propose a sentence or two and show the exact wording rather than restructuring the section, and propose moving something apart from changing it.
- No em dashes anywhere in the repository, including JSDoc, comments, test names and assertion messages. Use a colon, parentheses, a semicolon, a comma or a full stop, whichever carries the relationship; a table cell that needs a placeholder uses `n/a`. `grep -rn "—" --include="*.js" --include="*.ts" --include="*.md" .` checks a change before it lands.
- A comment in `index.js` says what the code does now and why, in a sentence or two. What broke before, and the full case for a choice, go in `DESIGN.md`. A comment never recounts an incident or restates the line below it.
- Name a condition in `index.js` when it's used more than once, or when it would otherwise need a comment to say what it means; one function's one-off condition can be a named `const`, as `pastTheEnd` is. Make a predicate a type guard (`@returns {value is T}`) only where a caller needs the narrowing, as the interpreter loop does with `isPending`; `isObject` returns a plain `boolean`, since a guard to `object` on an `any` value stops property reads compiling.

## Design rules

pure-effect is a zero-dependency effect system for JavaScript implementing the "Functional Core, Imperative Shell" pattern: business logic returns plain data instead of executing side effects, so it is tested without mocks, and a recorded run can be fed back through the interpreter with no I/O at all. Everything is in `index.js`, and `index.d.ts` declares it. The exports are the constructors `Success`, `Failure`, `Command`, `Ask`, `Retry` and `Parallel`; `effectPipe`, which composes steps through the internal `chain`; `runEffect`; `configureEffect`; `commandName`; and `recorder`, `recordEffect`, `replayEffect` and `timeTravel`.

### Failures and throws

- There are three kinds of failure, and most of the design depends on them. A `Failure` a step returned is an **abort**: the flow has decided, so it is never retried and `onExhausted` never sees it. A throw from a Command's function is an **I/O fault**, which is what `Retry` retries. An `EffectTypeError`, a replay fault, or a throw from a continuation or a pure step is a **harness error**: `runEffect` rejects with it, or, from a step before the first Command, the call that builds the flow throws it. An I/O fault is the internal `IoFault` state, which only `execute` and its per-node functions return, and which becomes a plain `Failure` wherever it would reach user code. The loop accepts only the six public types, so a continuation cannot forge a fault. **Keep provenance out of anything user code can hold.** A domain outcome is returned, never thrown.
- A throw means something different in each region of `runCommand`. From `onBeforeCommand` it is an abort, a veto. From the step runner it is an I/O fault, unless the Command's function had already succeeded, when it is a bug in an `onStep` hook and rejects the run. A hook that called `op` and returned `undefined` where the function returned a value rejects the run with a `TypeError`, and one that returned while `op` was still running is waited for first; only `undefined` is checked, and never for a hook that did not call `op`, since that is how replay answers. A hook that throws without calling `op` is a fault. `next` and the pure steps it reaches run in `execute`, outside both catches, so a throw there rejects the run. Harness errors carry the `harnessError` mark, and both catches rethrow them. `op` is async. The `Where a throw comes from` suite pins each region.
- A malformed flow throws, as the flow is built where possible. `asEffect` and `effectTypeError` name the source and the likely mistake (`describeValue`), and `nextOf` names the node whose `next` returned the value. The constructors check their arguments with `describeArgument`, so a mistake is reported before the I/O it would have run. An `options` argument refuses anything but an object, a name its function does not read, and a value it cannot use (`checkOptions`); `null` counts as none. A new option gets a rule in its function's list, or the function refuses it. A function that takes a trace checks it with `checkTrace`, and one that builds a flow from a recorded input checks the flow function with `checkFlowFn`, rather than checking either itself. A hook configuration, in `configureEffect` or a `callConfig`, refuses anything but an object, a key no hook has, and a hook that is not a function (`checkConfiguration`); only `undefined` leaves one out. `malformed` builds every `EffectTypeError` and attaches a handler only to a native `Promise`, since calling `then` on a query builder runs the query.

### Composition

- Control structures stay in pipeline functions: an `if` or a loop never wraps a Command. A decision sits in a function that receives one value, and control that spans I/O is a node. No API may let control span a Command; `DESIGN.md`'s Overview says why.
- A `Failure` carries only its error, untrimmed, and no node or outcome carries the flow's input. `effectPipe` records the input in the private `flowInputs` map, keyed on a copy of the root it returns, since the last step can return a shared object; `interpret` hands it to `onRun` as `initialInput`, which is how a hook-based recorder finds it. Only `effectPipe` records one.
- A Command's identity is `commandName(eff)`: a non-empty string `meta.name`, else `cmd.name`, else `'anonymous'`. Traces, replay matching, spans and tests all use it; never restate the rule.
- Docs and examples thread minimal values between steps rather than a growing accumulator object.

### Retry and Parallel

- `Retry` merges per-use options over `attempts: 3`, `delay: 100` and `backoff: 1`; an option set to `undefined` keeps its default, and values are checked once, as the `Retry` is built, which keeps a frozen copy, so they cannot change before it runs; `Parallel` does the same. An abort passes through unretried and unwrapped. Exhaustion is `{ retryExhausted, lastError, attempts }`, itself an I/O fault, so an enclosing `Retry` retries it. `onExhausted` runs a fallback under the `f` path prefix and never in a cancelled branch. Each attempt runs the **entire** wrapped tree again, `next` included, so a retried Command keeps its default `next` and branching happens in a later step.
- Primitives stay generic. A hazard the data cannot show, such as a Command under `Retry` that is not safe to run twice, gets a JSDoc note, a README Limitations entry and a test in `Documented sharp edges`, never a check that refuses a shape. `Retry` repeats rather than resumes unless the maintainer asks otherwise.
- `Parallel` runs branches through `runBounded`, so results and paths follow array order with or without `limit`; under `limit: 1` it is a sequential loop that stops at the first failure, unless `settled`. The first branch to fail or throw cancels the others: a failing branch's `Failure` is the result, and a throw rejects the run. Under `settled` a failure cancels nothing and `next` gets every outcome as a `Success` or `Failure`, while a throw still cancels the others and rejects the run. The whole `Parallel` is one `onStep` step of type `'Parallel'` whose `op` runs the branches and returns the decision, and a hook must call it. A branch's throw is held until every branch has settled. The branch that cancelled the others is tracked apart from those cancelled because of it.
- Cancellation is a request. Each `Parallel` has an `AbortController` linked to the enclosing one by `linkedScope`. A cancelled branch starts no further Commands: that is checked at the top of `execute`'s loop, after `onBeforeCommand` returns, and before a `Retry` fallback; a backoff ends at once, and `delayFor` checks `aborted` first. `cmd` receives the signal only inside a `Parallel`, and only when it declares a parameter (`cmd.length > 0`, which leaves out parameters with default values). `Parallel` awaits every branch before returning.

### Hooks

- `onStep(name, type, op, path)` wraps each Command and each `Parallel`; a hook that only watches must `await op()` and return its result. `onRun(effect, op, flowName, initialInput)` wraps a whole run once. `onBeforeCommand(command, context)` runs before each Command, and throwing from it vetoes the Command as an abort.
- `configureEffect` is additive. Each call adds one layer and returns a function that removes it; several configurations passed to one call form one layer; a bare call removes every layer; a call whose arguments are all `undefined` does nothing. `chainHooks` merges layers earliest outermost: `onStep` and `onRun` nest, and `onBeforeCommand` interceptors run in order. Keep those semantics if the hook shapes change. A per-call `callConfig` merges innermost, or over nothing under `inherit: false`, and a non-boolean `inherit` throws. A `retry` key throws as any key no hook has.
- **Anything that wraps `onStep` passes `path` on as the fourth argument, and anything that wraps `onRun` passes `initialInput` on.** Only the innermost hook can pass `op` an argument, the recorded decision.
- The recorder only watches: `op` always runs, its result is returned, and its error propagates. It catches exactly the two parts of recording a value that run the caller's code or read the caller's value, `redact` and the copy (`recordPart`), and marks the value `unrecorded` with which one threw. Every read of the caller's value, and of what `redact` returns, goes through `recordPart`. Nothing else in it may throw, and it has no catch-all to hide a bug of its own.

### Recording and replay

- Give each run its own recorder; one installed for the whole process mixes runs into a trace a replay refuses. `fromTrace` (internal) turns a trace into a `Resolver`, and `replayEffect` defaults its `context` to the trace's.
- Seven invariants hold replay together, and breaking one breaks it in ways tests may not catch; `DESIGN.md` explains each.
    1. Replay drives the real interpreter and never touches the flow. It replaces only I/O, with an `onStep` that answers from the trace, and waiting, with `fastRetry`. The only execution point is `await runtime.onStep(cmdName, 'Command', op, cmdPath)`, and replay's `onStep` calls `op` only under `onMissing: 'execute'`, so no side effect can occur by default; **never execute a Command anywhere else**. `hooks` defaults to `false`.
    2. Steps match by path: `0p1/0r2/0` is branch 1, attempt 2, first Command, and a fallback opens `0rf/`. A step the trace lacks is a `TimeParadox` when the trace recorded another kind of node at a position on its path (`nodesAlong`), so a reshaped flow never runs live under `'execute'`. A trace without paths matches in order and refuses a step inside a `Parallel`.
    3. A cancelled `Parallel` replays its recorded decision, its own entry at its path, rather than recomputing it. A step missing from a branch the decision cancelled is a cut (`replayCut`), and a decision that no longer holds is a `TimeParadox`.
    4. A replay fault is a harness error, marked `harnessError` and `replayFault`, which `replayEffect` turns into a `Failure` at its own boundary. A new harness error gets a mark, never a name to match on.
    5. The outcome wrapper is load-bearing: a `Resolver` returns `{ result }`, `{ error }`, or `undefined` for not recorded, and any other answer, or a throw from it, rejects the replay rather than counting as the Command failing. A trace whose `dropped` is above 0 refuses `onMissing: 'execute'`, and a step that threw is recorded with `threw: true`.
    6. Errors survive JSON through `serializeError` and `reviveError`, `cause` and an `AggregateError`'s `errors` included, with enumerability as the original had it; a chain that loops back is cut where it returns. An `Error` survives `redact` too: `recordError` re-marks an object returned for it.
    7. Recorded values are copies in the one form a trace has, JSON, both ways: `snapshot` on the way in, what `redact` returns included, and `entryToOutcome` on the way out, and `toTrace` is called before the run. A reference back to an enclosing object is cut, and a value JSON cannot encode is marked `unrecorded: 'copy'`, so a replay from memory gets what one from storage gets.
- `redact` sees everything a trace holds: results, serialized errors, and the trace's `initialInput` and `context`, told apart by `kind`. **Keep that coverage complete if the trace format grows a field.** A stand-in must get the same verdict from the flow as the value it replaces, so a value `redact` throws on, or one the recorder cannot copy, gets none: it is left out and marked `unrecorded`, and a replay that needs it stops.
- A replay proves the flow asks for the same Commands and handles the same answers, not what it computes. Test a value change against the pure step that computes it, and rename a Command whose result changes shape. A recording test asserts `unreached` is empty, or names the step a fix removed.
- `onResolved` is for observing a replay and a `Resolver` for supplying outcomes. A throw from either rejects the replay with that error.

### TypeScript

- `index.d.ts` is written by hand, apart from `effectPipe`'s overloads, and the `Declaration parity` test, `tsd` and `tsc -p jsconfig.json` keep it matched to `index.js`. Add any checked JavaScript to `jsconfig.json`'s `include` list.
- The declarations support TypeScript 5.1 and later; raising the minimum is a breaking change and goes in the changelog.
- An optional option or hook field is declared `T | undefined`, since `undefined` keeps its default, and under `exactOptionalPropertyTypes` a field declared `T` refuses a value read from configuration. `tsd` runs with that flag, and a test compiles each example under it.
- A doc comment in `index.d.ts` is a hover: a sentence or two about what a user needs. Its reasons go in `DESIGN.md`, and a non-obvious type trick gets a one-line `//` note above its doc comment.
- Deliberate type errors are `// @ts-expect-error` directives, never `tsd`'s `expectError`, each on one line, small enough that only the intended mistake can fail it, with a reason.
- Change `effectPipe`'s overloads in `scripts/effect-pipe-overloads.js` and run `npm run generate`, **never by hand**.
- Some declarations exist for a reason, and each is pinned in `test/types.test-d.ts`: `Retry`'s error and `RetryState`'s `R`, every `next` as a method signature, the `settled?: false` overloads, `Command`'s first and last overloads, `Failure`'s `const`, functions typed from their whole return (`AnyEffect`, `EffectValue`, `EffectError`, `EffectContext`), `commandName`'s parameter, `RunContext`, `CommandInterceptor`, `redact`'s `any`, and `Parallel`'s branch typing. Read `DESIGN.md`'s TypeScript section before changing one, and extend the tsd file when touching the recording, replay or `CallConfiguration` types.

### Reference integrations

- `examples/opentelemetry-example.js` and `examples/recording-example.js` are reference code: they ship under `examples/`, but `exports` offers only `index.js`. Edit them only with `npm test`. Each exports a function that returns a configuration and one that installs it, and nothing happens on import. Both import the library as `'pure-effect'`, so a copy runs as it is. Observing a run never decides it.
- Telemetry spans carry names, timings and status, never values, and nothing ahead of a run may throw. Recording keeps one recorder per run in an `AsyncLocalStorage` scope; an error from `keep` or the sink goes to `onSinkError`, a field the recorder cannot copy is marked rather than reported, since `toTrace` never throws, and each warning fires once per flow.

## Proposing changes

- Raise a design critique as an opinion, and let the maintainer choose before building it.
- A rule the docs do not state may still be deliberate: control structures stayed in pipeline functions from the first version, long before it was written down. Ask, or read the history, before calling a choice an afterthought.

## Settled decisions

Each was weighed and decided. Do not propose them again as improvements or rank them as weaknesses; `DESIGN.md` gives the reasons.

- No generator syntax: control structures stay in their own functions, and a generator lets an `if` or a loop span a Command.
- No catch: `Retry`'s per-use `onExhausted` is the only recovery, and only from an I/O fault.
- `attempts: 0` throws.
- No settled Command: a Command's `next` always receives its result, and an I/O error the flow handles is caught inside the Command's function.
- No global retry options, and a `retry` key throws.
- `settled` hands `next` `Success` and `Failure` nodes, not `{ status, value }`.
- A `Parallel`'s trigger is the first failure to finish, not the first by array order.
- No `AbortSignal` for a whole run, and none reaches a Command outside a `Parallel`.
- No finalizer inside a flow: cleanup is a try/finally around `runEffect` in the shell.
- Nested pipelines for dependent values are a TypeScript cost only.
- No join helper: `pair(f)` was built and dropped.
- No flows written as one function: `flow(fn)` was built and dropped.
- No loop helper: a loop is a step that gets the list, then `Parallel(list.map(f), { limit: 1 })`.
- A `TimeParadox` after a flow changes shape is the design; an incident test is re-recorded when its flow changes shape.
- A trace records results, never Command arguments.
- A trace keeps data, not objects, in one form, JSON.
- Steps match by path, with no option to choose.
- `fastRetry` is a parameter of the private `interpret`, not a rewrite of the tree, and not an option of `runEffect`.
- Per-call configuration merges; it never replaces one slot.
- What is internal stays internal: `fromTrace` and `chainHooks`.
- A helper ships only when users would otherwise copy a library rule, as `commandName` does.
- The conveniences stay: `recordEffect` and `timeTravel`.
- Recording stays out of the library.
- `effectPipe` stops at 20 steps, and nesting is the workaround.
- `index.js` stays one file, divided into sections; a `utils.js` and a split into the core and recording and replay were weighed and dropped.
- `runBranches` runs both modes through `settleBranches`.
- Thrown errors stay out of the declared error union.
- A `Failure` carries only its error; the flow's input reaches `onRun`, never an outcome.
- Sharp edges are documented, not guarded: `Retry` repeating its whole wrapped tree, a branch whose Command ignores its signal running to completion, and a function passed by name taking the signal for a plain first parameter it treats as optional.

## Tests

`test/all.js` holds every runtime test, with a user-registration domain as the running example; `registerUserFlow` has the same shape as the README's Quick Start. `test/types.test-d.ts` holds the type-level tests, run by `tsd`.

- Assert on the returned data, such as Commands, Failures and traces, rather than on side effects.
- Reset the hooks in every suite with `beforeEach(() => configureEffect())`, a bare call; `configureEffect({})` adds an empty layer rather than resetting.
- Count I/O in replay tests.
- Test behaviour through the public surface, and reach an internal such as `fromTrace` through its public consumer.
- Anchor an equation to a value, as the `Kleisli laws` suite does.
- Each example file has a suite, so a change to the hook contract breaks the examples rather than letting them rot.
- Audit the guidance when behaviour changes: write the flow a careful reader would write after reading each documented sharp edge, and run it.
- README examples run. The `README examples` suite executes every `js` block as one program with its asserts live, so a fenced `js` block is real JavaScript: a value shape goes in a `text` block, a placeholder is written out rather than `...`, and anything new outside the library gets a stub in that suite. A `ts` block is not run, so check `assertCommand` by hand when the types it touches change.
- Documented pipelines keep their shape. Every step accepts and returns the piped value, so a guard's `next` returns `Success(input)`, not `Success(true)`; threading the value is preferred over `() => f(outer)`, without presenting it as a rule; and a Command's function body stays a single call.
