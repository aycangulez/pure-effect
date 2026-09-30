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

/** `E` is what the Retry can fail with: an abort from the steps it wraps, or the exhaustion after its last attempt. */
export type RetryState<T, E = unknown, Ctx = unknown> = {
    type: 'Retry';
    effect: Effect<T, any, Ctx>;
    options: RetryOptions & { onExhausted?: (error: RetryExhaustedError) => Effect<T, any, Ctx> };
    next(value: T): Effect<T, E, Ctx>;
    initialInput?: unknown;
};

/** The error a `Retry` fails with once every attempt has thrown. `lastError` is what the last attempt threw. */
export type RetryExhaustedError<Thrown = unknown> = {
    retryExhausted: true;
    lastError: Thrown;
    attempts: number;
};

export type ParallelOptions = {
    /** Most branches in flight at once. Results and paths stay in array order regardless. */
    limit?: number;
    /** Hand every branch's outcome to `next` instead of failing on the first one. */
    settled?: boolean;
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
    initialInput?: unknown;
};

export type Effect<T, E = unknown, Ctx = unknown> =
    | SuccessState<T>
    | FailureState<E>
    | CommandState<any, T, E, Ctx>
    | AskState<T, E, Ctx>
    | RetryState<T, E, Ctx>
    | ParallelState<any, T, E, Ctx, any, any>;

/** The value an Effect succeeds with. */
export type EffectValue<X> =
    X extends SuccessState<infer T>
        ? T
        : X extends CommandState<any, infer T, any, any>
          ? T
          : X extends AskState<infer T, any, any>
            ? T
            : X extends RetryState<infer T, any, any>
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
            : X extends RetryState<any, infer E, any>
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
        : X extends RetryState<any, any, infer C>
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

/** Wraps a value for the next step. */
export declare function Success<T>(value: T): SuccessState<T>;

/** Stops the pipeline with `error`. A literal keeps its exact type, and an object or array error is readonly. */
export declare function Failure<const E = unknown>(error: E, initialInput?: unknown): FailureState<E>;

/**
 * Defers a side effect: `cmd` makes the call and `next` decides what follows; without `next` the result passes through.
 * `meta.name` names it, else `cmd.name`.
 */
export declare function Command<R>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: undefined,
    meta?: CommandMeta
): CommandState<R, R, never>;

export declare function Command<R, T = never, E = never, Ctx = unknown>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: (result: R) => Effect<T, E, Ctx>,
    meta?: CommandMeta
): CommandState<R, T, E, Ctx>;

/** For `Command<User | null>(fetchJson, next)`: given some type arguments, TypeScript infers none of the rest. */
export declare function Command<R, T = R, E = unknown, Ctx = unknown>(
    cmd: (signal?: AbortSignal) => Promise<R> | R,
    next?: (result: R) => Effect<T, E, Ctx>,
    meta?: CommandMeta
): CommandState<R, T, E, Ctx>;

/** Reads the context passed to `runEffect`. Give every type argument or none. */
export declare function Ask<T = never, E = never, Ctx = unknown>(
    next: (context: Ctx) => Effect<T, E, Ctx>
): AskState<T, E, Ctx>;

/**
 * Runs `effect` again when a Command in it throws, then runs `onExhausted` once the attempts run out. Give every type
 * argument or none.
 */
export declare function Retry<T, E = never, E2 = never, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options: RetryOptions & { onExhausted: (error: RetryExhaustedError) => Effect<T, E2, Ctx> }
): RetryState<T, E | E2, Ctx>;

/**
 * Runs `effect` again when a Command in it throws, and fails with `RetryExhaustedError` once the attempts run out. Give
 * every type argument or none.
 */
export declare function Retry<T, E = never, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options?: RetryOptions
): RetryState<T, E | RetryExhaustedError, Ctx>;

// `settled?: false` keeps a `settled` known only as boolean from matching; `| []` infers tuples on TypeScript 5.1.
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

export declare function Parallel<B extends readonly unknown[] | [], R = never, E = never, Ctx = unknown>(
    effects: ParallelBranches<B>,
    next: (outcomes: ParallelOutcomes<B>) => Effect<R, E, Ctx>,
    options: ParallelOptions & { settled: true }
): ParallelState<ParallelValues<B>, R, E, ParallelContext<B> & Ctx, ParallelOutcomes<B>, EffectError<B[number]>>;

export declare function Parallel<B extends readonly unknown[] | []>(
    effects: ParallelBranches<B>,
    options?: ParallelOptions & { settled?: false }
): ParallelState<ParallelValues<B>, ParallelValues<B>, EffectError<B[number]>, ParallelContext<B>>;

export declare function Parallel<B extends readonly unknown[] | [], R = never, E = never, Ctx = unknown>(
    effects: ParallelBranches<B>,
    next: (values: ParallelValues<B>) => Effect<R, E, Ctx>,
    options?: ParallelOptions & { settled?: false }
): ParallelState<
    ParallelValues<B>,
    R,
    // `E` alone would be inferred from the expected return type as well as from `next`, and inside
    // `effectPipe`'s arguments, where that type is still being inferred, it came out as `any`. The indexed
    // access resolves to `E` but offers nothing to infer from, as `NoInfer` would, which needs TypeScript 5.4.
    EffectError<B[number]> | [E][E extends any ? 0 : never],
    ParallelContext<B> & Ctx
>;

// BEGIN effectPipe overloads, generated by scripts/effect-pipe-overloads.js: edit it, then npm run generate.
/**
 * Composes steps into a pipeline: each step gets the previous step's value, and a `Failure` stops it.
 * Typed for up to 20 steps; nest pipelines for more.
 */
export declare function effectPipe<T0, T1 = never, E1 = never, C1 = unknown>(
    f1: (value: T0) => Effect<T1, E1, C1>
): (start: T0) => Effect<T1, E1, C1>;

export declare function effectPipe<T0, T1 = never, T2 = never, E1 = never, E2 = never, C1 = unknown, C2 = unknown>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>
): (start: T0) => Effect<T2, E1 | E2, C1 & C2>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>
): (start: T0) => Effect<T3, E1 | E2 | E3, C1 & C2 & C3>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>
): (start: T0) => Effect<T4, E1 | E2 | E3 | E4, C1 & C2 & C3 & C4>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>
): (start: T0) => Effect<T5, E1 | E2 | E3 | E4 | E5, C1 & C2 & C3 & C4 & C5>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>
): (start: T0) => Effect<T6, E1 | E2 | E3 | E4 | E5 | E6, C1 & C2 & C3 & C4 & C5 & C6>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>
): (start: T0) => Effect<T7, E1 | E2 | E3 | E4 | E5 | E6 | E7, C1 & C2 & C3 & C4 & C5 & C6 & C7>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>
): (start: T0) => Effect<T8, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8, C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>
): (start: T0) => Effect<T9, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9, C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>
): (
    start: T0
) => Effect<T10, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10, C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>
): (
    start: T0
) => Effect<
    T11,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>
): (
    start: T0
) => Effect<
    T12,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>
): (
    start: T0
) => Effect<
    T13,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>
): (
    start: T0
) => Effect<
    T14,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    T15 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    E15 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown,
    C15 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>,
    f15: (value: T14) => Effect<T15, E15, C15>
): (
    start: T0
) => Effect<
    T15,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14 & C15
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    T15 = never,
    T16 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    E15 = never,
    E16 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown,
    C15 = unknown,
    C16 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>,
    f15: (value: T14) => Effect<T15, E15, C15>,
    f16: (value: T15) => Effect<T16, E16, C16>
): (
    start: T0
) => Effect<
    T16,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14 & C15 & C16
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    T15 = never,
    T16 = never,
    T17 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    E15 = never,
    E16 = never,
    E17 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown,
    C15 = unknown,
    C16 = unknown,
    C17 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>,
    f15: (value: T14) => Effect<T15, E15, C15>,
    f16: (value: T15) => Effect<T16, E16, C16>,
    f17: (value: T16) => Effect<T17, E17, C17>
): (
    start: T0
) => Effect<
    T17,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14 & C15 & C16 & C17
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    T15 = never,
    T16 = never,
    T17 = never,
    T18 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    E15 = never,
    E16 = never,
    E17 = never,
    E18 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown,
    C15 = unknown,
    C16 = unknown,
    C17 = unknown,
    C18 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>,
    f15: (value: T14) => Effect<T15, E15, C15>,
    f16: (value: T15) => Effect<T16, E16, C16>,
    f17: (value: T16) => Effect<T17, E17, C17>,
    f18: (value: T17) => Effect<T18, E18, C18>
): (
    start: T0
) => Effect<
    T18,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17 | E18,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14 & C15 & C16 & C17 & C18
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    T15 = never,
    T16 = never,
    T17 = never,
    T18 = never,
    T19 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    E15 = never,
    E16 = never,
    E17 = never,
    E18 = never,
    E19 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown,
    C15 = unknown,
    C16 = unknown,
    C17 = unknown,
    C18 = unknown,
    C19 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>,
    f15: (value: T14) => Effect<T15, E15, C15>,
    f16: (value: T15) => Effect<T16, E16, C16>,
    f17: (value: T16) => Effect<T17, E17, C17>,
    f18: (value: T17) => Effect<T18, E18, C18>,
    f19: (value: T18) => Effect<T19, E19, C19>
): (
    start: T0
) => Effect<
    T19,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17 | E18 | E19,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14 & C15 & C16 & C17 & C18 & C19
>;

export declare function effectPipe<
    T0,
    T1 = never,
    T2 = never,
    T3 = never,
    T4 = never,
    T5 = never,
    T6 = never,
    T7 = never,
    T8 = never,
    T9 = never,
    T10 = never,
    T11 = never,
    T12 = never,
    T13 = never,
    T14 = never,
    T15 = never,
    T16 = never,
    T17 = never,
    T18 = never,
    T19 = never,
    T20 = never,
    E1 = never,
    E2 = never,
    E3 = never,
    E4 = never,
    E5 = never,
    E6 = never,
    E7 = never,
    E8 = never,
    E9 = never,
    E10 = never,
    E11 = never,
    E12 = never,
    E13 = never,
    E14 = never,
    E15 = never,
    E16 = never,
    E17 = never,
    E18 = never,
    E19 = never,
    E20 = never,
    C1 = unknown,
    C2 = unknown,
    C3 = unknown,
    C4 = unknown,
    C5 = unknown,
    C6 = unknown,
    C7 = unknown,
    C8 = unknown,
    C9 = unknown,
    C10 = unknown,
    C11 = unknown,
    C12 = unknown,
    C13 = unknown,
    C14 = unknown,
    C15 = unknown,
    C16 = unknown,
    C17 = unknown,
    C18 = unknown,
    C19 = unknown,
    C20 = unknown
>(
    f1: (value: T0) => Effect<T1, E1, C1>,
    f2: (value: T1) => Effect<T2, E2, C2>,
    f3: (value: T2) => Effect<T3, E3, C3>,
    f4: (value: T3) => Effect<T4, E4, C4>,
    f5: (value: T4) => Effect<T5, E5, C5>,
    f6: (value: T5) => Effect<T6, E6, C6>,
    f7: (value: T6) => Effect<T7, E7, C7>,
    f8: (value: T7) => Effect<T8, E8, C8>,
    f9: (value: T8) => Effect<T9, E9, C9>,
    f10: (value: T9) => Effect<T10, E10, C10>,
    f11: (value: T10) => Effect<T11, E11, C11>,
    f12: (value: T11) => Effect<T12, E12, C12>,
    f13: (value: T12) => Effect<T13, E13, C13>,
    f14: (value: T13) => Effect<T14, E14, C14>,
    f15: (value: T14) => Effect<T15, E15, C15>,
    f16: (value: T15) => Effect<T16, E16, C16>,
    f17: (value: T16) => Effect<T17, E17, C17>,
    f18: (value: T17) => Effect<T18, E18, C18>,
    f19: (value: T18) => Effect<T19, E19, C19>,
    f20: (value: T19) => Effect<T20, E20, C20>
): (
    start: T0
) => Effect<
    T20,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17 | E18 | E19 | E20,
    C1 & C2 & C3 & C4 & C5 & C6 & C7 & C8 & C9 & C10 & C11 & C12 & C13 & C14 & C15 & C16 & C17 & C18 & C19 & C20
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

/** `flowName` is `context.flowName`, or `''` when the context has none; the interpreter always passes it. */
export type RunWrapper = (
    effect: Effect<unknown>,
    op: () => Promise<SuccessState<unknown> | FailureState<unknown>>,
    flowName: string
) => Promise<SuccessState<unknown> | FailureState<unknown>>;

// A union, so a JSDoc `@type` on an async function fits it too.
/** Runs before each Command; throw to stop it. It need not be async. */
export type CommandInterceptor =
    | ((command: CommandState<unknown, unknown>, context?: any) => Promise<void>)
    | ((command: CommandState<unknown, unknown>, context?: any) => void);

export interface EffectConfiguration {
    onStep?: StepRunner;
    onRun?: RunWrapper;
    onBeforeCommand?: CommandInterceptor;
}

/** Adds a layer of hooks and returns a function that removes it. With no arguments, removes every layer. */
export declare function configureEffect(...configs: (EffectConfiguration | undefined)[]): () => void;

/** Hooks for one `runEffect` call, inside the installed ones; `inherit: false` leaves those out. */
export type CallConfiguration = EffectConfiguration & { inherit?: boolean };

/** Runs a flow and returns its `Success` or `Failure`. A flow that reads a context requires one. */
export declare function runEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    ...args: unknown extends Ctx
        ? [context?: Ctx, callConfig?: CallConfiguration]
        : [context: Ctx, callConfig?: CallConfiguration]
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
    /** How long the Command took in production, rounded to microseconds. */
    durationMs?: number;
};

/** The reference trace format; for any other, write a Resolver. `I` and `C` are the input and context types. */
export type TraceLog<I = unknown, C = unknown> = {
    flowName?: string;
    version?: string;
    initialInput?: I;
    context?: C;
    dropped?: number;
    trace: TraceEntry[];
};

export interface RecorderOptions {
    /**
     * Scrubs each value before it enters a trace; `kind` says which. It gets a copy, so editing it in place is safe.
     */
    redact?: (value: any, name: string, kind: 'result' | 'error' | 'initialInput' | 'context') => unknown;
    /** Cap trace length; further steps are counted in `dropped`, not stored. */
    maxEntries?: number;
    /** Record stack traces for thrown errors. Off by default. */
    stack?: boolean;
}

/** The trace's own fields, as `toTrace` takes them; the returned trace keeps the input's and context's types. */
export interface TraceMeta<I = unknown, C = unknown> {
    initialInput?: I;
    flowName?: string;
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
export type RecordOptions<Ctx = unknown> = RecorderOptions & { context?: Ctx; version?: string | undefined };

/** Runs a flow for real and returns its outcome with a trace, which keeps the input's type for the replay. */
export declare function recordEffect<I, T, E = unknown, Ctx = unknown>(
    flowFn: (input: I) => Effect<T, E, Ctx>,
    initialInput: I,
    ...options: unknown extends Ctx ? [options?: RecordOptions<Ctx>] : [options: RecordOptions<Ctx> & { context: Ctx }]
): Promise<{ result: SuccessState<T> | FailureState<E>; trace: TraceLog<I, Ctx> & { initialInput: I } }>;

export interface ReplayOptions<Ctx = unknown> {
    /** Context for `Ask`; defaults to the one the trace recorded. */
    context?: Ctx;
    /** Strip `Retry` delays so a replay does not wait out production backoff (default `true`). */
    fastRetry?: boolean;
    /** Runs the replay inside the installed hooks, so they see it. Off by default. */
    hooks?: boolean;
    /**
     * `'throw'` (default) fails on a step the trace lacks. `'execute'` runs it for real: use it only against test
     * doubles.
     */
    onMissing?: 'throw' | 'execute';
    onResolved?: (step: ReplayStep, outcome: ReplayOutcome | undefined) => void;
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

/** Replays a trace and logs each step, with its recorded timing. */
export declare function timeTravel<T, E = unknown, Ctx = unknown>(
    flowFn: (input: any) => Effect<T, E, Ctx>,
    traceLog: TraceLog,
    options?: { log?: (...args: any[]) => void; context?: Ctx; version?: string | undefined }
): Promise<SuccessState<T> | FailureState<E>>;
