export type SuccessState<T> = {
    type: 'Success';
    value: T;
};

export type FailureState<E = unknown> = {
    type: 'Failure';
    error: E;
};

/**
 * Metadata for a Command. `name` is its name in traces, replays and spans; other keys reach `onBeforeCommand` as they
 * are.
 */
export type CommandMeta = { name?: string } & Record<string, unknown>;

export type CommandState<R, T, E = unknown, Ctx = unknown> = {
    type: 'Command';
    /**
     * Makes the call. Inside a `Parallel` it gets an `AbortSignal` that fires when a sibling branch fails; pass it on
     * to cancel the work.
     */
    cmd: (signal?: AbortSignal) => Promise<R> | R;
    // A method rather than a function property, so a `cmd` that only throws still fits `Effect`.
    /** Receives `cmd`'s result and returns the next step. */
    next(result: R): Effect<T, E, Ctx>;
    meta?: CommandMeta;
};

export type AskState<T, E = unknown, Ctx = unknown> = {
    type: 'Ask';
    next(context: Ctx): Effect<T, E, Ctx>;
};

// Every optional option and hook takes `undefined`, which keeps its default, under `exactOptionalPropertyTypes` too.
export type RetryOptions = {
    /** Tries after the first, so `2` makes at most 3 calls. A positive integer, 3 by default. */
    attempts?: number | undefined;
    /** Milliseconds before the first retry, 100 by default. */
    delay?: number | undefined;
    /** Multiplies the wait before each later retry, so `2` doubles it. 1 by default, the same wait each time. */
    backoff?: number | undefined;
};

/**
 * `E` is what the Retry can fail with: an abort from the steps it wraps, or the exhaustion after its last attempt. `R`
 * is what the retried steps succeed with, which `next` receives; it differs from `T` once a pipeline continues past it.
 */
export type RetryState<T, E = unknown, Ctx = unknown, R = T> = {
    type: 'Retry';
    effect: Effect<R, any, Ctx>;
    options: RetryOptions & { onExhausted?: (error: RetryExhaustedError) => Effect<R, any, Ctx> };
    next(value: R): Effect<T, E, Ctx>;
};

/** The error a `Retry` fails with once every attempt has thrown. `lastError` is what the last attempt threw. */
export type RetryExhaustedError<Thrown = unknown> = {
    retryExhausted: true;
    lastError: Thrown;
    /** The `attempts` option: tries after the first, so the retried steps ran one more time than this. */
    attempts: number;
};

export type ParallelOptions = {
    /** Most branches in flight at once. Results and paths stay in array order regardless. */
    limit?: number | undefined;
    /** Hand every branch's outcome to `next` instead of failing on the first one. */
    settled?: boolean | undefined;
};

/** `V` is what `next` receives: the branch values, or their outcomes under `settled`. `BranchError` types `effects`. */
export type ParallelState<
    T extends readonly unknown[],
    R,
    E = unknown,
    Ctx = unknown,
    V extends readonly unknown[] = T,
    BranchError = E
> = {
    type: 'Parallel';
    effects: { [K in keyof T]: Effect<T[K], BranchError, Ctx> };
    next(values: [...V]): Effect<R, E, Ctx>;
    options?: ParallelOptions;
};

export type Effect<T, E = unknown, Ctx = unknown> =
    | SuccessState<T>
    | FailureState<E>
    | CommandState<any, T, E, Ctx>
    | AskState<T, E, Ctx>
    | RetryState<T, E, Ctx, any>
    | ParallelState<any, T, E, Ctx, any, any>;

// No type parameters, so as the constraint on a callback's return it gives a call written inline there nothing to infer.
/** Any Effect: a `Success`, `Failure`, `Command`, `Ask`, `Retry` or `Parallel`. */
export type AnyEffect = { readonly type: 'Success' | 'Failure' | 'Command' | 'Ask' | 'Retry' | 'Parallel' };

/** The value an Effect succeeds with. */
export type EffectValue<X> =
    X extends SuccessState<infer T>
        ? T
        : X extends CommandState<any, infer T, any, any>
          ? T
          : X extends AskState<infer T, any, any>
            ? T
            : X extends RetryState<infer T, any, any, any>
              ? T
              : X extends ParallelState<any, infer T, any, any, any, any>
                ? T
                : never;

/** The error an Effect can fail with: what it returns as a `Failure`, not what a Command's function throws. */
export type EffectError<X> =
    X extends FailureState<infer E>
        ? E
        : X extends CommandState<any, any, infer E, any>
          ? E
          : X extends AskState<any, infer E, any>
            ? E
            : X extends RetryState<any, infer E, any, any>
              ? E
              : X extends ParallelState<any, any, infer E, any, any, any>
                ? E
                : never;

/** The context an Effect reads, which is `unknown` for a `Success` or `Failure`, since they read none. */
export type EffectContext<X> = [X] extends [SuccessState<any> | FailureState<any>]
    ? unknown
    : X extends CommandState<any, any, any, infer C>
      ? C
      : X extends AskState<any, any, infer C>
        ? C
        : X extends RetryState<any, any, infer C, any>
          ? C
          : X extends ParallelState<any, any, any, infer C, any, any>
            ? C
            : never;

// Checked by a conditional, not a constraint: a constraint types an inline Ask's or Retry's error as any.
/** The branches `Parallel` accepts: each one an Effect. */
export type ParallelBranches<B> = B &
    (B extends readonly Effect<any, any, any>[] ? unknown : readonly Effect<any, any, any>[]);

/** The value of each branch, in array order: what `next` receives. */
export type ParallelValues<B extends readonly unknown[]> = { -readonly [K in keyof B]: EffectValue<B[K]> };

/** What a settled `Parallel` hands to `next`: one outcome per branch, in array order, with that branch's error. */
export type ParallelOutcomes<B extends readonly unknown[]> = {
    -readonly [K in keyof B]: SuccessState<EffectValue<B[K]>> | FailureState<EffectError<B[K]>>;
};

/** Every branch's context together, which is what `runEffect` needs for a `Parallel`. */
export type ParallelContext<B extends readonly unknown[]> = {
    [K in keyof B]: (context: EffectContext<B[K]>) => void;
}[number] extends (context: infer Ctx) => void
    ? Ctx
    : unknown;

/**
 * Wraps a value for the next step. A string in an object widens to `string`, as in any object literal; write
 * `Success<T>(...)` where a later step tells values apart by it.
 */
export declare function Success<T>(value: T): SuccessState<T>;

/** Stops the pipeline with `error`. A literal keeps its exact type, and an object or array error is readonly. */
export declare function Failure<const E = unknown>(error: E): FailureState<E>;

/**
 * Defers a side effect: `cmd` makes the call and `next` decides what follows; without `next` the result passes through.
 * `meta.name` names it, else `cmd.name`.
 */
export declare function Command<R>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: undefined,
    meta?: CommandMeta
): CommandState<R, R, never>;

// `N` is what `next` returns, whole, so Failures of different shapes join; given explicitly, `T`, `E` and `Ctx` build it.
export declare function Command<R, T = never, E = never, Ctx = unknown, N extends AnyEffect = Effect<T, E, Ctx>>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: (result: R) => N,
    meta?: CommandMeta
): CommandState<R, EffectValue<N>, EffectError<N>, EffectContext<N>>;

/** For `Command<User | null>(fetchJson, next)`: given some type arguments, TypeScript infers none of the rest. */
export declare function Command<R, T = R, E = unknown, Ctx = unknown>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: (result: R) => Effect<T, E, Ctx>,
    meta?: CommandMeta
): CommandState<R, T, E, Ctx>;

/** The name a Command is known by in traces, replays and spans: `meta.name`, else `cmd.name`, else `'anonymous'`. */
export declare function commandName(command: CommandState<any, any, any, any>): string;

/** Reads the context passed to `runEffect`. Give the value, error and context types, or none. */
export declare function Ask<T = never, E = never, Ctx = unknown, N extends AnyEffect = Effect<T, E, Ctx>>(
    next: (context: Ctx) => N
): AskState<EffectValue<N>, EffectError<N>, Ctx & EffectContext<N>>;

/**
 * Runs `effect` again when a Command in it throws, then runs `onExhausted` once the attempts run out. Give every type
 * argument or none.
 */
export declare function Retry<T, E = never, E2 = never, Ctx = unknown, N extends AnyEffect = Effect<T, E2, Ctx>>(
    effect: Effect<T, E, Ctx>,
    options: RetryOptions & { onExhausted: (error: RetryExhaustedError) => N }
): RetryState<T | EffectValue<N>, E | EffectError<N>, Ctx & EffectContext<N>>;

/**
 * Runs `effect` again when a Command in it throws, and fails with `RetryExhaustedError` once the attempts run out. Give
 * every type argument or none.
 */
export declare function Retry<T, E = never, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options?: RetryOptions
): RetryState<T, E | RetryExhaustedError, Ctx>;

// `settled?: false | undefined` keeps a `settled` typed boolean from matching; `| []` infers tuples on TypeScript 5.1.
/**
 * Runs the branches at the same time and hands `next` their values in order. The first to fail cancels the rest, unless
 * `settled`, which hands `next` every outcome.
 */
export declare function Parallel<B extends readonly unknown[] | []>(
    effects: ParallelBranches<B>,
    options: ParallelOptions & { settled: true }
): ParallelState<
    ParallelValues<B>,
    ParallelOutcomes<B>,
    never,
    ParallelContext<B>,
    ParallelOutcomes<B>,
    EffectError<B[number]>
>;

export declare function Parallel<B extends readonly unknown[] | [], N extends AnyEffect = never>(
    effects: ParallelBranches<B>,
    next: (outcomes: ParallelOutcomes<B>) => N,
    options: ParallelOptions & { settled: true }
): ParallelState<
    ParallelValues<B>,
    EffectValue<N>,
    EffectError<N>,
    ParallelContext<B> & EffectContext<N>,
    ParallelOutcomes<B>,
    EffectError<B[number]>
>;

export declare function Parallel<B extends readonly unknown[] | []>(
    effects: ParallelBranches<B>,
    options?: ParallelOptions & { settled?: false | undefined }
): ParallelState<ParallelValues<B>, ParallelValues<B>, EffectError<B[number]>, ParallelContext<B>>;

export declare function Parallel<B extends readonly unknown[] | [], N extends AnyEffect = never>(
    effects: ParallelBranches<B>,
    next: (values: ParallelValues<B>) => N,
    options?: ParallelOptions & { settled?: false | undefined }
): ParallelState<
    ParallelValues<B>,
    EffectValue<N>,
    EffectError<B[number]> | EffectError<N>,
    ParallelContext<B> & EffectContext<N>
>;

// BEGIN effectPipe overloads, generated by scripts/effect-pipe-overloads.js: edit it, then npm run generate.
/**
 * Composes steps into a pipeline: each step gets the previous step's value, and a `Failure` stops it.
 * Typed for up to 20 steps; nest pipelines for more.
 */
export declare function effectPipe<T0, R1 extends AnyEffect = never>(
    f1: (value: T0) => R1
): (start: T0) => Effect<EffectValue<R1>, EffectError<R1>, EffectContext<R1>>;

export declare function effectPipe<T0, R1 extends AnyEffect = never, R2 extends AnyEffect = never>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2
): (start: T0) => Effect<EffectValue<R2>, EffectError<R1> | EffectError<R2>, EffectContext<R1> & EffectContext<R2>>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3
): (
    start: T0
) => Effect<
    EffectValue<R3>,
    EffectError<R1> | EffectError<R2> | EffectError<R3>,
    EffectContext<R1> & EffectContext<R2> & EffectContext<R3>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4
): (
    start: T0
) => Effect<
    EffectValue<R4>,
    EffectError<R1> | EffectError<R2> | EffectError<R3> | EffectError<R4>,
    EffectContext<R1> & EffectContext<R2> & EffectContext<R3> & EffectContext<R4>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5
): (
    start: T0
) => Effect<
    EffectValue<R5>,
    EffectError<R1> | EffectError<R2> | EffectError<R3> | EffectError<R4> | EffectError<R5>,
    EffectContext<R1> & EffectContext<R2> & EffectContext<R3> & EffectContext<R4> & EffectContext<R5>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6
): (
    start: T0
) => Effect<
    EffectValue<R6>,
    EffectError<R1> | EffectError<R2> | EffectError<R3> | EffectError<R4> | EffectError<R5> | EffectError<R6>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7
): (
    start: T0
) => Effect<
    EffectValue<R7>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8
): (
    start: T0
) => Effect<
    EffectValue<R8>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9
): (
    start: T0
) => Effect<
    EffectValue<R9>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10
): (
    start: T0
) => Effect<
    EffectValue<R10>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11
): (
    start: T0
) => Effect<
    EffectValue<R11>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12
): (
    start: T0
) => Effect<
    EffectValue<R12>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13
): (
    start: T0
) => Effect<
    EffectValue<R13>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14
): (
    start: T0
) => Effect<
    EffectValue<R14>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never,
    R15 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14,
    f15: (value: EffectValue<R14>) => R15
): (
    start: T0
) => Effect<
    EffectValue<R15>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>
    | EffectError<R15>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14> &
        EffectContext<R15>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never,
    R15 extends AnyEffect = never,
    R16 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14,
    f15: (value: EffectValue<R14>) => R15,
    f16: (value: EffectValue<R15>) => R16
): (
    start: T0
) => Effect<
    EffectValue<R16>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>
    | EffectError<R15>
    | EffectError<R16>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14> &
        EffectContext<R15> &
        EffectContext<R16>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never,
    R15 extends AnyEffect = never,
    R16 extends AnyEffect = never,
    R17 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14,
    f15: (value: EffectValue<R14>) => R15,
    f16: (value: EffectValue<R15>) => R16,
    f17: (value: EffectValue<R16>) => R17
): (
    start: T0
) => Effect<
    EffectValue<R17>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>
    | EffectError<R15>
    | EffectError<R16>
    | EffectError<R17>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14> &
        EffectContext<R15> &
        EffectContext<R16> &
        EffectContext<R17>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never,
    R15 extends AnyEffect = never,
    R16 extends AnyEffect = never,
    R17 extends AnyEffect = never,
    R18 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14,
    f15: (value: EffectValue<R14>) => R15,
    f16: (value: EffectValue<R15>) => R16,
    f17: (value: EffectValue<R16>) => R17,
    f18: (value: EffectValue<R17>) => R18
): (
    start: T0
) => Effect<
    EffectValue<R18>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>
    | EffectError<R15>
    | EffectError<R16>
    | EffectError<R17>
    | EffectError<R18>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14> &
        EffectContext<R15> &
        EffectContext<R16> &
        EffectContext<R17> &
        EffectContext<R18>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never,
    R15 extends AnyEffect = never,
    R16 extends AnyEffect = never,
    R17 extends AnyEffect = never,
    R18 extends AnyEffect = never,
    R19 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14,
    f15: (value: EffectValue<R14>) => R15,
    f16: (value: EffectValue<R15>) => R16,
    f17: (value: EffectValue<R16>) => R17,
    f18: (value: EffectValue<R17>) => R18,
    f19: (value: EffectValue<R18>) => R19
): (
    start: T0
) => Effect<
    EffectValue<R19>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>
    | EffectError<R15>
    | EffectError<R16>
    | EffectError<R17>
    | EffectError<R18>
    | EffectError<R19>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14> &
        EffectContext<R15> &
        EffectContext<R16> &
        EffectContext<R17> &
        EffectContext<R18> &
        EffectContext<R19>
>;

export declare function effectPipe<
    T0,
    R1 extends AnyEffect = never,
    R2 extends AnyEffect = never,
    R3 extends AnyEffect = never,
    R4 extends AnyEffect = never,
    R5 extends AnyEffect = never,
    R6 extends AnyEffect = never,
    R7 extends AnyEffect = never,
    R8 extends AnyEffect = never,
    R9 extends AnyEffect = never,
    R10 extends AnyEffect = never,
    R11 extends AnyEffect = never,
    R12 extends AnyEffect = never,
    R13 extends AnyEffect = never,
    R14 extends AnyEffect = never,
    R15 extends AnyEffect = never,
    R16 extends AnyEffect = never,
    R17 extends AnyEffect = never,
    R18 extends AnyEffect = never,
    R19 extends AnyEffect = never,
    R20 extends AnyEffect = never
>(
    f1: (value: T0) => R1,
    f2: (value: EffectValue<R1>) => R2,
    f3: (value: EffectValue<R2>) => R3,
    f4: (value: EffectValue<R3>) => R4,
    f5: (value: EffectValue<R4>) => R5,
    f6: (value: EffectValue<R5>) => R6,
    f7: (value: EffectValue<R6>) => R7,
    f8: (value: EffectValue<R7>) => R8,
    f9: (value: EffectValue<R8>) => R9,
    f10: (value: EffectValue<R9>) => R10,
    f11: (value: EffectValue<R10>) => R11,
    f12: (value: EffectValue<R11>) => R12,
    f13: (value: EffectValue<R12>) => R13,
    f14: (value: EffectValue<R13>) => R14,
    f15: (value: EffectValue<R14>) => R15,
    f16: (value: EffectValue<R15>) => R16,
    f17: (value: EffectValue<R16>) => R17,
    f18: (value: EffectValue<R17>) => R18,
    f19: (value: EffectValue<R18>) => R19,
    f20: (value: EffectValue<R19>) => R20
): (
    start: T0
) => Effect<
    EffectValue<R20>,
    | EffectError<R1>
    | EffectError<R2>
    | EffectError<R3>
    | EffectError<R4>
    | EffectError<R5>
    | EffectError<R6>
    | EffectError<R7>
    | EffectError<R8>
    | EffectError<R9>
    | EffectError<R10>
    | EffectError<R11>
    | EffectError<R12>
    | EffectError<R13>
    | EffectError<R14>
    | EffectError<R15>
    | EffectError<R16>
    | EffectError<R17>
    | EffectError<R18>
    | EffectError<R19>
    | EffectError<R20>,
    EffectContext<R1> &
        EffectContext<R2> &
        EffectContext<R3> &
        EffectContext<R4> &
        EffectContext<R5> &
        EffectContext<R6> &
        EffectContext<R7> &
        EffectContext<R8> &
        EffectContext<R9> &
        EffectContext<R10> &
        EffectContext<R11> &
        EffectContext<R12> &
        EffectContext<R13> &
        EffectContext<R14> &
        EffectContext<R15> &
        EffectContext<R16> &
        EffectContext<R17> &
        EffectContext<R18> &
        EffectContext<R19> &
        EffectContext<R20>
>;
// END effectPipe overloads.

/**
 * Wraps each Command, and each `Parallel`. Call `op` and return its result; a hook that calls another passes `path` on.
 */
export type StepRunner = (
    name: string,
    type: string,
    op: (decision?: ParallelDecision) => Promise<unknown>,
    path: string
) => Promise<unknown>;

/** Which branch, if any, cancelled a `Parallel`; `branch: null` means an enclosing one did. */
export type ParallelDecision = { cancelled: false } | { cancelled: true; branch: number | null };

/**
 * `flowName` is `context.flowName`, or `''` when the context has none. `initialInput` is what the flow was called with
 * when `effectPipe` built it, and `undefined` otherwise. A hook that calls another passes both on.
 */
export type RunWrapper = (
    effect: Effect<unknown>,
    op: () => Promise<SuccessState<unknown> | FailureState<unknown>>,
    flowName: string,
    initialInput: unknown
) => Promise<SuccessState<unknown> | FailureState<unknown>>;

// A union, so a JSDoc `@type` on an async function fits it too.
/** Runs before each Command; throw to stop it. It need not be async. */
export type CommandInterceptor =
    | ((command: CommandState<unknown, unknown>, context?: any) => Promise<void>)
    | ((command: CommandState<unknown, unknown>, context?: any) => void);

export interface EffectConfiguration {
    onStep?: StepRunner | undefined;
    onRun?: RunWrapper | undefined;
    onBeforeCommand?: CommandInterceptor | undefined;
}

/** Adds a layer of hooks and returns a function that removes it. With no arguments, removes every layer. */
export declare function configureEffect(...configs: (EffectConfiguration | undefined)[]): () => void;

/** Hooks for one `runEffect` call, inside the installed ones; `inherit: false` leaves those out. */
export type CallConfiguration = EffectConfiguration & { inherit?: boolean | undefined };

/** The context a run is given: what the flow reads, and a `flowName` naming the run in traces and spans. */
export type RunContext<Ctx> = unknown extends Ctx
    ? Ctx
    : Ctx extends object
      ? Ctx & { flowName?: string | undefined }
      : Ctx;

/** Runs a flow and returns its `Success` or `Failure`. A flow that reads a context requires one. */
export declare function runEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    ...args: unknown extends Ctx
        ? [context?: Ctx, callConfig?: CallConfiguration]
        : [context: RunContext<Ctx>, callConfig?: CallConfiguration]
): Promise<SuccessState<T> | FailureState<E>>;

export type ReplayStep = {
    /** Position in completion order, which varies with a `Parallel`; prefer `path`. */
    index: number;
    /** `meta.name`, `cmd.name`, or 'anonymous'; 'Parallel' for a `Parallel`'s step. */
    name: string;
    /** `'Command'`, or `'Parallel'` for a `Parallel`'s decision. */
    type: string;
    /** The step's position in the flow, the same in every run; a Resolver should key off it. */
    path: string;
};

/**
 * What production got for a step: `{ result }` or `{ error }`. A Resolver returns `undefined` for a step it has no
 * record of.
 */
export type ReplayOutcome = { result: unknown } | { error: unknown };

/** Answers a step from a recording. Any other answer than an outcome or `undefined`, or a throw, rejects the replay. */
export type Resolver = (step: ReplayStep) => ReplayOutcome | undefined;

/** One recorded step: a Command's result or error, or a `Parallel`'s decision. */
export type TraceEntry = {
    command: string;
    /** The step's position in the flow, which a replay matches on. */
    path?: string;
    result?: unknown;
    /** Marks a step that threw; `false` is the same as leaving it out. */
    threw?: boolean;
    error?: unknown;
    /** Why the entry holds no value: `'redact'` threw on it, or copying it threw (`'copy'`). A replay stops there. */
    unrecorded?: string;
    /** How long the Command took in production, rounded to microseconds. */
    durationMs?: number;
};

/** The reference trace format; for any other, write a Resolver. `I` and `C` are the input and context types. */
export type TraceLog<I = unknown, C = unknown> = {
    flowName?: string;
    version?: string;
    initialInput?: I;
    context?: C;
    /** Why the trace holds no `initialInput` or `context`, as an entry's `unrecorded` says it for a step. */
    unrecorded?: { initialInput?: string; context?: string };
    dropped?: number;
    trace: TraceEntry[];
};

export interface RecorderOptions {
    /**
     * Scrubs each value before it enters a trace; `kind` says which. It gets a copy, so editing it in place is safe.
     */
    redact?: ((value: any, name: string, kind: 'result' | 'error' | 'initialInput' | 'context') => unknown) | undefined;
    /** Cap trace length; further steps are counted in `dropped`, not stored. */
    maxEntries?: number | undefined;
    /** Record stack traces for thrown errors. Off by default. */
    stack?: boolean | undefined;
}

/** The trace's own fields, as `toTrace` takes them; the returned trace keeps the input's and context's types. */
export interface TraceMeta<I = unknown, C = unknown> {
    initialInput?: I;
    flowName?: string | undefined;
    context?: C;
    /** Accepts `undefined`, so `process.env.BUILD_ID` passes under `exactOptionalPropertyTypes`. */
    version?: string | undefined;
}

/** An `onStep` hook that records each step, and `toTrace` to package the recording as a trace. */
export declare function recorder(options?: RecorderOptions): {
    onStep: StepRunner;
    entries: TraceEntry[];
    toTrace<I = unknown, C = unknown>(meta?: TraceMeta<I, C>): TraceLog<I, C>;
};

/** `recordEffect`'s options: recorder options, plus the context the run gets and a build id. */
export type RecordOptions<Ctx = unknown> = RecorderOptions & {
    context?: RunContext<Ctx> | undefined;
    version?: string | undefined;
};

/**
 * Runs a flow for real and returns its outcome with a trace, which keeps the input's type for the replay. That type is
 * wrong when `redact` changes the input, or the trace marks it `unrecorded`.
 */
export declare function recordEffect<I, T, E = unknown, Ctx = unknown>(
    flowFn: (input: I) => Effect<T, E, Ctx>,
    initialInput: I,
    ...options: unknown extends Ctx
        ? [options?: RecordOptions<Ctx>]
        : [options: RecordOptions<Ctx> & { context: RunContext<Ctx> }]
): Promise<{ result: SuccessState<T> | FailureState<E>; trace: TraceLog<I, Ctx> & { initialInput: I } }>;

export interface ReplayOptions<Ctx = unknown> {
    /** Context for `Ask`; defaults to the one the trace recorded. */
    context?: RunContext<Ctx> | undefined;
    /** Strip `Retry` delays so a replay does not wait out production backoff (default `true`). */
    fastRetry?: boolean | undefined;
    /** Runs the replay inside the installed hooks, so they see it. Off by default. */
    hooks?: boolean | undefined;
    /**
     * `'throw'` (default) fails on a step the trace lacks. `'execute'` runs it for real: use it only against test
     * doubles.
     */
    onMissing?: 'throw' | 'execute' | undefined;
    onResolved?: ((step: ReplayStep, outcome: ReplayOutcome | undefined) => void) | undefined;
}

/** The replay's outcome and, for a trace, the recorded steps the flow never asked for. */
export interface Replay<T, E = unknown> {
    result: SuccessState<T> | FailureState<E>;
    unreached: TraceEntry[];
}

/** Replays a flow from a trace, or from a Resolver for other storage, with no I/O. */
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

/** Replays a trace and logs each step with its recorded timing, warning about what will not replay as recorded. */
export declare function timeTravel<T, E = unknown, Ctx = unknown>(
    flowFn: (input: any) => Effect<T, E, Ctx>,
    traceLog: TraceLog,
    options?: {
        log?: ((...args: any[]) => void) | undefined;
        context?: RunContext<Ctx> | undefined;
        version?: string | undefined;
    }
): Promise<SuccessState<T> | FailureState<E>>;
