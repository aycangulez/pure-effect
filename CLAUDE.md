# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                          # run all tests
npx mocha test/all.js --grep "pattern"            # run a single test by name
```

No build or lint step — the library ships as plain ES modules with no transpilation.

## Architecture

**pure-effect** is a zero-dependency effect system for JavaScript implementing the "Functional Core, Imperative Shell" pattern. Business logic returns plain data structures instead of executing side effects, enabling testing without mocks.

### Core abstractions (all in `index.js`)

| Export                         | Shape                                      | Purpose                                                                                |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `Success(value)`               | `{ type: 'Success', value }`               | Wraps a successful result                                                              |
| `Failure(error, initialInput)` | `{ type: 'Failure', error, initialInput }` | Short-circuits the pipeline                                                            |
| `Command(cmdFn, nextFn, meta)` | `{ type: 'Command', cmd, next, meta }`     | Defers a side effect for the interpreter                                               |
| `Ask(nextFn)`                  | `{ type: 'Ask', next }`                    | Reads the `context` passed to `runEffect`; passes it to `nextFn`                       |
| `effectPipe(...fns)`           | —                                          | Composes functions into a sequential pipeline via `chain`                              |
| `runEffect(effect, context)`   | async                                      | Interpreter: traverses the effect tree, executes Commands; resolves `Ask` with context |
| `configureEffect(options)`     | —                                          | Injects telemetry hooks (`onStep`, `onRun`, `onBeforeCommand`)                         |

### Data flow

```
effectPipe(f1, f2, f3)(input)
  → returns tree of Success / Failure / Command / Ask values
  → f1 runs eagerly here

runEffect(tree, context)
  → executes Commands async, passes results into next(result), repeats
  → resolves Ask by calling next(context), continues
  → resolves to final Success or Failure
```

The `chain` combinator (internal) drives composition: `Success` passes its value to the next function, `Failure` short-circuits, `Command` defers execution, `Ask` wraps its continuation so the chain propagates through it. `runEffect` loops through the tree with a `while` loop rather than recursion.

`configureEffect` hooks:

- `onStep` — fires on every Command execution; wraps the `cmd` call (use for per-command tracing)
- `onRun` — fires once per `runEffect` call; wraps the whole workflow (use for top-level spans); receives `context.flowName` as the third argument
- `onBeforeCommand` — intercepts each Command before execution; receives the Command and the `context` passed to `runEffect`

### TypeScript

Full generic type declarations are in `index.d.ts` and referenced via the `types` field in `package.json`. Type-level tests live in `test/types.test-d.ts` and run via `tsd` as part of `npm test`.

### Observability

`opentelemetry-example.js` shows how to wire OpenTelemetry spans into `configureEffect`'s hooks — it is reference code, not part of the library.

### Tests

`test/all.js` contains all runtime tests and uses a user-registration domain as the running example. Tests assert on the _returned data structures_ (Commands, Failures) rather than on side effects, which is the core usage pattern to preserve.

`test/types.test-d.ts` contains type-level tests using `tsd`, verifying that generic type parameters flow correctly through `effectPipe` and `runEffect`.
