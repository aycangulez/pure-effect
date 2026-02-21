// @ts-check

/** @typedef {{ type: 'Success', value: any, initialInput?: any }} SuccessState */
/** @typedef {{ type: 'Failure', error: any, initialInput?: any }} FailureState */
/**
 * @typedef {{
 *   type: 'Command',
 *   cmd: () => Promise<any>|any,
 *   next: (result: any) => Effect,
 *   initialInput?: any
 * }} CommandState
 */

/**
 * The Union type for all possible states
 * @typedef {SuccessState | FailureState | CommandState} Effect
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
const Failure = (error, initialInput) => ({ type: 'Failure', error, initialInput });

/**
 * Represents a side effect to be executed later
 * @param {() => Promise<any>|any} cmd - The side-effect function to execute
 * @param {(result: any) => Effect} next - A function that receives the result of `cmd` and returns the next Effect
 * @returns {CommandState}
 */
const Command = (cmd, next) => ({ type: 'Command', cmd, next });

/**
 * Connects an Effect to the next function in the pipeline.
 * Handles the branching logic for Success, Failure, and Command.
 *
 * @param {Effect} effect - The current Effect object
 * @param {(value: any) => Effect} fn - The next function to run if the current effect is a Success
 * @returns {Effect} The composed Effect
 */
const chain = (effect, fn) => {
    switch (effect.type) {
        case 'Success':
            return fn(effect.value);
        case 'Failure':
            return effect;
        case 'Command':
            const next = (/** @type {Effect} */ result) => chain(effect.next(result), fn);
            return Command(effect.cmd, next);
    }
};

/**
 * Composes a list of functions into a single Effect pipeline.
 * Each function receives the output of the previous one.
 *
 * @param {...(input: any) => Effect} fns - Functions that return Success, Failure, or Command.
 * @returns {(start: any) => Effect} A function that accepts an initial input and returns the final Effect tree.
 */
const effectPipe = (...fns) => {
    return (start) => {
        const effect = fns.reduce(chain, Success(start));
        effect.initialInput = start;
        return effect;
    };
};

/** @type {(name: string, type: string, op: function) => Promise<any>} */
const defaultStepRunner = async (name, type, op) => await op();

/** @type {(effect: Effect, op: function, flowName?: string) => Promise<any>} */
const defaultRunWrapper = async (effect, op, flowName) => await op();

let stepRunner = defaultStepRunner;
let runWrapper = defaultRunWrapper;

/**
 * Enables OpenTelemetry support if it receives an OpenTelemetry onStep option.
 * Otherwise OpenTelemetry support is disabled.
 *
 * @param {any} options
 */
const configureTelemetry = (/** @type any **/ options) => {
    stepRunner = options.onStep ? options.onStep : defaultStepRunner;
    runWrapper = options.onRun ? options.onRun : defaultRunWrapper;
};

/**
 * The Interpreter
 * Iterates through the Effect tree, executing Commands and handling async flow.
 *
 * @param {Effect} effect - The Effect tree returned by a pipeline
 * @param {string} flowName - Name of the workflow
 * @returns {Promise<SuccessState | FailureState>}
 */
async function runEffect(effect, flowName = '') {
    return runWrapper(
        effect,
        async () => {
            while (effect.type === 'Command') {
                const currentCmd = effect.cmd;
                const cmdName = currentCmd.name || 'anonymous';

                try {
                    const result = await stepRunner(cmdName, 'Command', currentCmd);
                    effect = effect.next(result);
                } catch (e) {
                    return Failure(e, effect.initialInput);
                }
            }

            return effect;
        },
        flowName || ''
    );
}

export { Success, Failure, Command, effectPipe, runEffect, configureTelemetry };
