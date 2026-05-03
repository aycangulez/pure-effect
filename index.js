// @ts-check

/** @typedef {{ type: 'Success', value: any, initialInput?: any }} SuccessState */
/** @typedef {{ type: 'Failure', error: any, initialInput?: any }} FailureState */
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
 * Represents a side effect to be executed later
 * @param {() => Promise<any>|any} cmd - The side-effect function to execute
 * @param {(result: any) => Effect} next - A function that receives the result of `cmd` and returns the next Effect
 * @param {any} [meta] - Optional metadata
 * @returns {CommandState}
 */
const Command = (cmd, next, meta) => ({ type: 'Command', cmd, next, meta });

/**
 * Reads the context object from the current `runEffect` call.
 * @param {(context: any) => Effect} next - Receives the context and returns the next Effect
 * @returns {AskState}
 */
const Ask = (next) => ({ type: 'Ask', next });

/**
 * Wraps an Effect tree with retry-on-failure semantics.
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
            return withII(fn(effect.value));
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
 * @property {StepRunner} [onStep] - Fires once per runEffect call. It wraps the entire workflow execution.
 * @property {RunWrapper} [onRun] - Fires every time a Command is executed.
 * @property {CommandInterceptor} [onBeforeCommand] - Intercepts a Command and any context passed to runEffect before execution.
 * @property {{ attempts?: number, delay?: number, backoff?: number }} [retry] - Global Retry defaults; merged under per-use options.
 */

/**
 * Configures the global behavior of the Effect runner, including the command interceptor and telemetry.
 *
 * @param {EffectConfiguration} options - The configuration object for the effect pipeline.
 */
const configureEffect = (options) => {
    stepRunner = options.onStep ? options.onStep : defaultStepRunner;
    runWrapper = options.onRun ? options.onRun : defaultRunWrapper;
    commandInterceptor = options.onBeforeCommand ? options.onBeforeCommand : defaultCommandInterceptor;
    retryDefaults = options.retry ? { ...defaultRetryOptions, ...options.retry } : defaultRetryOptions;
};

const runEffect =
    /**
     * The Interpreter
     * Iterates through the Effect tree, executing Commands and handling async flow.
     * Ask effects are resolved synchronously with the context object.
     *
     * Per-call config takes precedence over global configureEffect defaults.
     * onRun fires exactly once per runEffect call — Retry attempts run inside that
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
            while (eff.type === 'Command' || eff.type === 'Ask' || eff.type === 'Retry' || eff.type === 'Parallel') {
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
                const cmdName = eff.cmd.name || 'anonymous';
                const initialInput = eff.initialInput;
                try {
                    await localCommandInterceptor(eff, context);
                    const result = await localStepRunner(cmdName, 'Command', eff.cmd);
                    eff = eff.next(result);
                } catch (e) {
                    return Failure(e, initialInput);
                }
            }
            return eff;
        }

        return localRunWrapper(effect, () => execute(effect), context?.flowName || '');
    };

export { Success, Failure, Command, Ask, Retry, Parallel, effectPipe, runEffect, configureEffect };
