// @ts-check

/** @typedef {{ type: 'Success', value: any }} SuccessState */
/** @typedef {{ type: 'Failure', error: any }} FailureState */
/**
 * @typedef {{
 *   type: 'Command',
 *   cmd: () => Promise<any>|any,
 *   next: (result: any) => Effect
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
 * @returns {FailureState}
 */
const Failure = (error) => ({ type: 'Failure', error });

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
    return (start) => fns.reduce(chain, Success(start));
};

/**
 * The Interpreter
 * Iterates through the Effect tree, executing Commands and handling async flow.
 *
 * @param {Effect} effect - The Effect tree returned by a pipeline
 * @returns {Promise<SuccessState | FailureState>}
 */
async function runEffect(effect) {
    while (effect.type === 'Command') {
        try {
            effect = effect.next(await effect.cmd());
        } catch (e) {
            return Failure(e);
        }
    }
    return effect;
}

export { Success, Failure, Command, effectPipe, runEffect };
