# Hooks

This guide continues the [README](../README.md), and its examples use the Quick Start's `registerUserFlow` and `input`. The exact rules are in [REFERENCE.md](../REFERENCE.md#configureeffectconfigs).

Hooks see every run, and recording, replay and the [telemetry example](#tracing-with-opentelemetry) are built on them. There are three: `onRun` wraps a whole run, `onStep` wraps each Command and each `Parallel`, and `onBeforeCommand` runs before each Command and can veto it by throwing. A hook that only watches must `await` what it wraps and return its result; [`configureEffect`](../REFERENCE.md#configureeffectconfigs) lists each hook's arguments.

Use a veto as a guardrail, not as part of the flow's logic. A veto stops the whole run. The trace has no entry for the vetoed Command, so a replay of that run fails there. Put a decision the flow should handle in a step instead. Check a permission with `Ask` before the first Command writes anything, so a refusal leaves nothing half done. To turn off a supplier, read the switch in a Command and let its `next` fall back or return a `Failure`. The trace then records the switch, and a replay makes the same decision; [Errors no branch returned](../REFERENCE.md#errors-no-branch-returned) shows one.

`configureEffect` adds a layer of hooks for the whole process and returns a function that removes it. Removing a layer removes only that layer, even when others were installed after it, so a library can add and remove its own hooks without touching the application's:

```js
// recordingHooks comes from pure-effect/flight-recorder; telemetryHooks from the telemetry example.
const remove = configureEffect(telemetryHooks(), recordingHooks({ sink }));
// One layer whose hooks run as two calls' layers would; remove() removes both.
remove();
```

Layers run in the order they were installed, the first outermost, so a result or a thrown error unwinds from the innermost hook out:

```
runEffect(flow(input))
│
├─ telemetry.onRun                       first configuration: outermost
│  └─ recording.onRun                    last configuration: innermost
│     │
│     │  for each Command:
│     ├─ telemetry.onStep
│     │  └─ recording.onStep             closest to the Command
│     │     └─ cmd()
│     │  ┌─ recording.onStep returns     a result, or a thrown error, unwinds
│     ├─ telemetry.onStep returns        from the inside out
│     │
│  ┌─ recording.onRun returns
├─ telemetry.onRun returns
```

Neither the telemetry example nor the flight recorder has an `onBeforeCommand` hook. One you add runs before `onStep` for each Command. If several layers have one, they run in the order the layers were installed.

**Knowing which request a step belongs to.** `onRun` gets the run's context, but `onStep` does not, so a hook that logs each step per request finds the request the way the rest of your logging does. An `AsyncLocalStorage` scope entered around `runEffect` reaches every hook the run calls, and the flight recorder uses one to give each run its own recorder:

```js
import { AsyncLocalStorage } from 'node:async_hooks';

const requestScope = new AsyncLocalStorage();
const stepLog = [];

// Logs each step with its request and duration, and returns what the step returned.
const removeStepLog = configureEffect({
    onStep: async (name, type, op, path, step) => {
        const started = performance.now();
        try {
            return await op();
        } finally {
            const { requestId } = requestScope.getStore() ?? {};
            // The attempt at the nearest Retry: 0 for a first try, and for a step no Retry wraps.
            const attempt = step.attempts.at(-1) ?? 0;
            stepLog.push({ requestId, name, path, attempt, ms: performance.now() - started });
        }
    }
});

await requestScope.run({ requestId: 'req_1' }, () => runEffect(registerUserFlow(input)));
assert.deepEqual(
    stepLog.map((line) => [line.requestId, line.name]),
    [
        ['req_1', 'cmdFindUser'],
        ['req_1', 'cmdSaveUser']
    ]
);
removeStepLog();
```

**Knowing which try a step is, and what it calls.** The fifth argument, `step`, holds what the name does not say, so a hook never has to read it out of `path`:

- `step.attempts` is the attempt at each `Retry` around the step, outermost first. `0` is a first try, so `step.attempts.at(-1) > 0` means a retry. A step no `Retry` wraps has `[]`, and so does a step in an `onExhausted` fallback.
- `step.branches` is the branch at each `Parallel` around the step, outermost first.
- `step.meta` is the Command's `meta`. A Command built as `Command(cmdCharge, { external: true })` can be picked out by `step.meta?.external`, without matching its name.

A hook that calls another hook itself passes `path` and `step` on.

A Command that `onBeforeCommand` vetoes never reaches `onStep`, so log a veto where you make it. The run's `Failure` holds what the hook threw. Throw an error with a `code`, as in `Object.assign(new Error('Missing permission.'), { code: 'FORBIDDEN' })`, so the code that calls `runEffect` can answer it, with a 403 say, without matching the message.

In tests, call `configureEffect()` with no arguments in a `beforeEach`, so a test that fails before removing its hooks does not leave them installed for the next. A bare call removes every layer, your app's own hooks included. So when a test needs the app's hooks, such as a server's permission check or its recording, install them after the reset, in the same `beforeEach`, not once in a `before`. Nothing warns when they are missing: the run just goes ahead without them.

**Per-call hooks.** `runEffect`'s third argument takes hooks for that call only, and the run's `flowName`.

Exact rules: [per-call hooks](../REFERENCE.md#per-call-hooks).

## Tracing with OpenTelemetry

The telemetry example opens a span for each run, a child span for each Command, and one for each `Parallel` around its branches' spans. Spans carry names, timings and status, never values, so nothing a step returns reaches your tracing backend.

It is reference code you copy, not an entry point you import. It ships in the package's `examples` folder, `node_modules/pure-effect/examples`, and in the repository's [examples folder](https://github.com/aycangulez/pure-effect/blob/main/examples); copy it into your project.

In a TypeScript project, copy its `.d.ts` beside it, which types the import, so the project needs no `allowJs`. Without `allowJs`, though, `tsc` does not copy a `.js` file into its output folder. If your compiled code runs from that folder, copy the example's `.js` there as part of the build, or the import fails at runtime with `ERR_MODULE_NOT_FOUND`.

The telemetry example needs `@opentelemetry/api` installed, and its `.d.ts` does not compile without it. Its `startTelemetrySdk` loads `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/sdk-trace-base` only when it is called, so a project that starts the SDK itself needs none of them. If you start OpenTelemetry that way, also register a context manager, such as `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`. Without one, each Command's span is a separate root instead of a child of the run's span.

```js
import { enableTelemetry, startTelemetrySdk } from './opentelemetry-example.js';

await startTelemetrySdk({ serviceName: 'checkout' }); // or start the OpenTelemetry SDK yourself
enableTelemetry(); // installs telemetryHooks(); returns a function that removes them
```

Telemetry and the flight recorder work together as two layers: call `enableTelemetry()` and `enableRecording()` once each. Or install `telemetryHooks()` and `recordingHooks()` in one `configureEffect` call, as [Hooks](#hooks) shows, in place of both, never beside them, or each run is traced or recorded twice.
