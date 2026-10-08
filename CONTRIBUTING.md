# Contributing

Thanks for taking the time. These are the rules a change has to follow.

## Before opening a pull request

- **Read the matching section of `DESIGN.md` before changing how something works.** It records why each part works as it does, what broke before it did, and the designs already weighed and dropped. A change that settles a design question adds its reason there.
- **Propose a design change before building it.** Open an issue and let the maintainer choose first. A choice the docs do not explain may still be deliberate, so ask about it before treating it as an accident.

- **Run `npm test` and check its exit code.** It runs mocha, `tsd`, and strict `tsc` in sequence. A `tsd` failure prints neither "passing" nor "failing", so a glance at the output can miss it; a non-zero exit cannot.
- **Run `npm run format`.** Prettier covers the source, the tests, the examples, the scripts, and the Markdown. Prose in Markdown is written as one line per paragraph or list item, never wrapped at a column.
- **Name a condition in `index.js` when it's used more than once, or when you'd otherwise need a comment to say what it means.** Use a predicate defined beside its first use, or a named `const` when one function uses it once.
- **Keep comments in `index.js` short and about the present.** A comment says what the code does now and why, in a sentence or two. The bug a line fixed, and the full case for a choice, go in `DESIGN.md`; a comment does not recount an incident or restate the line below it.
- **Put a new definition in the section of `index.js` it serves.** That is usually the section that calls it. The contents comment at the top of the file lists the sections, so update it when a section gains or loses something it names. Where two sections share a private protocol, as replay and the interpreter do, the comment at each end names the function at the other.
- **Keep `index.d.ts` in step with `index.js`.** The declarations are hand-maintained, so a new or changed export needs both files; the `Declaration parity` test fails when the two lists differ. A new type needs an assertion in `test/types.test-d.ts`, with deliberate errors written as `// @ts-expect-error` directives rather than `expectError` calls.
- **Change `effectPipe`'s overloads in `scripts/effect-pipe-overloads.js`, not in `index.d.ts`.** Run `npm run generate` to rewrite them; a test fails when the file and the script disagree.
- **Keep `index.d.ts` compiling on TypeScript 5.1.** `npm run test:ts-minimum` compiles the declarations and the type tests with it, and CI runs it too. It is not part of `npm test`, and it fetches TypeScript 5.1 with `npx` the first time.
- **Declare an optional option or hook field as `T | undefined`.** An option or hook set to `undefined` keeps its default, and a project compiled with `exactOptionalPropertyTypes` cannot pass a value read from configuration, typed `T | undefined`, to a field declared `T`. `tsd` runs with that flag, so give a new option a line in the type tests' section on options set to `undefined`. A test compiles each example under the flag too, since users copy the examples into their own projects.
- **Keep jargon out of the README.** The names the library exports are fine; everything else gets the plain word, so a flow rather than an Effect tree, joining rather than fan-in, stops rather than short-circuits. A precise term may stay where the plain words follow it in the same breath.
- **Keep README examples runnable.** The `README examples` suite executes every `js` block with its assertions live, so a fenced `js` block has to be real JavaScript: put a value shape in a `text` block, write out a placeholder rather than `...`, and add a stub to that suite for anything new an example reaches for outside the library.
- **Keep the README's orientation sections short.** How It Works and the others are a few plain sentences. Where something is missing, add a sentence or two rather than restructuring the section.
- **Add a changelog entry** under `Unreleased` in `CHANGELOG.md` for a change to what the library does or exports, placed by importance within its section: a breaking change before the rest, then what affects the most users or changes what their runs do. A documentation-only change gets no entry, and a commit message does not list the docs updated alongside a code change.

## What to know about the tests

Tests assert on the data structures a flow returns rather than on side effects; that is the usage pattern the library exists for, so keep it. Hooks installed with `configureEffect` are process-wide and outlive a suite, so every `describe` that could inherit another's wiring resets with `beforeEach`. Both files in `examples/` are covered by tests and should not be edited without running them.

## Reporting a bug

Open an issue with the smallest flow that reproduces it. If replay is involved, the trace and the flow together are usually enough to reproduce the problem with no I/O at all, which is the point of the library; strip anything sensitive with `redact` first.
