# Contributing

Thanks for taking the time. This file holds the rules; the reasoning behind each one lives in [CLAUDE.md](CLAUDE.md), which doubles as the project's design record, and is worth reading before a change to `index.js`.

## Before opening a pull request

- **Run `npm test` and check its exit code.** It runs mocha, `tsd`, and strict `tsc` in sequence. A `tsd` failure prints neither "passing" nor "failing", so a glance at the output can miss it; a non-zero exit cannot.
- **Run `npm run format`.** Prettier covers the source, the tests, the examples, and the Markdown. Prose in Markdown is written as one line per paragraph or list item, never wrapped at a column.
- **Keep `index.d.ts` in step with `index.js`.** The declarations are hand-maintained, so a new or changed export needs both files; the `Declaration parity` test fails when the two lists differ. A new type needs an assertion in `test/types.test-d.ts`, with deliberate errors written as `// @ts-expect-error` directives rather than `expectError` calls.
- **Keep jargon out of the README.** The names the library exports are fine; everything else gets the plain word, so a flow rather than an Effect tree, joining rather than fan-in, stops rather than short-circuits. A precise term may stay where the plain words follow it in the same breath. CLAUDE.md carries the list and a grep that checks it.
- **Keep README examples runnable.** The `README examples` suite executes every `js` block with its assertions live, so a fenced `js` block has to be real JavaScript: put a value shape in a `text` block, write out a placeholder rather than `...`, and add a stub to that suite for anything new an example reaches for outside the library.
- **Add a changelog entry** under `Unreleased` in `CHANGELOG.md` for anything a user would notice.

## What to know about the tests

Tests assert on the data structures a flow returns rather than on side effects; that is the usage pattern the library exists for, so keep it. Hooks installed with `configureEffect` are process-wide and outlive a suite, so every `describe` that could inherit another's wiring resets with `beforeEach`. Both files in `examples/` are covered by tests and should not be edited without running them.

## Reporting a bug

Open an issue with the smallest flow that reproduces it. If replay is involved, the trace and the flow together are usually enough to reproduce the problem with no I/O at all, which is the point of the library; strip anything sensitive with `redact` first.
