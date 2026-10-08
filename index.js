// @ts-check

// Contents. Each section is a `#region`, so an editor can fold it.
//
// 1. Types: the JSDoc shapes of the nodes a flow is made of.
// 2. Building flows: the constructors; the checks, error messages and kinds of failure the later sections
//    share, `checkOptions` and `Retry`'s defaults among them; and `effectPipe`, with the `chain` that joins its
//    steps and the `flowInputs` it records for `onRun`.
// 3. Configuration: the hook types and their defaults, `configureEffect` and its layers, and `chainHooks`, which
//    merges them.
// 4. Running flows: the helpers `Retry` and `Parallel` run on; `interpret`, which builds a run's `Runtime`, then
//    `execute` and a function for each kind of node, which each take it; and `runEffect`.
// 5. Recording and replay: the trace format and replay errors, copying values and errors into a trace,
//    `recorder` and `recordEffect`, then `fromTrace`, `replayEffect` and `timeTravel`.
//
// A new definition goes in the section it serves, which is usually the one that calls it. DESIGN.md explains why
// each part works the way it does.

// #region Types

/** @typedef {{ type: 'Success', value: any }} SuccessState */
/** @typedef {{ type: 'Failure', error: any }} FailureState */
/**
 * Metadata attached to a Command. A string `name` is the Command's identity; every other key is carried through
 * for `onBeforeCommand`.
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
 * Every node a flow can be made of.
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
 * Represents a failed computation. Stops the pipeline.
 * @param {any} error - The error reason (string, Error object, etc).
 * @returns {FailureState}
 */
const Failure = (error) => ({ type: 'Failure', error });

/**
 * Represents a side effect to be executed later.
 *
 * @param {(signal?: AbortSignal) => Promise<any>|any} cmd - The function that does the I/O. Inside a `Parallel`, a
 *        function that declares a parameter receives an `AbortSignal` that fires when a sibling branch fails. A
 *        parameter with a default value does not count, so `nanoid(size = 21)` keeps its default.
 * @param {(result: any) => Effect} [next] - Receives the result of `cmd`. Defaults to `Success(result)`; `null`
 *        counts as omitted.
 * @param {CommandMeta} [meta] - Passed to `onBeforeCommand`. A string `meta.name` is the Command's identity.
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
 * The name a Command is known by in traces, replay matching and telemetry: a non-empty string `meta.name`, else
 * `cmd.name`, else 'anonymous'. Exported so a test walking a flow uses the same rule.
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
 * Runs `effect` again when a Command in it throws.
 *
 * Each attempt runs the **entire** wrapped tree again, including Commands that already succeeded, so wrap the one
 * Command that fails transiently. `Retry(effectPipe(charge, receipt))` charges the customer again every time the
 * receipt step fails.
 *
 * @param {Effect} effect - The inner Effect tree to retry
 * @param {Object} [options] - Merged over the defaults when it runs; an option set to `undefined` keeps its default.
 * @param {number} [options.attempts] - Retries after the first try, a positive integer
 * @param {number} [options.delay] - Ms before the first retry, a finite number of 0 or more
 * @param {number} [options.backoff] - Multiplier applied to the delay on each later retry, a finite number of 0 or
 *        more
 * @param {(error: any) => Effect} [options.onExhausted] - Builds a fallback from `{ retryExhausted, lastError,
 *        attempts }` once every attempt has failed. Its success feeds `next`; its failure propagates unwrapped.
 * @returns {RetryState}
 */
const Retry = (effect, options) => {
    if (!isEffect(effect)) throw malformed(`Retry expects the Effect to run, got ${describeValue(effect)}.`, effect);
    if (options != null && !isOptionsObject(options)) {
        const hint = typeof options === 'number' ? `: write Retry(effect, { attempts: ${options} })` : '';
        throw malformed(`Retry's options must be an object, got ${describeArgument(options)}${hint}.`, options);
    }
    checkOptions(options, 'Retry', retryOptionRules, malformed);
    return { type: 'Retry', effect, options: options ?? {}, next: (value) => Success(value) };
};

/**
 * Runs Effect trees at the same time. The first branch to fail cancels the others, and its Failure is the result.
 * A cancelled branch starts no further Commands, but one already in flight stops only if its function passes on
 * the `AbortSignal` it receives.
 *
 * `settled: true` runs every branch to completion and hands `next` each outcome as a `Success` or `Failure`.
 * `limit: n` keeps at most `n` branches in flight. Results and paths follow array order either way.
 *
 * The second argument is `next` or the options, whichever it looks like. `undefined` or `null` there is a skipped
 * `next`, so options passed third still count.
 *
 * @param {Effect[]} effects - Array of Effect trees to run concurrently
 * @param {((values: any[]) => Effect) | ParallelOptions | null} [nextOrOptions] - Receives the success values in
 *        order, and defaults to `Success(values)`; or the options.
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
    const nextSkipped = nextOrOptions == null;
    const optionsSecond = !hasNext && !nextSkipped;
    if (optionsSecond && !isOptionsObject(nextOrOptions)) {
        const got = describeArgument(nextOrOptions);
        throw malformed(`Parallel's second argument must be next or the options, got ${got}.`, nextOrOptions);
    }
    // Nothing would read a third argument after the options.
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
    checkOptions(options, 'Parallel', parallelOptionRules, malformed);
    return {
        type: 'Parallel',
        effects,
        next: hasNext ? nextOrOptions : (/** @type {any[]} */ values) => Success(values),
        options: options ?? {}
    };
};

/**
 * Whether a value is an object: not `null`, a primitive, or a function.
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
 * @param {any} value
 * @returns {boolean}
 */
const isBoolean = (value) => typeof value === 'boolean';

/**
 * @param {any} value
 * @returns {boolean}
 */
const isFunction = (value) => typeof value === 'function';

/**
 * An object that can hold options or meta: not an array, and not an Effect passed in the wrong place.
 * @param {any} value
 * @returns {boolean}
 */
const isOptionsObject = (value) => isObject(value) && !Array.isArray(value) && !isEffect(value);

/**
 * Refuses an option name the function does not read, such as p-limit's `concurrency` passed to `Parallel`.
 * @param {any} options
 * @param {string} source - The function that takes them, as the message names it
 * @param {string[]} known
 * @param {(message: string, value: any) => Error} [raise] - Builds the error; a constructor's are EffectTypeErrors
 */
const rejectUnknownOptions = (options, source, known, raise = (message) => new TypeError(message)) => {
    const name = isObject(options) ? Object.keys(options).find((key) => !known.includes(key)) : undefined;
    if (name !== undefined) {
        const list = `${known.slice(0, -1).join(', ')} and ${known[known.length - 1]}`;
        throw raise(`${source} has no option named '${name}'; its options are ${list}.`, options);
    }
};

/**
 * An option's rule: a test its value has to pass, the words for what passes, and advice for the message. `null`
 * for an option that takes any value.
 * @typedef {[(value: any) => boolean, string, string?] | null} OptionRule
 */

/**
 * Refuses an option name the function does not read, and a value it cannot use. An option set to `undefined` keeps
 * its default.
 * @param {any} options
 * @param {string} source - The function that takes them, as the message names it
 * @param {Record<string, OptionRule>} rules - Every option the function reads, in the order a message lists them
 * @param {(message: string, value: any) => Error} [raise] - Builds the error; a constructor's are EffectTypeErrors
 */
const checkOptions = (options, source, rules, raise = (message) => new TypeError(message)) => {
    rejectUnknownOptions(options, source, Object.keys(rules), raise);
    if (!isObject(options)) return;
    for (const [name, rule] of Object.entries(rules)) {
        const value = options[name];
        if (rule === null || value === undefined || rule[0](value)) continue;
        const [, takes, advice] = rule;
        const message = `${source} '${name}' must be ${takes}, received ${describeArgument(value)}.`;
        throw raise(advice ? `${message} ${advice}` : message, value);
    }
};

/** What `Retry` uses for an option left out or set to `undefined`. */
const defaultRetryOptions = { attempts: 3, delay: 100, backoff: 1 };

/**
 * Checked when the Retry is built and again when it runs, since a caller can change the options object in between.
 * @type {Record<string, OptionRule>}
 */
const retryOptionRules = {
    // Not 0, which would make `onExhausted` a catch.
    attempts: [
        isPositiveInteger,
        'a positive integer',
        "To handle an outcome without retrying, branch on it as data in the Command's next, or isolate a failing " +
            "branch with Parallel's settled option."
    ],
    delay: [isFiniteNonNegative, 'a finite number of 0 or more'],
    backoff: [isFiniteNonNegative, 'a finite number of 0 or more'],
    onExhausted: [isFunction, 'a function that returns the fallback']
};

/**
 * Checked when the Parallel is built and again when it runs, as `Retry`'s are.
 * @type {Record<string, OptionRule>}
 */
const parallelOptionRules = {
    limit: [isPositiveInteger, 'a positive integer'],
    settled: [isBoolean, 'true or false']
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
    // `String` for the rest, since JSON prints NaN as null and throws on a BigInt.
    if (typeof value !== 'object') {
        return `the ${typeof value} ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
    }
    if (Array.isArray(value)) return 'an array';
    if (typeof value.type === 'string') return `an object with an unrecognised type '${value.type}'`;
    return 'a plain object';
};

/**
 * Describes a constructor's argument for an error message. A missing one is usually a misspelt name rather than a
 * missing return, and an Effect in the wrong place is named by its type.
 * @param {any} value
 * @returns {string}
 */
const describeArgument = (value) =>
    value === undefined ? 'undefined' : isEffect(value) ? `an Effect of type '${value.type}'` : describeValue(value);

/**
 * Marks an error as the harness failing rather than the flow: a malformed flow, or a trace that cannot answer a
 * step. The interpreter rethrows it rather than folding it into a `Failure`, so nothing that handles a domain
 * failure can absorb it. A new kind of harness error gets this mark, not a name to match on. Non-enumerable, so it
 * stays out of a serialized error and a `deepEqual`.
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
 * An I/O fault: a Command's function threw, or a `Retry` ran out of attempts. It is what `Retry` retries, unlike a
 * `Failure` a step returned. Only `execute` and its per-node functions return one, and `asOutcome` turns it into a
 * plain `Failure` before it reaches user code.
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
 * Builds an `EffectTypeError`, the harness error for a malformed flow or a constructor argument it cannot use.
 *
 * @param {string} message
 * @param {any} value - The malformed value
 * @returns {Error}
 */
const malformed = (message, value) => {
    // The error reports the bug, so the rejection must not also crash the process as unhandled. Only a native
    // Promise: calling `then` on a Knex or Mongoose query builder runs the query.
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
 * Connects an Effect to the next function in the pipeline: a Success passes its value on, a Failure stops, and
 * every other node gets a `next` that continues into `fn`.
 *
 * @param {Effect} effect - The current Effect object
 * @param {(value: any) => Effect} fn - The next function to run if the current effect is a Success
 * @param {Effect} [from] - The node whose `next` returned `effect`, which an error names
 * @returns {Effect} The composed Effect
 */
const chain = (effect, fn, from) => {
    const source = () => (from ? nextOf(from) : 'A continuation');

    // Before reading `.type`, so a missing return is named rather than thrown as a bare TypeError.
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
 * The input each flow `effectPipe` built was called with, keyed on the flow's root, for `interpret` to hand `onRun`.
 * Kept off the flow, so no node or outcome carries it.
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
        // Keyed on a copy, since the last step can return an object other flows share, such as a constant Failure.
        const root = { ...tree };
        flowInputs.set(root, start);
        return root;
    };
};

// #endregion
// #region Configuration

/**
 * Wraps one Command, or one Parallel, whose `op` runs the branches and returns the decision, so a hook must call it.
 * Only a replay passes `op` an argument, the recorded decision. `path` is the step's position in the Effect tree.
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

/**
 * Refuses the removed `retry` key rather than ignoring it. Migration scaffolding: remove at 1.0.
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
 * Describes what was passed where a configuration belongs. A function there is usually one that builds hooks, as
 * `telemetryHooks` does, passed without calling it.
 * @param {any} value
 * @returns {string}
 */
const describeConfiguration = (value) =>
    typeof value === 'function'
        ? 'a function, which usually means one that builds hooks was passed without being called'
        : describeArgument(value);

/**
 * Refuses a key no hook has, such as a misspelt `onstep`, and a hook that is not a function. Only `undefined`
 * leaves a hook unset.
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
 * @property {RunWrapper} [onRun] - Wraps a whole run once, and is handed the flow's input when `effectPipe` built it.
 * @property {CommandInterceptor} [onBeforeCommand] - Runs before each Command; a throw vetoes it.
 */

/**
 * A per-call configuration. With `inherit: true` (the default) its hooks merge over the installed wiring, global
 * outermost; with `inherit: false` that wiring is ignored.
 *
 * @typedef {EffectConfiguration & { inherit?: boolean }} CallConfiguration
 */

/** @type {EffectConfiguration[]} */
let layers = [];

/**
 * The installed layers merged into one configuration. A slot no layer defines is absent, and `interpret` picks the
 * library default for it.
 * @type {EffectConfiguration}
 */
let globalConfig = {};

/** Recomputes the effective wiring from the installed layers, earlier layers outermost. */
const applyLayers = () => {
    globalConfig = chainHooks(...layers);
};

/**
 * Adds a layer of global hooks and returns a function that removes it, wherever it sits by then. Layers merge as
 * configurations passed to one call do, so these are the same:
 *
 *     configureEffect(telemetryHooks(), recordingHooks({ sink }));
 *     configureEffect(telemetryHooks()); configureEffect(recordingHooks({ sink }));
 *
 * A call with no arguments removes every layer. A call whose arguments are all `undefined`, as in
 * `configureEffect(flag ? hooks : undefined)`, adds and removes nothing.
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
 * Merges configurations into one, the first given outermost. `onStep` and `onRun` nest around `op`, and
 * `onBeforeCommand` interceptors run in order, the first to throw vetoing the Command. A hook no configuration
 * defines is left unset.
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
 * The Failure a cancelled `Parallel` branch stops with, named so it is never mistaken for the failure that
 * triggered the cancellation.
 * @returns {FailureState}
 */
const cancelledBranch = () =>
    Failure(Object.assign(new Error('Parallel branch cancelled.'), { name: 'ParallelCancelled' }));

/**
 * Which branch, if any, cancelled a Parallel; `branch: null` means an enclosing Parallel did. Timing decides it, so
 * it is recorded as the Parallel's own step for a replay to hand back.
 * @typedef {{ cancelled: false } | { cancelled: true, branch: number | null }} ParallelDecision
 */

/**
 * What running a Parallel's branches produced: each branch's outcome in array order, the decision, and the first
 * error a branch threw, which the Parallel rethrows once its step has returned the decision.
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
 * Reads a recorded decision, or `undefined` for anything that is not one, which replays the Parallel by timing.
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
 * Marks a step a replay reached that production never ran, in a branch a recorded decision cancelled. Only
 * `fromTrace` raises it, and `runCommand` and `runParallel` catch it and stop the branch there, as production did.
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
 * Awaits every task, with at most `limit` in flight. Workers pull by index, so results land where the caller put
 * the effect rather than where it finished, which keeps trace paths stable.
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
 * Sleeps, but stops early when the branch is cancelled. Resolves either way; the caller's abort check turns a
 * cancelled wait into a Failure.
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
        // A listener added to an aborted signal never runs, and a Retry often backs off on a signal that has already
        // fired.
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

/**
 * What every part of the interpreter needs from one run: the context `Ask` reads, whether retries wait, and the two
 * hooks a step calls, resolved from the installed wiring and the call's own configuration.
 * @typedef {{
 *   context: any,
 *   fastRetry: boolean,
 *   onStep: StepRunner,
 *   onBeforeCommand: CommandInterceptor
 * }} Runtime
 */

/**
 * The interpreter, which `runEffect` and `replayEffect` share, so a replay cannot drift from a run. Only a replay
 * sets `fastRetry`, which waits no time between retry attempts.
 *
 * @param {Effect} effect
 * @param {any} [context]
 * @param {CallConfiguration} [callConfig]
 * @param {boolean} [fastRetry]
 * @returns {Promise<SuccessState | FailureState>}
 */
const interpret = async (effect, context = {}, callConfig = {}, fastRetry = false) => {
    if (!isOptionsObject(callConfig)) {
        throw new TypeError(`runEffect's callConfig must be an object, got ${describeConfiguration(callConfig)}.`);
    }
    checkConfiguration(callConfig, "runEffect's callConfig", 'callConfig.', [...hookNames, 'inherit']);
    const { inherit = true, ...local } = callConfig;
    // Not coerced, so `'false'` cannot inherit everything.
    if (typeof inherit !== 'boolean') {
        throw new TypeError(`callConfig.inherit must be true or false, got ${JSON.stringify(inherit)}.`);
    }
    const base = inherit ? globalConfig : {};
    const resolved = Object.keys(local).length ? chainHooks(base, local) : base;
    /** @type {Runtime} */
    const runtime = {
        context,
        fastRetry,
        onStep: resolved.onStep || defaultStepRunner,
        onBeforeCommand: resolved.onBeforeCommand || defaultCommandInterceptor
    };
    const onRun = resolved.onRun || defaultRunWrapper;
    // An I/O fault becomes a plain Failure here, where every outcome leaves.
    const op = async () => asOutcome(await execute(runtime, effect));
    return onRun(effect, op, context?.flowName || '', flowInputs.get(effect));
};

/**
 * Walks a subtree until it reaches a Success, a Failure or an I/O fault. Every node but `Ask` runs in its
 * own function, which returns a Success carrying the value for the node's `next`, or what stops the subtree.
 *
 * @param {Runtime} runtime
 * @param {Effect} eff
 * @param {AbortSignal} [signal] - Cancellation for this subtree, set for `Parallel` branches.
 * @param {string} [path] - This subtree's prefix. Each `Parallel` branch and `Retry` attempt opens its own, so
 *        a path depends only on the tree's shape, never on the order branches finish in.
 * @returns {Promise<SuccessState | FailureState | IoFaultState>}
 */
const execute = async (runtime, eff, signal, path = '') => {
    let step = 0;
    /** @type {Effect | undefined} The node whose `next` returned `eff`, which an error names. */
    let from;
    while (isPending(eff)) {
        // A Command already in flight cannot be stopped, but the next one never starts.
        if (signal?.aborted) return cancelledBranch();
        if (eff.type === 'Ask') {
            from = eff;
            eff = eff.next(runtime.context);
            continue;
        }
        const stepPath = `${path}${step++}`;
        const outcome =
            eff.type === 'Retry'
                ? await runRetry(runtime, eff, signal, stepPath)
                : eff.type === 'Parallel'
                  ? await runParallel(runtime, eff, signal, stepPath)
                  : await runCommand(runtime, eff, signal, stepPath);
        if (outcome.type !== 'Success') return outcome;
        // Outside every catch: `next` and the pure steps it reaches are code, not I/O, so a throw there
        // rejects the run.
        from = eff;
        eff = eff.next(outcome.value);
    }
    if (isOutcome(eff)) return eff;
    throw effectTypeError(eff, from ? nextOf(from) : 'The flow');
};

/**
 * Runs a Retry's wrapped tree until it succeeds or runs out of attempts, then its fallback if it has one.
 * Each attempt opens its own path prefix, and so does the fallback.
 *
 * @param {Runtime} runtime
 * @param {RetryState} retry
 * @param {AbortSignal | undefined} signal
 * @param {string} stepPath
 * @returns {Promise<SuccessState | FailureState | IoFaultState>}
 */
const runRetry = async (runtime, retry, signal, stepPath) => {
    checkOptions(retry.options, 'Retry', retryOptionRules, malformed);
    const given = Object.entries(retry.options ?? {}).filter(([, value]) => value !== undefined);
    const opts = /** @type {typeof defaultRetryOptions & RetryState['options']} */ ({
        ...defaultRetryOptions,
        ...Object.fromEntries(given)
    });
    const { attempts, onExhausted } = opts;
    let lastError;
    for (let attempt = 0; attempt <= attempts; attempt++) {
        // `fastRetry` waits for no time rather than skipping the wait, so branches replayed by timing still
        // interleave.
        if (attempt > 0) {
            await delayFor(runtime.fastRetry ? 0 : opts.delay * Math.pow(opts.backoff, attempt - 1), signal);
        }
        // After the wait, so a branch cancelled mid-backoff makes no further attempt.
        if (signal?.aborted) return cancelledBranch();
        const result = await execute(runtime, retry.effect, signal, `${stepPath}r${attempt}/`);
        // Only an I/O fault is retried. An abort passes through unwrapped.
        if (result.type !== 'IoFault') return result;
        lastError = result.error;
    }
    const exhausted = { retryExhausted: true, lastError, attempts };
    // A fault too, so an enclosing Retry retries this one.
    if (typeof onExhausted !== 'function') return IoFault(exhausted);
    if (signal?.aborted) return cancelledBranch();
    // A failing fallback propagates as it is, not wrapped as another exhaustion.
    return execute(runtime, asEffect(onExhausted(exhausted), "Retry option 'onExhausted'"), signal, `${stepPath}rf/`);
};

/**
 * Runs a Parallel as one step, whose `op` runs the branches and returns the decision, so the decision is
 * recorded and a replay can hand it back.
 *
 * @param {Runtime} runtime
 * @param {ParallelState} parallel
 * @param {AbortSignal | undefined} signal
 * @param {string} stepPath
 * @returns {Promise<SuccessState | FailureState | IoFaultState>}
 */
const runParallel = async (runtime, parallel, signal, stepPath) => {
    const branchPath = `${stepPath}p`;
    const options = parallel.options ?? {};
    checkOptions(options, 'Parallel', parallelOptionRules, malformed);
    const { settled } = options;
    // Cast rather than annotated, since only `op` assigns it.
    let branchRun = /** @type {BranchRun | undefined} */ (undefined);
    // A replay passes the recorded decision, from `replayEffect`'s onStep; a live run passes nothing.
    const op = async (/** @type {any} */ recorded) => {
        branchRun = await runBranches(runtime, parallel.effects, options, signal, branchPath, recorded);
        return branchRun.decision;
    };
    try {
        await runtime.onStep('Parallel', 'Parallel', op, branchPath);
    } catch (e) {
        // A cut from `fromTrace`: production had already stopped the branch this Parallel is in.
        if (hasMark(e, replayCut)) return cancelledBranch();
        throw e;
    }
    if (!branchRun) {
        throw new TypeError(
            `An onStep hook returned without letting op run the Parallel at path '${branchPath}'. ` +
                'A hook has to call op for a Parallel and pass on what it returns or throws, because op ' +
                'runs its branches.'
        );
    }
    const { results, decision, thrown } = branchRun;
    // Rethrown only now, after the step has returned its decision, so the decision is recorded.
    if (thrown) throw thrown.error;
    if (settled) return Success(results.map(asOutcome));
    const failure =
        decision.cancelled && decision.branch !== null
            ? results[decision.branch]
            : results.find((r) => r.type !== 'Success');
    if (failure) return failure;
    return Success(results.map((r) => /** @type {SuccessState} */ (r).value));
};

/**
 * Runs a Parallel's branches and decides which branch, if any, cancelled the others. Live, timing decides.
 * A recorded cancellation is reproduced rather than recomputed: no branch cancels another, each stops where
 * its recording stops, and the recorded branch's failure is the result.
 *
 * @param {Runtime} runtime
 * @param {Effect[]} effects
 * @param {ParallelOptions} options
 * @param {AbortSignal | undefined} signal - The enclosing Parallel's cancellation, if any
 * @param {string} branchPath
 * @param {any} recorded - The recorded decision, which `replayEffect`'s onStep passes to the Parallel's
 *        `op`; undefined in a live run
 * @returns {Promise<BranchRun>}
 */
const runBranches = async (runtime, effects, options, signal, branchPath, recorded) => {
    const { limit, settled } = options;
    // A recorded branch past the end means the flow changed shape. A negative one is not a decision, and
    // replays by timing.
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
    // Live, a throw cancels the others, and so does a failure unless `settled`. Reproducing, nothing does,
    // since the recording already says where each branch stops.
    const { results, thrown, trigger, cancelled } = await settleBranches(
        runtime,
        effects,
        limit,
        signal,
        branchPath,
        reproducing ? () => false : (threw, result) => threw || (!settled && result.type !== 'Success')
    );
    if (reproducing) {
        // A branch that threw has no result to check, and its throw is what is rethrown.
        const recordedTriggerSucceeded = !thrown && forced.branch !== null && results[forced.branch].type === 'Success';
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
};

/**
 * Runs every branch to completion, at most `limit` at once, under one cancellation scope linked to the
 * enclosing one. The first branch to settle in a way `cancelsOthers` accepts cancels the rest, and is the
 * trigger.
 *
 * @param {Runtime} runtime
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
const settleBranches = async (runtime, effects, limit, signal, branchPath, cancelsOthers) => {
    const { scope, unlink } = linkedScope(signal);
    /** @type {(SuccessState | FailureState | IoFaultState)[]} */
    const results = new Array(effects.length);
    // Held rather than rethrown, so every branch still settles and no `limit` worker stops early.
    /** @type {{ error: unknown }[]} */
    const thrown = new Array(effects.length);
    // Whether each branch cancelled the others itself, rather than being cancelled.
    const triggered = new Array(effects.length).fill(false);
    const settle = async (/** @type {Effect} */ branch, /** @type {number} */ i) => {
        try {
            results[i] = await execute(runtime, branch, scope?.signal, `${branchPath}${i}/`);
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
        // Awaits every branch, so no cancelled work runs on after the Parallel returns.
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
};

/**
 * Runs one Command. A throw from an interceptor vetoes the Command, an abort; a throw from its function is an
 * I/O fault. A harness error is rethrown from either. DESIGN.md's "Where a throw comes from" has the rest.
 *
 * @param {Runtime} runtime
 * @param {CommandState} command
 * @param {AbortSignal | undefined} signal
 * @param {string} cmdPath
 * @returns {Promise<SuccessState | FailureState | IoFaultState>}
 */
const runCommand = async (runtime, command, signal, cmdPath) => {
    const cmdName = commandName(command);
    const { cmd } = command;
    // Whether the function itself succeeded: a hook that throws after that is a bug, not an I/O fault.
    let succeeded = false;
    // What it returned, so a hook that loses it is caught.
    /** @type {unknown} */
    let value;
    // Only inside a Parallel, and only to a function that declares a parameter. A parameter with a default
    // value does not count toward `length`, so `nanoid(size = 21)` keeps its default; a plain first parameter
    // the function treats as optional still takes the signal, a documented sharp edge.
    const takesSignal = signal !== undefined && cmd.length > 0;
    // Async, so a hook always gets a promise. The latest call is kept, with whether it is still running, to
    // catch a hook that does not wait for it.
    /** @type {Promise<unknown> | undefined} */
    let latestCall;
    let running = false;
    const callCmd = async () => {
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
    const op = () => (latestCall = callCmd());
    try {
        await runtime.onBeforeCommand(command, runtime.context);
    } catch (e) {
        if (hasMark(e, harnessError)) throw e;
        return Failure(e);
    }
    // Again, since an interceptor can wait (a rate limiter, say) while a sibling fails.
    if (signal?.aborted) return cancelledBranch();
    let returned;
    let unwaited = false;
    try {
        returned = await runtime.onStep(cmdName, 'Command', op, cmdPath);
        // A hook that returned without awaiting `op` is judged as though it had awaited it.
        if (returned === undefined && running) {
            unwaited = true;
            await latestCall;
        }
    } catch (e) {
        // A cut from `fromTrace`: production stopped this branch before this step.
        if (hasMark(e, replayCut)) return cancelledBranch();
        if (hasMark(e, harnessError)) throw e;
        // After the function succeeded, a throw is a bug in a hook. From a hook that never called `op` it is a
        // fault, which is how replay reports a recorded error.
        if (succeeded) throw e;
        return IoFault(e);
    }
    // A hook that dropped the result would hand `next` `undefined`. Only `undefined` is refused, so a hook can
    // return a copy.
    if (returned === undefined && succeeded && value !== undefined) {
        throw new TypeError(
            `An onStep hook called op for '${cmdName}' at path '${cmdPath}' and returned undefined` +
                `${unwaited ? ' before op had finished' : ''}, although the Command returned a value. ` +
                'A hook has to await op() and return what it returns.'
        );
    }
    return Success(returned);
};

/**
 * Runs a flow: executes its Commands, resolving `Ask` with the context and running `Retry` and `Parallel`. `onRun`
 * fires once per call, around every Retry attempt.
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
 * The step a replay is asking about. `path` is its position in the Effect tree, stable across runs; `index` is its
 * position in completion order, which is not stable for a flow with a `Parallel`. A step whose `type` is 'Parallel'
 * asks for the recorded decision and does not advance `index`; an answer that holds no decision replays that
 * Parallel by timing.
 * @typedef {{ index: number, name: string, type: string, path?: string }} ReplayStep
 */

/**
 * What production observed for a step. `{ result }` is handed to the Command's `next`; `{ error }` is thrown. A
 * Resolver returning `undefined` means "not recorded". Any other answer, `null` included, or a throw from the
 * Resolver, rejects the replay.
 *
 * @typedef {{ result: any } | { error: any }} ReplayOutcome
 */

/**
 * Whether a Resolver's answer is an outcome: an object holding `result` or `error`.
 * @param {any} value
 * @returns {boolean}
 */
const isReplayOutcome = (value) => isObject(value) && ('result' in value || 'error' in value);

/** @typedef {(step: ReplayStep) => ReplayOutcome | undefined} Resolver */

/**
 * A recorded step: a Command's result or error, or a Parallel's decision, recorded as `command` 'Parallel' at the
 * Parallel's own path. `threw` marks a throw, since JSON drops an `error` key whose value is `undefined`.
 * `unrecorded` says why the entry holds no value. `durationMs` is rounded to microseconds.
 * @typedef {{
 *   command: string,
 *   path?: string,
 *   result?: any,
 *   threw?: true,
 *   error?: any,
 *   unrecorded?: UnrecordedCause,
 *   durationMs?: number
 * }} TraceEntry
 */

/**
 * The reference trace format produced by `recorder`. A convenience, not a contract: `replayEffect` takes a Resolver,
 * so any storage shape works. `unrecorded` says why the trace holds no `initialInput` or `context`.
 * @typedef {{
 *   flowName?: string,
 *   version?: string,
 *   initialInput?: any,
 *   context?: any,
 *   unrecorded?: { initialInput?: UnrecordedCause, context?: UnrecordedCause },
 *   dropped?: number,
 *   trace: TraceEntry[]
 * }} TraceLog
 */

/**
 * Marks a replay fault: the trace cannot answer the flow, or disagrees with it. `replayEffect` turns one into a
 * `Failure` at its own boundary. An `EffectTypeError` has no such mark and keeps propagating, since a malformed flow
 * is a bug in the flow rather than in the trace.
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
 * Builds a `TimeParadox`: the flow no longer matches its recording at this point.
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
 * Converts a thrown value into something JSON can carry, including the non-enumerable `message`, `stack` and
 * `cause` a plain `JSON.stringify` would drop.
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
    // A chain that loops back is cut where it returns, with the name and message only. Only ancestors count, so an
    // error that merely appears twice is carried in full both times.
    if (ancestors.has(e)) return out;
    ancestors.add(e);
    if (withStack) out.stack = e.stack;
    if ('cause' in e) out.cause = serializeError(e.cause, withStack, ancestors);
    // An AggregateError's hidden `errors` goes under its own key, so revival can tell it from an enumerable `errors`,
    // which is data and is copied below as it is.
    const errors = /** @type {any} */ (e).errors;
    const hasHiddenErrors = Array.isArray(errors) && !Object.prototype.propertyIsEnumerable.call(e, 'errors');
    if (hasHiddenErrors) {
        out.__errors = errors.map((x) => serializeError(x, withStack, ancestors));
    }
    ancestors.delete(e);
    // An assigned `name`, `message` or `cause` is enumerable. It is carried above already, so it is only listed, for
    // revival to restore as it was.
    const shown = carriedKeys.filter((k) => Object.prototype.propertyIsEnumerable.call(e, k));
    if (shown.length > 0) out.__enumerable = shown;
    for (const k of Object.keys(e)) if (!carriedKeys.includes(k)) out[k] = /** @type {any} */ (e)[k];
    return out;
};

/**
 * Rebuilds an Error from `serializeError` output. Non-Error values pass through, so a Command that rejected with a
 * string still replays as a string.
 * @param {any} v - A serialized error, or any other recorded value
 * @returns {any}
 */
const reviveError = (v) => {
    if (!isObject(v) || v.__error !== true) return v;
    const e = new Error(v.message);
    // `name`, `message`, `cause` and `errors` get the enumerability the original had, so a revived error deep-equals
    // the one the Command threw.
    const shown = Array.isArray(v.__enumerable) ? v.__enumerable : [];
    const restore = (/** @type {string} */ key, /** @type {any} */ value) =>
        Object.defineProperty(e, key, { enumerable: shown.includes(key), configurable: true, writable: true, value });
    restore('name', v.name);
    if (shown.includes('message')) restore('message', v.message);
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
 * @property {(value: any, name: string, kind: string) => any} [redact] - Scrubs every value a trace holds. `kind` is
 *           `'result'`, `'error'`, `'initialInput'` or `'context'`, and `name` is the Command's name for the first
 *           two and the kind for the others. It is handed a copy; a value it throws on is left out and marked.
 * @property {number} [maxEntries] - Caps trace length; further steps are counted in `dropped`, not stored.
 * @property {boolean} [stack] - Records stack traces for thrown errors.
 */

/** @type {Record<string, OptionRule>} */
const recorderOptionRules = {
    redact: [isFunction, 'a function'],
    maxEntries: [(value) => value === Infinity || isPositiveInteger(value), 'a positive integer or Infinity'],
    stack: [isBoolean, 'true or false']
};

/**
 * Why the recorder stored nothing for a value: `redact` threw on it, or copying it threw. It stores nothing rather
 * than a stand-in, since a stand-in would replay as what production saw.
 * @typedef {'redact' | 'copy'} UnrecordedCause
 */

/**
 * What recording a value produced: the value the trace stores, or why it stores none.
 * @typedef {{ value: any } | { unrecorded: UnrecordedCause }} Recorded
 */

/**
 * Runs one of the two parts of recording that can throw, `redact` or the copy, and names the one that threw. Every
 * read of the caller's value, and of what `redact` returns, goes through here. Nothing else in the recorder may
 * throw: a throw while a Command's error was being recorded would replace that error, and `Retry` would retry it.
 * @param {UnrecordedCause} cause
 * @param {() => any} compute
 * @returns {Recorded}
 */
const recordPart = (cause, compute) => {
    try {
        return { value: compute() };
    } catch {
        return { unrecorded: cause };
    }
};

/**
 * @typedef {Object} TraceMeta
 * @property {any} [initialInput] - The value the flow was called with.
 * @property {string} [flowName]
 * @property {any} [context] - Context passed to `runEffect`; required to replay `Ask`.
 * @property {string} [version] - Commit or build id, so a replay can detect a stale trace.
 */

/**
 * Copies a value through JSON, the one form a trace has, on its way into a trace and on its way out in a replay, so a
 * replay from memory hands the flow what one from storage does. Throws on a value JSON cannot encode, such as a
 * BigInt; `undefined` and a function come back as `undefined`.
 *
 * @param {any} value
 * @returns {any}
 */
const snapshot = (value) => {
    // A reference back to an enclosing object is cut, so a request and a response that point at each other can still
    // be recorded. An object shared without a loop is kept.
    /** @type {object[]} */
    const ancestors = [];
    const json = JSON.stringify(value, function (key, item) {
        if (!isObject(item)) return item;
        // `this` is the object holding `item`, so popping back to it leaves only `item`'s ancestors.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(item)) return undefined;
        ancestors.push(item);
        return item;
    });
    return json === undefined ? undefined : JSON.parse(json);
};

const now = () => (typeof performance === 'object' ? performance.now() : Date.now());

/**
 * Builds an `onStep` hook that records every Command's result or error and every Parallel's decision, and `toTrace`,
 * which packages them. Give each run its own recorder: one installed for a whole application mixes runs into a trace
 * a replay refuses. examples/recording-example.js shows how.
 *
 * @param {RecorderOptions} [options] - Redaction and size limits
 * @returns {{ onStep: StepRunner, entries: TraceEntry[], toTrace: (meta?: TraceMeta) => TraceLog }}
 */
const recorder = (options = {}) => {
    checkOptions(options, 'recorder', recorderOptionRules);
    const { redact = (/** @type {any} */ r) => r, maxEntries = Infinity, stack = false } = options;
    /** @type {TraceEntry[]} */
    const entries = [];
    let dropped = 0;

    const push = (/** @type {TraceEntry} */ entry) => {
        if (entries.length < maxEntries) entries.push(entry);
        else dropped++;
    };

    /**
     * Copies a value for the trace and redacts the copy, for a step's result or one of the trace's own fields.
     * @returns {Recorded}
     */
    const copyAndRedact = (/** @type {any} */ value, /** @type {string} */ name, /** @type {string} */ kind) => {
        const copied = recordPart('copy', () => snapshot(value));
        if ('unrecorded' in copied) return copied;
        // What redact returns is copied too, so it reads the same from memory as from storage.
        return recordPart('redact', () => snapshot(redact(copied.value, name, kind)));
    };

    /**
     * Copies a thrown value's serialized form and redacts the copy. An Error stays marked as one when `redact` returns
     * an object without the mark, so a replay still throws an Error.
     * @returns {Recorded}
     */
    const recordError = (/** @type {any} */ thrown, /** @type {string} */ name) => {
        // Read inside the copy, since it reads the caller's value, and before `redact` can change the copy.
        const copied = recordPart('copy', () => {
            const copy = snapshot(serializeError(thrown, stack));
            return { copy, wasError: isObject(copy) && copy.__error === true };
        });
        if ('unrecorded' in copied) return copied;
        const { copy: serialized, wasError } = copied.value;
        return recordPart('redact', () => {
            const redacted = snapshot(redact(serialized, name, 'error'));
            const rebuilt = wasError && isObject(redacted) && !Array.isArray(redacted) && redacted.__error !== true;
            return rebuilt ? { __error: true, ...redacted } : redacted;
        });
    };

    /**
     * Records each step it wraps and changes nothing about it: `op` runs, its result is returned, and its error
     * propagates.
     * @type {StepRunner}
     */
    const onStep = async (name, type, op, path) => {
        const started = now();
        const record = (/** @type {boolean} */ threw, /** @type {any} */ outcome) => {
            const durationMs = Math.round((now() - started) * 1000) / 1000;
            // A Parallel's decision holds no user data and must survive intact for a replay, so it is not redacted.
            const recorded = threw
                ? recordError(outcome, name)
                : type === 'Parallel'
                  ? recordPart('copy', () => snapshot(outcome))
                  : copyAndRedact(outcome, name, 'result');
            /** @type {TraceEntry} */
            const step = threw ? { command: name, path, threw: true } : { command: name, path };
            if ('unrecorded' in recorded) push({ ...step, unrecorded: recorded.unrecorded, durationMs });
            else
                push(
                    threw
                        ? { ...step, error: recorded.value, durationMs }
                        : { ...step, result: recorded.value, durationMs }
                );
        };
        try {
            const result = await op();
            record(false, result);
            return result;
        } catch (error) {
            record(true, error);
            throw error;
        }
    };

    /**
     * Copies and redacts `meta.initialInput` and `meta.context` when it is called, so call it before a run that can
     * change them, and again once it ends for `dropped` and `trace`. A field it cannot record is named in
     * `unrecorded`. It never throws. `undefined` is left alone, so a redact that spreads its argument cannot invent
     * an empty object.
     * @param {TraceMeta} [meta]
     * @returns {TraceLog}
     */
    const toTrace = (meta = {}) => {
        const field = (/** @type {any} */ value, /** @type {string} */ kind) =>
            value === undefined ? { value } : copyAndRedact(value, kind, kind);
        const initialInput = field(meta.initialInput, 'initialInput');
        const context = field(meta.context, 'context');
        /** @type {{ initialInput?: UnrecordedCause, context?: UnrecordedCause }} */
        const unrecorded = {};
        if ('unrecorded' in initialInput) unrecorded.initialInput = initialInput.unrecorded;
        if ('unrecorded' in context) unrecorded.context = context.unrecorded;
        return {
            flowName: meta.flowName,
            version: meta.version,
            initialInput: 'value' in initialInput ? initialInput.value : undefined,
            context: 'value' in context ? context.value : undefined,
            ...(Object.keys(unrecorded).length > 0 ? { unrecorded } : {}),
            dropped,
            trace: entries.slice()
        };
    };

    return { onStep, entries, toTrace };
};

/**
 * Runs a flow for real while recording it, and returns the outcome and a replayable trace. Convenient in tests and
 * scripts; to record an application, give each run its own recorder, as examples/recording-example.js does.
 *
 * @param {(input: any) => Effect} flowFn - Builds the Effect tree from its input
 * @param {any} initialInput - The value the flow is called with; stored so a replay can rebuild it
 * @param {RecorderOptions & { context?: any, version?: string }} [options] - Recorder options, plus the
 *        `context` given to `runEffect` (stored so `Ask` can be replayed) and a build id
 * @returns {Promise<{ result: SuccessState | FailureState, trace: TraceLog }>}
 */
const recordEffect = async (flowFn, initialInput, options = {}) => {
    checkOptions(options, 'recordEffect', { context: null, version: null, ...recorderOptionRules });
    const { context = {}, version, ...recorderOptions } = options;
    const rec = recorder(recorderOptions);
    // Before the run, so a Command that writes to the input or the context cannot rewrite what the trace received.
    const head = rec.toTrace({ initialInput, flowName: context.flowName, context, version });
    // Merged over the global wiring, so recording inside an instrumented application keeps its spans.
    const result = await runEffect(flowFn(initialInput), context, { onStep: rec.onStep });
    const { dropped, trace } = rec.toTrace();
    return { result, trace: { ...head, dropped, trace } };
};

/**
 * Whether a recorded entry says its step threw: `threw`, or an `error` key, as older and hand-written traces say it.
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
 * The positions a path passes through, each with the kind of node there. `0p1/2r0/1` passes a Parallel at `0` and a
 * Retry at `0p1/2`, and ends at a Command at `0p1/2r0/1`. A path not in the recorder's format gives none, so a
 * hand-built trace is never judged by its shape.
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
 * Turns a recorded entry into the outcome a Resolver returns, copied so a replayed step that mutates its result
 * cannot rewrite the trace.
 *
 * @param {TraceEntry} entry
 * @returns {ReplayOutcome}
 */
const entryToOutcome = (entry) =>
    entryThrew(entry) ? { error: reviveError(snapshot(entry.error)) } : { result: snapshot(entry.result) };

/**
 * Whether an entry is a Parallel's recorded decision. A decision's path ends in `p`, so a Command named 'Parallel'
 * is never mistaken for one.
 * @param {TraceEntry} entry
 * @returns {boolean}
 */
const isDecisionEntry = (entry) =>
    entry.command === 'Parallel' && typeof entry.path === 'string' && entry.path.endsWith('p');

/**
 * Builds a Resolver for the reference trace format; `replayEffect` is its only caller. A trace whose entries all
 * carry a `path` is matched by path. One without is matched in order, which cannot tell `Parallel` branches apart.
 * A step the trace lacks resolves to `undefined`, as from a Resolver, and `missing` describes it for the error.
 *
 * @param {TraceLog | TraceEntry[]} traceLog - A reference-format trace, or a bare array of entries
 * @param {Object} [options]
 * @param {(entry: TraceEntry) => void} [options.onEntry] - Observes each entry as it is handed to a step, which is
 *        how `replayEffect` learns which entries the flow never asked for.
 * @returns {{ resolve: Resolver, missing: (step: ReplayStep) => string }}
 */
const fromTrace = (traceLog, options = {}) => {
    const { onEntry } = options;
    const entries = Array.isArray(traceLog) ? traceLog : traceLog?.trace;
    if (!Array.isArray(entries)) throw replayError('Trace has no `trace` array.');
    const resolveEntry = (/** @type {TraceEntry} */ entry, /** @type {ReplayStep} */ step) => {
        if (onEntry) onEntry(entry);
        // Production ran this step, so it stops the replay rather than run live under `onMissing`.
        if (entry.unrecorded !== undefined) {
            throw unrecordedError(
                `outcome for '${step.name}' at path '${step.path}'`,
                entry.unrecorded,
                "Production ran the step, so onMissing: 'execute' does not run it either. To replay past it,",
                { command: step.name, index: step.index, path: step.path }
            );
        }
        // Only a hand-built trace can hold a value the copy cannot encode.
        try {
            return entryToOutcome(entry);
        } catch {
            throw replayError(
                `Trace entry for '${step.name}' at path '${step.path}' holds a value JSON cannot encode, such as a ` +
                    'BigInt. A recorded trace never does, so write the entry as JSON would store it.',
                { command: step.name, index: step.index, path: step.path }
            );
        }
    };

    if (entries.length > 0 && entries.every(hasPath)) {
        const byPath = new Map(entries.map((e) => [e.path, e]));
        // A recorder never writes a duplicate path, and keeping either entry would hand a branch the wrong result.
        if (byPath.size !== entries.length) {
            throw replayError('Trace has duplicate step paths.');
        }
        /** The kind of node the recorded run had at each position its steps passed through. */
        const recordedKinds = new Map(entries.flatMap((e) => nodesAlong(/** @type {string} */ (e.path))));
        /** Names the first Command the trace recorded inside the Retry or Parallel at `at`, for a message. */
        const firstStepIn = (/** @type {string} */ at, /** @type {NodeKind} */ kind) => {
            const opens = `${at}${kind === 'Retry' ? 'r' : 'p'}`;
            const inside = entries.find((e) => e.path?.startsWith(opens) && !isDecisionEntry(e));
            return inside ? `, with '${inside.command}' at path '${inside.path}'` : '';
        };
        // A step the trace lacks is a change of shape when the trace recorded another kind of node along its path, as
        // when a Command was added where a Retry was. Reported as missing, it would run live under 'execute'.
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
        // A missing step in a branch a recorded decision cancelled (any branch but the trigger, or every branch of a
        // Parallel cancelled from outside) is where production stopped. It throws a cut, which `runCommand` or
        // `runParallel` catches to stop the branch.
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
                // `runBranches` reproduces it; with none recorded, the Parallel replays by timing.
                if (entry && entry.command !== 'Parallel') throw timeParadox(step, entry.command);
                if (entry) return resolveEntry(entry, step);
                throwIfReshaped(step);
                if (stoppedInProduction(step.path)) throw replayCutError(/** @type {string} */ (step.path));
                return undefined;
            }
            if (!entry) {
                throwIfReshaped(step);
                if (stoppedInProduction(step.path)) throw replayCutError(/** @type {string} */ (step.path));
                return undefined;
            }
            if (entry.command !== step.name) throw timeParadox(step, entry.command);
            return resolveEntry(entry, step);
        };
        const missing = (/** @type {ReplayStep} */ step) =>
            `Trace has no step at path '${step.path}' for '${step.name}'`;
        return { resolve, missing };
    }

    /** @type {Resolver} */
    const resolve = (step) => {
        // A trace with no paths predates recorded decisions, so a Parallel replays by timing.
        if (step.type === 'Parallel') return undefined;
        // Completion order cannot tell Parallel branches apart, so a step inside one is refused rather than guessed.
        if (isInsideParallel(step.path)) {
            throw replayError(
                `Trace carries no paths, so '${step.name}' inside a Parallel cannot be matched positionally.`,
                { command: step.name, path: step.path }
            );
        }
        const entry = entries[step.index];
        if (!entry) return undefined;
        if (entry.command !== step.name) throw timeParadox(step, entry.command);
        return resolveEntry(entry, step);
    };
    const missing = (/** @type {ReplayStep} */ step) => `Trace exhausted: no entry #${step.index} for '${step.name}'`;
    return { resolve, missing };
};

/**
 * The error for a step a replay has no recorded outcome for, which it refuses to run live. It says whether a cap
 * may have dropped the step or production may never have run it, since the fix differs.
 * @param {ReplayStep} step
 * @param {((step: ReplayStep) => string) | undefined} describe - `fromTrace`'s `missing`; a Resolver has none
 * @param {number} droppedEntries - How many entries the trace dropped under `maxEntries`
 * @returns {Error}
 */
const missingStepError = (step, describe, droppedEntries) => {
    const what = describe ? describe(step) : `No recorded outcome for '${step.name}' at step ${step.index}`;
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

/** What each cause the recorder writes means, and what fixes it, for a replay error. */
const unrecordedReasons = new Map([
    ['redact', ['redact threw on it', 'make redact handle every value it is given, null included']],
    ['copy', ['it could not be copied, as when it holds a BigInt or a getter that throws', 'keep it to plain data']]
]);

/**
 * The error for a replay that needs a value the recorder could not record.
 * @param {string} what - What the trace lacks, as the message names it
 * @param {unknown} cause - Why, as the trace records it
 * @param {string} lead - What that means for this replay, leading into the fix
 * @param {Object} props - The fields that locate it, such as `path`
 * @returns {Error}
 */
const unrecordedError = (what, cause, lead, props) => {
    // A cause the recorder does not write, as a hand-built trace may hold, is not guessed at.
    const [reason, fix] = unrecordedReasons.get(/** @type {string} */ (cause)) ?? [
        'it could not be recorded',
        'find out what kept it out'
    ];
    return replayError(
        `The trace holds no ${what}: ${reason}, so the recorder left it out. ${lead} ${fix}, and record the flow again.`,
        props
    );
};

/**
 * Why the recorder left one of a trace's own fields out, or `undefined` when it did not.
 * @param {TraceLog | undefined} traceLog
 * @param {'initialInput' | 'context'} field
 * @returns {unknown}
 */
const unrecordedCause = (traceLog, field) => {
    const fields = /** @type {any} */ (traceLog?.unrecorded);
    return isObject(fields) ? fields[field] : undefined;
};

/**
 * @typedef {Object} ReplayOptions
 * @property {any} [context] - Context for `Ask`; defaults to the context a trace recorded.
 * @property {boolean} [fastRetry] - Waits no time between Retry attempts. On by default.
 * @property {boolean} [hooks] - Runs the replay inside the hooks `configureEffect` installed, with the resolver
 *           innermost. Off by default, so a replay cannot reach a telemetry backend or a guardrail that does I/O.
 * @property {'throw' | 'execute'} [onMissing] - What to do with a step the resolver has no recording for. `'throw'`
 *           (default) fails the replay, so no side effect can occur. `'execute'` runs the real Command, so pass it
 *           only where the Commands reach test doubles or only read. A trace that dropped entries refuses it.
 * @property {(step: ReplayStep, outcome: ReplayOutcome | undefined) => void} [onResolved] - Observes each step.
 */

/**
 * What a replay returns: the flow's own outcome and, for a trace, the recorded entries the flow never asked for. A
 * flow that stops early mismatches nothing, so `unreached` is the only sign that a step went away.
 * @typedef {{ result: SuccessState | FailureState, unreached?: TraceEntry[] }} Replay
 */

/**
 * Replays a flow, feeding recorded outcomes to its Commands instead of running them. No side effect can occur by
 * default: the interpreter executes a Command only as the `op` it hands `onStep`, and the `onStep` here calls `op`
 * only under `onMissing: 'execute'`. Async, so a malformed trace rejects rather than throwing.
 *
 * @param {Effect} effect - The Effect tree, rebuilt from the recorded initial input
 * @param {Resolver | TraceLog | TraceEntry[]} traceOrResolver - A reference-format trace, or a Resolver supplying
 *        each Command's recorded outcome (`undefined` if it has none) for traces stored in another shape.
 * @param {ReplayOptions} [options]
 * @returns {Promise<Replay>} `{ result, unreached }` for a trace, `{ result }` for a Resolver
 */
const replayEffect = async (effect, traceOrResolver, options = {}) => {
    checkOptions(options, 'replayEffect', {
        context: null,
        fastRetry: [isBoolean, 'true or false'],
        hooks: [isBoolean, 'true or false'],
        onMissing: [(value) => value === 'throw' || value === 'execute', "'throw' or 'execute'"],
        onResolved: [isFunction, 'a function']
    });
    const { fastRetry = true, hooks = false, onMissing = 'throw', onResolved } = options;
    const fromResolver = typeof traceOrResolver === 'function';
    /** @type {Set<TraceEntry>} */
    const reached = new Set();
    const { resolve, missing } = fromResolver
        ? { resolve: traceOrResolver, missing: undefined }
        : fromTrace(traceOrResolver, { onEntry: (entry) => void reached.add(entry) });
    // Only a trace log carries metadata; a bare entries array and a Resolver carry none.
    const traceLog = fromResolver || Array.isArray(traceOrResolver) ? undefined : traceOrResolver;
    // Another context can take another branch at an `Ask` with nothing to flag it, so a trace whose context was not
    // recorded needs one passed.
    const contextCause = unrecordedCause(traceLog, 'context');
    if (options.context == null && contextCause !== undefined) {
        throw unrecordedError(
            'context',
            contextCause,
            'A replay with an empty one could take another branch at an Ask: pass options.context, or',
            { field: 'context' }
        );
    }
    const context = options.context ?? traceLog?.context ?? {};
    // A capped trace lacks steps production ran, so running a missing one live could repeat production's I/O.
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
    // What the Resolver or `onResolved` threw, or a Resolver's answer that is not an outcome. The replay rejects with
    // it, rather than counting it as the Command failing. Cast rather than annotated, since only the step runner
    // assigns it.
    let callbackFailure = /** @type {{ error: unknown } | undefined} */ (undefined);
    /** Keeps the first such failure for the replay to reject with, and returns a stand-in nothing in the flow absorbs. */
    const stopWith = (/** @type {unknown} */ error) => {
        callbackFailure ??= { error };
        return asHarnessError(new Error('A replay callback failed.'));
    };

    /**
     * Asks for a step's recorded outcome. A replay fault from `fromTrace` passes as it is.
     * @param {ReplayStep} step
     * @returns {ReplayOutcome | undefined}
     */
    const answer = (step) => {
        let outcome;
        try {
            outcome = resolve(step);
        } catch (error) {
            if (hasMark(error, harnessError)) throw error;
            throw stopWith(error);
        }
        if (outcome === undefined || isReplayOutcome(outcome)) return outcome;
        throw stopWith(
            new TypeError(
                'A Resolver answers with { result }, { error }, or undefined for a step it has no record of, and it ' +
                    `answered ${describeValue(outcome)} for '${step.name}' at path '${step.path}'.`
            )
        );
    };

    /** @type {StepRunner} */
    const onStep = async (name, type, op, path) => {
        if (type === 'Parallel') {
            // A Parallel's step carries its recorded decision into `op`, where `runBranches` reproduces it. It is not
            // a Command: `index` still counts Commands, and `onResolved` still sees only them.
            const outcome = answer({ index, name, type, path });
            return await op(outcome !== undefined && 'result' in outcome ? outcome.result : undefined);
        }
        const step = { index: index++, name, type, path };
        const outcome = answer(step);
        if (onResolved) {
            try {
                onResolved(step, outcome);
            } catch (error) {
                throw stopWith(error);
            }
        }
        if (outcome === undefined) {
            if (onMissing !== 'execute') throw missingStepError(step, missing, droppedEntries);
            return await op();
        }
        if ('error' in outcome) throw outcome.error;
        return outcome.result;
    };

    /** @type {CallConfiguration} */
    const callConfig = { onStep, inherit: hooks };

    // A replay fault becomes a Failure here, outside the flow, where nothing can absorb it.
    let result;
    try {
        result = await interpret(effect, context, callConfig, fastRetry);
    } catch (e) {
        if (callbackFailure) throw callbackFailure.error;
        if (!hasMark(e, replayFault)) throw e;
        result = Failure(e);
    }
    if (fromResolver) return { result };
    // `fromTrace` has already checked the shape.
    const entries = Array.isArray(traceOrResolver) ? traceOrResolver : traceOrResolver.trace;
    return { result, unreached: entries.filter((entry) => !reached.has(entry)) };
};

/**
 * Replays a reference-format trace and narrates each step. Rebuilds the flow from the recorded input, reports the
 * outcome, and names any recorded steps that were never reached.
 *
 * @param {(input: any) => Effect} flowFn - The same flow function that produced the trace
 * @param {TraceLog} traceLog - A trace from `recordEffect` or a `recorder`
 * @param {Object} [options]
 * @param {(...args: any[]) => void} [options.log] - Defaults to `console.log`
 * @param {any} [options.context] - Overrides the context stored on the trace
 * @param {string} [options.version] - Current build id; warns when it differs from the trace's
 * @returns {Promise<SuccessState | FailureState>} The flow's outcome. For the unreached entries as data, use
 *          `replayEffect`.
 */
const timeTravel = async (flowFn, traceLog, options = {}) => {
    checkOptions(options, 'timeTravel', { log: [isFunction, 'a function'], context: null, version: null });
    const { log = console.log, context, version } = options;
    const { initialInput, trace, flowName, version: traceVersion } = traceLog;
    const inputCause = unrecordedCause(traceLog, 'initialInput');
    if (inputCause !== undefined) {
        throw unrecordedError('initialInput', inputCause, 'The flow is rebuilt from it, so', { field: 'initialInput' });
    }
    // Spreads an Error's hidden `message`, and falls back to `String` where JSON throws: narration must not be what
    // fails a replay.
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
    if (initialInput === undefined) {
        log(
            'Warning: the trace holds no initial input, so the flow is rebuilt from undefined. A recorder ' +
                'installed as a hook finds the input only on a flow built with effectPipe.'
        );
    }
    const anonymous = trace.filter((e) => e.command === 'anonymous').length;
    if (anonymous > 0) {
        log(
            `Warning: ${anonymous} of the recorded steps are named 'anonymous', usually inline arrow Commands, so ` +
                'this replay cannot tell them apart and would not notice two of them trading places. Name them with ' +
                'a const or meta.name.'
        );
    }
    // Decisions are not narrated as steps, so the header counts only Commands.
    const commandCount = trace.filter((e) => !isDecisionEntry(e)).length;
    const stepsText = commandCount === 1 ? 'step' : 'steps';
    log(`Replaying '${flowName || 'flow'}' (${commandCount} recorded ${stepsText})`);
    log(`Initial input: ${format(initialInput)}`);

    // By path, or by position for a trace without paths.
    const byPath = new Map(trace.filter(hasPath).map((e) => [e.path, e]));
    const timing = (/** @type {ReplayStep} */ step) => {
        const recorded = byPath.get(step.path) ?? trace[step.index];
        return typeof recorded?.durationMs === 'number' ? ` in ${recorded.durationMs}ms` : '';
    };
    // `replayEffect` defaults the context to the trace's.
    const replay = await replayEffect(flowFn(initialInput), traceLog, {
        context,
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
    // A replay fault already names where the flow diverged. Told by the mark, since a flow's own error can share the
    // name.
    const haltedByReplay = result.type === 'Failure' && hasMark(result.error, replayFault);
    if (unreached.length > 0 && !haltedByReplay) {
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
