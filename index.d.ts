export type SuccessState<T> = {
    type: 'Success';
    value: T;
    initialInput?: unknown;
};

export type FailureState<E = unknown> = {
    type: 'Failure';
    error: E;
    initialInput?: unknown;
};

/**
 * Metadata attached to a Command. A string `name` is read by the interpreter as the Command's
 * identity for traces, replay matching, and telemetry spans; every other key is carried through
 * untouched for `onBeforeCommand`.
 */
export type CommandMeta = { name?: string } & Record<string, unknown>;

export type CommandState<R, T, E = unknown, Ctx = unknown> = {
    type: 'Command';
    /**
     * Performs the side effect. Inside a `Parallel` branch it receives an `AbortSignal` that fires when a
     * sibling branch fails; forward it to `fetch`, a driver, or an `AbortController`-aware client to have
     * the work cancelled in flight. Ignoring it is fine and is what every thunk written before this did:
     * the interpreter still refuses to start any *later* Command in a cancelled branch. Outside a
     * `Parallel` no argument is passed at all.
     */
    cmd: (signal?: AbortSignal) => Promise<R> | R;
    /**
     * Method syntax, not a function-typed property, on every state's `next`: `strictFunctionTypes`
     * checks a property's parameter contravariantly, which made a `CommandState<never, ...>` (a `cmd`
     * that only throws) unassignable to `Effect`. Method parameters are bivariant, so it is accepted.
     */
    next(result: R): Effect<T, E, Ctx>;
    meta?: CommandMeta;
    initialInput?: unknown;
};

export type AskState<T, E = unknown, Ctx = unknown> = {
    type: 'Ask';
    next(context: Ctx): Effect<T, E, Ctx>;
    initialInput?: unknown;
};

export type RetryOptions = {
    attempts?: number;
    delay?: number;
    backoff?: number;
};

/**
 * `E` is the error the node contributes to its pipeline, which for a Retry is the exhaustion failure:
 * the interpreter never lets an inner attempt's error escape unwrapped, so the wrapped tree's own
 * error type is consumed by the retry loop rather than exposed here.
 */
export type RetryState<T, E = unknown, Ctx = unknown> = {
    type: 'Retry';
    effect: Effect<T, any, Ctx>;
    options: RetryOptions & { onExhausted?: (error: RetryExhaustedError<any>) => Effect<T, any, Ctx> };
    next(value: T): Effect<T, E, Ctx>;
    initialInput?: unknown;
};

export type RetryExhaustedError<E = unknown> = {
    retryExhausted: true;
    lastError: E;
    attempts: number;
};

export type ParallelState<T extends readonly unknown[], R, E = unknown, Ctx = unknown> = {
    type: 'Parallel';
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> };
    next(values: [...T]): Effect<R, E, Ctx>;
    initialInput?: unknown;
};

export type Effect<T, E = unknown, Ctx = unknown> =
    | SuccessState<T>
    | FailureState<E>
    | CommandState<any, T, E, Ctx>
    | AskState<T, E, Ctx>
    | RetryState<T, E, Ctx>
    | ParallelState<any, T, E, Ctx>;

export declare function Success<T>(value: T): SuccessState<T>;

export declare function Failure<E = unknown>(error: E, initialInput?: unknown): FailureState<E>;

/**
 * `next` is optional and defaults to `(result) => Success(result)`, which is what most Commands want.
 *
 * A `meta.name` becomes this Command's identity, which keeps it independent of how `cmd` was declared
 * and immune to minification. Without one the identity falls back to `cmd.name`, then to 'anonymous'.
 */
export declare function Command<R, T = R, E = unknown, Ctx = unknown>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: (result: R) => Effect<T, E, Ctx>,
    meta?: CommandMeta
): CommandState<R, T, E, Ctx>;

export declare function Ask<T, E = unknown, Ctx = unknown>(
    next: (context: Ctx) => Effect<T, E, Ctx>
): AskState<T, E, Ctx>;

/**
 * With `onExhausted`, the exhaustion failure never escapes: the fallback Effect runs instead, its
 * success feeds `next`, and its failure propagates unwrapped, so the node's declared error is the
 * fallback's own error type. `onExhausted` is a per-use option only; the global `retry` defaults in
 * `EffectConfiguration` deliberately cannot carry one.
 */
export declare function Retry<T, E = unknown, E2 = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options: RetryOptions & { onExhausted: (error: RetryExhaustedError<E>) => Effect<T, E2, Ctx> }
): RetryState<T, E2, Ctx>;

/**
 * Without `onExhausted`, the declared error type is `RetryExhaustedError<E>`, because that is what
 * a Retry's Failure actually carries: on exhaustion the interpreter returns
 * `Failure({ retryExhausted: true, lastError, attempts })` rather than the inner error itself,
 * so `result.error.lastError` is where the wrapped tree's `E` survives.
 */
export declare function Retry<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options?: RetryOptions
): RetryState<T, RetryExhaustedError<E>, Ctx>;

/**
 * `next` is optional and defaults to `(values) => Success(values)`, same as `Command`'s default,
 * so a bare `Parallel(effects)` resolves to the ordered array of success values.
 */
export declare function Parallel<T extends readonly unknown[], E = unknown, Ctx = unknown>(effects: {
    [K in keyof T]: Effect<T[K], E, Ctx>;
}): ParallelState<[...T], [...T], E, Ctx>;

export declare function Parallel<T extends readonly unknown[], R, E = unknown, Ctx = unknown>(
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> },
    next: (values: [...T]) => Effect<R, E, Ctx>
): ParallelState<[...T], R, E, Ctx>;

export declare function effectPipe<A, B, E1 = unknown, Ctx = unknown>(
    f1: (a: A) => Effect<B, E1, Ctx>
): (start: A) => Effect<B, E1, Ctx>;

export declare function effectPipe<A, B, C, E1 = unknown, E2 = unknown, Ctx = unknown>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>
): (start: A) => Effect<C, E1 | E2, Ctx>;

export declare function effectPipe<A, B, C, D, E1 = unknown, E2 = unknown, E3 = unknown, Ctx = unknown>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>,
    f3: (c: C) => Effect<D, E3, Ctx>
): (start: A) => Effect<D, E1 | E2 | E3, Ctx>;

export declare function effectPipe<
    A,
    B,
    C,
    D,
    F,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    Ctx = unknown
>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>,
    f3: (c: C) => Effect<D, E3, Ctx>,
    f4: (d: D) => Effect<F, E4, Ctx>
): (start: A) => Effect<F, E1 | E2 | E3 | E4, Ctx>;

export declare function effectPipe<
    A,
    B,
    C,
    D,
    F,
    G,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    Ctx = unknown
>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>,
    f3: (c: C) => Effect<D, E3, Ctx>,
    f4: (d: D) => Effect<F, E4, Ctx>,
    f5: (f: F) => Effect<G, E5, Ctx>
): (start: A) => Effect<G, E1 | E2 | E3 | E4 | E5, Ctx>;

export declare function effectPipe<
    A,
    B,
    C,
    D,
    F,
    G,
    H,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    Ctx = unknown
>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>,
    f3: (c: C) => Effect<D, E3, Ctx>,
    f4: (d: D) => Effect<F, E4, Ctx>,
    f5: (f: F) => Effect<G, E5, Ctx>,
    f6: (g: G) => Effect<H, E6, Ctx>
): (start: A) => Effect<H, E1 | E2 | E3 | E4 | E5 | E6, Ctx>;

export declare function effectPipe<
    A,
    B,
    C,
    D,
    F,
    G,
    H,
    I,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    Ctx = unknown
>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>,
    f3: (c: C) => Effect<D, E3, Ctx>,
    f4: (d: D) => Effect<F, E4, Ctx>,
    f5: (f: F) => Effect<G, E5, Ctx>,
    f6: (g: G) => Effect<H, E6, Ctx>,
    f7: (h: H) => Effect<I, E7, Ctx>
): (start: A) => Effect<I, E1 | E2 | E3 | E4 | E5 | E6 | E7, Ctx>;

export declare function effectPipe<
    A,
    B,
    C,
    D,
    F,
    G,
    H,
    I,
    J,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    Ctx = unknown
>(
    f1: (a: A) => Effect<B, E1, Ctx>,
    f2: (b: B) => Effect<C, E2, Ctx>,
    f3: (c: C) => Effect<D, E3, Ctx>,
    f4: (d: D) => Effect<F, E4, Ctx>,
    f5: (f: F) => Effect<G, E5, Ctx>,
    f6: (g: G) => Effect<H, E6, Ctx>,
    f7: (h: H) => Effect<I, E7, Ctx>,
    f8: (i: I) => Effect<J, E8, Ctx>
): (start: A) => Effect<J, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8, Ctx>;

/**
 * Wraps one Command execution. `path` is the Command's position in the Effect tree rather than its
 * position in completion order, so it is the same in a replay as in the recorded run even when
 * `Parallel` branches finish in a different order. Hooks that take three parameters are unaffected.
 */
export type StepRunner = (name: string, type: string, op: () => Promise<unknown>, path?: string) => Promise<unknown>;

export type RunWrapper = (
    effect: Effect<unknown>,
    op: () => Promise<SuccessState<unknown> | FailureState<unknown>>,
    flowName?: string
) => Promise<SuccessState<unknown> | FailureState<unknown>>;

export type CommandInterceptor = (command: CommandState<unknown, unknown>, context?: any) => Promise<void>;

export interface EffectConfiguration {
    onStep?: StepRunner;
    onRun?: RunWrapper;
    onBeforeCommand?: CommandInterceptor;
    retry?: RetryOptions;
}

/**
 * Configures the global runner. Several configurations can be passed and are merged, which is how
 * independent concerns share the one slot each hook has: `onStep` and `onRun` nest with the first
 * outermost, `onBeforeCommand` interceptors all run in order, and `retry` merges with later winning.
 * Merging does not accumulate across calls: a later call replaces the previous wiring, and calling
 * this with nothing resets every slot to its default.
 *
 * Returns a function that puts back whatever was installed when this call was made, so a caller can
 * install hooks without owning the global wiring forever. Restoring is a snapshot rather than a stack:
 * if a later call has run since, restoring reverts to the older snapshot and discards the newer one.
 */
export declare function configureEffect(...configs: (EffectConfiguration | undefined)[]): () => void;

export declare function runEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    context?: Ctx,
    callConfig?: EffectConfiguration
): Promise<SuccessState<T> | FailureState<E>>;

export type ReplayStep = {
    /**
     * Zero-based position in this run's completion order. Not stable for a flow containing `Parallel`,
     * whose branches finish in whatever order they finish in. Prefer `path`.
     */
    index: number;
    /** `cmd.name`, or 'anonymous'. */
    name: string;
    /** Always 'Command' today; reserved. */
    type: string;
    /**
     * The Command's position in the Effect tree, stable across runs: steps are numbered within a
     * subtree, and each `Parallel` branch and `Retry` attempt opens its own prefix. This is what a
     * replay matches on, and what a Resolver should key off. Absent on traces recorded before paths.
     */
    path?: string;
};

/**
 * What production observed for a step. `{ result }` feeds the Command's `next`;
 * `{ error }` is thrown so the interpreter produces a Failure. A Resolver returning
 * `undefined` means "not recorded", which is distinct from `{ result: undefined }`.
 */
export type ReplayOutcome = { result: unknown } | { error: unknown };

export type Resolver = (step: ReplayStep) => ReplayOutcome | undefined;

export type TraceEntry = {
    command: string;
    /**
     * The Command's position in the Effect tree. Order-independent, so a replay lines a recorded step
     * up with the step that asked for it even when `Parallel` branches finish out of order.
     */
    path?: string;
    result?: unknown;
    error?: unknown;
    /** How long the Command took in production, rounded to microseconds. */
    durationMs?: number;
};

/** The reference trace format. A convenience, not a contract: write a Resolver for any other shape. */
export type TraceLog = {
    flowName?: string;
    version?: string;
    initialInput?: unknown;
    context?: unknown;
    dropped?: number;
    trace: TraceEntry[];
};

export interface RecorderOptions {
    /**
     * Scrubs every value a trace holds: each Command's result, each serialized error, and the
     * `initialInput` and `context` stored on the trace itself. `kind` is `'result'`, `'error'`,
     * `'initialInput'`, or `'context'`; `name` is the Command's name for the first two and the kind for
     * the last two. This is the single place PII is kept out of a trace, which is why it sees all four.
     */
    redact?: (value: unknown, name: string, kind: 'result' | 'error' | 'initialInput' | 'context') => unknown;
    /** Cap trace length; further steps are counted in `dropped`, not stored. */
    maxEntries?: number;
    /** Record stack traces for thrown errors. Off by default. */
    stack?: boolean;
}

export interface TraceMeta {
    initialInput?: unknown;
    flowName?: string;
    context?: unknown;
    version?: string;
}

export declare function recorder(options?: RecorderOptions): {
    onStep: StepRunner;
    entries: TraceEntry[];
    toTrace(meta?: TraceMeta): TraceLog;
};

export declare function recordEffect<T, E = unknown, Ctx = unknown>(
    flowFn: (input: any) => Effect<T, E, Ctx>,
    initialInput: any,
    options?: RecorderOptions & { context?: Ctx; version?: string }
): Promise<{ result: SuccessState<T> | FailureState<E>; trace: TraceLog }>;

export interface ReplayOptions<Ctx = unknown> {
    /** Context for `Ask`. Pass the recorded context to reproduce a run faithfully. */
    context?: Ctx;
    /** Strip `Retry` delays so a replay does not wait out production backoff (default `true`). */
    fastRetry?: boolean;
    /** Allow configured `onRun` / `onBeforeCommand` to fire (default `false`). */
    hooks?: boolean;
    /**
     * What to do when the Resolver has no recording for a step.
     * `'throw'` (default) fails the replay, making side effects impossible.
     * `'execute'` runs the real Command: recorded prefix, live tail.
     */
    onMissing?: 'throw' | 'execute';
    onResolved?: (step: ReplayStep, outcome: ReplayOutcome | undefined) => void;
}

/**
 * What a replay returns: the flow's own outcome and, for a trace, the recorded entries the flow
 * never asked for. A flow that stops issuing Commands early mismatches nothing, so `result` can be a
 * `Success` with steps left over; `unreached` is where that shows. It is absent for a Resolver,
 * since only a trace knows what it holds.
 */
export interface Replay<T, E = unknown> {
    result: SuccessState<T> | FailureState<E>;
    unreached: TraceEntry[];
}

/**
 * Pass a trace to replay it directly, or a Resolver when traces are stored in some other
 * shape. To observe a replay rather than change how it resolves, use `onResolved`.
 * A malformed trace rejects with a `ReplayError`.
 *
 * Three overloads: a trace yields `unreached`, a Resolver yields none, and a source only known
 * as the union of the two (a wrapper forwarding whatever it was handed) yields it as optional.
 */
export declare function replayEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    trace: TraceLog | TraceEntry[],
    options?: ReplayOptions<Ctx>
): Promise<Replay<T, E>>;
export declare function replayEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    resolver: Resolver,
    options?: ReplayOptions<Ctx>
): Promise<Omit<Replay<T, E>, 'unreached'>>;
export declare function replayEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    traceOrResolver: Resolver | TraceLog | TraceEntry[],
    options?: ReplayOptions<Ctx>
): Promise<Omit<Replay<T, E>, 'unreached'> & { unreached?: TraceEntry[] }>;

export declare function timeTravel<T, E = unknown, Ctx = unknown>(
    flowFn: (input: any) => Effect<T, E, Ctx>,
    traceLog: TraceLog,
    options?: { log?: (...args: any[]) => void; context?: Ctx; version?: string }
): Promise<SuccessState<T> | FailureState<E>>;
