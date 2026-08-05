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
 *   cmd: () => Promise<any>|any,
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
 *   options: { attempts?: number, delay?: number, backoff?: number },
 *   next: (value: any) => Effect,
 *   initialInput?: any
 * }} RetryState
 */

/**
 * @typedef {{
 *   type: 'Parallel',
 *   effects: Effect[],
 *   next: (values: any[]) => Effect,
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
 * @param {() => Promise<any>|any} cmd - The side-effect function to execute
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
 * The name a Command is known by: what a trace records, what strict replay matches on, and what a
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
 * @param {Object} [options] - Per-use retry options; merged over global defaults at runtime
 * @param {number} [options.attempts] - Max retries (not counting first try)
 * @param {number} [options.delay] - Ms before first retry
 * @param {number} [options.backoff] - Multiplier applied to delay on each subsequent retry
 * @returns {RetryState}
 */
const Retry = (effect, options = {}) => ({
    type: 'Retry',
    effect,
    options,
    next: (value) => Success(value)
});

/**
 * Runs multiple Effect trees concurrently. If any effect fails, returns the first Failure by array order and skips next.
 * @param {Effect[]} effects - Array of Effect trees to run concurrently
 * @param {(values: any[]) => Effect} next - Receives array of success values in order, returns next Effect
 * @returns {ParallelState}
 */
const Parallel = (effects, next) => ({ type: 'Parallel', effects, next });

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
    Object.assign(
        new Error(
            `${source} returned ${describeValue(value)}. Return Success, Failure, Command, Ask, Retry, or Parallel: ` +
                'a plain value has to be wrapped, as in Success(value).'
        ),
        { name: 'EffectTypeError' }
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
 * Handles the branching logic for Success, Failure, Command, Ask, and Retry.
 *
 * @param {Effect} effect - The current Effect object
 * @param {(value: any) => Effect} fn - The next function to run if the current effect is a Success
 * @returns {Effect} The composed Effect
 */
/**
 * @param {Effect} effect
 * @param {(value: any) => Effect} fn
 * @param {any} [initialInput]
 * @returns {Effect}
 */
const chain = (effect, fn, initialInput) => {
    const withII = (/** @type {Effect} */ e) =>
        initialInput !== undefined && e.initialInput === undefined ? { ...e, initialInput } : e;

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
        return fns.reduce(chainWithII, /** @type {Effect} */ (Success(start)));
    };
};

/** @typedef {(name: string, type: string, op: function) => Promise<any>} StepRunner */
/** @type StepRunner */
const defaultStepRunner = async (name, type, op) => await op();

/** @typedef {(effect: Effect, op: function, flowName?: string) => Promise<any>} RunWrapper */
/** @type RunWrapper */
const defaultRunWrapper = async (effect, op, flowName) => await op();

/** @typedef {(command: CommandState, context?: any) => Promise<any>} CommandInterceptor */
/** @type CommandInterceptor */
const defaultCommandInterceptor = async (command, context) => {};

let stepRunner = defaultStepRunner;
let runWrapper = defaultRunWrapper;
let commandInterceptor = defaultCommandInterceptor;

const defaultRetryOptions = { attempts: 3, delay: 100, backoff: 1 };
let retryDefaults = { ...defaultRetryOptions };

/**
 * @typedef {Object} EffectConfiguration
 * @property {StepRunner} [onStep] - Fires every time a Command is executed. It wraps the `cmd` call.
 * @property {RunWrapper} [onRun] - Fires once per runEffect call. It wraps the entire workflow execution.
 * @property {CommandInterceptor} [onBeforeCommand] - Intercepts a Command and any context passed to runEffect before execution.
 * @property {{ attempts?: number, delay?: number, backoff?: number }} [retry] - Global Retry defaults; merged under per-use options.
 */

/**
 * Configures the global behavior of the Effect runner, including the command interceptor and telemetry.
 *
 * Several configurations can be passed and are merged, which is how independent concerns share the
 * one slot each hook has:
 *
 *     configureEffect(telemetryHooks(), recordingHooks({ sink }))
 *
 * `onStep` and `onRun` are wrappers, so they nest with the first configuration outermost and the last
 * closest to the Command. `onBeforeCommand` interceptors all run, in the order given, and `retry`
 * merges with later configurations winning.
 *
 * Merging happens per call and does not accumulate across calls: a later `configureEffect` still
 * replaces the previous wiring entirely, and calling it with nothing resets every slot to its default.
 *
 * Returns a function that puts back whatever was installed when this call was made, so a caller can
 * install hooks without owning the wiring forever. That is what makes this usable from a test, a
 * request-scoped experiment, or a library that wraps this one: without it, installing anything means
 * clobbering the host's telemetry permanently, since there is no way to read the current wiring.
 * Restoring undoes this call only while its wiring is still in effect. If a later `configureEffect` has
 * run since, restoring does nothing rather than discarding that newer wiring, so two callers installing
 * and releasing in interleaved order cannot clobber each other.
 *
 * @param {...(EffectConfiguration | undefined)} configs - Configurations to merge, outermost first
 * @returns {() => void} Restores the wiring that was in place before this call
 */
const configureEffect = (...configs) => {
    const previousStepRunner = stepRunner;
    const previousRunWrapper = runWrapper;
    const previousCommandInterceptor = commandInterceptor;
    const previousRetryDefaults = retryDefaults;

    const options = chainHooks(...configs);
    stepRunner = options.onStep ? options.onStep : defaultStepRunner;
    runWrapper = options.onRun ? options.onRun : defaultRunWrapper;
    commandInterceptor = options.onBeforeCommand ? options.onBeforeCommand : defaultCommandInterceptor;
    retryDefaults = options.retry ? { ...defaultRetryOptions, ...options.retry } : defaultRetryOptions;

    const installedStepRunner = stepRunner;
    const installedRunWrapper = runWrapper;
    const installedCommandInterceptor = commandInterceptor;
    const installedRetryDefaults = retryDefaults;

    return () => {
        // Only undo an install that is still in effect. Without this check, two callers that install
        // and release in interleaved order silently discard each other's hooks: A installs, B installs,
        // A restores, and B's wiring is gone though B never released it.
        const unchanged =
            stepRunner === installedStepRunner &&
            runWrapper === installedRunWrapper &&
            commandInterceptor === installedCommandInterceptor &&
            retryDefaults === installedRetryDefaults;
        if (!unchanged) return;

        stepRunner = previousStepRunner;
        runWrapper = previousRunWrapper;
        commandInterceptor = previousCommandInterceptor;
        retryDefaults = previousRetryDefaults;
    };
};

/**
 * @typedef {Object} StepStart
 * @property {string} name - `cmd.name`, or 'anonymous'.
 * @property {string} type - Always 'Command' today.
 */

/**
 * @typedef {Object} StepEnd
 * @property {string} name
 * @property {string} type
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
const observeSteps = (handler) => async (name, type, op) => {
    /** @type {((end: StepEnd) => void) | undefined} */
    let finish;
    try {
        finish = handler({ name, type });
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
        report({ name, type, result, durationMs: now() - started });
        return result;
    } catch (error) {
        report({ name, type, error, durationMs: now() - started });
        throw error;
    }
};

/**
 * Merges several configurations into one, so independent concerns can share the hooks.
 *
 * `onStep` and `onRun` are wrappers around an `op`, so they nest. The first config given is
 * the outermost wrapper and the last sits closest to the Command, which also means a thrown
 * Command unwinds from the last config back to the first. `onBeforeCommand` is an observer,
 * so every interceptor runs in the order given. `retry` is plain data and merges with later
 * configs winning. A hook no config defines is left unset, so `configureEffect` keeps its
 * default for that slot.
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
    const retries = present('retry');

    if (steps.length) {
        merged.onStep = steps.reduceRight(
            (inner, outer) => (name, type, op) => outer(name, type, () => inner(name, type, op))
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
    if (retries.length) merged.retry = Object.assign({}, ...retries);
    return merged;
};

const runEffect =
    /**
     * The Interpreter
     * Iterates through the Effect tree, executing Commands and handling async flow.
     * Ask effects are resolved synchronously with the context object.
     *
     * Per-call config takes precedence over global configureEffect defaults.
     * onRun fires exactly once per runEffect call. Retry attempts run inside that
     * single span rather than spawning their own, keeping telemetry non-duplicated.
     *
     * @param {Effect} effect - The Effect tree returned by a pipeline
     * @param {any} [context] - Optional context object. Passed to Ask continuations and the Command Interceptor.
     * @param {EffectConfiguration} [callConfig] - Per-call overrides; merged over global configureEffect defaults.
     * @returns {Promise<SuccessState | FailureState>}
     */
    async function runEffect(effect, context = {}, callConfig = {}) {
        const localStepRunner = callConfig.onStep ? callConfig.onStep : stepRunner;
        const localRunWrapper = callConfig.onRun ? callConfig.onRun : runWrapper;
        const localCommandInterceptor = callConfig.onBeforeCommand ? callConfig.onBeforeCommand : commandInterceptor;
        const localRetryDefaults = callConfig.retry ? { ...retryDefaults, ...callConfig.retry } : retryDefaults;

        /**
         * @param {Effect} eff
         * @returns {Promise<SuccessState | FailureState>}
         */
        async function execute(eff) {
            while (
                eff &&
                (eff.type === 'Command' || eff.type === 'Ask' || eff.type === 'Retry' || eff.type === 'Parallel')
            ) {
                if (eff.type === 'Ask') {
                    eff = eff.next(context);
                    continue;
                }
                if (eff.type === 'Retry') {
                    const opts = { ...localRetryDefaults, ...eff.options };
                    const { attempts } = opts;
                    let lastError;
                    let succeeded = false;

                    for (let attempt = 0; attempt <= attempts; attempt++) {
                        if (attempt > 0) {
                            await new Promise((r) => setTimeout(r, opts.delay * Math.pow(opts.backoff, attempt - 1)));
                        }
                        const result = await execute(eff.effect);
                        if (result.type === 'Success') {
                            eff = eff.next(result.value);
                            succeeded = true;
                            break;
                        }
                        lastError = result.error;
                    }

                    if (!succeeded) {
                        return Failure({ retryExhausted: true, lastError, attempts }, eff.initialInput);
                    }
                    continue;
                }
                if (eff.type === 'Parallel') {
                    const results = await Promise.all(eff.effects.map((e) => execute(e)));
                    const failure = results.find((r) => r.type === 'Failure');
                    if (failure) return failure;
                    eff = eff.next(results.map((r) => /** @type {SuccessState} */ (r).value));
                    continue;
                }
                const cmdName = commandName(eff);
                const initialInput = eff.initialInput;
                try {
                    await localCommandInterceptor(eff, context);
                    const result = await localStepRunner(cmdName, 'Command', eff.cmd);
                    eff = eff.next(result);
                } catch (e) {
                    // A malformed flow is a bug, not a domain failure, so it must not masquerade as one.
                    if (e instanceof Error && e.name === 'EffectTypeError') throw e;
                    return Failure(e, initialInput);
                }
            }
            if (eff && (eff.type === 'Success' || eff.type === 'Failure')) return eff;
            throw effectTypeError(eff, 'The flow');
        }

        return localRunWrapper(effect, () => execute(effect), context?.flowName || '');
    };

/** @typedef {{ index: number, name: string, type: string }} ReplayStep */

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
 * @typedef {{ command: string, result?: any, error?: any, durationMs?: number }} TraceEntry
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
 * Creates a replay error. Thrown from a resolver, it is caught by the interpreter
 * and returned as a Failure, exactly like a rejected Command.
 * @param {string} message - Human-readable reason
 * @param {Object} [props] - Extra fields such as `name`, `index`, `expected`, `actual`
 * @returns {Error}
 */
const replayError = (message, props = {}) => Object.assign(new Error(message), { name: 'ReplayError' }, props);

/**
 * Signals that the flow being replayed asked for a different Command than the trace
 * recorded, which means the code has diverged from the recorded run.
 * @param {ReplayStep} step - The step the flow asked for
 * @param {string} recorded - The command name the trace holds at that position
 * @returns {Error}
 */
const timeParadox = (step, recorded) =>
    replayError(`Time paradox at step ${step.index}: flow asked for '${step.name}', trace recorded '${recorded}'`, {
        name: 'TimeParadox',
        index: step.index,
        expected: recorded,
        actual: step.name
    });

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
    e.name = v.name;
    for (const [k, val] of Object.entries(v)) {
        if (k !== '__error' && k !== 'name' && k !== 'message') /** @type {any} */ (e)[k] = val;
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

    // Built on `observe` so the hook contract lives in one place: `op` always runs, its result is
    // always returned, and its error always propagates.
    const onStep = observeSteps(({ name }) => (end) => {
        const durationMs = Math.round(end.durationMs * 1000) / 1000;
        push(
            'error' in end
                ? {
                      command: name,
                      error: snapshot(safeRedact(serializeError(end.error, stack), name, 'error')),
                      durationMs
                  }
                : { command: name, result: snapshot(safeRedact(end.result, name, 'result')), durationMs }
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
 * Strict matching consumes entries in recorded order and verifies that the flow asks
 * for the Command the trace expects, which is what detects divergence between the
 * recorded run and the code being replayed.
 *
 * Name matching is required for flows containing `Parallel`: branches run through
 * `Promise.all` and therefore complete out of array order, so recorded positions are
 * not stable. It resolves per-Command FIFO queues instead, which is order-independent
 * and still keeps duplicate Command names apart.
 *
 * @param {TraceLog | TraceEntry[]} traceLog - A reference-format trace, or a bare array of entries
 * @param {Object} [options]
 * @param {boolean} [options.strict] - Positional matching with paradox detection (default `true`)
 * @returns {Resolver}
 */
const fromTrace = (traceLog, options = {}) => {
    const { strict = true } = options;
    const entries = Array.isArray(traceLog) ? traceLog : traceLog?.trace;
    if (!Array.isArray(entries)) throw replayError('Trace has no `trace` array.');

    if (strict) {
        return (step) => {
            const entry = entries[step.index];
            if (!entry) throw replayError(`Trace exhausted: no entry #${step.index} for '${step.name}'.`);
            if (entry.command !== step.name) throw timeParadox(step, entry.command);
            return entryToOutcome(entry);
        };
    }

    /** @type {Map<string, TraceEntry[]>} */
    const queues = new Map();
    for (const entry of entries) {
        if (!queues.has(entry.command)) queues.set(entry.command, []);
        /** @type {TraceEntry[]} */ (queues.get(entry.command)).push(entry);
    }
    return (step) => {
        const queue = queues.get(step.name);
        if (!queue || queue.length === 0) throw replayError(`No recorded result left for '${step.name}'.`);
        return entryToOutcome(/** @type {TraceEntry} */ (queue.shift()));
    };
};

/**
 * Rewrites `Retry` nodes to zero delay, lazily, through their `next` continuations.
 *
 * Needed because the interpreter merges per-use options over call config
 * (`{ ...localRetryDefaults, ...eff.options }`), so a `callConfig.retry` cannot
 * override a delay written at the call site. Without this, replaying a flow that
 * retried in production waits out the production backoff.
 *
 * @param {any} eff - Any Effect node
 * @returns {any} The same tree with Retry delays removed
 */
const zeroRetryDelays = (eff) => {
    if (!eff || typeof eff.type !== 'string') return eff;
    switch (eff.type) {
        case 'Retry':
            return {
                ...eff,
                options: { ...eff.options, delay: 0, backoff: 1 },
                effect: zeroRetryDelays(eff.effect),
                next: (/** @type {any} */ value) => zeroRetryDelays(eff.next(value))
            };
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
 * @property {boolean} [hooks] - Lets configured `onRun` and `onBeforeCommand` fire. Off by default, so a
 *           replay cannot reach a telemetry backend or a guardrail that performs I/O.
 * @property {'throw' | 'execute'} [onMissing] - What to do when the resolver has no recording for a step.
 *           `'throw'` (default) fails the replay, which makes side effects impossible for the whole run.
 *           `'execute'` runs the real Command, giving partial replay: recorded prefix, live tail.
 * @property {(step: ReplayStep, outcome: ReplayOutcome | undefined) => void} [onResolved] - Observes each step.
 * @property {boolean} [strict] - Matching mode used when a trace is passed instead of a Resolver.
 *           `true` (default) consumes entries positionally and raises a `TimeParadox` on divergence;
 *           `false` matches per-Command FIFO queues, which is required for flows containing `Parallel`.
 *           Ignored when a Resolver is supplied, since that Resolver has already chosen how it matches.
 */

/**
 * Replays an Effect tree, feeding recorded results to Commands instead of running them.
 *
 * No side effect can occur by default. The interpreter's only execution point is
 * `await localStepRunner(cmdName, 'Command', eff.cmd)`, which hands the Command thunk
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
 * @returns {Promise<SuccessState | FailureState>}
 */
// `async` so a malformed trace arrives as a rejection rather than a synchronous throw:
// the function otherwise returns a promise, and callers should not have to handle both.
const replayEffect = async (effect, traceOrResolver, options = {}) => {
    const { context = {}, fastRetry = true, hooks = false, onMissing = 'throw', onResolved, strict = true } = options;
    // A trace is data and a Resolver is a function, so nothing else is needed to tell them
    // apart, including the bare entries array that `fromTrace` also accepts.
    const resolve = typeof traceOrResolver === 'function' ? traceOrResolver : fromTrace(traceOrResolver, { strict });
    let index = 0;

    /** @type {StepRunner} */
    const onStep = async (name, type, op) => {
        const step = { index: index++, name, type };
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

    /** @type {EffectConfiguration} */
    const callConfig = { onStep };
    if (!hooks) {
        callConfig.onRun = async (effect, op) => await op();
        callConfig.onBeforeCommand = async () => {};
    }

    return runEffect(fastRetry ? zeroRetryDelays(effect) : effect, context, callConfig);
};

/**
 * Replays a reference-format trace and narrates each step. Rebuilds the flow from the
 * recorded input, reports the outcome, and warns when recorded steps were never
 * reached, which means the current code issued fewer Commands than production did.
 *
 * @param {(input: any) => Effect} flowFn - The same flow function that produced the trace
 * @param {TraceLog} traceLog - A trace from `recordEffect` or a `recorder`
 * @param {Object} [options]
 * @param {boolean} [options.strict] - Positional matching with paradox detection; set `false` for `Parallel`
 * @param {(...args: any[]) => void} [options.log] - Defaults to `console.log`
 * @param {any} [options.context] - Overrides the context stored on the trace
 * @param {string} [options.version] - Current build id; warns when it differs from the trace's
 * @returns {Promise<SuccessState | FailureState>}
 */
const timeTravel = async (flowFn, traceLog, options = {}) => {
    const { strict = true, log = console.log, context, version } = options;
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
    const stepsText = (trace.length === 0 || trace.length > 1) ? 'steps' : 'step';
    log(`Replaying '${flowName || 'flow'}' (${trace.length} recorded ${stepsText})`);
    log(`Initial input: ${format(initialInput)}`);

    // Narration goes through `onResolved` rather than a wrapped Resolver: observing each
    // step is all this needs, and `replayEffect` already resolves the trace itself.
    let consumed = 0;
    // Only strict matching maps a replayed step back to its recorded entry by position, so timings
    // are narrated there and omitted when per-Command queues are matching by name.
    const timing = (/** @type {ReplayStep} */ step) => {
        const recorded = strict ? trace[step.index] : undefined;
        return typeof recorded?.durationMs === 'number' ? ` in ${recorded.durationMs}ms` : '';
    };
    const result = await replayEffect(flowFn(initialInput), traceLog, {
        strict,
        context: context !== undefined ? context : traceLog.context || {},
        onResolved: (step, outcome) => {
            // Resolving from a trace either answers or throws, so this is never undefined.
            if (outcome === undefined) return;
            consumed++;
            log(
                'error' in outcome
                    ? `Step ${step.index + 1}: ${step.name} threw${timing(step)} ${format(outcome.error)}`
                    : `Step ${step.index + 1}: ${step.name} returned${timing(step)} ${format(outcome.result)}`
            );
        }
    });

    log(`Replay finished with state: ${result.type}`);
    log(result.type === 'Failure' ? `Error: ${format(result.error)}` : `Result: ${format(result.value)}`);
    if (consumed < trace.length) {
        log(`Warning: ${trace.length - consumed} recorded ${stepsText} were never reached. The flow diverged.`);
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
