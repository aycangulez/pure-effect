# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository. `AGENTS.md` is a symlink to this file, so agents that read that name get the same guidance; edit this file, never the link.

This file holds the rules. `DESIGN.md` holds the reasons: how each part works, what broke before, and the full case for every settled decision. Read the matching `DESIGN.md` section before changing how something works.

## Commands

```bash
npm test                                          # run all tests
npx mocha --grep "pattern"                        # one test by name; npx mocha test/replay.js runs one file
npm run format                                    # Prettier over the files package.json's format script lists
npx tsd                                           # type-level gate over test/types.test-d.ts
npx tsc -p jsconfig.json                          # strict tsc, reading index.d.ts as a consumer
npm run test:fuzz                                 # test/fuzz.js over twenty times the seeds; CI runs it
npm run test:ts-minimum                           # compiles the shipped declarations with TypeScript 5.1
npm run generate                                  # rewrites effectPipe's overloads, RULES.md and the generated .d.ts files
npx esbuild index.js --minify --format=esm | gzip -9 | wc -c    # the size the README claims
npx stryker run                                   # mutation testing; report in reports/mutation/
npx stryker run --mutate "index.js:120-180"       # the same, limited to the lines a change touched
```

There is no build or lint step: the library ships as plain ES modules, formatted by Prettier (`.prettierrc`). CI (`.github/workflows/ci.yml`) runs `npm test` on Node 22, 24 and 26, Prettier's check, `npm run test:ts-minimum` and `npm run test:fuzz`, on pull requests and pushes to `main`; the TypeScript 5.1 check fetches 5.1 with `npx`, so it needs the network the first time. **Check `npm test` by its exit code**: a `tsd` failure prints neither "passing" nor "failing". After a structural edit to `index.d.ts`, compare the runtime exports against the declared ones rather than trusting the diff. `package.json` has a `files` list, so anything new that must ship is added there; `npm pack --dry-run` shows what would be published.

Mutation testing stays out of CI. Run it after changing `index.js`, `flight-recorder.js`, `testing.js` or their tests. Its survivors are not a to-do list: most are equivalent mutants or message wording, a few flip between runs because some tests depend on timing, and two gaps are deliberate (`DESIGN.md`'s Mutation testing names them). Before calling a survivor new, apply the mutant by hand to the old code and the new and run the suite: one that survives both is an old gap.

## Where things go

- A rule goes here and in `CONTRIBUTING.md`, and its reason in `DESIGN.md`. `CONTRIBUTING.md` restates the rules for a human contributor and does not refer to this file. When a rule changes, change all three.
- A design verdict goes in `DESIGN.md`, with one line under Settled decisions here once it is settled.
- Nothing about this library lives in an agent's private memory. A design verdict, a critique accepted or rejected, or a preference about how to work here goes in this file or `DESIGN.md`.
- This file stays well under 32 KiB. It is loaded into every session, and Codex reads only the first 32 KiB of `AGENTS.md`; a test fails past that. History and explanation go in `DESIGN.md`.
- `index.js` is one file in five sections, each a `#region` (Types, Building flows, Configuration, Running flows, and Recording and replay), listed in a contents comment at its top. A new definition goes in the section it serves, usually the one that calls it, and the contents comment changes when a section gains or loses something it names. Where two sections share a private protocol, as replay and the interpreter do, the comment at each end names the function at the other.

## House rules

- The size figure lives in one place, the README's feature bullet. Re-measure it with the command above after changing `index.js`, and reword it when the number moves. **A commit message and a changelog entry never mention the size.**
- A changelog entry and a commit message leave out documentation-only changes. A docs change that ships with a behaviour change goes unmentioned in both; one that ships alone gets no changelog entry, and its commit message says why the docs changed. The exception is a new file the package ships, which gets a changelog entry even when it is documentation, as `RULES.md` did.
- A commit message is one short line, with no body.
- Prose calls the library Pure Effect. `pure-effect` is its package name, written as code where code needs it: an import, `npm install`, `package.json`, a URL.
- Changelog entries are ordered by importance within each section: a breaking change first, then what affects the most users or changes what their runs do. Among breaking changes, one nothing reports comes before one a type or runtime error catches; within each, the one more users meet. Published sections stay as released.
- A changelog entry is short and plain: a sentence saying what changed, and at most one more on what a user must do. No bold, except a label such as `Breaking:`. The story of a fix goes in `DESIGN.md`. This holds from 0.20.1 on.
- Markdown prose has no hard line breaks: each paragraph and list item is one line. Code blocks and table rows are untouched.
- No jargon in the README, the guides or `REFERENCE.md`. The names the library exports are not jargon; everything else gets the plain word, as in a flow, not an Effect tree; a stop, not an abort, for a returned `Failure`; and does the same thing again, not deterministic. `DESIGN.md` lists every pair, and `grep -rniE "thunk|combinator|monad|kleisli|effect tree|fan-in|fan-out|short-circuit|cooperative|imperative shell|arity|stamp" README.md REFERENCE.md` should print nothing, and so should the same search over the guides. A precise term may stay if the plain words follow it in the same breath, as `idempotent (safe to run more than once)` does, and a term the README coins is defined where it first appears. The precise words are fine everywhere else.
- Docs are written for a reader who skims and lands mid-file: short sentences, one idea each. A section works on its own: it says where its code comes from, and repeats a hazard where it applies, in a sentence or code comment that links to the full rule.
- `RULES.md` ships the README's rules, the list between its `rules:start` and `rules:end` markers, with a task index. `scripts/rules-file.js` writes it: change the rules in the README and the index in the script, run `npm run generate`, and never edit `RULES.md` by hand.
- `guides/failures.md`, `guides/typescript.md`, `guides/time-travel.md`, `guides/recording.md` and `guides/hooks.md` are guides: README sections moved out to keep it short, which its table of contents links to. A guide follows every rule the README does, and `scripts/rules-file.js` lists them in `GUIDES`, which the tests and `RULES.md` read.
- `README.md` teaches, and `REFERENCE.md` holds the API and every exact rule, by feature: the signature, what it returns, and one line per option, parameter or rule. A rule's full statement lives once, in `REFERENCE.md`; the guide section teaches it and links there, and the Rules list, Limitations and a guide's advice summarise it and link.
- The README's orientation sections, such as The Core, stay a few plain sentences: to fill a gap, propose the exact sentence or two rather than restructure, and propose a move apart from a change.
- No em dashes anywhere in the repository, including JSDoc, comments, test names and assertion messages. Use a colon, parentheses, a semicolon, a comma or a full stop; a table cell that needs a placeholder uses `n/a`. `grep -rn "—" --include="*.js" --include="*.ts" --include="*.md" .` checks a change before it lands.
- A comment in `index.js` says what the code does now and why, in a sentence or two. It never recounts an incident or restates the line below it; what broke before, and the full case for a choice, go in `DESIGN.md`.
- Name a condition in `index.js` when it is used more than once, or when it would otherwise need a comment to say what it means; a one-off can be a named `const`, as `pastTheEnd` is. Make a predicate a type guard (`@returns {value is T}`) only where a caller needs the narrowing, as the interpreter loop does with `isPending`; `isObject` returns a plain `boolean`, since a guard to `object` on an `any` value stops property reads compiling.

## Design rules

Pure Effect is a zero-dependency effect system for JavaScript implementing the "Functional Core, Imperative Shell" pattern: business logic returns plain data instead of executing side effects, so it is tested without mocks, and a recorded run can be fed back through the interpreter with no I/O at all. Everything is in `index.js`, and `index.d.ts` declares it. The exports are `Success`, `Failure`, `Command`, `Ask`, `Retry`, `Parallel`, `effectPipe`, `effectGen`, `step`, `runEffect`, `configureEffect`, `commandName`, `recorder`, `recordEffect`, `replayEffect` and `timeTravel`; `effectPipe` composes steps through the internal `chain`.

### Failures and throws

- There are three kinds of failure, and most of the design depends on them. A `Failure` a step returned is an **abort**: the flow has decided, so it is never retried and `onExhausted` never sees it. A throw from a Command's function is an **I/O fault**, which is what `Retry` retries. An `EffectTypeError`, a replay fault, or a throw from a continuation or a pure step is a **harness error**: `runEffect` rejects with it, or, from a step before the first Command, the call that builds the flow throws it. An I/O fault is the internal `IoFault` state, which only `execute` and its per-node functions return, and which becomes a plain `Failure` wherever it would reach user code. The loop accepts only the six public types, so a continuation cannot forge a fault. **Keep provenance out of anything user code can hold.** A domain outcome is returned, never thrown.
- A throw means something different in each region of `runCommand`, and the `Where a throw comes from` suite pins each. From `onBeforeCommand` it is an abort, a veto. From the step runner it is an I/O fault, unless the Command's function had already succeeded, when it is a bug in an `onStep` hook and rejects the run, as does a hook that called `op` and returned `undefined` in place of its value. From `next` and the pure steps it reaches, which run in `execute` outside both catches, it rejects the run. Harness errors carry the `harnessError` mark, and both catches rethrow them.
- A malformed flow throws an `EffectTypeError` built by `malformed`, as the flow is built where possible, naming the source and the likely mistake, so it is reported before the I/O it would have run. Use the shared checks rather than writing one: `asEffect`, `describeArgument`, `checkOptions`, `checkTrace`, `checkFlowFn` and `checkConfiguration`. `null` options count as none, and only `undefined` leaves a hook out. A new option gets a rule in its function's list, or the function refuses it. `malformed` attaches a handler only to a native `Promise`, since calling `then` on a query builder runs the query.

### Composition

- Outside `effectGen`, control structures stay in pipeline functions: an `if` or a loop never wraps a Command. A decision sits in a function that receives one value, and control that spans I/O is a node. `effectGen` is the one API that lets control span a Command, and its body yields only Effects; `DESIGN.md`'s Overview says why.
- A `Failure` carries only its error, untrimmed, and no node or outcome carries the flow's input. `effectPipe` records the input in the private `flowInputs` map, keyed on a copy of the root it returns, since the last step can return a shared object; `interpret` hands it to `onRun` as `initialInput`, which is how a hook-based recorder finds it, and `recordEffect` reads it there for its trace. Only `effectPipe` and `effectGen` record one.
- A Command's identity is `commandName(eff)`: a non-empty string `meta.name`, else `cmd.name`, else `'anonymous'`. Traces, replay matching, spans and tests all use it; never restate the rule. A replay refuses a Command with no name of its own (`ownName`), and an explicit `meta.name: 'anonymous'` counts as one.
- Docs and examples thread minimal values between steps rather than a growing accumulator object.

### Generator flows

- `effectGen` is an adapter over `chain`, and the nodes it builds are ordinary plain data: no iterator and no proxy on a node. A mistake with `step` or `effectGen` is an `EffectTypeError`, never a warning.
- `chain`'s `onStop` and `execute`'s `stopAt` share the stop listeners, and `execute`'s `ownRun` reads `restarts`, which `effectGen` fills. `chain` and `copyRoot` keep both on their copies, and the comment at each end names the other.
- A step that stops the flow throws a `FlowStopped` error into the waiting body; only that error coming back out is accepted. A harness error stops no generator.
- Every execution of a generator flow but the first builds it again from its input. A body walked down a second branch is fed its earlier answers and checked against the steps it asked for before; a run an execution owns keeps none (`droppedAnswers`), and `rerun` refuses to go past them.

### Retry and Parallel

- `Retry` merges per-use options over `retries: 3`, `delay: 100` and `backoff: 1`, and an option set to `undefined` keeps its default. A `delay` function returns each wait from the last error and the attempt's number (`retryWait`): it is refused beside a `backoff`, never called under `fastRetry` or in a cancelled branch, and a throw from it, or an answer that is no wait, rejects the run. `retryIf` returns whether to try again from the same two arguments (`retriesAfter`): `false` gives up at once, on the path exhaustion takes, with `retries` in the exhaustion the retries made. It runs in a replay too, on the error as the trace holds it, is not asked after the last attempt or in a cancelled branch, and a throw from it, or an answer that is no boolean, rejects the run. `Retry` and `Parallel` check their options once, as they are built, and keep a frozen copy. An abort passes through unretried and unwrapped. Exhaustion is `{ retryExhausted, lastError, retries }`, itself an I/O fault, so an enclosing `Retry` retries it. `onExhausted` runs a fallback under the `f` path prefix and never in a cancelled branch. Each attempt runs the **entire** wrapped tree again, `next` included, so a retried Command keeps its default `next` and branching happens in a later step.
- Primitives stay generic. A hazard the data cannot show, such as a Command under `Retry` that is not safe to run twice, gets a JSDoc note, a README Limitations entry and a test in `Documented sharp edges`, never a check that refuses a shape. `Retry` repeats rather than resumes unless the maintainer asks otherwise.
- `Parallel` runs branches through `runBounded`, so results and paths follow array order with or without `limit`, and `limit: 1` is a sequential loop. The first branch to fail or throw cancels the others: a failing branch's `Failure` is the result, and a throw rejects the run once every branch has settled. Under `settled` a failure cancels nothing and `next` gets every outcome as a `Success` or `Failure`, while a throw still cancels and rejects. The whole `Parallel` is one `onStep` step of type `'Parallel'` whose `op` runs the branches and returns the decision, so a hook must call it.
- Cancellation is a request, through an `AbortController` per `Parallel`, linked to the enclosing one by `linkedScope`. A cancelled branch starts no further Command, attempt or fallback, and a backoff ends at once. `cmd` receives the signal only inside a `Parallel`, and only when it declares a parameter (`cmd.length > 0`, which leaves out parameters with default values). `Parallel` awaits every branch before returning.

### Hooks

- `onStep(name, type, op, path, step)` wraps each Command and each `Parallel`; a hook that only watches must `await op()` and return its result. `step` is `{ attempts, branches, meta }`, which `stepInfo` reads from the path, so no hook parses one. `onRun(op, flowName, initialInput, context)` wraps a whole run once. `onBeforeCommand(command, context)` runs before each Command, and a throw from it vetoes the Command as an abort.
- `configureEffect` is additive. Each call adds one layer, made of every configuration passed to it, and returns a function that removes it; a bare call removes every layer, and a call whose arguments are all `undefined` does nothing. `chainHooks` merges layers earliest outermost: `onStep` and `onRun` nest, and `onBeforeCommand` interceptors run in order. Keep those semantics if the hook shapes change. A per-call `callConfig` merges innermost, or over nothing under `inherit: false`; a non-boolean `inherit` throws, and so does a `retry` key, as any key no hook has.
- **Anything that wraps `onStep` passes `path` and `step` on as the fourth and fifth arguments, and anything that wraps `onRun` passes `initialInput` and `context` on.** Only the innermost hook can pass `op` an argument, the recorded decision.
- The recorder only watches: `op` always runs, its result is returned, and its error propagates. Every read of the caller's value, and of what `redact` returns, goes through `recordPart`, which marks the value `unrecorded` with whether `redact` or the copy threw. Nothing else in it may throw, and it has no catch-all to hide a bug of its own.

### Recording and replay

- Give each run its own recorder; one installed for the whole process mixes runs into a trace a replay refuses. `fromTrace` (internal) turns a trace into a `Resolver`, and `replayEffect` defaults its `context` to the trace's.
- Seven invariants hold replay together, and breaking one breaks it in ways tests may not catch; `DESIGN.md` explains each.
    1. Replay drives the real interpreter and never touches the flow. It replaces only I/O, with an `onStep` that answers from the trace, and waiting, with `fastRetry`. The only execution point is `await runtime.onStep(cmdName, 'Command', op, cmdPath)`, and replay's `onStep` calls `op` only under `onMissing: 'execute'`, so no side effect can occur by default; **never execute a Command anywhere else**. `hooks` defaults to `false`, and a replay with no context stops at its first `Ask` (`noContext`).
    2. Steps match by path: `0p1/0r2/0` is branch 1, attempt 2, first Command, and a fallback opens `0rf/`. A flow that changed shape stops at a `TimeParadox` or a `ReplayError` (`nodesAlong`), and never runs live under `onMissing: 'execute'`. A trace without paths matches in order and refuses a step inside a `Parallel`.
    3. A cancelled `Parallel` replays its recorded decision, its own entry at its path, rather than recomputing it. A step missing from a branch the decision cancelled is a cut (`replayCut`), and a decision that no longer holds is a `TimeParadox`.
    4. A replay fault is a harness error, marked `harnessError` and `replayFault`, which `replayEffect` turns into a `Failure` at its own boundary. A new harness error gets a mark, never a name to match on.
    5. The outcome wrapper is load-bearing: a `Resolver` returns `{ result }`, `{ error }`, or `undefined` for not recorded, and any other answer, or a throw from it, rejects the replay rather than counting as the Command failing. A trace whose `dropped` is above 0 refuses `onMissing: 'execute'`, and a step that threw is recorded with `threw: true`.
    6. Errors survive JSON through `serializeError` and `reviveError`, `cause` and an `AggregateError`'s `errors` included, and survive `redact` through `recordError`; a chain that loops back is cut where it returns.
    7. Recorded values are copies in the one form a trace has, JSON, both ways: `snapshot` on the way in, what `redact` returns included, and `entryToOutcome` on the way out, and `toTrace` is called before the run. A value JSON cannot encode is marked `unrecorded: 'copy'`.
- `redact` sees everything a trace holds: results, serialized errors, the trace's `initialInput` and `context`, and an outcome, told apart by `kind`. **Keep that coverage complete if the trace format grows a field.** A stand-in must get the same verdict from the flow as the value it replaces, so a value `redact` throws on or returns `undefined` for (an error aside), or one the recorder cannot copy, gets none: it is left out and marked `unrecorded`, and a replay that needs it stops.
- A replay proves the flow asks for the same Commands and handles the same answers, not what it computes. A trace holds the run's outcome unless `recordOutcome` is `false`, given to `redact` as a result or an error named `'outcome'`, with no stack, and its replay returns `changed`. Test a value change against the pure step that computes it, and rename a Command whose result changes shape. A recording test asserts `unreached` is empty, or names the step a fix removed.
- `onResolved` is for observing a replay and a `Resolver` for supplying outcomes. A throw from either rejects the replay with that error.

### TypeScript

- `index.d.ts` is written by hand, apart from `effectPipe`'s overloads, and the `Declaration parity` test, `tsd` and `tsc -p jsconfig.json` keep it matched to `index.js`. Add any checked JavaScript to `jsconfig.json`'s `include` list.
- The declarations support TypeScript 5.1 and later; raising the minimum is a breaking change and goes in the changelog.
- An optional option or hook field is declared `T | undefined`, since `undefined` keeps its default, and under `exactOptionalPropertyTypes` a field declared `T` refuses a value read from configuration. `tsd` runs with that flag, and a test compiles each example under it.
- A doc comment in `index.d.ts` is a hover: a sentence or two about what a user needs. Its reasons go in `DESIGN.md`, and a non-obvious type trick gets a one-line `//` note above its doc comment.
- Deliberate type errors are `// @ts-expect-error` directives, never `tsd`'s `expectError`, each on one line, small enough that only the intended mistake can fail it, with a reason.
- `index.d.ts` ends with `export {}`, so only a declaration marked `export` is public; a helper type stays unmarked.
- Change `effectPipe`'s overloads in `scripts/effect-pipe-overloads.js` and run `npm run generate`, **never by hand**.
- Some declarations exist for a reason, and each is pinned in `test/types.test-d.ts`; `DESIGN.md`'s "Declarations that exist for a reason" lists them. Read it before changing a declaration, and extend the tsd file when touching the recording, replay or `CallConfiguration` types.

### Reference integrations

- `examples/opentelemetry-example.js` is reference code shipped under `examples/`, and `flight-recorder.js` ships as `pure-effect/flight-recorder`. Edit either only with `npm test`. Each exports a function that returns a configuration and one that installs it, and nothing happens on import. The example imports `'pure-effect'`, so a copy runs as it is; the flight recorder imports `'./index.js'`. Each ships a `.d.ts` that `npm run generate` writes from its JSDoc, never edited by hand. Observing a run never decides it.
- `testing.js` ships as `pure-effect/testing`, imports `'./index.js'`, and is for tests only. `answers` keeps the outcome wrappers and copies its table, and `assertReproduced` fails a trace with no outcome; `branches` is read in `index.js`, which owns the path format.
- Telemetry spans carry names, timings and status, never values, and nothing ahead of a run may throw. The flight recorder keeps one recorder per run in an `AsyncLocalStorage` scope; an error from `keep` or the sink goes to `onSinkError`, a field the recorder cannot copy is marked rather than reported, since `toTrace` never throws, and each warning fires once per flow.

## Proposing changes

- Raise a design critique as an opinion, and let the maintainer choose before building it.
- A rule the docs do not state may still be deliberate, as keeping control structures in pipeline functions was long before it was written down. Ask, or read the history, before calling a choice an afterthought.

## Settled decisions

Each was weighed and decided. Do not propose them again as improvements or rank them as weaknesses; `DESIGN.md` gives the reasons.

- Generator flows go through `step`: no iterable nodes and no proxy on a node.
- A stop runs a generator's `catch` and `finally`; a swallowed stop, a different error, or a `yield*` during a stop rejects the run.
- No catch: `Retry`'s `onExhausted` is the only recovery, and only from an I/O fault. `retryIf` can hand it one at once.
- `retries: 0` throws.
- No settled Command: an I/O error the flow handles is given up on by `retryIf` and handled in `onExhausted`, or caught inside the Command's function.
- No global retry options, and a `retry` key throws.
- `settled` hands `next` `Success` and `Failure` nodes, not `{ status, value }`.
- A `Parallel`'s trigger is the first failure to finish, not the first by array order.
- No `AbortSignal` for a whole run, and none reaches a Command outside a `Parallel`.
- No finalizer inside a flow: cleanup is a try/finally around `runEffect`.
- No undo node: an undo after a later step's throw is caught inside that Command's function.
- Nested pipelines for dependent values are a TypeScript cost only.
- No join helper (`pair(f)`).
- No flows written as one function (`flow(fn)`); `effectGen` replaced it.
- No loop helper: a loop is a `for` loop with `yield*` in a generator flow, or `Parallel(list.map(f), { limit: 1 })` in a pipeline.
- A `TimeParadox` after a flow changes shape is the design; its incident test is re-recorded.
- A trace records results, never Command arguments.
- A trace keeps data, not objects, in one form, JSON.
- Steps match by path, with no option to choose.
- `fastRetry` is a parameter of the private `interpret`, not a rewrite of the tree or an option of `runEffect`.
- Per-call configuration merges; it never replaces one slot.
- What is internal stays internal: `fromTrace` and `chainHooks`.
- A helper ships only when users would otherwise copy a library rule, as `commandName` does.
- The conveniences stay: `recordEffect` and `timeTravel`.
- Recording ships as its own entry point, `pure-effect/flight-recorder`, never in `index.js`.
- `effectPipe` stops at 20 steps, and nesting is the workaround.
- `index.js` stays one file, divided into sections, with no `utils.js` and no split into the core and recording and replay.
- `runBranches` runs both modes through `settleBranches`.
- A result's error, and a settled outcome's, includes `Error` for what was thrown; a step's `Effect` keeps only its declared errors.
- `meta` is unchecked: a `meta.name` that is not a non-empty string falls back to the function's name.
- A `Failure` carries only its error; the flow's input reaches `onRun`, never an outcome.
- A run's name is `flowName` in `runEffect`'s call configuration and `recordEffect`'s options, never the context.
- Sharp edges are documented, not guarded: `Retry` repeating its whole wrapped tree, a branch whose Command ignores its signal running to completion, a function passed by name taking the signal for a plain first parameter it treats as optional, a step before the first Command that changes its input, and a `retryIf` that decides by an error's class giving up in a replay.

## Tests

The runtime tests are in `test/`, a file for each concern (`core`, `retry`, `parallel`, `hooks`, `recording`, `replay`, `gen`, `fuzz`, `testing`, `examples` and `docs`), and a new test goes in the file for its concern. `fuzz` runs seeded random flows as pipelines and with generator flows mixed in, and checks they do the same; run `npm run test:fuzz` after changing `chain`, `execute`, `Retry`, `Parallel`, replay or `gen`, and turn a failing seed into a test. `test/helpers.js` holds what more than one file needs, including the user-registration example, whose `registerUserFlow` has the shape of the README's Quick Start. `test/types.test-d.ts` holds the type-level tests, run by `tsd`.

- Assert on the returned data, such as Commands, Failures and traces, rather than on side effects.
- Reset the hooks in every suite with `beforeEach(() => configureEffect())`, a bare call; `configureEffect({})` adds an empty layer rather than resetting.
- Count I/O in replay tests.
- Test behaviour through the public surface, and reach an internal such as `fromTrace` through its public consumer.
- Anchor an equation to a value, as the `Kleisli laws` suite does.
- Each example file has a suite, so a change to the hook contract breaks the examples rather than letting them rot.
- Audit the guidance when behaviour changes: write the flow a careful reader would write after reading each documented sharp edge, and run it.
- README, guide and `REFERENCE.md` examples run. The `README examples` suite executes every `js` block in each file as one program with its asserts live, and the `README TypeScript examples` suite compiles each `ts` block in the README and the guides in a strict project. So a fenced block is real code: a value shape goes in a `text` block, a placeholder is written out rather than `...`, and anything new outside the library gets a stub in its suite.
- Documented pipelines keep their shape. Every step accepts and returns the piped value, so a guard's `next` returns `Success(input)`, not `Success(true)`; threading the value is preferred over `() => f(outer)`, without presenting it as a rule; and a Command's function body stays a single call.
