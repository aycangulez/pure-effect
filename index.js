// @ts-check

/** @typedef {{ type: 'Success', value: any, initialInput?: any }} SuccessState */
/** @typedef {{ type: 'Failure', error: any, initialInput?: any }} FailureState */
/**
 * Metadata attached to a Command. A string `name` is read by the interpreter as the Command's
 * identity; every other key is carried through untouched for `onBeforeCommand`.
 * @typedef {{ name?: string } & Record<string, any>} CommandMeta
 */
/**
 * @typedef {{
 *   type: 'Command',
 *   cmd: (signal?: AbortSignal) => Promise<any>|any,
 *   next: (result: any) => Effect,
 *   meta?: any,
 *   initialInput?: any
 * }} CommandState
 */
/**
 * @typedef {{
 *   type: 'Ask',
 *   next: (context: any) => Effect,
 *   initialInput?: any
 * }} AskState
 */

/**
 * @typedef {{
 *   type: 'Retry',
 *   effect: Effect,
 *   options: { attempts?: number, delay?: number, backoff?: number, onExhausted?: (error: any) => Effect },
 *   next: (value: any) => Effect,
 *   initialInput?: any
 * }} RetryState
 */

/**
 * `settled` hands branch outcomes to `next` instead of failing on the first one; `limit` caps how many
 * branches run at once.
 * @typedef {{ limit?: number, settled?: boolean }} ParallelOptions
 */

/**
 * @typedef {{
 *   type: 'Parallel',
 *   effects: Effect[],
 *   next: (values: any[]) => Effect,
 *   options?: ParallelOptions,
 *   initialInput?: any
 * }} ParallelState
 */

/**
 * The Union type for all possible states
 * @typedef {SuccessState | FailureState | CommandState | AskState | RetryState | ParallelState} Effect
 */

/**
 * Represents a successful computation
 * @param {any} value - The result value
 * @returns {SuccessState}
 */
const Success = (value) => ({ type: 'Success', value });

/**
 * Represents a failed computation. Stops the pipeline execution
 * @param {any} error - The error reason (string, Error object, etc).
 * @param {any} [initialInput] - initial input passed to the flow (optional)
 * @returns {FailureState}
 */
const Failure = (error, initialInput) => ({
    type: 'Failure',
    error,
    initialInput
});

/**
 * Represents a side effect to be executed later.
 *
 * @param {(signal?: AbortSignal) => Promise<any>|any} cmd - The side-effect function to execute. Inside a
 *        `Parallel` branch it receives an `AbortSignal` that fires when a sibling branch fails, so I/O that
 *        accepts one can be cancelled in flight. Ignoring it is fine: the interpreter still refuses to start
 *        any later Command in a cancelled branch. Outside a `Parallel` no argument is passed.
 * @param {(result: any) => Effect} [next] - Receives the result of `cmd` and returns the next Effect.
 *        Defaults to `(result) => Success(result)`, which is what most Commands want.
 * @param {CommandMeta} [meta] - Optional metadata, passed to `onBeforeCommand`. A string `meta.name`
 *        becomes this Command's identity for traces, replay matching, and telemetry spans, which makes
 *        the identity independent of how `cmd` was declared and immune to minification.
 * @returns {CommandState}
 */
const Command = (cmd, next = (/** @type {any} */ result) => Success(result), meta) => ({
    type: 'Command',
    cmd,
    next,
    meta
});

/**
 * The name a Command is known by: what a trace records, what replay matches on, and what a
 * telemetry span is called.
 *
 * `meta.name` wins when it is a non-empty string. Otherwise the identity is the thunk's own `name`,
 * so an inline arrow records as 'anonymous' and a minifier that mangles function names silently
 * renames every step of every trace. Passing `meta.name` avoids both.
 *
 * @param {CommandState} eff
 * @returns {string}
 */
const commandName = (eff) => {
    const meta = eff.meta;
    const named = meta && typeof meta === 'object' ? meta.name : undefined;
    return typeof named === 'string' && named !== '' ? named : eff.cmd.name || 'anonymous';
};

/**
 * Reads the context object from the current `runEffect` call.
 * @param {(context: any) => Effect} next - Receives the context and returns the next Effect
 * @returns {AskState}
 */
const Ask = (next) => ({ type: 'Ask', next });

/**
 * Wraps an Effect tree with retry-on-failure semantics.
 *
 * Each attempt runs the **entire** wrapped tree again, including Commands that already succeeded, so
 * wrap the one Command that fails transiently rather than a pipeline. `Retry(effectPipe(charge, receipt))`
 * charges the customer again every time the receipt step fails. Wrapping a pipeline is only safe when
 * every Command in it is idempotent.
 *
 * @param {Effect} effect - The inner Effect tree to retry
 * @param {Object} [options] - Retry options, merged over the library defaults at runtime; there are no
 *        configured defaults, since how a dependency misbehaves is a property of that dependency
 * @param {number} [options.attempts] - Max retries (not counting first try)
 * @param {number} [options.delay] - Ms before first retry
 * @param {number} [options.backoff] - Multiplier applied to delay on each subsequent retry
 * @param {(error: any) => Effect} [options.onExhausted] - Runs a fallback Effect when every attempt has
 *        failed, receiving `{ retryExhausted, lastError, attempts }`. The fallback's success feeds `next`
 *        exactly as the primary's would have; its failure propagates unwrapped. Per-use only, never a
 *        global default, and a fallback never starts in a `Parallel` branch a sibling has cancelled.
 * @returns {RetryState}
 */
const Retry = (effect, options = {}) => ({
    type: 'Retry',
    effect,
    options,
    next: (value) => Success(value)
});

/**
 * Runs multiple Effect trees concurrently. The first branch to fail cancels its siblings, and that
 * branch's Failure is what the Parallel returns; `next` is skipped. When several branches fail in the
 * same tick, the first by array order wins.
 *
 * Cancellation is cooperative and works at two levels. A cancelled branch starts no further Commands,
 * which needs nothing from the caller. Stopping the Command already in flight needs its thunk to accept
 * the `AbortSignal` it is passed and hand it to whatever performs the I/O; a thunk that ignores the
 * signal runs to completion, so a branch's first Command can still write after a sibling has failed.
 *
 * `settled: true` turns off that first-failure rule: every branch runs to completion and `next`
 * receives the branch outcomes themselves, `Success` and `Failure` nodes in array order, so one
 * record's failure cannot abort a batch. An `EffectTypeError` still escapes, because a malformed flow
 * is a bug rather than a branch outcome. `limit: n` keeps at most `n` branches in flight, for a
 * resource that rate limits; results and paths stay in array order either way.
 *
 * The second argument is the `next` function or the options, whichever it looks like, so
 * `Parallel(effects, { limit: 5 })` needs no placeholder.
 *
 * @param {Effect[]} effects - Array of Effect trees to run concurrently
 * @param {((values: any[]) => Effect) | ParallelOptions} [nextOrOptions] - Receives array of success
 *        values in order and returns the next Effect, or the options. `next` defaults to
 *        `(values) => Success(values)`, same as `Command`'s default.
 * @param {ParallelOptions} [maybeOptions] - Options, when `next` was given
 * @returns {ParallelState}
 */
const Parallel = (effects, nextOrOptions, maybeOptions) => {
    const hasNext = typeof nextOrOptions === 'function';
    return {
        type: 'Parallel',
        effects,
        next: hasNext ? nextOrOptions : (/** @type {any[]} */ values) => Success(values),
        options: (hasNext ? maybeOptions : nextOrOptions) ?? {}
    };
};

/**
 * Describes a value for an error message, leading with the mistake it most likely is.
 * @param {any} value
 * @returns {string}
 */
const describeValue = (value) =>
    value === undefined
        ? 'undefined, which usually means a missing return'
        : value === null
          ? 'null'
          : typeof value === 'function'
            ? 'a function, which usually means a flow was passed without being called with its input'
            : typeof value === 'object'
              ? typeof value.type === 'string'
                  ? `an object with an unrecognised type '${value.type}'`
                  : 'a plain object'
              : `the ${typeof value} ${JSON.stringify(value)}`;

/**
 * Marks an error as the harness failing rather than the flow. The interpreter rethrows anything
 * carrying it instead of folding it into a `Failure`, which keeps it out of reach of everything that
 * legitimately handles a domain failure: a Command's `next`, `Retry`'s `onExhausted`, and the outcomes
 * a settled `Parallel` collects. A malformed flow and a trace that cannot answer a step are both this
 * kind of error, and a new one gets the mark rather than a new name for the interpreter to know about.
 * Non-enumerable, so it cannot show up in a serialized error or upset a `deepEqual` on an outcome.
 */
const harnessError = Symbol('pure-effect.harnessError');

/**
 * @param {Error} error
 * @returns {Error}
 */
const asHarnessError = (error) => Object.defineProperty(error, harnessError, { value: true });

/**
 * Marks a `Failure` as an I/O fault: the Command's function threw rather than the flow deciding to
 * stop. One failure channel carries both, and without the distinction `Retry` could not tell "the
 * socket died, try again" from "this email is already taken", so it re-ran a lookup four times for an
 * answer that could not change, buried the domain error under `retryExhausted`, and let `onExhausted`
 * answer a deliberate abort. A `Failure` a step returned carries no mark and is an abort, which is the
 * right default for one written by hand or rebuilt by a caller. Non-enumerable, so it never reaches a
 * comparison, a trace, or a caller reading the outcome.
 */
const ioFault = Symbol('pure-effect.ioFault');

/**
 * @param {FailureState} failure
 * @returns {FailureState}
 */
const asIoFault = (failure) => Object.defineProperty(failure, ioFault, { value: true });

/**
 * Checks that a value is an Effect, and explains the mistake when it is not.
 *
 * `EffectTypeError` is a bug in the flow rather than a domain failure, so it is thrown instead of
 * becoming a `Failure`, and the interpreter rethrows it rather than folding it into one.
 *
 * @param {any} value
 * @param {string} source - What produced the value, named where it is known
 * @returns {Error}
 */
const effectTypeError = (value, source) =>
    asHarnessError(
        Object.assign(
            new Error(
                `${source} returned ${describeValue(value)}. Return Success, Failure, Command, Ask, Retry, or Parallel: ` +
                    'a plain value has to be wrapped, as in Success(value).'
            ),
            { name: 'EffectTypeError' }
        )
    );

/**
 * @param {any} value
 * @param {string} source
 * @returns {Effect}
 */
const asEffect = (value, source) => {
    if (value && ['Success', 'Failure', 'Command', 'Ask', 'Retry', 'Parallel'].includes(value.type)) return value;
    throw effectTypeError(value, source);
};

/**
 * Connects an Effect to the next function in the pipeline.
 * Handles the branching logic for Success, Failure, Command, Ask, Retry, and Parallel.
 *
 * @param {Effect} effect - The current Effect object
 * @param {(value: any) => Effect} fn - The next function to run if the current effect is a Success
 * @param {any} [initialInput] - The pipeline's starting value, stamped on every node but a Success
 * @returns {Effect} The composed Effect
 */
const chain = (effect, fn, initialInput) => {
    // The outermost pipeline wins. A step can return a sub-pipeline whose nodes already carry that
    // sub-pipeline's start, and an outer chain reaches every one of them through the wrapped `next`
    // continuations, so overwriting here is what makes the whole tree, a Failure from any depth, and
    // the root a hook-based recorder reads carry the input of the flow that was actually called. The
    // previous rule, stamp only when unset, let a Retry- or Parallel-headed sub-pipeline leave its own
    // input on the root, and a trace recorded from it rebuilt the flow from the wrong value. A Success
    // is never stamped: nothing reads the input off a terminal value, and leaving it bare is what lets
    // `assert.deepEqual(result, Success(v))` hold whatever shape the flow had.
    const withII = (/** @type {Effect} */ e) =>
        initialInput !== undefined && e.type !== 'Success' ? { ...e, initialInput } : e;

    // A continuation that returned nothing has to be caught before `effect.type` is read. Reading it off
    // `undefined` throws a bare TypeError that names no step, and the run would reject with that. This
    // guard turns it into an EffectTypeError that says what went wrong. The `default` arm below never sees
    // it, because the switch itself is what throws.
    if (effect == null) return asEffect(effect, 'A continuation');

    switch (effect.type) {
        case 'Success':
            return withII(asEffect(fn(effect.value), `Step '${fn.name || 'anonymous'}'`));
        case 'Failure':
            return withII(effect);
        case 'Command': {
            const next = (/** @type {any} */ result) => chain(effect.next(result), fn, initialInput);
            return withII(Command(effect.cmd, next, effect.meta));
        }
        case 'Ask': {
            const next = (/** @type {any} */ ctx) => chain(effect.next(ctx), fn, initialInput);
            return withII(Ask(next));
        }
        case 'Retry': {
            const next = (/** @type {any} */ result) => chain(effect.next(result), fn, initialInput);
            return withII({ ...effect, next });
        }
        case 'Parallel': {
            const next = (/** @type {any} */ result) => chain(effect.next(result), fn, initialInput);
            return withII({ ...effect, next });
        }
        default:
            return asEffect(effect, 'A continuation');
    }
};

/**
 * Composes a list of functions into a single Effect pipeline.
 * Each function receives the output of the previous one.
 *
 * @param {...(input: any) => Effect} fns - Functions that return Success, Failure, Command, or Ask.
 * @returns {(start: any) => Effect} A function that accepts an initial input and returns the final Effect tree.
 */
const effectPipe = (...fns) => {
    return (start) => {
        const chainWithII = (/** @type {Effect} */ eff, /** @type {(v: any) => Effect} */ fn) => chain(eff, fn, start);
        const tree = fns.reduce(chainWithII, /** @type {Effect} */ (Success(start)));
        // One identity pass over the finished tree. `chain` re-stamps a sub-pipeline's nodes only as
        // it wraps the continuations that lead to them, and the last step has no later step to do
        // that wrapping, so a sub-pipeline returned by the last step would keep its own input on
        // everything past its head. The pass wraps those continuations too, so every node reachable
        // from here, a Failure at any depth included, carries this pipeline's `start`. `Success` is the
        // identity step: it can never return a non-Effect, so no message is ever attributed to it.
        return chain(tree, Success, start);
    };
};

/**
 * Wraps one Command execution. `path` identifies the Command's position in the Effect tree rather than
 * its position in completion order, so it is the same in a replay as it was in the recorded run even
 * when `Parallel` branches finish in a different order. Hooks written before `path` existed take three
 * parameters and are unaffected.
 * @typedef {(name: string, type: string, op: function, path?: string) => Promise<any>} StepRunner
 */
/** @type StepRunner */
const defaultStepRunner = async (name, type, op) => await op();

/** @typedef {(effect: Effect, op: function, flowName?: string) => Promise<any>} RunWrapper */
/** @type RunWrapper */
const defaultRunWrapper = async (effect, op, flowName) => await op();

/** @typedef {(command: CommandState, context?: any) => Promise<any>} CommandInterceptor */
/** @type CommandInterceptor */
const defaultCommandInterceptor = async (command, context) => {};

const defaultRetryOptions = { attempts: 3, delay: 100, backoff: 1 };

/**
 * Retry options were once a process-wide default that a per-use `Retry` merged over. They describe how
 * one dependency misbehaves rather than a property of the process, so they are per-use only now, and a
 * leftover `retry` key throws instead of being ignored: silently falling back to the library defaults
 * is how a configured `attempts: 5` quietly becomes 3. Remove this guard at 1.0.
 * @param {any} config
 * @param {string} source
 */
const rejectRetryKey = (config, source) => {
    if (config && typeof config === 'object' && 'retry' in config)
        throw new TypeError(
            `${source} no longer takes 'retry'. Retry options are per-use: pass them to Retry(effect, options).`
        );
};

/**
 * @typedef {Object} EffectConfiguration
 * @property {StepRunner} [onStep] - Fires every time a Command is executed. It wraps the `cmd` call.
 * @property {RunWrapper} [onRun] - Fires once per runEffect call. It wraps the entire workflow execution.
 * @property {CommandInterceptor} [onBeforeCommand] - Intercepts a Command and any context passed to runEffect before execution.
 */

/**
 * A per-call configuration: an `EffectConfiguration` plus `inherit`. With `inherit: true` (the default)
 * the call's hooks are added to the wiring `configureEffect` installed, by the merge `configureEffect`
 * applies to several configurations: global outermost, interceptors in order. With `inherit: false` the global wiring is not consulted at all, so any slot the call
 * leaves unset falls back to the library default. A per-call hook cannot replace a single global slot on
 * its own; that was the previous default, and it is how a per-call recorder silently switched off an
 * application's tracing.
 *
 * @typedef {EffectConfiguration & { inherit?: boolean }} CallConfiguration
 */

/** @type {EffectConfiguration[]} */
let layers = [];

/**
 * The installed layers merged into one configuration, empty when nothing is configured. This is the
 * only derived form of `layers`: `runEffect` reads it and merges the call's configuration over it,
 * and a slot no layer defines is simply absent, so the library default is chosen at the one place the
 * hook is used rather than held in a second set of variables kept in step by hand.
 * @type {EffectConfiguration}
 */
let globalConfig = {};

/** Recomputes the effective wiring from the installed layers, earlier layers outermost. */
const applyLayers = () => {
    globalConfig = chainHooks(...layers);
};

/**
 * Adds a configuration to the global wiring of the Effect runner: telemetry and the command
 * interceptor. Retry options are not part of it; they are per-use, passed to `Retry(effect, options)`.
 *
 * Each call adds one layer on top of those already installed and returns a function that removes that
 * layer, wherever it sits by then. Layers merge the way several configurations passed to one call do:
 * `onStep` and `onRun` are wrappers, so they nest with the earliest layer outermost and the latest
 * closest to the Command; and `onBeforeCommand` interceptors all run, in the order installed. So these
 * are the same:
 *
 *     configureEffect(telemetryHooks(), recordingHooks({ sink }));
 *     configureEffect(telemetryHooks()); configureEffect(recordingHooks({ sink }));
 *
 * Calling it with no arguments at all removes every layer. A call whose arguments are all `undefined`
 * is a conditional install that installed nothing: it adds no layer and removes none.
 *
 * Layers replaced the previous one-slot rule, under which a later call displaced the earlier wiring and
 * the returned function restored a snapshot, guarded so that interleaved installs could not clobber
 * each other. Removing a layer needs no guard: A installs, B installs, A removes, and B is still there.
 * It also means a library can install its own hooks without erasing its host's, which under the old rule
 * was possible only if the host passed the library's configuration into its own call.
 *
 * @param {...(EffectConfiguration | undefined)} configs - Configurations merged into one layer, outermost first
 * @returns {() => void} Removes the layer this call added; a second call does nothing
 */
const configureEffect = (...configs) => {
    // Only a call with no arguments at all is a reset. A call whose arguments are all absent, such as
    // `configureEffect(flag ? hooks : undefined)`, is a conditional install that happened not to install
    // anything, so it adds no layer and must not remove anyone else's.
    if (configs.length === 0) {
        layers = [];
        applyLayers();
        return () => {};
    }
    const present = configs.filter(Boolean);
    // Checked before anything is installed, so a refused call leaves the wiring exactly as it found it.
    present.forEach((config) => rejectRetryKey(config, 'configureEffect'));
    if (present.length === 0) return () => {};
    const layer = chainHooks(...present);
    layers = [...layers, layer];
    applyLayers();
    return () => {
        if (!layers.includes(layer)) return;
        layers = layers.filter((l) => l !== layer);
        applyLayers();
    };
};

/**
 * @typedef {Object} StepStart
 * @property {string} name - The Command's identity: `meta.name`, else `cmd.name`, else 'anonymous'.
 * @property {string} type - Always 'Command' today.
 * @property {string} [path] - The Command's position in the Effect tree.
 */

/**
 * @typedef {Object} StepEnd
 * @property {string} name
 * @property {string} type
 * @property {string} [path]
 * @property {any} [result] - What the Command returned, when it succeeded.
 * @property {any} [error] - What it threw, when it did not.
 * @property {number} durationMs
 */

const now = () => (typeof performance === 'object' ? performance.now() : Date.now());

/**
 * Wraps a step observer into an `onStep` that cannot change the run.
 *
 * @param {(start: StepStart) => (end: StepEnd) => void} handler - Returns a finisher for the outcome
 * @returns {StepRunner}
 */
const observeSteps = (handler) => async (name, type, op, path) => {
    /** @type {((end: StepEnd) => void) | undefined} */
    let finish;
    try {
        finish = handler({ name, type, path });
    } catch {
        finish = undefined;
    }
    const report = (/** @type {StepEnd} */ end) => {
        try {
            if (finish) finish(end);
        } catch {
            // Observation does not get to decide the outcome, so a broken observer is dropped.
        }
    };

    const started = now();
    try {
        const result = await op();
        report({ name, type, path, result, durationMs: now() - started });
        return result;
    } catch (error) {
        report({ name, type, path, error, durationMs: now() - started });
        throw error;
    }
};

/**
 * Merges several configurations into one, so independent concerns can share the hooks.
 *
 * `onStep` and `onRun` are wrappers around an `op`, so they nest. The first config given is
 * the outermost wrapper and the last sits closest to the Command, which also means a thrown
 * Command unwinds from the last config back to the first. `onBeforeCommand` is an observer,
 * so every interceptor runs in the order given. Nothing else merges, since every slot is a hook. A hook
 * no config defines is left unset, so the caller of the merged wiring keeps its default for that slot.
 *
 * @param {...(EffectConfiguration | undefined)} configs - Configurations to merge, outermost first
 * @returns {EffectConfiguration}
 */
const chainHooks = (...configs) => {
    const present = (/** @type {string} */ key) =>
        configs
            .filter(Boolean)
            .map((c) => /** @type {any} */ (c)[key])
            .filter(Boolean);

    /** @type {EffectConfiguration} */
    const merged = {};
    const steps = /** @type {StepRunner[]} */ (present('onStep'));
    const runs = /** @type {RunWrapper[]} */ (present('onRun'));
    const interceptors = /** @type {CommandInterceptor[]} */ (present('onBeforeCommand'));

    if (steps.length) {
        merged.onStep = steps.reduceRight(
            (inner, outer) => (name, type, op, path) => outer(name, type, () => inner(name, type, op, path), path)
        );
    }
    if (runs.length) {
        merged.onRun = runs.reduceRight(
            (inner, outer) => (effect, op, flowName) => outer(effect, () => inner(effect, op, flowName), flowName)
        );
    }
    if (interceptors.length) {
        merged.onBeforeCommand = async (command, context) => {
            for (const intercept of interceptors) await intercept(command, context);
        };
    }
    return merged;
};

/**
 * The Failure a `Parallel` branch resolves to when a sibling branch has already failed.
 *
 * Branches are cancelled, not merely ignored: this is what `Parallel` returns for a branch that was
 * still in flight, and it is deliberately distinguishable so it can be told apart from the genuine
 * failure that triggered the cancellation.
 * @returns {Error}
 */
const parallelCancelled = () =>
    Object.assign(new Error('Parallel branch cancelled.'), {
        name: 'ParallelCancelled'
    });

/**
 * Awaits every task, with at most `limit` of them in flight. Without a limit this is `Promise.all`,
 * which is what `Parallel` did before the option existed. Workers pull by index, so a slow branch
 * holds one slot rather than a position: results land where the caller put the effect, never where it
 * happened to finish, which is also what keeps trace paths stable.
 * @param {(() => Promise<void>)[]} tasks
 * @param {number} [limit]
 * @returns {Promise<void>}
 */
const runBounded = async (tasks, limit) => {
    if (!limit || limit >= tasks.length) {
        await Promise.all(tasks.map((task) => task()));
        return;
    }
    let cursor = 0;
    const worker = async () => {
        for (let i = cursor++; i < tasks.length; i = cursor++) await tasks[i]();
    };
    await Promise.all(Array.from({ length: limit }, worker));
};

/**
 * Sleeps, but gives up early when the surrounding branch is cancelled, so a sibling's failure does not
 * have to wait out a retry backoff that is now pointless. Resolves either way: the caller's abort check
 * is what turns a cancelled wait into a Failure.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
const delayFor = (ms, signal) =>
    new Promise((resolve) => {
        if (!signal) {
            setTimeout(resolve, ms);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });

const runEffect =
    /**
     * The Interpreter
     * Iterates through the Effect tree, executing Commands and handling async flow.
     * Ask effects are resolved synchronously with the context object.
     *
     * Per-call config is merged over the global configureEffect wiring, or over nothing under
     * `inherit: false`. onRun fires exactly once per runEffect call. Retry attempts run inside that
     * single span rather than spawning their own, keeping telemetry non-duplicated.
     *
     * @param {Effect} effect - The Effect tree returned by a pipeline
     * @param {any} [context] - Optional context object. Passed to Ask continuations and the Command Interceptor.
     * @param {CallConfiguration} [callConfig] - Per-call configuration, added to the wiring `configureEffect`
     *        installed unless `inherit: false`, which ignores that wiring for this run.
     * @returns {Promise<SuccessState | FailureState>}
     */
    async function runEffect(effect, context = {}, callConfig = {}) {
        rejectRetryKey(callConfig, "runEffect's callConfig");
        const { inherit = true, ...local } = callConfig;
        // A value that is not a boolean, such as a string left over from an older API, must not be
        // coerced: `'false'` inheriting everything is exactly the silent behaviour this option removes.
        if (typeof inherit !== 'boolean') {
            throw new TypeError(`callConfig.inherit must be true or false, got ${JSON.stringify(inherit)}.`);
        }
        // The call's configuration is merged over the installed wiring, or over nothing when the call
        // inherits nothing, by the same merge `configureEffect` applies to several configurations. Most
        // calls carry no configuration of their own, and those use the installed wiring as it is.
        const base = inherit ? globalConfig : {};
        const resolved = Object.keys(local).length ? chainHooks(base, local) : base;
        const localStepRunner = resolved.onStep || defaultStepRunner;
        const localRunWrapper = resolved.onRun || defaultRunWrapper;
        const localCommandInterceptor = resolved.onBeforeCommand || defaultCommandInterceptor;

        /**
         * @param {Effect} eff
         * @param {AbortSignal} [signal] - Cancellation for this subtree, set for `Parallel` branches.
         *        A branch stops starting new Commands once it is aborted, and the signal is handed to
         *        each Command's thunk so I/O that accepts one can be cancelled in flight.
         * @param {string} [path] - Prefix identifying this subtree's position in the Effect tree.
         *        Steps are numbered sequentially within a subtree and each `Parallel` branch and `Retry`
         *        attempt opens its own prefix, so a Command's full path depends only on the shape of the
         *        tree and not on the order branches happen to finish in. That is what lets a replay line
         *        a recorded step up with the step that asked for it.
         * @returns {Promise<SuccessState | FailureState>}
         */
        async function execute(eff, signal, path = '') {
            let step = 0;
            while (
                eff &&
                (eff.type === 'Command' || eff.type === 'Ask' || eff.type === 'Retry' || eff.type === 'Parallel')
            ) {
                // Checked before every node, which is what short-circuits a branch whose Commands
                // ignore the signal: the one in flight cannot be stopped, but the next never starts.
                if (signal?.aborted) return Failure(parallelCancelled(), eff.initialInput);
                if (eff.type === 'Ask') {
                    eff = eff.next(context);
                    continue;
                }
                if (eff.type === 'Retry') {
                    const opts = { ...defaultRetryOptions, ...eff.options };
                    const { attempts } = opts;
                    // A Retry that does not retry is not a Retry, and `attempts: 0` was also the one
                    // spelling that made `onExhausted` a plain catch for free. Both readings are wrong,
                    // so the value is refused rather than coerced.
                    if (!Number.isInteger(attempts) || attempts < 1)
                        throw new TypeError(
                            `Retry 'attempts' must be a positive integer, received ${describeValue(attempts)}. ` +
                                `To handle an outcome without retrying, branch on it as data in the Command's ` +
                                `next, or isolate a failing branch with Parallel's settled option.`
                        );
                    let lastError;
                    let succeeded = false;
                    // Each attempt gets its own prefix, so the Commands of attempt 2 cannot be mistaken
                    // for the Commands of attempt 1 when a trace is matched back up.
                    const retryPath = `${path}${step++}r`;
                    // Captured while `eff` is still narrowed to a Retry node: the loop reassigns `eff`
                    // on success, after which the checker cannot prove the fallback path still holds it.
                    const retryNext = eff.next;

                    for (let attempt = 0; attempt <= attempts; attempt++) {
                        if (attempt > 0) {
                            await delayFor(opts.delay * Math.pow(opts.backoff, attempt - 1), signal);
                        }
                        // Checked after the wait, so a branch cancelled mid-backoff stops here rather
                        // than buying one more attempt, and a sibling's failure does not pay for the
                        // rest of this branch's retry schedule.
                        if (signal?.aborted) return Failure(parallelCancelled(), eff.initialInput);
                        const result = await execute(eff.effect, signal, `${retryPath}${attempt}/`);
                        if (result.type === 'Success') {
                            eff = retryNext(result.value);
                            succeeded = true;
                            break;
                        }
                        // An abort is the flow deciding, not the I/O failing, so there is nothing to
                        // try again and nothing for a fallback to answer. It leaves unwrapped: the
                        // exhaustion shape would be a claim about retrying that never happened.
                        if (!(/** @type {any} */ (result)[ioFault])) return result;
                        lastError = result.error;
                    }

                    if (!succeeded) {
                        const exhausted = { retryExhausted: true, lastError, attempts };
                        const { onExhausted } = opts;
                        if (typeof onExhausted !== 'function') return asIoFault(Failure(exhausted, eff.initialInput));
                        // A cancelled branch must not start its fallback, for the same reason it starts
                        // no further Commands: recovery must not resurrect work a sibling's failure ended.
                        if (signal?.aborted) return Failure(parallelCancelled(), eff.initialInput);
                        // The fallback gets its own path prefix, so a fallback-path trace can never be
                        // confused with a success-path one when it is matched back up on replay.
                        const fallback = await execute(
                            asEffect(onExhausted(exhausted), "Retry option 'onExhausted'"),
                            signal,
                            `${retryPath}f/`
                        );
                        // A failing fallback propagates as-is: the flow's last word was the fallback's
                        // error, not the exhaustion it was already told about.
                        if (fallback.type === 'Failure') return fallback;
                        eff = retryNext(fallback.value);
                    }
                    continue;
                }
                if (eff.type === 'Parallel') {
                    // Branch prefixes come from the branch's index in the array, never from the order
                    // branches complete in, which is the whole point: two branches calling the same
                    // Command are told apart by where they are rather than by who finished first.
                    const branchPath = `${path}${step++}p`;
                    const { limit, settled } = eff.options ?? {};
                    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
                        throw new TypeError(
                            `Parallel 'limit' must be a positive integer, received ${describeValue(limit)}.`
                        );
                    // One scope per Parallel, linked to the enclosing one so cancellation nests.
                    // Absent AbortController (very old runtimes), `branchSignal` stays undefined and
                    // the old run-everything-to-completion behaviour is what happens. The scope is kept
                    // under `settled` so an enclosing Parallel can still cancel this one; what settled
                    // drops is a branch cancelling its own siblings.
                    const scope = typeof AbortController === 'function' ? new AbortController() : undefined;
                    const branchSignal = scope?.signal;
                    const relay = () => scope?.abort();
                    if (signal && scope) {
                        if (signal.aborted) scope.abort();
                        else signal.addEventListener('abort', relay, { once: true });
                    }

                    /** @type {(SuccessState | FailureState)[]} */
                    const results = new Array(eff.effects.length);
                    // Which branch failed on its own account rather than because it was cancelled.
                    const triggered = new Array(eff.effects.length).fill(false);
                    // A branch that throws (a bug in its code, or a harness error) cancels its siblings
                    // like a failing one, under `settled` too, since the run is rejecting either way. The
                    // error is held rather than rethrown at once: rejecting `runBounded` early used to
                    // leave the siblings running unobserved, and under `limit` it stopped that worker.
                    /** @type {{ error: unknown }[]} */
                    const thrown = new Array(eff.effects.length);
                    try {
                        // Still awaits every branch, so no cancelled work is left running unobserved
                        // after the Failure is returned. Cancelled branches settle promptly; a branch
                        // whose in-flight Command ignores the signal is the one case that does not.
                        await runBounded(
                            eff.effects.map((e, i) => async () => {
                                let result;
                                try {
                                    result = await execute(e, branchSignal, `${branchPath}${i}/`);
                                } catch (error) {
                                    thrown[i] = { error };
                                    scope?.abort();
                                    return;
                                }
                                results[i] = result;
                                // Read-then-abort is atomic here, so exactly one branch is the trigger.
                                if (result.type === 'Failure' && !settled && !branchSignal?.aborted) {
                                    triggered[i] = true;
                                    scope?.abort();
                                }
                            }),
                            limit
                        );
                    } finally {
                        if (signal && scope) signal.removeEventListener('abort', relay);
                    }
                    // The first by array order, matching how a Failure is chosen when several land at once.
                    const firstThrown = thrown.find(Boolean);
                    if (firstThrown) throw firstThrown.error;

                    // Settled hands the outcomes on as they are. A branch that failed is data here, so
                    // `next` runs and the Parallel itself never fails on a branch's account.
                    if (settled) {
                        eff = eff.next(results);
                        continue;
                    }

                    const trigger = triggered.indexOf(true);
                    const failure = trigger >= 0 ? results[trigger] : results.find((r) => r.type === 'Failure');
                    if (failure) return failure;
                    eff = eff.next(results.map((r) => /** @type {SuccessState} */ (r).value));
                    continue;
                }
                const cmdName = commandName(eff);
                const initialInput = eff.initialInput;
                const cmdPath = `${path}${step++}`;
                const cmd = eff.cmd;
                // The signal reaches the thunk only inside a Parallel, so a thunk written to take a
                // parameter is not handed an argument it never expected anywhere else.
                const op = signal ? () => cmd(signal) : cmd;
                // Three separate regions, because a throw means something different in each. An
                // interceptor that throws is vetoing the Command, which is the flow being stopped rather
                // than the I/O failing, so it is an abort and `Retry` passes it on. Only a throw from the
                // Command's function is an I/O fault. A malformed flow is a bug, not a domain failure,
                // so in either catch it must not masquerade as one.
                try {
                    await localCommandInterceptor(eff, context);
                } catch (e) {
                    if (e && /** @type {any} */ (e)[harnessError]) throw e;
                    return Failure(e, initialInput);
                }
                let result;
                try {
                    result = await localStepRunner(cmdName, 'Command', op, cmdPath);
                } catch (e) {
                    if (e && /** @type {any} */ (e)[harnessError]) throw e;
                    return asIoFault(Failure(e, initialInput));
                }
                // Outside both catches: `next`, and every pure step it reaches up to the next Command, is
                // code rather than I/O, so a throw there is a bug and rejects the run like a throw from
                // any other continuation. Inside the catch it was an I/O fault, and `Retry` re-ran a
                // Command that had succeeded because a TypeError followed it.
                eff = eff.next(result);
            }
            if (eff && (eff.type === 'Success' || eff.type === 'Failure')) return eff;
            throw effectTypeError(eff, 'The flow');
        }

        // Every Failure leaves through here, including one a Parallel branch or a Retry fallback handed
        // back. `chain` stamps only what passes through the continuations it wraps, and those subtrees
        // are executed directly rather than reached through a continuation, so their Failures arrive
        // carrying the subtree's own input or none. Restamping the outcome with the root's input is
        // what makes "a Failure carries the input of the flow that was called" true at any depth.
        const rootInput = effect?.initialInput;
        const run = async () => {
            const result = await execute(effect);
            return result.type === 'Failure' && rootInput !== undefined ? Failure(result.error, rootInput) : result;
        };
        return localRunWrapper(effect, run, context?.flowName || '');
    };

/**
 * The step a replay is asking about. `path` is the Command's position in the Effect tree and is stable
 * across runs; `index` is its position in this run's completion order, which is not stable for a flow
 * containing `Parallel`. Prefer `path` when writing a Resolver.
 * @typedef {{ index: number, name: string, type: string, path?: string }} ReplayStep
 */

/**
 * What production observed for a step. `{ result }` is handed to the Command's
 * `next`; `{ error }` is thrown so the interpreter produces a Failure. A resolver
 * returning `undefined` means "not recorded".
 *
 * @typedef {{ result: any } | { error: any }} ReplayOutcome
 */

/** @typedef {(step: ReplayStep) => ReplayOutcome | undefined} Resolver */

/**
 * A recorded step. `durationMs` is how long the Command took in production, rounded to microseconds,
 * which is the one question a trace could not answer before: which step was slow.
 * `path` locates the Command in the Effect tree, which is what a replay matches on: it does not move
 * when `Parallel` branches finish in a different order than they did in production.
 * @typedef {{ command: string, path?: string, result?: any, error?: any, durationMs?: number }} TraceEntry
 */

/**
 * The reference trace format produced by `recorder`. A convenience, not a contract:
 * `replayEffect` takes a Resolver, so any storage shape works.
 * @typedef {{
 *   flowName?: string,
 *   version?: string,
 *   initialInput?: any,
 *   context?: any,
 *   dropped?: number,
 *   trace: TraceEntry[]
 * }} TraceLog
 */

/**
 * A replay fault: the trace cannot answer the flow, or disagrees with it. It is a harness error while
 * the flow runs, so nothing inside the flow can swallow it, and `replayEffect` turns it back into a
 * `Failure` at its own boundary, where there is no longer anything to swallow it and a caller can
 * inspect it. An `EffectTypeError` carries no replay mark and keeps propagating, since a malformed
 * flow is a bug in the flow rather than a problem with the trace.
 */
const replayFault = Symbol('pure-effect.replayFault');

/**
 * Creates a replay error. Thrown from a resolver, it is rethrown by the interpreter rather than folded
 * into a Failure, and `replayEffect` turns it into one at its own boundary.
 * @param {string} message - Human-readable reason
 * @param {Object} [props] - Extra fields such as `name`, `index`, `expected`, `actual`
 * @returns {Error}
 */
const replayError = (message, props = {}) =>
    Object.defineProperty(
        asHarnessError(Object.assign(new Error(message), { name: 'ReplayError' }, props)),
        replayFault,
        {
            value: true
        }
    );

/**
 * Signals that the flow being replayed asked for a different Command than the trace
 * recorded, which means the code has diverged from the recorded run.
 * @param {ReplayStep} step - The step the flow asked for
 * @param {string} recorded - The command name the trace holds at that position
 * @returns {Error}
 */
const timeParadox = (step, recorded) =>
    replayError(
        `Time paradox at ${step.path !== undefined ? `path '${step.path}'` : `step ${step.index}`}: ` +
            `flow asked for '${step.name}', trace recorded '${recorded}'`,
        {
            name: 'TimeParadox',
            index: step.index,
            path: step.path,
            expected: recorded,
            actual: step.name
        }
    );

/**
 * Converts a thrown value into something JSON can carry. `message` and `stack` are
 * non-enumerable on Error, so a plain `JSON.stringify` would silently drop them.
 *
 * @param {any} e - The thrown value
 * @param {boolean} [withStack] - Include the stack (off by default: noisy, leaks paths)
 * @returns {any}
 */
const serializeError = (e, withStack) => {
    if (!(e instanceof Error)) return e;
    /** @type {any} */
    const out = { __error: true, name: e.name, message: e.message };
    if (withStack) out.stack = e.stack;
    // `cause` is non-enumerable too, and it can itself be an Error, so it is carried recursively.
    if ('cause' in e) out.cause = serializeError(e.cause, withStack);
    for (const k of Object.keys(e)) out[k] = /** @type {any} */ (e)[k];
    return out;
};

/**
 * Rebuilds an Error from `serializeError` output. Non-Error values pass through, so a
 * Command that rejected with a string still replays as a string.
 * @param {any} v - A serialized error, or any other recorded value
 * @returns {any}
 */
const reviveError = (v) => {
    if (!v || typeof v !== 'object' || v.__error !== true) return v;
    const e = new Error(v.message);
    // `name` and `cause` are non-enumerable on a native Error (`name` is inherited, `cause` is set by the
    // constructor), so they are defined the same way here. Assigning them would make them own enumerable
    // keys, and the revived error would then never compare deep-equal to the one the Command threw, which
    // is what the record-then-replay determinism check relies on. Everything else was enumerable on the
    // original, since `serializeError` read it through `Object.keys`, so plain assignment is faithful.
    const hidden = { enumerable: false, configurable: true, writable: true };
    Object.defineProperty(e, 'name', { ...hidden, value: v.name });
    for (const [k, val] of Object.entries(v)) {
        if (k === '__error' || k === 'name' || k === 'message') continue;
        if (k === 'cause') Object.defineProperty(e, 'cause', { ...hidden, value: reviveError(val) });
        else /** @type {any} */ (e)[k] = val;
    }
    return e;
};

/**
 * @typedef {Object} RecorderOptions
 * @property {(value: any, name: string, kind: string) => any} [redact] - Scrubs every value a trace holds:
 *           each Command's result, each serialized error, and the `initialInput` and `context` stored on the
 *           trace itself. `kind` is `'result'`, `'error'`, `'initialInput'`, or `'context'`, and `name` is the
 *           Command's name for the first two and the kind for the last two. It is the single place PII is kept
 *           out of a trace, so it has to see all four.
 * @property {number} [maxEntries] - Caps trace length; further steps are counted in `dropped`, not stored.
 * @property {boolean} [stack] - Records stack traces for thrown errors.
 */

/**
 * @typedef {Object} TraceMeta
 * @property {any} [initialInput] - The value the flow was called with.
 * @property {string} [flowName]
 * @property {any} [context] - Context passed to `runEffect`; required to replay `Ask`.
 * @property {string} [version] - Commit or build id, so a replay can detect a stale trace.
 */

/**
 * Snapshots a value on its way into a trace.
 *
 * Commands return live objects, and a later step that mutates one would otherwise rewrite what the
 * trace says an earlier step returned: `toTrace` runs after the flow finishes, so by serialization
 * time the mutation is already baked in and the trace records a value production never saw. Values
 * that cannot be cloned fall back to the reference.
 *
 * @param {any} value
 * @returns {any}
 */
const snapshot = (value) => {
    if (value === null || typeof value !== 'object') return value;
    try {
        return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
};

/**
 * Builds an `onStep` hook that records what every Command returned, plus a packager
 * for the reference trace format. Pass `onStep` to `runEffect` as per-call config, or
 * to `configureEffect` to record globally.
 *
 * @param {RecorderOptions} [options] - Redaction and size limits
 * @returns {{ onStep: StepRunner, entries: TraceEntry[], toTrace: (meta?: TraceMeta) => TraceLog }}
 */
const recorder = (options = {}) => {
    const { redact = (/** @type {any} */ r) => r, maxEntries = Infinity, stack = false } = options;
    /** @type {TraceEntry[]} */
    const entries = [];
    let dropped = 0;

    const push = (/** @type {TraceEntry} */ entry) => {
        if (entries.length < maxEntries) entries.push(entry);
        else dropped++;
    };

    /**
     * `redact` is the caller's code.
     */
    const safeRedact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
        try {
            return redact(value, name, kind);
        } catch {
            return '[redaction failed]';
        }
    };

    /**
     * Redacts and snapshots one of the trace's own fields. `undefined` is left alone so a flow with no
     * context does not acquire an empty object from a redact function that spreads its argument.
     */
    const redactField = (/** @type {any} */ value, /** @type {string} */ kind) =>
        value === undefined ? undefined : snapshot(safeRedact(value, kind, kind));

    // Built on `observeSteps` so the hook contract lives in one place: `op` always runs, its result is
    // always returned, and its error always propagates.
    const onStep = observeSteps(({ name, path }) => (end) => {
        const durationMs = Math.round(end.durationMs * 1000) / 1000;
        push(
            'error' in end
                ? {
                      command: name,
                      path,
                      error: snapshot(safeRedact(serializeError(end.error, stack), name, 'error')),
                      durationMs
                  }
                : { command: name, path, result: snapshot(safeRedact(end.result, name, 'result')), durationMs }
        );
    });

    /**
     * @param {TraceMeta} [meta]
     * @returns {TraceLog}
     */
    const toTrace = (meta = {}) => ({
        flowName: meta.flowName,
        version: meta.version,
        initialInput: redactField(meta.initialInput, 'initialInput'),
        context: redactField(meta.context, 'context'),
        dropped,
        trace: entries.slice()
    });

    return { onStep, entries, toTrace };
};

/**
 * Runs a flow for real while recording every Command result, and returns both the
 * outcome and a replayable trace. Convenient in tests and scripts; in an application,
 * install `recorder().onStep` once via `configureEffect` instead of changing call sites.
 *
 * @param {(input: any) => Effect} flowFn - Builds the Effect tree from its input
 * @param {any} initialInput - The value the flow is called with; stored so a replay can rebuild it
 * @param {RecorderOptions & { context?: any, version?: string }} [options] - Recorder options, plus the
 *        `context` given to `runEffect` (stored so `Ask` can be replayed) and a build id
 * @returns {Promise<{ result: SuccessState | FailureState, trace: TraceLog }>}
 */
const recordEffect = async (flowFn, initialInput, options = {}) => {
    const { context = {}, version, ...recorderOptions } = options;
    const rec = recorder(recorderOptions);
    // The recorder is added to the global wiring, so recording inside an instrumented application keeps
    // its spans.
    const result = await runEffect(flowFn(initialInput), context, { onStep: rec.onStep });
    return {
        result,
        trace: rec.toTrace({ initialInput, flowName: context.flowName, context, version })
    };
};

/**
 * Turns a recorded entry into the outcome a Resolver must return.
 *
 * @param {TraceEntry} entry
 * @returns {ReplayOutcome}
 */
const entryToOutcome = (entry) => ('error' in entry ? { error: reviveError(entry.error) } : { result: entry.result });

/**
 * Builds a Resolver for the reference trace format. Internal: `replayEffect` calls this
 * when handed a trace instead of a Resolver, and is the only caller. Callers with traces
 * in some other shape write a Resolver instead, which is the extension point.
 *
 * Path matching is used whenever every entry carries a `path`, which is every trace this
 * version records. A path is the Command's position in the Effect tree, so it is order-independent
 * and still paradox-detecting: it works for `Parallel` as it is, and it tells two branches that
 * call the same Command apart by where they are rather than by which finished first.
 *
 * A trace whose entries carry no path (recorded before paths existed, or written by hand) is
 * matched positionally: entries are consumed in recorded order and each must name the Command the
 * flow asks for. That is exact for sequential flows and cannot tell `Parallel` branches apart, which
 * is what paths were added to fix.
 *
 * @param {TraceLog | TraceEntry[]} traceLog - A reference-format trace, or a bare array of entries
 * @param {Object} [options]
 * @param {(entry: TraceEntry) => void} [options.onEntry] - Observes each entry as it is handed to a step,
 *        which is how `replayEffect` learns which recorded entries the flow never asked for.
 * @returns {Resolver}
 */
const fromTrace = (traceLog, options = {}) => {
    const { onEntry } = options;
    const entries = Array.isArray(traceLog) ? traceLog : traceLog?.trace;
    if (!Array.isArray(entries)) throw replayError('Trace has no `trace` array.');
    const resolveEntry = (/** @type {TraceEntry} */ entry) => {
        if (onEntry) onEntry(entry);
        return entryToOutcome(entry);
    };

    if (entries.length > 0 && entries.every((e) => typeof e.path === 'string')) {
        const byPath = new Map(entries.map((e) => [e.path, e]));
        // Paths are derived from tree position, so they are unique by construction. A collision means
        // either a hand-built trace or a bug in path derivation, and silently keeping the last entry
        // would reintroduce exactly the wrong-result-per-branch failure paths exist to prevent.
        if (byPath.size !== entries.length) {
            throw replayError('Trace has duplicate step paths.');
        }
        return (step) => {
            const entry = byPath.get(step.path);
            if (!entry) {
                throw replayError(`Trace has no step at path '${step.path}' for '${step.name}'.`, {
                    command: step.name,
                    path: step.path
                });
            }
            if (entry.command !== step.name) throw timeParadox(step, entry.command);
            return resolveEntry(entry);
        };
    }

    return (step) => {
        // Positional matching pairs steps by completion order, which is exactly what makes Parallel
        // branches indistinguishable. Refusing is better than a result that is right only when the
        // replay happens to finish in production's order.
        if (typeof step.path === 'string' && /p\d+\//.test(step.path)) {
            throw replayError(
                `Trace carries no paths, so '${step.name}' inside a Parallel cannot be matched positionally.`,
                { command: step.name, path: step.path }
            );
        }
        const entry = entries[step.index];
        if (!entry) throw replayError(`Trace exhausted: no entry #${step.index} for '${step.name}'.`);
        if (entry.command !== step.name) throw timeParadox(step, entry.command);
        return resolveEntry(entry);
    };
};

/**
 * Rewrites `Retry` nodes to zero delay, lazily, through their `next` continuations.
 *
 * Needed because a delay is written at the call site and nothing outside the node
 * can override it: retry options are per-use only. Without this, replaying a flow
 * that retried in production waits out the production backoff.
 *
 * @param {any} eff - Any Effect node
 * @returns {any} The same tree with Retry delays removed
 */
const zeroRetryDelays = (eff) => {
    if (!eff || typeof eff.type !== 'string') return eff;
    switch (eff.type) {
        case 'Retry': {
            const options = { ...eff.options, delay: 0, backoff: 1 };
            // The fallback tree only exists once onExhausted runs, so it is rewritten lazily too;
            // otherwise a Retry inside the fallback keeps its production backoff during replay.
            if (typeof options.onExhausted === 'function') {
                const original = options.onExhausted;
                options.onExhausted = (/** @type {any} */ error) => zeroRetryDelays(original(error));
            }
            return {
                ...eff,
                options,
                effect: zeroRetryDelays(eff.effect),
                next: (/** @type {any} */ value) => zeroRetryDelays(eff.next(value))
            };
        }
        case 'Command':
            return { ...eff, next: (/** @type {any} */ result) => zeroRetryDelays(eff.next(result)) };
        case 'Ask':
            return { ...eff, next: (/** @type {any} */ ctx) => zeroRetryDelays(eff.next(ctx)) };
        case 'Parallel':
            return {
                ...eff,
                effects: eff.effects.map(zeroRetryDelays),
                next: (/** @type {any} */ values) => zeroRetryDelays(eff.next(values))
            };
        default:
            return eff;
    }
};

/**
 * @typedef {Object} ReplayOptions
 * @property {any} [context] - Context for `Ask`; pass the recorded context to reproduce a run faithfully.
 * @property {boolean} [fastRetry] - Strips Retry delays so a replay does not wait out production backoff.
 * @property {boolean} [hooks] - Runs the replay inside the hooks `configureEffect` installed, with the
 *           resolver innermost, so a configured `onStep` observes each replayed step and `onRun` and
 *           `onBeforeCommand` fire. Off by default, which ignores the global hooks, so a replay cannot
 *           reach a telemetry backend or a guardrail that performs I/O. Retry options travel with the
 *           node either way, so a replay makes the attempts production made.
 * @property {'throw' | 'execute'} [onMissing] - What to do when the resolver has no recording for a step.
 *           `'throw'` (default) fails the replay, which makes side effects impossible for the whole run.
 *           `'execute'` runs the real Command, giving partial replay: recorded prefix, live tail.
 * @property {(step: ReplayStep, outcome: ReplayOutcome | undefined) => void} [onResolved] - Observes each step.
 */

/**
 * What a replay returns: the flow's own outcome, and, when a trace was supplied, the recorded
 * entries the flow never asked for. `unreached` is absent for a Resolver, since only a trace
 * knows what it holds.
 *
 * A flow that stops issuing Commands before its recording ends mismatches nothing, so no
 * `TimeParadox` fires and `result` can be a `Success` with recorded steps left over. That is
 * sometimes the point of a fix and sometimes a fix that quietly dropped a step; `unreached` is
 * the only place the difference shows, which is why it travels with the result rather than
 * behind an option.
 * @typedef {{ result: SuccessState | FailureState, unreached?: TraceEntry[] }} Replay
 */

/**
 * Replays an Effect tree, feeding recorded results to Commands instead of running them.
 *
 * No side effect can occur by default. The interpreter's only execution point is
 * `await localStepRunner(cmdName, 'Command', op, cmdPath)`, which hands the Command thunk
 * to `onStep` as `op` rather than calling it. The `onStep` installed here never invokes
 * `op` unless `onMissing: 'execute'` is set, so `eff.cmd` is never applied and the I/O
 * it describes does not happen.
 *
 * Driving the interpreter instead of walking the tree is what makes `Ask`, `Retry` and
 * `Parallel` work, and means replay cannot drift from execution semantics.
 *
 * @param {Effect} effect - The Effect tree, rebuilt from the recorded initial input
 * @param {Resolver | TraceLog | TraceEntry[]} traceOrResolver - A reference-format trace, resolved here, or a
 *        Resolver supplying each Command's recorded outcome (`undefined` if it has none). Write a Resolver when
 *        traces are stored in some other shape; to observe a replay without one, use `onResolved`.
 * @param {ReplayOptions} [options]
 * @returns {Promise<Replay>} `{ result, unreached }` for a trace, `{ result }` for a Resolver
 */
// `async` so a malformed trace arrives as a rejection rather than a synchronous throw:
// the function otherwise returns a promise, and callers should not have to handle both.
const replayEffect = async (effect, traceOrResolver, options = {}) => {
    const { context = {}, fastRetry = true, hooks = false, onMissing = 'throw', onResolved } = options;
    // A trace is data and a Resolver is a function, so nothing else is needed to tell them
    // apart, including the bare entries array that `fromTrace` also accepts.
    const fromResolver = typeof traceOrResolver === 'function';
    /** @type {Set<TraceEntry>} */
    const reached = new Set();
    const resolve = fromResolver
        ? traceOrResolver
        : fromTrace(traceOrResolver, { onEntry: (entry) => void reached.add(entry) });
    let index = 0;

    /** @type {StepRunner} */
    const onStep = async (name, type, op, path) => {
        const step = { index: index++, name, type, path };
        const outcome = resolve(step);
        if (onResolved) onResolved(step, outcome);
        if (outcome === undefined) {
            if (onMissing !== 'execute') {
                throw replayError(
                    `No recorded outcome for '${name}' at step ${step.index}; refusing to run the real Command. ` +
                        `Pass onMissing: 'execute' to allow live I/O for unrecorded steps.`,
                    { command: name, index: step.index }
                );
            }
            return await op();
        }
        if ('error' in outcome) throw outcome.error;
        return outcome.result;
    };

    // Off, a replay ignores the global hooks, so it can reach neither a telemetry backend nor a guardrail
    // that performs I/O. On, it runs inside them with the resolver innermost, so a configured onStep
    // observes each replayed step and the Command still never executes. Retry shape needs nothing from
    // the wiring either way, since retry options live on the node: a replay makes the attempts production
    // made whichever way this is set.
    /** @type {CallConfiguration} */
    const callConfig = { onStep, inherit: hooks };

    // The interpreter rethrows a replay fault rather than folding it into a `Failure`, so that neither
    // `onExhausted` nor a settled `Parallel` can absorb one: a truncated trace used to replay as a
    // `Success` whose branches each carried the ReplayError as though production had returned it. It
    // becomes a `Failure` here instead, which is the shape this function has always returned and the
    // one place where nothing downstream can catch it.
    let result;
    try {
        result = await runEffect(fastRetry ? zeroRetryDelays(effect) : effect, context, callConfig);
    } catch (e) {
        if (!(e && /** @type {any} */ (e)[replayFault])) throw e;
        result = Failure(e, effect.initialInput);
    }
    if (fromResolver) return { result };
    // `fromTrace` has already validated the shape, so the entries are here in one form or the other.
    const entries = Array.isArray(traceOrResolver) ? traceOrResolver : traceOrResolver.trace;
    return { result, unreached: entries.filter((entry) => !reached.has(entry)) };
};

/**
 * Replays a reference-format trace and narrates each step. Rebuilds the flow from the
 * recorded input, reports the outcome, and names any recorded steps that were never
 * reached, which means the current code issued fewer Commands than production did.
 *
 * @param {(input: any) => Effect} flowFn - The same flow function that produced the trace
 * @param {TraceLog} traceLog - A trace from `recordEffect` or a `recorder`
 * @param {Object} [options]
 * @param {(...args: any[]) => void} [options.log] - Defaults to `console.log`
 * @param {any} [options.context] - Overrides the context stored on the trace
 * @param {string} [options.version] - Current build id; warns when it differs from the trace's
 * @returns {Promise<SuccessState | FailureState>} The flow's outcome. Narration is the point of this function;
 *          a caller who wants the unreached entries as data uses `replayEffect`.
 */
const timeTravel = async (flowFn, traceLog, options = {}) => {
    const { log = console.log, context, version } = options;
    const { initialInput, trace, flowName, version: traceVersion } = traceLog;
    // `message` and `stack` are non-enumerable on Error, so JSON.stringify alone would
    // drop the most useful line of the report.
    const format = (/** @type {any} */ v) =>
        v instanceof Error
            ? JSON.stringify({ ...v, name: v.name, message: v.message }, null, 2)
            : JSON.stringify(v, null, 2);

    if (version && traceVersion && version !== traceVersion) {
        log(`Warning: trace was recorded at ${traceVersion}, replaying against ${version}.`);
    }
    const stepsText = trace.length === 0 || trace.length > 1 ? 'steps' : 'step';
    log(`Replaying '${flowName || 'flow'}' (${trace.length} recorded ${stepsText})`);
    log(`Initial input: ${format(initialInput)}`);

    // Narration goes through `onResolved` rather than a wrapped Resolver: observing each
    // step is all this needs, and `replayEffect` already resolves the trace itself.
    // A path maps a replayed step back to its recorded entry whatever order branches finished in, so
    // timings are narrated for Parallel too. Positional lookup is the fallback for a trace with no paths,
    // which is how such a trace is matched anyway.
    const byPath = new Map(trace.filter((e) => typeof e.path === 'string').map((e) => [e.path, e]));
    const timing = (/** @type {ReplayStep} */ step) => {
        const recorded = byPath.get(step.path) ?? trace[step.index];
        return typeof recorded?.durationMs === 'number' ? ` in ${recorded.durationMs}ms` : '';
    };
    const replay = await replayEffect(flowFn(initialInput), traceLog, {
        context: context !== undefined ? context : traceLog.context || {},
        onResolved: (step, outcome) => {
            // Resolving from a trace either answers or throws, so this is never undefined.
            if (outcome === undefined) return;
            log(
                'error' in outcome
                    ? `Step ${step.index + 1}: ${step.name} threw${timing(step)} ${format(outcome.error)}`
                    : `Step ${step.index + 1}: ${step.name} returned${timing(step)} ${format(outcome.result)}`
            );
        }
    });
    const { result, unreached = [] } = replay;

    log(`Replay finished with state: ${result.type}`);
    log(result.type === 'Failure' ? `Error: ${format(result.error)}` : `Result: ${format(result.value)}`);
    // After a replay error the flow never got past the divergence, so the entries behind it are not
    // news; the error already names where the timeline split. Only a flow that ended on its own terms
    // with steps left over is worth a warning.
    const haltedByReplay = result.type === 'Failure' && /^(TimeParadox|ReplayError)$/.test(result.error?.name);
    if (unreached.length > 0 && !haltedByReplay) {
        // Named, not just counted: the step a fix stopped issuing is usually the one under suspicion.
        const names = unreached.map((e) =>
            typeof e.path === 'string' ? `${e.command} (path '${e.path}')` : e.command
        );
        const count = unreached.length === 1 ? '1 recorded step was' : `${unreached.length} recorded steps were`;
        log(`Warning: ${count} never reached: ${names.join(', ')}. The flow diverged.`);
    }
    return result;
};

export {
    Success,
    Failure,
    Command,
    Ask,
    Retry,
    Parallel,
    effectPipe,
    runEffect,
    configureEffect,
    recorder,
    recordEffect,
    replayEffect,
    timeTravel
};
