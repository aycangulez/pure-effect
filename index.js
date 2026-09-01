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
 * @param {Effect[]} effects - Array of Effect trees to run concurrently
 * @param {(values: any[]) => Effect} [next] - Receives array of success values in order, returns next Effect.
 *        Defaults to `(values) => Success(values)`, same as `Command`'s default.
 * @returns {ParallelState}
 */
const Parallel = (effects, next = (/** @type {any[]} */ values) => Success(values)) => ({
    type: 'Parallel',
    effects,
    next
});

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
    if (retries.length) merged.retry = Object.assign({}, ...retries);
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
                    const opts = { ...localRetryDefaults, ...eff.options };
                    const { attempts } = opts;
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
                        lastError = result.error;
                    }

                    if (!succeeded) {
                        const exhausted = { retryExhausted: true, lastError, attempts };
                        const { onExhausted } = opts;
                        if (typeof onExhausted !== 'function') return Failure(exhausted, eff.initialInput);
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
                    // One scope per Parallel, linked to the enclosing one so cancellation nests.
                    // Absent AbortController (very old runtimes), `branchSignal` stays undefined and
                    // the old run-everything-to-completion behaviour is what happens.
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
                    try {
                        // Still awaits every branch, so no cancelled work is left running unobserved
                        // after the Failure is returned. Cancelled branches settle promptly; a branch
                        // whose in-flight Command ignores the signal is the one case that does not.
                        await Promise.all(
                            eff.effects.map(async (e, i) => {
                                const result = await execute(e, branchSignal, `${branchPath}${i}/`);
                                results[i] = result;
                                // Read-then-abort is atomic here, so exactly one branch is the trigger.
                                if (result.type === 'Failure' && !branchSignal?.aborted) {
                                    triggered[i] = true;
                                    scope?.abort();
                                }
                            })
                        );
                    } finally {
                        if (signal && scope) signal.removeEventListener('abort', relay);
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
                try {
                    await localCommandInterceptor(eff, context);
                    const result = await localStepRunner(cmdName, 'Command', op, cmdPath);
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
    e.name = v.name;
    for (const [k, val] of Object.entries(v)) {
        if (k !== '__error' && k !== 'name' && k !== 'message') {
            /** @type {any} */ (e)[k] = k === 'cause' ? reviveError(val) : val;
        }
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
 * and still paradox-detecting: it works for `Parallel` without `strict: false`, and it tells two
 * branches that call the same Command apart by where they are rather than by which finished first.
 * `strict` does not apply, since path matching is neither positional nor lenient.
 *
 * The two older modes remain for traces recorded before paths existed. Strict matching consumes
 * entries in recorded order and verifies the flow asks for the Command the trace expects. Name
 * matching resolves per-Command FIFO queues, which was the only option for `Parallel` and is the
 * mode that could pair a branch with a sibling's result when both called the same Command.
 *
 * @param {TraceLog | TraceEntry[]} traceLog - A reference-format trace, or a bare array of entries
 * @param {Object} [options]
 * @param {boolean} [options.strict] - Positional matching with paradox detection (default `true`).
 *        Ignored for a trace carrying paths.
 * @returns {Resolver}
 */
const fromTrace = (traceLog, options = {}) => {
    const { strict = true } = options;
    const entries = Array.isArray(traceLog) ? traceLog : traceLog?.trace;
    if (!Array.isArray(entries)) throw replayError('Trace has no `trace` array.');

    // Paths win when the trace has them, whatever `strict` says: a caller who passed `strict: false`
    // to work around Parallel should get the correct matching once their traces carry paths, rather
    // than keeping the mode that option existed to work around.
    if (entries.length > 0 && entries.every((e) => typeof e.path === 'string')) {
        const byPath = new Map(entries.map((e) => [e.path, e]));
        // Paths are derived from tree position, so they are unique by construction. A collision means
        // either a hand-built trace or a bug in path derivation, and silently keeping the last entry
        // would reintroduce exactly the wrong-result-per-branch failure paths exist to prevent.
        if (byPath.size !== entries.length) {
            throw replayError('Trace has duplicate step paths, so it cannot be matched by path.');
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
            return entryToOutcome(entry);
        };
    }

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
    const stepsText = trace.length === 0 || trace.length > 1 ? 'steps' : 'step';
    log(`Replaying '${flowName || 'flow'}' (${trace.length} recorded ${stepsText})`);
    log(`Initial input: ${format(initialInput)}`);

    // Narration goes through `onResolved` rather than a wrapped Resolver: observing each
    // step is all this needs, and `replayEffect` already resolves the trace itself.
    let consumed = 0;
    // A path maps a replayed step back to its recorded entry whatever order branches finished in, so
    // timings are narrated for Parallel too. Positional lookup is the fallback for a legacy trace with
    // no paths, and only under strict matching, since per-Command queues carry no position.
    const byPath = new Map(trace.filter((e) => typeof e.path === 'string').map((e) => [e.path, e]));
    const timing = (/** @type {ReplayStep} */ step) => {
        const recorded = byPath.get(step.path) ?? (strict ? trace[step.index] : undefined);
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
