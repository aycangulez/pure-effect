// @ts-check

// Contents. Each section is a `#region`, so an editor can fold it.
//
// 1. Types: the JSDoc shapes of the nodes a flow is made of.
// 2. Building flows: the constructors; the checks, error messages and kinds of failure the later sections
//    share; and `effectPipe`, with the `chain` that joins its steps and the `flowInputs` it records for `onRun`.
// 3. Configuration: the hook types and the library's defaults, `configureEffect` and its layers, and
//    `chainHooks`, which merges them.
// 4. Running flows: the helpers `Retry` and `Parallel` run on, the interpreter, and `runEffect`.
// 5. Recording and replay: the trace format and replay errors, copying values and errors into a trace,
//    `recorder`, built on `observeSteps`, and `recordEffect`, then `fromTrace`, `replayEffect` and `timeTravel`.
//
// A new definition goes in the section it serves, which is usually the one that calls it.

// #region Types

/** @typedef {{ type: 'Success', value: any }} SuccessState */
/** @typedef {{ type: 'Failure', error: any }} FailureState */
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
 *   meta?: any
 * }} CommandState
 */
/**
 * @typedef {{
 *   type: 'Ask',
 *   next: (context: any) => Effect
 * }} AskState
 */

/**
 * @typedef {{
 *   type: 'Retry',
 *   effect: Effect,
 *   options: { attempts?: number, delay?: number, backoff?: number, onExhausted?: (error: any) => Effect },
 *   next: (value: any) => Effect
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
 *   options?: ParallelOptions
 * }} ParallelState
 */

/**
 * The Union type for all possible states
 * @typedef {SuccessState | FailureState | CommandState | AskState | RetryState | ParallelState} Effect
 */

// #endregion
// #region Building flows

/**
 * Represents a successful computation
 * @param {any} value - The result value
 * @returns {SuccessState}
 */
const Success = (value) => ({ type: 'Success', value });

/**
 * Represents a failed computation. Stops the pipeline execution
 * @param {any} error - The error reason (string, Error object, etc).
 * @returns {FailureState}
 */
const Failure = (error) => ({ type: 'Failure', error });

/**
 * Represents a side effect to be executed later.
 *
 * @param {(signal?: AbortSignal) => Promise<any>|any} cmd - The side-effect function to execute. Inside a
 *        `Parallel` branch, a function that declares a parameter receives an `AbortSignal` in it that fires when a
 *        sibling branch fails, so I/O that accepts one can be cancelled in flight. A parameter with a default value
 *        does not count, so `nanoid(size = 21)` keeps its default. Outside a `Parallel` no argument is passed.
 * @param {(result: any) => Effect} [next] - Receives the result of `cmd` and returns the next Effect.
 *        Defaults to `(result) => Success(result)`, which is what most Commands want; `null` counts as omitted.
 * @param {CommandMeta} [meta] - Optional metadata, passed to `onBeforeCommand`. A string `meta.name`
 *        becomes this Command's identity for traces, replay matching, and telemetry spans.
 * @returns {CommandState}
 */
const Command = (cmd, next, meta) => {
    // Checked as the flow is built, so a mistake is reported before the I/O it would have run.
    if (typeof cmd !== 'function') {
        throw malformed(
            /** @type {any} */ (cmd) instanceof Promise
                ? 'Command expects a function, got a Promise.'
                : `Command expects the function that does the I/O, got ${describeArgument(cmd)}.`,
            cmd
        );
    }
    if (next != null && typeof next !== 'function') {
        throw malformed(
            isOptionsObject(next)
                ? "Command's second argument is next, and meta goes third: Command(fn, undefined, { name: 'chargeCard' })."
                : `Command's next must be a function, got ${describeArgument(next)}.`,
            next
        );
    }
    return { type: 'Command', cmd, next: next ?? ((/** @type {any} */ result) => Success(result)), meta };
};

/**
 * The name a Command is known by: what a trace records, what replay matches on, and what a
 * telemetry span is called. A non-empty string `meta.name`, else `cmd.name`, else 'anonymous'.
 * Exported so a test walking a flow checks each step by the same rule.
 *
 * @param {CommandState} eff
 * @returns {string}
 */
const commandName = (eff) => {
    if (eff?.type !== 'Command') {
        throw malformed(`commandName expects a Command, got ${describeArgument(eff)}.`, eff);
    }
    const meta = eff.meta;
    const named = isObject(meta) ? meta.name : undefined;
    return typeof named === 'string' && named !== '' ? named : eff.cmd.name || 'anonymous';
};

/**
 * Reads the context object from the current `runEffect` call.
 * @param {(context: any) => Effect} next - Receives the context and returns the next Effect
 * @returns {AskState}
 */
const Ask = (next) => {
    if (typeof next !== 'function') {
        throw malformed(`Ask expects a function that receives the context, got ${describeArgument(next)}.`, next);
    }
    return { type: 'Ask', next };
};

/**
 * Wraps an Effect tree with retry-on-failure semantics.
 *
 * Each attempt runs the **entire** wrapped tree again, including Commands that already succeeded, so
 * wrap the one Command that fails transiently rather than a pipeline. `Retry(effectPipe(charge, receipt))`
 * charges the customer again every time the receipt step fails. Wrapping a pipeline is only safe when
 * every Command in it is idempotent.
 *
 * @param {Effect} effect - The inner Effect tree to retry
 * @param {Object} [options] - Retry options, merged over the library defaults at runtime. An option set to
 *        `undefined` keeps its default, as an absent config key does.
 * @param {number} [options.attempts] - Max retries (not counting first try), a positive integer
 * @param {number} [options.delay] - Ms before first retry, a finite number of 0 or more
 * @param {number} [options.backoff] - Multiplier applied to delay on each subsequent retry, a finite number
 *        of 0 or more
 * @param {(error: any) => Effect} [options.onExhausted] - Runs a fallback Effect when every attempt has
 *        failed, receiving `{ retryExhausted, lastError, attempts }`. The fallback's success feeds `next`
 *        exactly as the primary's would have; its failure propagates unwrapped. A fallback never starts
 *        in a `Parallel` branch a sibling has cancelled.
 * @returns {RetryState}
 */
const Retry = (effect, options) => {
    if (!isEffect(effect)) throw malformed(`Retry expects the Effect to run, got ${describeValue(effect)}.`, effect);
    if (options != null && !isOptionsObject(options)) {
        const hint = typeof options === 'number' ? `: write Retry(effect, { attempts: ${options} })` : '';
        throw malformed(`Retry's options must be an object, got ${describeArgument(options)}${hint}.`, options);
    }
    rejectUnknownOptions(options, 'Retry', ['attempts', 'delay', 'backoff', 'onExhausted'], (m) =>
        malformed(m, options)
    );
    return { type: 'Retry', effect, options: options ?? {}, next: (value) => Success(value) };
};

/**
 * Runs multiple Effect trees concurrently. The first branch to fail cancels its siblings, and that
 * branch's Failure is what the Parallel returns; `next` is skipped. Which branch fails first depends on
 * timing, so it is recorded, and a replay returns the same one.
 *
 * A cancelled branch starts no further Commands. Stopping the Command already in flight needs its
 * function to pass the `AbortSignal` it receives to whatever performs the I/O; one that ignores the
 * signal runs to completion, so a branch's first Command can still write after a sibling has failed.
 *
 * `settled: true` turns off that first-failure rule: every branch runs to completion and `next`
 * receives the branch outcomes, `Success` and `Failure` nodes in array order. An `EffectTypeError`
 * still escapes. `limit: n` keeps at most `n` branches in flight. Results and paths stay in array
 * order either way.
 *
 * The second argument is the `next` function or the options, whichever it looks like, so
 * `Parallel(effects, { limit: 5 })` needs no placeholder. `undefined` or `null` there is a skipped `next`,
 * so `Parallel(effects, undefined, { limit: 5 })` still reads the options.
 *
 * @param {Effect[]} effects - Array of Effect trees to run concurrently
 * @param {((values: any[]) => Effect) | ParallelOptions | null} [nextOrOptions] - Receives array of success
 *        values in order and returns the next Effect, or the options. `next` defaults to
 *        `(values) => Success(values)`, same as `Command`'s default.
 * @param {ParallelOptions} [maybeOptions] - Options, when `next` was given or skipped
 * @returns {ParallelState}
 */
const Parallel = (effects, nextOrOptions, maybeOptions) => {
    if (!Array.isArray(effects)) {
        throw malformed(`Parallel expects an array of Effects, got ${describeArgument(effects)}.`, effects);
    }
    effects.forEach((branch, i) => {
        if (!isEffect(branch)) throw malformed(`Parallel's branch ${i} is ${describeValue(branch)}.`, branch);
    });
    const hasNext = typeof nextOrOptions === 'function';
    // A caller forwarding an absent `next` still passes its options third, as the signature reads.
    const nextSkipped = nextOrOptions == null;
    const optionsSecond = !hasNext && !nextSkipped;
    if (optionsSecond && !isOptionsObject(nextOrOptions)) {
        const got = describeArgument(nextOrOptions);
        throw malformed(`Parallel's second argument must be next or the options, got ${got}.`, nextOrOptions);
    }
    // Nothing reads a third argument after the options, so a `next` passed there would silently be skipped.
    if (optionsSecond && maybeOptions != null) {
        throw malformed(
            typeof maybeOptions === 'function'
                ? "Parallel's next goes second and its options third: Parallel(effects, next, options)."
                : `Parallel takes one options object, and with the options second its third argument, ` +
                      `${describeArgument(maybeOptions)}, would be ignored.`,
            maybeOptions
        );
    }
    const options = optionsSecond ? nextOrOptions : maybeOptions;
    if (options != null && !isOptionsObject(options)) {
        throw malformed(`Parallel's options must be an object, got ${describeArgument(options)}.`, options);
    }
    rejectUnknownOptions(options, 'Parallel', ['limit', 'settled'], (m) => malformed(m, options));
    return {
        type: 'Parallel',
        effects,
        next: hasNext ? nextOrOptions : (/** @type {any[]} */ values) => Success(values),
        options: options ?? {}
    };
};

/**
 * Whether a value is an object that can carry properties: not `null`, a primitive, or a function.
 * @param {any} value
 * @returns {boolean}
 */
const isObject = (value) => value !== null && typeof value === 'object';

/**
 * @param {any} value
 * @returns {boolean}
 */
const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

/**
 * @param {any} value
 * @returns {boolean}
 */
const isFiniteNonNegative = (value) => Number.isFinite(value) && value >= 0;

/**
 * An object that can hold options or meta: not an array, and not an Effect passed in the wrong place.
 * @param {any} value
 * @returns {boolean}
 */
const isOptionsObject = (value) => isObject(value) && !Array.isArray(value) && !isEffect(value);

/**
 * Refuses an option name a function does not read. A misspelt name, or one borrowed from another library, as
 * `concurrency` is from p-limit, otherwise ran with the default and nothing to say so.
 * @param {any} options
 * @param {string} source - The function that takes them, as the message names it
 * @param {string[]} known
 * @param {(message: string) => Error} [raise] - Builds the error; a constructor's argument errors are EffectTypeErrors
 */
const rejectUnknownOptions = (options, source, known, raise = (message) => new TypeError(message)) => {
    const name = isObject(options) ? Object.keys(options).find((key) => !known.includes(key)) : undefined;
    if (name !== undefined) {
        const list = `${known.slice(0, -1).join(', ')} and ${known[known.length - 1]}`;
        throw raise(`${source} has no option named '${name}'; its options are ${list}.`);
    }
};

/**
 * Describes a value for an error message, leading with the mistake it most likely is.
 * @param {any} value
 * @returns {string}
 */
const describeValue = (value) => {
    if (value === undefined) return 'undefined, which usually means a missing return';
    if (value === null) return 'null';
    if (value instanceof Promise) return 'a Promise, which usually means an async function';
    if (typeof value === 'function')
        return 'a function, which usually means a flow was passed without being called with its input';
    // `String`, since `JSON.stringify` prints NaN and Infinity as null and throws on a BigInt.
    if (typeof value !== 'object') {
        return `the ${typeof value} ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
    }
    if (Array.isArray(value)) return 'an array';
    if (typeof value.type === 'string') return `an object with an unrecognised type '${value.type}'`;
    return 'a plain object';
};

/**
 * Describes a constructor's argument for an error message. A missing one is usually a misspelt name
 * rather than a missing return, and an Effect in the wrong place is named by its type.
 * @param {any} value
 * @returns {string}
 */
const describeArgument = (value) =>
    value === undefined ? 'undefined' : isEffect(value) ? `an Effect of type '${value.type}'` : describeValue(value);

/**
 * Marks an error as the harness failing rather than the flow: a malformed flow, or a trace that cannot
 * answer a step. The interpreter rethrows anything carrying it instead of folding it into a `Failure`, so
 * nothing that handles a domain failure can absorb it. A new kind of harness error gets this mark rather
 * than a name the interpreter has to know. Non-enumerable, so it never shows up in a serialized error or
 * a `deepEqual`.
 */
const harnessError = Symbol('pure-effect.harnessError');

/**
 * @param {Error} error
 * @returns {Error}
 */
const asHarnessError = (error) => Object.defineProperty(error, harnessError, { value: true });

/**
 * Whether a thrown value carries one of the library's marks: `harnessError`, `replayCut`, or `replayFault`.
 * @param {unknown} e
 * @param {symbol} mark
 * @returns {boolean}
 */
const hasMark = (e, mark) => Boolean(e && /** @type {any} */ (e)[mark]);

/**
 * An I/O fault: a Command's function threw, or a `Retry` ran out of attempts. `Retry` retries this, never a
 * `Failure` a step returned, which is an abort. Internal: only `execute` and its per-node functions return
 * one, and `asOutcome` turns it into a plain `Failure` before it reaches user code.
 * @typedef {{ type: 'IoFault', error: any }} IoFaultState
 */

/**
 * @param {any} error
 * @returns {IoFaultState}
 */
const IoFault = (error) => ({ type: 'IoFault', error });

/**
 * @param {SuccessState | FailureState | IoFaultState} state
 * @returns {SuccessState | FailureState}
 */
const asOutcome = (state) => (state.type === 'IoFault' ? Failure(state.error) : state);

/**
 * Builds an `EffectTypeError`, for a malformed flow: a step or continuation that returned something other
 * than an Effect, or a constructor given an argument it cannot use. It is a harness error: a malformed flow
 * is a bug, so it is thrown rather than becoming a `Failure`.
 *
 * @param {string} message
 * @param {any} value - The malformed value
 * @returns {Error}
 */
const malformed = (message, value) => {
    // This error already reports the bug, so the Promise rejecting must not also crash the process as
    // unhandled. Only a native Promise: calling `then` on a Knex or Mongoose query builder runs the query.
    if (value instanceof Promise) value.catch(() => {});
    return asHarnessError(Object.assign(new Error(message), { name: 'EffectTypeError' }));
};

/**
 * Builds the error for a value that is not an Effect, explaining the likely mistake.
 *
 * @param {any} value
 * @param {string} source - What produced the value, named where it is known
 * @returns {Error}
 */
const effectTypeError = (value, source) =>
    malformed(
        `${source} returned ${describeValue(value)}. Return Success, Failure, Command, Ask, Retry, or Parallel: ` +
            (value instanceof Promise
                ? 'a step cannot be async, so do the awaited work in a Command and continue in its next.'
                : 'a plain value has to be wrapped, as in Success(value).'),
        value
    );

/**
 * Names the node whose `next` returned a value, for an error message: a Command by its name, any other by its type.
 * @param {Effect} node
 * @returns {string}
 */
const nextOf = (node) =>
    node.type === 'Command'
        ? `The next of Command '${commandName(node)}'`
        : `The next of ${node.type === 'Ask' ? 'an' : 'a'} ${node.type}`;

/**
 * A Success or a Failure: a flow with nothing left to run.
 * @param {any} value
 * @returns {value is SuccessState | FailureState}
 */
const isOutcome = (value) => ['Success', 'Failure'].includes(value?.type);

/**
 * A Command, Ask, Retry, or Parallel: a flow the interpreter still has work to do on.
 * @param {any} value
 * @returns {value is CommandState | AskState | RetryState | ParallelState}
 */
const isPending = (value) => ['Command', 'Ask', 'Retry', 'Parallel'].includes(value?.type);

/**
 * @param {any} value
 * @returns {value is Effect}
 */
const isEffect = (value) => isOutcome(value) || isPending(value);

/**
 * @param {any} value
 * @param {string} source
 * @returns {Effect}
 */
const asEffect = (value, source) => {
    if (isEffect(value)) return value;
    throw effectTypeError(value, source);
};

/**
 * Connects an Effect to the next function in the pipeline.
 * Handles the branching logic for Success, Failure, Command, Ask, Retry, and Parallel.
 *
 * @param {Effect} effect - The current Effect object
 * @param {(value: any) => Effect} fn - The next function to run if the current effect is a Success
 * @param {Effect} [from] - The node whose `next` returned `effect`, which an error names
 * @returns {Effect} The composed Effect
 */
const chain = (effect, fn, from) => {
    const source = () => (from ? nextOf(from) : 'A continuation');

    // Checked before `effect.type` is read, which would otherwise throw a bare TypeError naming no step.
    if (effect == null) return asEffect(effect, source());

    switch (effect.type) {
        case 'Success':
            return asEffect(fn(effect.value), `Step '${fn.name || 'anonymous'}'`);
        case 'Failure':
            return effect;
        case 'Command': {
            const next = (/** @type {any} */ result) => chain(effect.next(result), fn, effect);
            return Command(effect.cmd, next, effect.meta);
        }
        case 'Ask': {
            const next = (/** @type {any} */ ctx) => chain(effect.next(ctx), fn, effect);
            return Ask(next);
        }
        case 'Retry': {
            const next = (/** @type {any} */ result) => chain(effect.next(result), fn, effect);
            return { ...effect, next };
        }
        case 'Parallel': {
            const next = (/** @type {any} */ result) => chain(effect.next(result), fn, effect);
            return { ...effect, next };
        }
        default:
            return asEffect(effect, source());
    }
};

/**
 * The input each flow `effectPipe` built was called with, keyed on the flow's root, for `interpret` to hand
 * `onRun`. Kept off the flow itself, so no node or outcome user code holds carries it.
 * @type {WeakMap<Effect, any>}
 */
const flowInputs = new WeakMap();

/**
 * Composes a list of functions into a single Effect pipeline.
 * Each function receives the output of the previous one.
 *
 * @param {...(input: any) => Effect} fns - Functions that each return an Effect: Success, Failure, Command, Ask,
 *        Retry, or Parallel.
 * @returns {(start: any) => Effect} A function that accepts an initial input and returns the final Effect tree.
 */
const effectPipe = (...fns) => {
    // Checked where the pipeline is defined, so a misspelt import is named before any flow is built from it.
    fns.forEach((fn, i) => {
        if (typeof fn !== 'function') {
            const got = describeArgument(fn);
            throw malformed(
                `effectPipe's step ${i + 1} is ${got}; each step is a function that returns an Effect.`,
                fn
            );
        }
    });
    return (start) => {
        const tree = fns.reduce((eff, fn) => chain(eff, fn), /** @type {Effect} */ (Success(start)));
        // A copy, since the last step can return an object other flows share, such as a Failure kept in a
        // constant, and the input is keyed on it.
        const root = { ...tree };
        flowInputs.set(root, start);
        return root;
    };
};

// #endregion
// #region Configuration

/**
 * Wraps one Command execution, or one Parallel: `type` is 'Parallel', and `op` runs the branches and
 * returns the Parallel's decision, even when a branch threw, so a hook must call it. Only a replay passes
 * `op` an argument, the recorded decision. `path` is the step's position in the Effect tree, so it matches
 * between a run and its replay whatever order `Parallel` branches finish in.
 * @typedef {(name: string, type: string, op: function, path?: string) => Promise<any>} StepRunner
 */
/** @type StepRunner */
const defaultStepRunner = async (name, type, op) => await op();

/**
 * Wraps one run. `initialInput` is what the flow was called with, when `effectPipe` built it.
 * @typedef {(effect: Effect, op: function, flowName?: string, initialInput?: any) => Promise<any>} RunWrapper
 */
/** @type RunWrapper */
const defaultRunWrapper = async (effect, op, flowName, initialInput) => await op();

/** @typedef {(command: CommandState, context?: any) => Promise<any>} CommandInterceptor */
/** @type CommandInterceptor */
const defaultCommandInterceptor = async (command, context) => {};

const defaultRetryOptions = { attempts: 3, delay: 100, backoff: 1 };

/**
 * Refuses the removed `retry` key rather than ignoring it, which would quietly turn a configured
 * `attempts: 5` back into 3. Migration scaffolding: remove at 1.0.
 * @param {any} config
 * @param {string} source
 */
const rejectRetryKey = (config, source) => {
    if (isObject(config) && 'retry' in config)
        throw new TypeError(
            `${source} no longer takes 'retry'. Retry options are per-use: pass them to Retry(effect, options).`
        );
};

/** The hooks a configuration can set. */
const hookNames = ['onStep', 'onRun', 'onBeforeCommand'];

/**
 * Describes what was passed where a configuration belongs. A function there is usually one that builds hooks,
 * as `telemetryHooks` does, passed without calling it.
 * @param {any} value
 * @returns {string}
 */
const describeConfiguration = (value) =>
    typeof value === 'function'
        ? 'a function, which usually means one that builds hooks was passed without being called'
        : describeArgument(value);

/**
 * Refuses a configuration that would quietly switch a hook off or break every run: a key no hook is named, as a
 * misspelt `onstep` is, or a hook that is not a function, which made every Command an I/O fault that `Retry`
 * retried. A hook left `undefined` is a slot left unset; `null` is refused, as the types refuse it.
 * @param {any} config
 * @param {string} source - Where it was passed, as the message names it
 * @param {string} prefix - What precedes a hook's name in the message, as in `configureEffect's onStep`
 * @param {string[]} known - The keys it may hold
 */
const checkConfiguration = (config, source, prefix, known) => {
    rejectRetryKey(config, source);
    rejectUnknownOptions(config, source, known);
    for (const name of hookNames) {
        const hook = config[name];
        if (hook !== undefined && typeof hook !== 'function') {
            throw new TypeError(`${prefix}${name} must be a function, got ${describeArgument(hook)}.`);
        }
    }
};

/**
 * @typedef {Object} EffectConfiguration
 * @property {StepRunner} [onStep] - Wraps each Command's execution, and each Parallel's branches.
 * @property {RunWrapper} [onRun] - Fires once per runEffect call. It wraps the entire workflow execution, and is
 *           handed the flow's input when `effectPipe` built it.
 * @property {CommandInterceptor} [onBeforeCommand] - Intercepts a Command and any context passed to runEffect before execution.
 */

/**
 * A per-call configuration: an `EffectConfiguration` plus `inherit`. With `inherit: true` (the default)
 * the call's hooks are merged over the wiring `configureEffect` installed, global outermost. With
 * `inherit: false` that wiring is ignored, so a slot the call leaves unset falls back to the library default.
 *
 * @typedef {EffectConfiguration & { inherit?: boolean }} CallConfiguration
 */

/** @type {EffectConfiguration[]} */
let layers = [];

/**
 * The installed layers merged into one configuration. A slot no layer defines is absent, and `runEffect`
 * picks the library default where it reads the slot.
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
 * closest to the Command; and `onBeforeCommand` interceptors run in the order installed, the first to throw
 * vetoing the Command. So these
 * are the same:
 *
 *     configureEffect(telemetryHooks(), recordingHooks({ sink }));
 *     configureEffect(telemetryHooks()); configureEffect(recordingHooks({ sink }));
 *
 * Calling it with no arguments at all removes every layer. A call whose arguments are all `undefined`,
 * such as `configureEffect(flag ? hooks : undefined)`, is a conditional install that installed nothing:
 * it adds no layer and removes none.
 *
 * @param {...(EffectConfiguration | undefined)} configs - Configurations merged into one layer, outermost first
 * @returns {() => void} Removes the layer this call added; a second call does nothing
 */
const configureEffect = (...configs) => {
    if (configs.length === 0) {
        layers = [];
        applyLayers();
        return () => {};
    }
    // Only `undefined` leaves a configuration out, as in `configureEffect(flag ? hooks : undefined)`.
    const present = configs.filter((config) => config !== undefined);
    // Before installing anything, so a refused call leaves the wiring untouched.
    present.forEach((config) => {
        if (!isOptionsObject(config)) {
            throw new TypeError(`configureEffect expects configuration objects, got ${describeConfiguration(config)}.`);
        }
        checkConfiguration(config, 'configureEffect', "configureEffect's ", hookNames);
    });
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
 * Merges several configurations into one, so independent concerns can share the hooks.
 *
 * `onStep` and `onRun` are wrappers around an `op`, so they nest: the first config given is the
 * outermost and the last sits closest to the Command, so a thrown Command unwinds from the last back
 * to the first. `onBeforeCommand` interceptors do not nest: they run in the order given, and the first to
 * throw vetoes the Command, so the ones after it do not run. A hook
 * no config defines is left unset, so the caller keeps its default for that slot.
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
            (inner, outer) => (effect, op, flowName, initialInput) =>
                outer(effect, () => inner(effect, op, flowName, initialInput), flowName, initialInput)
        );
    }
    if (interceptors.length) {
        merged.onBeforeCommand = async (command, context) => {
            for (const intercept of interceptors) await intercept(command, context);
        };
    }
    return merged;
};

// #endregion
// #region Running flows

/**
 * The Failure a cancelled `Parallel` branch stops with. Its error is named so it is never mistaken for
 * the failure that triggered the cancellation.
 * @returns {FailureState}
 */
const cancelledBranch = () =>
    Failure(Object.assign(new Error('Parallel branch cancelled.'), { name: 'ParallelCancelled' }));

/**
 * Which branch, if any, cancelled a Parallel. `branch: null` means an enclosing Parallel cancelled it.
 * It is recorded as the Parallel's own step, since it is decided by timing and a replay cannot recompute it.
 * @typedef {{ cancelled: false } | { cancelled: true, branch: number | null }} ParallelDecision
 */

/**
 * What running a Parallel's branches produced: each branch's outcome in array order, the decision, and
 * the first error a branch threw, which the Parallel rethrows once its step has returned the decision.
 * @typedef {{
 *   results: (SuccessState | FailureState | IoFaultState)[],
 *   decision: ParallelDecision,
 *   thrown: { error: unknown } | undefined
 * }} BranchRun
 */

/**
 * @param {any} branch
 * @param {number} count - How many branches the Parallel has
 * @returns {boolean}
 */
const isBranchIndex = (branch, count) => Number.isInteger(branch) && branch >= 0 && branch < count;

/**
 * Reads a recorded decision, or `undefined` for anything that is not one, which replays the Parallel
 * under timing.
 * @param {any} value
 * @param {number} branches - How many branches the Parallel has, so a stale branch index is refused too
 * @returns {ParallelDecision | undefined}
 */
const asDecision = (value, branches) => {
    if (!isObject(value)) return undefined;
    if (value.cancelled === false) return { cancelled: false };
    if (value.cancelled !== true) return undefined;
    const { branch } = value;
    if (branch === null) return { cancelled: true, branch: null };
    return isBranchIndex(branch, branches) ? { cancelled: true, branch } : undefined;
};

/**
 * Marks a step a replay reached that production never ran, in a branch a recorded decision cancelled.
 * Only `fromTrace` raises it, and `runCommand` and `runParallel` catch it and stop the branch there, as
 * production did.
 */
const replayCut = Symbol('pure-effect.replayCut');

/**
 * @param {string} path
 * @returns {Error}
 */
const replayCutError = (path) =>
    Object.defineProperty(
        asHarnessError(new Error(`Replay stopped a cancelled Parallel branch at path '${path}'.`)),
        replayCut,
        { value: true }
    );

/**
 * A cancellation scope for one Parallel, linked to the enclosing one so cancellation nests. Without an
 * `AbortController` there is no scope, and every branch runs to completion.
 * @param {AbortSignal} [signal] - The enclosing Parallel's signal, if any
 * @returns {{ scope: AbortController | undefined, unlink: () => void }}
 */
const linkedScope = (signal) => {
    const scope = typeof AbortController === 'function' ? new AbortController() : undefined;
    const relay = () => scope?.abort();
    if (signal && scope) {
        if (signal.aborted) scope.abort();
        else signal.addEventListener('abort', relay, { once: true });
    }
    const unlink = () => {
        if (signal && scope) signal.removeEventListener('abort', relay);
    };
    return { scope, unlink };
};

/**
 * Awaits every task, with at most `limit` of them in flight. Workers pull by index, so results land where
 * the caller put the effect rather than where it finished, which keeps trace paths stable.
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
 * Sleeps, but gives up early when the surrounding branch is cancelled. Resolves either way: the
 * caller's abort check is what turns a cancelled wait into a Failure.
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
        // A listener added to an aborted signal never runs, and this is the usual case: a Command that
        // honours the signal rejects when a sibling fails, and the Retry around it backs off on that signal.
        if (signal.aborted) {
            resolve();
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

const interpret =
    /**
     * The interpreter: walks the Effect tree, executing Commands and resolving Ask, Retry, and Parallel.
     * `runEffect` and `replayEffect` both run flows through it, so a replay cannot drift from a run.
     * `fastRetry` is the one thing only a replay sets: it waits no time between retry attempts, since a
     * delay is written on the Retry node and nothing else can override it.
     *
     * @param {Effect} effect
     * @param {any} [context]
     * @param {CallConfiguration} [callConfig]
     * @param {boolean} [fastRetry]
     * @returns {Promise<SuccessState | FailureState>}
     */
    async function interpret(effect, context = {}, callConfig = {}, fastRetry = false) {
        if (!isOptionsObject(callConfig)) {
            throw new TypeError(`runEffect's callConfig must be an object, got ${describeConfiguration(callConfig)}.`);
        }
        checkConfiguration(callConfig, "runEffect's callConfig", 'callConfig.', [...hookNames, 'inherit']);
        const { inherit = true, ...local } = callConfig;
        // Not coerced: `'false'` quietly inheriting everything is the behaviour this option exists to remove.
        if (typeof inherit !== 'boolean') {
            throw new TypeError(`callConfig.inherit must be true or false, got ${JSON.stringify(inherit)}.`);
        }
        // Merged the way `configureEffect` merges layers. A call with no hooks of its own skips the merge.
        const base = inherit ? globalConfig : {};
        const resolved = Object.keys(local).length ? chainHooks(base, local) : base;
        const localStepRunner = resolved.onStep || defaultStepRunner;
        const localRunWrapper = resolved.onRun || defaultRunWrapper;
        const localCommandInterceptor = resolved.onBeforeCommand || defaultCommandInterceptor;

        /**
         * Walks a subtree until it reaches a Success or a Failure. Every node but `Ask` runs in its own
         * function, which returns a Success carrying the value for the node's `next`, or the Failure or I/O
         * fault that stops the subtree.
         *
         * @param {Effect} eff
         * @param {AbortSignal} [signal] - Cancellation for this subtree, set for `Parallel` branches.
         * @param {string} [path] - Prefix for this subtree's position in the Effect tree. Steps are numbered
         *        within a subtree and each `Parallel` branch and `Retry` attempt opens its own prefix, so a
         *        path depends only on the tree's shape, never on the order branches finish in.
         * @returns {Promise<SuccessState | FailureState | IoFaultState>}
         */
        async function execute(eff, signal, path = '') {
            let step = 0;
            /** @type {Effect | undefined} The node whose `next` returned `eff`, which an error names. */
            let from;
            while (isPending(eff)) {
                // Checked before every node: a Command already in flight cannot be stopped, but the next never starts.
                if (signal?.aborted) return cancelledBranch();
                if (eff.type === 'Ask') {
                    from = eff;
                    eff = eff.next(context);
                    continue;
                }
                const stepPath = `${path}${step++}`;
                const outcome =
                    eff.type === 'Retry'
                        ? await runRetry(eff, signal, stepPath)
                        : eff.type === 'Parallel'
                          ? await runParallel(eff, signal, stepPath)
                          : await runCommand(eff, signal, stepPath);
                if (outcome.type !== 'Success') return outcome;
                // Outside every catch: `next` and the pure steps it reaches are code, not I/O, so a throw there
                // rejects the run.
                from = eff;
                eff = eff.next(outcome.value);
            }
            if (isOutcome(eff)) return eff;
            throw effectTypeError(eff, from ? nextOf(from) : 'The flow');
        }

        /**
         * Runs a Retry's wrapped tree until it succeeds or runs out of attempts, then its fallback if it has
         * one. Each attempt opens its own path prefix, and so does the fallback.
         *
         * @param {RetryState} retry
         * @param {AbortSignal | undefined} signal
         * @param {string} stepPath
         * @returns {Promise<SuccessState | FailureState | IoFaultState>}
         */
        async function runRetry(retry, signal, stepPath) {
            // An option set to `undefined` keeps its default, since that is how an absent config key arrives.
            const given = Object.entries(retry.options ?? {}).filter(([, value]) => value !== undefined);
            const opts = /** @type {typeof defaultRetryOptions & RetryState['options']} */ ({
                ...defaultRetryOptions,
                ...Object.fromEntries(given)
            });
            const { attempts, onExhausted } = opts;
            // `0` is refused rather than meaning run once: it would make `onExhausted` a free catch.
            if (!isPositiveInteger(attempts))
                throw new TypeError(
                    `Retry 'attempts' must be a positive integer, received ${describeValue(attempts)}. ` +
                        `To handle an outcome without retrying, branch on it as data in the Command's ` +
                        `next, or isolate a failing branch with Parallel's settled option.`
                );
            // A wait that is NaN, negative or infinite used to be no wait at all, so a flapping dependency was
            // called back to back.
            for (const key of /** @type {const} */ (['delay', 'backoff'])) {
                if (!isFiniteNonNegative(opts[key]))
                    throw new TypeError(
                        `Retry '${key}' must be a finite number of 0 or more, received ${describeValue(opts[key])}.`
                    );
            }
            let lastError;
            for (let attempt = 0; attempt <= attempts; attempt++) {
                // Under `fastRetry` this waits for no time rather than skipping the wait, so branches replayed by
                // timing still interleave as they do with a delay.
                if (attempt > 0) {
                    await delayFor(fastRetry ? 0 : opts.delay * Math.pow(opts.backoff, attempt - 1), signal);
                }
                // After the wait, so a branch cancelled mid-backoff makes no further attempt.
                if (signal?.aborted) return cancelledBranch();
                const result = await execute(retry.effect, signal, `${stepPath}r${attempt}/`);
                // A Success feeds `next`. An abort is the flow deciding, not the I/O failing: not retried, not
                // wrapped.
                if (result.type !== 'IoFault') return result;
                lastError = result.error;
            }
            const exhausted = { retryExhausted: true, lastError, attempts };
            // An exhaustion is a fault too, which keeps an enclosing Retry retrying this one.
            if (typeof onExhausted !== 'function') return IoFault(exhausted);
            // A cancelled branch starts no fallback, as it starts no further Commands.
            if (signal?.aborted) return cancelledBranch();
            // A failing fallback propagates as it is, not wrapped as another exhaustion.
            return execute(asEffect(onExhausted(exhausted), "Retry option 'onExhausted'"), signal, `${stepPath}rf/`);
        }

        /**
         * Runs a Parallel as one step of its own, whose `op` runs the branches and returns the decision, so
         * the decision is recorded and a replay can hand it back.
         *
         * @param {ParallelState} parallel
         * @param {AbortSignal | undefined} signal
         * @param {string} stepPath
         * @returns {Promise<SuccessState | FailureState | IoFaultState>}
         */
        async function runParallel(parallel, signal, stepPath) {
            // Branch prefixes come from array index, never completion order, so two branches calling the same
            // Command are told apart by position.
            const branchPath = `${stepPath}p`;
            const options = parallel.options ?? {};
            const { limit, settled } = options;
            if (limit !== undefined && !isPositiveInteger(limit))
                throw new TypeError(`Parallel 'limit' must be a positive integer, received ${describeValue(limit)}.`);
            // Cast rather than annotated, since only `op` assigns it.
            let run = /** @type {BranchRun | undefined} */ (undefined);
            // A replay passes the recorded decision, from `replayEffect`'s onStep; a live run passes nothing.
            const op = async (/** @type {any} */ recorded) => {
                run = await runBranches(parallel.effects, options, signal, branchPath, recorded);
                return run.decision;
            };
            try {
                await localStepRunner('Parallel', 'Parallel', op, branchPath);
            } catch (e) {
                // A cut from `fromTrace`: a replay found this Parallel inside a branch production had already stopped.
                if (hasMark(e, replayCut)) return cancelledBranch();
                throw e;
            }
            if (!run) {
                throw new TypeError(
                    `An onStep hook returned without letting op run the Parallel at path '${branchPath}'. ` +
                        'A hook has to call op for a Parallel and pass on what it returns or throws, because op ' +
                        'runs its branches.'
                );
            }
            const { results, decision, thrown } = run;
            // Rethrown here, after the step has returned its decision, so the decision is recorded.
            if (thrown) throw thrown.error;
            // Settled hands `next` the outcomes as plain Success and Failure nodes, so the Parallel never fails
            // on a branch's account.
            if (settled) return Success(results.map(asOutcome));
            const failure =
                decision.cancelled && decision.branch !== null
                    ? results[decision.branch]
                    : results.find((r) => r.type !== 'Success');
            if (failure) return failure;
            return Success(results.map((r) => /** @type {SuccessState} */ (r).value));
        }

        /**
         * Runs a Parallel's branches and decides which branch, if any, cancelled the others. In a live run
         * timing decides it, which is why the decision is recorded. A recorded cancellation passed in by a
         * replay is reproduced rather than recomputed: no branch cancels another, each runs its recorded steps
         * and stops where its recording stops, and the recorded branch's failure is the result.
         *
         * @param {Effect[]} effects
         * @param {ParallelOptions} options
         * @param {AbortSignal | undefined} signal - The enclosing Parallel's cancellation, if any
         * @param {string} branchPath
         * @param {any} recorded - The recorded decision, which `replayEffect`'s onStep passes to the Parallel's
         *        `op`; undefined in a live run
         * @returns {Promise<BranchRun>}
         */
        async function runBranches(effects, options, signal, branchPath, recorded) {
            const { limit, settled } = options;
            // A recorded branch past the end means the flow changed shape since the recording. A negative one is
            // not a decision, so it replays by timing like anything else.
            const recordedBranch = recorded?.cancelled === true ? recorded.branch : undefined;
            const pastTheEnd = Number.isInteger(recordedBranch) && recordedBranch >= effects.length;
            if (pastTheEnd) {
                const count = effects.length === 1 ? '1 branch' : `${effects.length} branches`;
                throw timeParadoxAt(
                    `path '${branchPath}'`,
                    `the recorded run was cancelled by branch ${recordedBranch}, but this Parallel has ${count}.`,
                    { path: branchPath, branch: recordedBranch }
                );
            }
            const forced = asDecision(recorded, effects.length);
            const reproducing = forced !== undefined && forced.cancelled;
            // Live, a throw cancels the others, and so does a failure unless `settled`; the run rejects on a throw
            // either way, and an enclosing Parallel can still cancel this one. Reproducing, nothing cancels, since
            // the recording already says where each branch stops.
            const { results, thrown, trigger, cancelled } = await settleBranches(
                effects,
                limit,
                signal,
                branchPath,
                reproducing ? () => false : (threw, result) => threw || (!settled && result.type !== 'Success')
            );
            if (reproducing) {
                // A branch that threw has no result to check, and its throw is what is rethrown.
                const recordedTriggerSucceeded =
                    !thrown && forced.branch !== null && results[forced.branch].type === 'Success';
                if (recordedTriggerSucceeded) {
                    throw timeParadoxAt(
                        `path '${branchPath}'`,
                        `the recorded run was cancelled by branch ${forced.branch}, which did not fail in this replay.`,
                        { path: branchPath, branch: forced.branch }
                    );
                }
                return { results, decision: forced, thrown };
            }
            /** @type {ParallelDecision} */
            const decision =
                trigger >= 0
                    ? { cancelled: true, branch: trigger }
                    : cancelled
                      ? { cancelled: true, branch: null }
                      : { cancelled: false };
            return { results, decision, thrown };
        }

        /**
         * Runs every branch to completion, at most `limit` at once, under one cancellation scope linked to the
         * enclosing one. A branch that settles in a way `cancelsOthers` accepts cancels the rest, and the first
         * to do so is the trigger.
         *
         * @param {Effect[]} effects
         * @param {number | undefined} limit
         * @param {AbortSignal | undefined} signal
         * @param {string} branchPath
         * @param {(threw: boolean, result: SuccessState | FailureState | IoFaultState) => boolean} cancelsOthers
         * @returns {Promise<{
         *   results: (SuccessState | FailureState | IoFaultState)[],
         *   thrown: { error: unknown } | undefined,
         *   trigger: number,
         *   cancelled: boolean
         * }>}
         */
        async function settleBranches(effects, limit, signal, branchPath, cancelsOthers) {
            const { scope, unlink } = linkedScope(signal);
            /** @type {(SuccessState | FailureState | IoFaultState)[]} */
            const results = new Array(effects.length);
            // Held rather than rethrown, so every branch still settles and no `limit` worker stops early.
            /** @type {{ error: unknown }[]} */
            const thrown = new Array(effects.length);
            // Which branch cancelled the others on its own account rather than because it was cancelled.
            const triggered = new Array(effects.length).fill(false);
            const settle = async (/** @type {Effect} */ branch, /** @type {number} */ i) => {
                try {
                    results[i] = await execute(branch, scope?.signal, `${branchPath}${i}/`);
                } catch (error) {
                    thrown[i] = { error };
                }
                // Read-then-abort is atomic here, so exactly one branch is the trigger.
                if (cancelsOthers(thrown[i] !== undefined, results[i])) {
                    if (!scope?.signal.aborted) triggered[i] = true;
                    scope?.abort();
                }
            };
            try {
                // Awaits every branch, so no cancelled work runs on unobserved after the Parallel returns.
                await runBounded(
                    effects.map((branch, i) => () => settle(branch, i)),
                    limit
                );
            } finally {
                unlink();
            }
            return {
                results,
                // The first by array order, since every branch has settled by now.
                thrown: thrown.find(Boolean),
                trigger: triggered.indexOf(true),
                cancelled: Boolean(scope?.signal.aborted)
            };
        }

        /**
         * Runs one Command. A throw means something different in each region: an interceptor throwing vetoes
         * the Command, which is an abort, and the Command's function throwing is an I/O fault. A harness error
         * is rethrown from either.
         *
         * @param {CommandState} command
         * @param {AbortSignal | undefined} signal
         * @param {string} cmdPath
         * @returns {Promise<SuccessState | FailureState | IoFaultState>}
         */
        async function runCommand(command, signal, cmdPath) {
            const cmdName = commandName(command);
            const { cmd } = command;
            // Whether the function itself succeeded: a hook throwing after it did is a bug, and retrying would
            // repeat work already done.
            let succeeded = false;
            // What it returned, so a hook that loses it is caught.
            /** @type {unknown} */
            let value;
            // The signal goes only to a function that declares a parameter for it, and only inside a Parallel. A
            // parameter with a default value does not count toward `length`, so `nanoid(size = 21)` passed by name
            // keeps its default rather than reading the signal as its size. A plain first parameter the function
            // treats as optional still takes the signal: a documented sharp edge.
            const takesSignal = signal !== undefined && cmd.length > 0;
            // Async, so a hook always gets a promise, even from a synchronous function. The latest call is kept,
            // with whether it is still running, so a hook that does not wait for it is caught.
            /** @type {Promise<unknown> | undefined} */
            let call;
            let running = false;
            const run = async () => {
                succeeded = false;
                running = true;
                try {
                    value = await (takesSignal ? cmd(signal) : cmd());
                    succeeded = true;
                    return value;
                } finally {
                    running = false;
                }
            };
            const op = () => (call = run());
            try {
                await localCommandInterceptor(command, context);
            } catch (e) {
                if (hasMark(e, harnessError)) throw e;
                return Failure(e);
            }
            // Again, since an interceptor can wait (a rate limiter, say) while a sibling fails.
            if (signal?.aborted) return cancelledBranch();
            let returned;
            let unwaited = false;
            try {
                returned = await localStepRunner(cmdName, 'Command', op, cmdPath);
                // A hook that called `op` without waiting for it returned while the Command ran, so the check below
                // would have nothing to check yet. Waiting here judges the step as though the hook had awaited `op`.
                if (returned === undefined && running) {
                    unwaited = true;
                    await call;
                }
            } catch (e) {
                // A cut from `fromTrace`: a step production never ran, in a branch a Parallel cancelled. Stop here,
                // as production did.
                if (hasMark(e, replayCut)) return cancelledBranch();
                if (hasMark(e, harnessError)) throw e;
                // A hook threw after the function returned, which is a bug in the hook. A hook that throws
                // without calling `op` is still a fault, since that is how replay reports a recorded error.
                if (succeeded) throw e;
                return IoFault(e);
            }
            // A hook that awaited `op` and forgot to return its result: `next` would take the branch for a Command
            // that returned nothing, while a recorder inside the hook kept the real value. Only `undefined` is
            // refused, so a hook that returns a copy of the result still works.
            if (returned === undefined && succeeded && value !== undefined) {
                throw new TypeError(
                    `An onStep hook called op for '${cmdName}' at path '${cmdPath}' and returned undefined` +
                        `${unwaited ? ' before op had finished' : ''}, although the Command returned a value. ` +
                        'A hook has to await op() and return what it returns.'
                );
            }
            return Success(returned);
        }

        // An I/O fault becomes a plain Failure here, where every outcome leaves.
        const run = async () => asOutcome(await execute(effect));
        // Recorded by `effectPipe`, so a hook-based recorder can store what the flow was called with.
        return localRunWrapper(effect, run, context?.flowName || '', flowInputs.get(effect));
    };

/**
 * Runs a flow: executes its Commands, resolving `Ask` with the context and running `Retry` and `Parallel`.
 * onRun fires exactly once per call; Retry attempts run inside that single span.
 *
 * @param {Effect} effect - The Effect tree returned by a pipeline
 * @param {any} [context] - Optional context object. Passed to Ask continuations and the Command Interceptor.
 * @param {CallConfiguration} [callConfig] - Per-call configuration, added to the wiring `configureEffect`
 *        installed unless `inherit: false`, which ignores that wiring for this run.
 * @returns {Promise<SuccessState | FailureState>}
 */
const runEffect = (effect, context, callConfig) => interpret(effect, context, callConfig);

// #endregion
// #region Recording and replay

/**
 * The step a replay is asking about. `path` is the Command's position in the Effect tree and is stable
 * across runs; `index` is its position in this run's completion order, which is not stable for a flow
 * containing `Parallel`. Prefer `path` when writing a Resolver. A step whose `type` is 'Parallel' asks
 * for a Parallel's recorded decision; it does not advance `index`, and anything but a decision replays
 * that Parallel under timing.
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
 * A recorded step: a Command's result or error, or a Parallel's decision, recorded as `command`
 * 'Parallel' at the Parallel's own path with the decision as its `result`. `durationMs` is how long
 * the step took in production, rounded to microseconds. `path` is what a replay matches on.
 * `threw` marks a step that threw. The `error` key alone cannot, since JSON drops it when the value is
 * `undefined`, as it is for `reject()` with no argument or an error `redact` removed.
 * @typedef {{ command: string, path?: string, result?: any, threw?: true, error?: any, durationMs?: number }} TraceEntry
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
 * A replay fault: the trace cannot answer the flow, or disagrees with it. A harness error while the flow
 * runs, so nothing inside the flow can swallow it; `replayEffect` turns it into a `Failure` at its own
 * boundary. An `EffectTypeError` carries no replay mark and keeps propagating, since a malformed flow is
 * a bug in the flow rather than a problem with the trace.
 */
const replayFault = Symbol('pure-effect.replayFault');

/**
 * Creates a replay error, which `replayEffect` turns into a Failure at its own boundary.
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
 * Builds a `TimeParadox`: the replay reached a point where the flow no longer matches its recording, which
 * means the code has diverged from the recorded run.
 * @param {string} at - Where, as the message names it
 * @param {string} detail - How the flow and the recording disagree
 * @param {Object} props - The fields that locate it, such as `path`
 * @returns {Error}
 */
const timeParadoxAt = (at, detail, props) =>
    replayError(`Time paradox at ${at}: ${detail}`, { name: 'TimeParadox', ...props });

/**
 * Signals that the flow being replayed asked for a different Command than the trace recorded.
 * @param {ReplayStep} step - The step the flow asked for
 * @param {string} recorded - The command name the trace holds at that position
 * @returns {Error}
 */
const timeParadox = (step, recorded) =>
    timeParadoxAt(
        step.path !== undefined ? `path '${step.path}'` : `step ${step.index}`,
        `flow asked for '${step.name}', trace recorded '${recorded}'`,
        { index: step.index, path: step.path, expected: recorded, actual: step.name }
    );

/** The keys `serializeError` carries whatever their enumerability, which a native Error sets as hidden. */
const carriedKeys = ['name', 'message', 'cause'];

/**
 * Converts a thrown value into something JSON can carry. `message` and `stack` are
 * non-enumerable on Error, so a plain `JSON.stringify` would silently drop them.
 *
 * @param {any} e - The thrown value
 * @param {boolean} [withStack] - Include the stack (off by default: noisy, leaks paths)
 * @param {Set<Error>} [ancestors] - The errors whose `cause` or `errors` led here
 * @returns {any}
 */
const serializeError = (e, withStack, ancestors = new Set()) => {
    if (!(e instanceof Error)) return e;
    /** @type {any} */
    const out = { __error: true, name: e.name, message: e.message };
    // A chain that comes back to an error it passed through is cut there, with the name and message only:
    // following it overflowed the stack, and the recorder dropped the whole step. Only ancestors count, so an
    // error that merely appears twice is carried in full both times.
    if (ancestors.has(e)) return out;
    ancestors.add(e);
    if (withStack) out.stack = e.stack;
    // `cause` is non-enumerable too, and it can itself be an Error, so it is carried recursively.
    if ('cause' in e) out.cause = serializeError(e.cause, withStack, ancestors);
    // So is an AggregateError's `errors`, which is where its detail lives. It goes under its own key so
    // revival can tell it from an enumerable `errors`, which is data and is copied below as it is.
    const errors = /** @type {any} */ (e).errors;
    const hasHiddenErrors = Array.isArray(errors) && !Object.prototype.propertyIsEnumerable.call(e, 'errors');
    if (hasHiddenErrors) {
        out.__errors = errors.map((x) => serializeError(x, withStack, ancestors));
    }
    ancestors.delete(e);
    // Assigning `name`, `message` or `cause`, as `e.name = 'TimeoutError'` or `e.cause = inner` does, makes it
    // enumerable. It is carried above already, so it is listed for revival to restore as it was rather than
    // copied again, where a raw cause would replace the serialized one and reach JSON as {}.
    const shown = carriedKeys.filter((k) => Object.prototype.propertyIsEnumerable.call(e, k));
    if (shown.length > 0) out.__enumerable = shown;
    for (const k of Object.keys(e)) if (!carriedKeys.includes(k)) out[k] = /** @type {any} */ (e)[k];
    return out;
};

/**
 * Rebuilds an Error from `serializeError` output. Non-Error values pass through, so a
 * Command that rejected with a string still replays as a string.
 * @param {any} v - A serialized error, or any other recorded value
 * @returns {any}
 */
const reviveError = (v) => {
    if (!isObject(v) || v.__error !== true) return v;
    const e = new Error(v.message);
    // `name`, `message`, `cause` and `errors` are defined as the original had them, so a revived error
    // deep-equals the one the Command threw: non-enumerable, as on a native Error, unless `__enumerable` lists
    // them. Every other key was enumerable on the original.
    const shown = Array.isArray(v.__enumerable) ? v.__enumerable : [];
    const restore = (/** @type {string} */ key, /** @type {any} */ value) =>
        Object.defineProperty(e, key, { enumerable: shown.includes(key), configurable: true, writable: true, value });
    restore('name', v.name);
    if (shown.includes('message')) restore('message', v.message);
    // The markers are dropped, and `name` and `message` are already set.
    const alreadyHandled = ['__error', '__enumerable', 'name', 'message'];
    for (const [k, val] of Object.entries(v)) {
        if (alreadyHandled.includes(k)) continue;
        if (k === 'cause') restore('cause', reviveError(val));
        else if (k === '__errors' && Array.isArray(val)) restore('errors', val.map(reviveError));
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
 *           out of a trace, so it has to see all four. It is handed a copy, so changing the value in place
 *           never reaches the run.
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
 * An array, a plain object, or an object with no prototype: the shapes `copyAround` rebuilds itself rather
 * than handing to `structuredClone`.
 * @param {object} value
 * @returns {boolean}
 */
const isPlainContainer = (value) => {
    if (Array.isArray(value)) return true;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

/**
 * Copies what `structuredClone` refused. Arrays and plain objects are rebuilt and everything inside them is
 * copied in turn, so only the parts that cannot be copied, such as a function or an object holding one, are
 * kept as they are. A context holding a logger is the usual case.
 *
 * @param {any} value
 * @param {Map<object, any>} seen - Copies made so far, so a cycle is copied as a cycle
 * @returns {any}
 */
const copyAround = (value, seen) => {
    if (!isObject(value)) return value;
    if (seen.has(value)) return seen.get(value);
    if (!isPlainContainer(value)) {
        try {
            return structuredClone(value);
        } catch {
            return value;
        }
    }
    /** @type {any} */
    const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
        let item;
        try {
            item = value[key];
        } catch {
            // A getter that throws when read, as a lazy client's does, cannot be copied either, so it is kept too.
            Object.defineProperty(
                copy,
                key,
                /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, key))
            );
            continue;
        }
        copy[key] = copyAround(item, seen);
    }
    return copy;
};

/**
 * Snapshots a value on its way into a trace, and on its way out of one in a replay, so a later mutation
 * cannot rewrite what the trace says a step returned. The copy is also what `redact` is handed, so it has
 * to be one the flow never sees. A value that cannot be cloned whole is copied around the parts that
 * cannot be copied.
 *
 * @param {any} value
 * @returns {any}
 */
const snapshot = (value) => {
    if (!isObject(value)) return value;
    try {
        return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    } catch {
        return copyAround(value, new Map());
    }
};

/**
 * @typedef {Object} StepStart
 * @property {string} name - The Command's identity: `meta.name`, else `cmd.name`, else 'anonymous'.
 * @property {string} type - 'Command', or 'Parallel' for a Parallel's decision.
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
 * Wraps a step observer into an `onStep` that cannot change the run: `op` always runs, its result is
 * returned, its error propagates, and anything the observer throws is dropped.
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
 * Builds an `onStep` hook that records every Command's result or error and every Parallel's decision, plus
 * a packager for the reference trace format. Pass `onStep` to `runEffect` as per-call config. A recorder holds
 * the steps of every run it sees, so installed with `configureEffect` for a whole application it mixes requests
 * into one trace with duplicate paths, which a replay refuses; examples/recording-example.js gives each run its
 * own.
 *
 * @param {RecorderOptions} [options] - Redaction and size limits
 * @returns {{ onStep: StepRunner, entries: TraceEntry[], toTrace: (meta?: TraceMeta) => TraceLog }}
 */
const recorder = (options = {}) => {
    rejectUnknownOptions(options, 'recorder', ['redact', 'maxEntries', 'stack']);
    const { redact = (/** @type {any} */ r) => r, maxEntries = Infinity, stack = false } = options;
    /** @type {TraceEntry[]} */
    const entries = [];
    let dropped = 0;

    const push = (/** @type {TraceEntry} */ entry) => {
        if (entries.length < maxEntries) entries.push(entry);
        else dropped++;
    };

    // `redact` is the caller's code, and a throw from it must not reach the run.
    const safeRedact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
        try {
            return redact(value, name, kind);
        } catch {
            return '[redaction failed]';
        }
    };

    /**
     * Snapshots one of the trace's own fields and redacts the copy. `undefined` is left alone so a flow with no
     * context does not acquire an empty object from a redact function that spreads its argument.
     */
    const redactField = (/** @type {any} */ value, /** @type {string} */ kind) =>
        value === undefined ? undefined : safeRedact(snapshot(value), kind, kind);

    /**
     * Snapshots a thrown value's serialized form and redacts the copy. An Error stays marked as one when redact
     * returns an object without the mark, as one that builds a fresh object from `name` and `message` does:
     * otherwise the replay handed the flow a plain object where production had thrown an Error.
     */
    const redactError = (/** @type {any} */ thrown, /** @type {string} */ name) => {
        const serialized = snapshot(serializeError(thrown, stack));
        // Read before redact runs, since it may change the copy it is handed.
        const wasError = isObject(serialized) && serialized.__error === true;
        const redacted = safeRedact(serialized, name, 'error');
        const rebuilt = wasError && isObject(redacted) && !Array.isArray(redacted) && redacted.__error !== true;
        if (!rebuilt) return redacted;
        // A field it left undefined, as `{ status: value.status }` leaves one the error did not have, is dropped as
        // JSON drops it, so a replay from memory matches one from storage, and production.
        const fields = Object.entries(redacted).filter(([, field]) => field !== undefined);
        return { __error: true, ...Object.fromEntries(fields) };
    };

    const onStep = observeSteps(({ name, type, path }) => (end) => {
        const durationMs = Math.round(end.durationMs * 1000) / 1000;
        // A Parallel's result is its decision, which holds no user data and must survive intact for a replay
        // to reproduce it, so it is not redacted.
        const recorded = (/** @type {any} */ result) =>
            type === 'Parallel' ? snapshot(result) : safeRedact(snapshot(result), name, 'result');
        push(
            'error' in end
                ? {
                      command: name,
                      path,
                      threw: true,
                      error: redactError(end.error, name),
                      durationMs
                  }
                : { command: name, path, result: recorded(end.result), durationMs }
        );
    });

    /**
     * Redacts and copies `meta.initialInput` and `meta.context` when it is called, so call it before the run
     * when the run can change them, and take `dropped` and `trace` from a second call once it ends.
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
 * outcome and a replayable trace. Convenient in tests and scripts; to record an application without
 * changing call sites, give each run its own recorder, as examples/recording-example.js does.
 *
 * @param {(input: any) => Effect} flowFn - Builds the Effect tree from its input
 * @param {any} initialInput - The value the flow is called with; stored so a replay can rebuild it
 * @param {RecorderOptions & { context?: any, version?: string }} [options] - Recorder options, plus the
 *        `context` given to `runEffect` (stored so `Ask` can be replayed) and a build id
 * @returns {Promise<{ result: SuccessState | FailureState, trace: TraceLog }>}
 */
const recordEffect = async (flowFn, initialInput, options = {}) => {
    rejectUnknownOptions(options, 'recordEffect', ['context', 'version', 'redact', 'maxEntries', 'stack']);
    const { context = {}, version, ...recorderOptions } = options;
    const rec = recorder(recorderOptions);
    // Packaged before the run, so a Command that writes to the input or the context, as an ORM save
    // assigning an id does, cannot rewrite what the trace says the run received.
    const head = rec.toTrace({ initialInput, flowName: context.flowName, context, version });
    // Merged over the global wiring, so recording inside an instrumented application keeps its spans.
    const result = await runEffect(flowFn(initialInput), context, { onStep: rec.onStep });
    const { dropped, trace } = rec.toTrace();
    return { result, trace: { ...head, dropped, trace } };
};

/**
 * Whether a recorded entry says its step threw: `threw`, or an `error` key, which is how older and
 * hand-written traces say it.
 * @param {TraceEntry} entry
 * @returns {boolean}
 */
const entryThrew = (entry) => entry.threw === true || 'error' in entry;

/**
 * Whether a trace entry or a replay step carries a path.
 * @param {{ path?: string }} step
 * @returns {boolean}
 */
const hasPath = (step) => typeof step.path === 'string';

/**
 * Whether a path lies inside a Parallel branch, which a `p` followed by the branch number marks.
 * @param {string | undefined} path
 * @returns {boolean}
 */
const isInsideParallel = (path) => typeof path === 'string' && /p\d+\//.test(path);

/** @typedef {'Command' | 'Retry' | 'Parallel'} NodeKind */

/**
 * The positions a path passes through, each with the kind of node there: the Retry or Parallel each prefix
 * opens, then the Command the path ends at, or the Parallel whose own entry it is. So `0p1/2r0/1` passes a
 * Parallel at `0` and a Retry at `0p1/2`, and ends at a Command at `0p1/2r0/1`. A path that is not in the
 * recorder's format gives none, so a hand-built trace is never judged by its shape.
 * @param {string} path
 * @returns {[string, NodeKind][]}
 */
const nodesAlong = (path) => {
    /** @type {[string, NodeKind][]} */
    const nodes = [];
    let prefix = '';
    for (const segment of path.split('/')) {
        const match = /^(\d+)(?:(p)\d*|(r)(?:\d+|f))?$/.exec(segment);
        if (!match) return [];
        const [, step, parallel, retry] = match;
        nodes.push([prefix + step, parallel ? 'Parallel' : retry ? 'Retry' : 'Command']);
        prefix += `${segment}/`;
    }
    return nodes;
};

/**
 * Turns a recorded entry into the outcome a Resolver must return, snapshotted so a replayed step that
 * mutates its result cannot rewrite the trace.
 *
 * @param {TraceEntry} entry
 * @returns {ReplayOutcome}
 */
const entryToOutcome = (entry) =>
    entryThrew(entry) ? { error: reviveError(snapshot(entry.error)) } : { result: snapshot(entry.result) };

/**
 * Whether an entry is a Parallel's recorded decision rather than a Command's result. A Parallel's path
 * ends in its `p` marker and a Command's in its step number, so a Command that happens to be named
 * 'Parallel' is never mistaken for one.
 * @param {TraceEntry} entry
 * @returns {boolean}
 */
const isDecisionEntry = (entry) =>
    entry.command === 'Parallel' && typeof entry.path === 'string' && entry.path.endsWith('p');

/**
 * Builds a Resolver for the reference trace format. Internal: `replayEffect` is the only caller, and a
 * caller with traces in another shape writes a Resolver instead.
 *
 * When every entry carries a `path`, steps are matched by path, which is order-independent and still
 * detects a paradox: two `Parallel` branches calling the same Command are told apart by position. A
 * trace without paths is matched positionally, each entry checked against the Command the flow asks
 * for, which is exact for sequential flows and cannot tell `Parallel` branches apart.
 *
 * A step the trace does not hold resolves to `undefined`, as from a Resolver, so `replayEffect` applies
 * `onMissing` to both; `missing` describes the step for the error.
 *
 * @param {TraceLog | TraceEntry[]} traceLog - A reference-format trace, or a bare array of entries
 * @param {Object} [options]
 * @param {(entry: TraceEntry) => void} [options.onEntry] - Observes each entry as it is handed to a step,
 *        which is how `replayEffect` learns which recorded entries the flow never asked for.
 * @returns {{ resolve: Resolver, missing: (step: ReplayStep) => string }}
 */
const fromTrace = (traceLog, options = {}) => {
    const { onEntry } = options;
    const entries = Array.isArray(traceLog) ? traceLog : traceLog?.trace;
    if (!Array.isArray(entries)) throw replayError('Trace has no `trace` array.');
    const resolveEntry = (/** @type {TraceEntry} */ entry) => {
        if (onEntry) onEntry(entry);
        return entryToOutcome(entry);
    };

    if (entries.length > 0 && entries.every(hasPath)) {
        const byPath = new Map(entries.map((e) => [e.path, e]));
        // Paths are unique by construction, so a collision means a hand-built trace or a bug, and keeping
        // either entry would hand a branch the wrong result.
        if (byPath.size !== entries.length) {
            throw replayError('Trace has duplicate step paths.');
        }
        /** The kind of node the recorded run had at each position its steps passed through. */
        const recordedKinds = new Map(entries.flatMap((e) => nodesAlong(/** @type {string} */ (e.path))));
        // A step the trace lacks is a change of shape, not a missing step, when the trace recorded another kind of
        // node somewhere along its path: a Command added where a Retry was, or one removed so that a Retry moved
        // onto a Command's position. Its path is one the trace never had, so it would otherwise be reported as
        // missing, and run live under `onMissing: 'execute'`.
        /** Names the first Command the trace recorded inside the Retry or Parallel at `at`, for a message. */
        const firstStepIn = (/** @type {string} */ at, /** @type {NodeKind} */ kind) => {
            const opens = `${at}${kind === 'Retry' ? 'r' : 'p'}`;
            const inside = entries.find((e) => e.path?.startsWith(opens) && !isDecisionEntry(e));
            return inside ? `, with '${inside.command}' at path '${inside.path}'` : '';
        };
        const throwIfReshaped = (/** @type {ReplayStep} */ step) => {
            const nodes = nodesAlong(/** @type {string} */ (step.path));
            const diverged = nodes.find(([at, kind]) => (recordedKinds.get(at) ?? kind) !== kind);
            if (!diverged) return;
            const [at, kind] = diverged;
            const recorded = /** @type {NodeKind} */ (recordedKinds.get(at));
            const actual = kind === 'Command' ? step.name : kind;
            const expected = recorded === 'Command' ? /** @type {TraceEntry} */ (byPath.get(at)).command : recorded;
            const flowHad = kind === 'Command' ? `flow asked for '${actual}'` : `flow has a ${kind} there`;
            const traceHad =
                recorded === 'Command'
                    ? `trace recorded '${expected}'`
                    : `trace recorded a ${recorded} there${firstStepIn(at, recorded)}`;
            throw timeParadoxAt(`path '${at}'`, `${flowHad}, ${traceHad}`, {
                index: step.index,
                path: at,
                expected,
                actual
            });
        };
        /** Recorded Parallel decisions that cancelled branches, by the Parallel's path. */
        const cancellations = entries.filter(isDecisionEntry).filter((e) => e.result?.cancelled === true);
        // A missing step is where production stopped a branch when it lies in a branch a recorded decision
        // cancelled: any branch but the cancelling one, or every branch of a Parallel cancelled from outside. Such a
        // step throws a cut, which `runCommand` or `runParallel` catches to stop the branch.
        const stoppedInProduction = (/** @type {string | undefined} */ stepPath) =>
            typeof stepPath === 'string' &&
            cancellations.some((e) => {
                const at = /** @type {string} */ (e.path);
                const branch = stepPath.startsWith(at) ? /^(\d+)\//.exec(stepPath.slice(at.length)) : null;
                return branch !== null && (e.result.branch === null || Number(branch[1]) !== e.result.branch);
            });
        /** @type {Resolver} */
        const resolve = (step) => {
            const entry = byPath.get(step.path);
            if (step.type === 'Parallel') {
                // A decision rather than I/O. `replayEffect` hands a recorded one to the Parallel's `op`, and
                // `runBranches` reproduces it; with none recorded, the Parallel replays under timing.
                if (entry && entry.command !== 'Parallel') throw timeParadox(step, entry.command);
                if (entry) return resolveEntry(entry);
                throwIfReshaped(step);
                if (stoppedInProduction(step.path)) throw replayCutError(/** @type {string} */ (step.path));
                return undefined;
            }
            if (!entry) {
                throwIfReshaped(step);
                // Production never ran this step, so it is not run live under `onMissing` either.
                if (stoppedInProduction(step.path)) throw replayCutError(/** @type {string} */ (step.path));
                return undefined;
            }
            if (entry.command !== step.name) throw timeParadox(step, entry.command);
            return resolveEntry(entry);
        };
        const missing = (/** @type {ReplayStep} */ step) =>
            `Trace has no step at path '${step.path}' for '${step.name}'`;
        return { resolve, missing };
    }

    /** @type {Resolver} */
    const resolve = (step) => {
        // A trace with no paths predates recorded decisions, so a Parallel replays under timing.
        if (step.type === 'Parallel') return undefined;
        // Positional matching pairs steps by completion order, which cannot tell Parallel branches apart.
        // Refusing beats a result that is right only when the replay finishes in production's order.
        if (isInsideParallel(step.path)) {
            throw replayError(
                `Trace carries no paths, so '${step.name}' inside a Parallel cannot be matched positionally.`,
                { command: step.name, path: step.path }
            );
        }
        const entry = entries[step.index];
        if (!entry) return undefined;
        if (entry.command !== step.name) throw timeParadox(step, entry.command);
        return resolveEntry(entry);
    };
    const missing = (/** @type {ReplayStep} */ step) => `Trace exhausted: no entry #${step.index} for '${step.name}'`;
    return { resolve, missing };
};

/**
 * The error for a step a replay has no recorded outcome for, which it refuses to run live.
 * @param {ReplayStep} step
 * @param {((step: ReplayStep) => string) | undefined} describe - `fromTrace`'s `missing`; a Resolver has none
 * @param {number} droppedEntries - How many entries the trace dropped under `maxEntries`
 * @returns {Error}
 */
const missingStepError = (step, describe, droppedEntries) => {
    const what = describe ? describe(step) : `No recorded outcome for '${step.name}' at step ${step.index}`;
    // Why the step may be missing decides the fix. A capped trace needs a higher cap, since the step may be one
    // production ran; any other missing step may be one production never ran, and running it live against
    // production would do I/O production refused.
    const why =
        droppedEntries > 0
            ? `The trace dropped ${droppedEntries} entries under maxEntries, so production may have run ` +
              'this step and the recorder not kept it; record the flow with a higher maxEntries to ' +
              'replay past it.'
            : 'Production may never have run it: a Command an onBeforeCommand hook vetoed leaves no ' +
              'entry, and neither does a step the flow reaches now that it did not then, such as one added ' +
              "past the end of the recording. onMissing: 'execute' runs such a step for real, and every step " +
              'after it that the trace also lacks, so pass it only where every Command the flow can still ' +
              'reach goes to a test double or only reads.';
    return replayError(`${what}; refusing to run the real Command. ${why}`, {
        command: step.name,
        index: step.index,
        path: step.path
    });
};

/**
 * @typedef {Object} ReplayOptions
 * @property {any} [context] - Context for `Ask`; defaults to the context a trace recorded.
 * @property {boolean} [fastRetry] - Waits no time between Retry attempts, so a replay does not wait out
 *           production backoff. On by default.
 * @property {boolean} [hooks] - Runs the replay inside the hooks `configureEffect` installed, with the
 *           resolver innermost, so a configured `onStep` observes each replayed step and `onRun` and
 *           `onBeforeCommand` fire. Off by default, which ignores the global hooks, so a replay cannot
 *           reach a telemetry backend or a guardrail that performs I/O.
 * @property {'throw' | 'execute'} [onMissing] - What to do when the resolver has no recording for a step.
 *           `'throw'` (default) fails the replay, which makes side effects impossible for the whole run.
 *           `'execute'` runs the real Command, so pass it only where the Commands reach test doubles or only
 *           read. A trace that dropped entries under `maxEntries` refuses it, since a step it lacks may be one
 *           production ran.
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
 * the only place the difference shows.
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
// `async` so a malformed trace arrives as a rejection rather than a synchronous throw.
const replayEffect = async (effect, traceOrResolver, options = {}) => {
    rejectUnknownOptions(options, 'replayEffect', ['context', 'fastRetry', 'hooks', 'onMissing', 'onResolved']);
    const { fastRetry = true, hooks = false, onMissing = 'throw', onResolved } = options;
    // A trace is data and a Resolver is a function, so nothing else is needed to tell them
    // apart, including the bare entries array that `fromTrace` also accepts.
    const fromResolver = typeof traceOrResolver === 'function';
    /** @type {Set<TraceEntry>} */
    const reached = new Set();
    const { resolve, missing } = fromResolver
        ? { resolve: traceOrResolver, missing: undefined }
        : fromTrace(traceOrResolver, { onEntry: (entry) => void reached.add(entry) });
    // Only a trace log carries metadata; a bare entries array and a Resolver carry none.
    const traceLog = fromResolver || Array.isArray(traceOrResolver) ? undefined : traceOrResolver;
    // Defaults to the trace's context: an `Ask` gate replayed with another one takes another branch, and
    // no paradox flags it.
    const context = options.context ?? traceLog?.context ?? {};
    // A trace capped by `maxEntries` lacks steps production ran, so running a missing step live repeats
    // production's I/O: a billing batch replayed that way charged and invoiced subscriptions again.
    const droppedEntries = Number(traceLog?.dropped) || 0;
    const capped = droppedEntries > 0;
    if (capped && onMissing === 'execute') {
        throw replayError(
            `The trace dropped ${droppedEntries} entries under maxEntries, so a step it lacks may be one ` +
                "production ran, and onMissing: 'execute' would run it again. Replay without it to stop at the " +
                'first missing step, or record the flow with a higher maxEntries.'
        );
    }
    let index = 0;
    // What `onResolved` threw. It stops the replay, which rejects with it, rather than counting as the
    // Command failing, which would let a Retry ask for an attempt production never made. Cast rather than
    // annotated, since only the step runner assigns it.
    let observerFailure = /** @type {{ error: unknown } | undefined} */ (undefined);

    /** @type {StepRunner} */
    const onStep = async (name, type, op, path) => {
        if (type === 'Parallel') {
            // A Parallel's step carries its recorded decision into `op`, where `runBranches` reproduces it.
            // It is not a Command: `index` still counts Commands, and `onResolved` still sees only them.
            const outcome = resolve({ index, name, type, path });
            return await op(outcome && 'result' in outcome ? outcome.result : undefined);
        }
        const step = { index: index++, name, type, path };
        const outcome = resolve(step);
        if (onResolved) {
            try {
                onResolved(step, outcome);
            } catch (error) {
                observerFailure ??= { error };
                throw asHarnessError(new Error('onResolved threw.'));
            }
        }
        if (outcome === undefined) {
            if (onMissing !== 'execute') throw missingStepError(step, missing, droppedEntries);
            return await op();
        }
        if ('error' in outcome) throw outcome.error;
        return outcome.result;
    };

    // With `hooks` off the replay ignores the global wiring, so it reaches no telemetry backend or
    // guardrail. On, the resolver sits innermost and a configured onStep observes each replayed step.
    /** @type {CallConfiguration} */
    const callConfig = { onStep, inherit: hooks };

    // The interpreter rethrows a replay fault so nothing in the flow can absorb it; it becomes a Failure
    // here, where nothing downstream can.
    let result;
    try {
        result = await interpret(effect, context, callConfig, fastRetry);
    } catch (e) {
        if (observerFailure) throw observerFailure.error;
        if (!hasMark(e, replayFault)) throw e;
        result = Failure(e);
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
    rejectUnknownOptions(options, 'timeTravel', ['log', 'context', 'version']);
    const { log = console.log, context, version } = options;
    const { initialInput, trace, flowName, version: traceVersion } = traceLog;
    // `message` is non-enumerable on Error, so JSON.stringify alone would drop it. JSON.stringify throws on
    // a BigInt and on a cycle, and narration must not be what fails a replay.
    const format = (/** @type {any} */ v) => {
        try {
            return JSON.stringify(v instanceof Error ? { ...v, name: v.name, message: v.message } : v, null, 2);
        } catch {
            return String(v);
        }
    };

    if (version && traceVersion && version !== traceVersion) {
        log(`Warning: trace was recorded at ${traceVersion}, replaying against ${version}.`);
    }
    // The flow is rebuilt from this input, and a recorder installed as a hook reads it off the flow, where only
    // effectPipe puts it.
    if (initialInput === undefined) {
        log(
            'Warning: the trace holds no initial input, so the flow is rebuilt from undefined. A recorder ' +
                'installed as a hook finds the input only on a flow built with effectPipe.'
        );
    }
    // A replay tells steps apart by name, so two anonymous Commands that swapped places replay without complaint.
    const anonymous = trace.filter((e) => e.command === 'anonymous').length;
    if (anonymous > 0) {
        log(
            `Warning: ${anonymous} of the recorded steps are named 'anonymous', usually inline arrow Commands, so ` +
                'this replay cannot tell them apart and would not notice two of them trading places. Name them with ' +
                'a const or meta.name.'
        );
    }
    // Parallel decisions are not narrated as steps, so the header counts Commands to match the lines below.
    const commandCount = trace.filter((e) => !isDecisionEntry(e)).length;
    const stepsText = commandCount === 1 ? 'step' : 'steps';
    log(`Replaying '${flowName || 'flow'}' (${commandCount} recorded ${stepsText})`);
    log(`Initial input: ${format(initialInput)}`);

    // Timings are looked up by path, whatever order branches finished in, or by position for a trace
    // with no paths, which is how such a trace is matched anyway.
    const byPath = new Map(trace.filter(hasPath).map((e) => [e.path, e]));
    const timing = (/** @type {ReplayStep} */ step) => {
        const recorded = byPath.get(step.path) ?? trace[step.index];
        return typeof recorded?.durationMs === 'number' ? ` in ${recorded.durationMs}ms` : '';
    };
    const replay = await replayEffect(flowFn(initialInput), traceLog, {
        context: context !== undefined ? context : traceLog.context || {},
        onResolved: (step, outcome) => {
            // A step the trace does not hold is refused or run live by `replayEffect`, not narrated here.
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
    // After a replay error the flow never got past the divergence, and the error already names where it
    // split. Only a flow that ended on its own terms with steps left over is worth a warning. Told by the
    // mark rather than the name, which a flow's own error can share.
    const haltedByReplay = result.type === 'Failure' && hasMark(result.error, replayFault);
    if (unreached.length > 0 && !haltedByReplay) {
        // Named, not just counted: the step a fix stopped issuing is usually the one under suspicion.
        const names = unreached.map((e) => (hasPath(e) ? `${e.command} (path '${e.path}')` : e.command));
        const count = unreached.length === 1 ? '1 recorded step was' : `${unreached.length} recorded steps were`;
        log(`Warning: ${count} never reached: ${names.join(', ')}. The flow diverged.`);
    }
    return result;
};

// #endregion

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
    timeTravel,
    commandName
};
