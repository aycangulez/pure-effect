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
 * `E` is the error the node contributes to its pipeline. A Retry contributes two kinds: an abort the
 * wrapped tree returned, which is not retried and leaves unwrapped, and the exhaustion failure that
 * follows an I/O fault the retry loop could not get past.
 */
export type RetryState<T, E = unknown, Ctx = unknown> = {
    type: 'Retry';
    effect: Effect<T, any, Ctx>;
    options: RetryOptions & { onExhausted?: (error: RetryExhaustedError) => Effect<T, any, Ctx> };
    next(value: T): Effect<T, E, Ctx>;
    initialInput?: unknown;
};

/**
 * The error a `Retry` fails with once every attempt has hit an I/O fault. `lastError` is what the last
 * attempt threw: a Command's function throwing, or a nested `Retry` running out. It is never a `Failure`
 * a step returned, since that is an abort and is not retried, so the wrapped tree's error type cannot
 * reach it. Nothing declares what a function throws, so `Retry` leaves `Thrown` as `unknown`; pass it
 * only to annotate a value whose thrown type you already know.
 */
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

/** What a settled `Parallel` hands to `next`: one outcome per branch, in array order. */
export type ParallelOutcomes<T extends readonly unknown[], E> = {
    [K in keyof T]: SuccessState<T[K]> | FailureState<E>;
};

/**
 * `V` is what `next` receives, which is the branch values normally and the branch outcomes under
 * `settled`. It defaults to `T`, so every non-settled use reads as it always did.
 */
export type ParallelState<
    T extends readonly unknown[],
    R,
    E = unknown,
    Ctx = unknown,
    V extends readonly unknown[] = T
> = {
    type: 'Parallel';
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> };
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
 * fallback's own error type alongside `E`, since an abort the wrapped tree returned reaches neither
 * the retry loop nor the fallback and leaves as itself. `onExhausted` is a per-use option, and so is every other retry
 * option: there are no configured defaults for one to be carried by.
 */
export declare function Retry<T, E = unknown, E2 = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options: RetryOptions & { onExhausted: (error: RetryExhaustedError) => Effect<T, E2, Ctx> }
): RetryState<T, E | E2, Ctx>;

/**
 * Without `onExhausted`, an I/O fault the retry loop cannot get past arrives as
 * `Failure({ retryExhausted: true, lastError, attempts })`, with whatever was thrown as `lastError`.
 * An abort the wrapped tree returned is not retried and is not wrapped, so `E` reaches the pipeline
 * as itself and never as `lastError`.
 */
export declare function Retry<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options?: RetryOptions
): RetryState<T, E | RetryExhaustedError, Ctx>;

/**
 * `next` is optional and defaults to `(values) => Success(values)`, same as `Command`'s default,
 * so a bare `Parallel(effects)` resolves to the ordered array of success values. The second argument
 * is `next` or the options, whichever it looks like.
 */
export declare function Parallel<T extends readonly unknown[], E = unknown, Ctx = unknown>(
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> },
    options: ParallelOptions & { settled: true }
): ParallelState<[...T], ParallelOutcomes<T, E>, E, Ctx, ParallelOutcomes<T, E>>;

export declare function Parallel<T extends readonly unknown[], R, E = unknown, Ctx = unknown>(
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> },
    next: (values: ParallelOutcomes<T, E>) => Effect<R, E, Ctx>,
    options: ParallelOptions & { settled: true }
): ParallelState<[...T], R, E, Ctx, ParallelOutcomes<T, E>>;

export declare function Parallel<T extends readonly unknown[], E = unknown, Ctx = unknown>(
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> },
    options?: ParallelOptions
): ParallelState<[...T], [...T], E, Ctx>;

export declare function Parallel<T extends readonly unknown[], R, E = unknown, Ctx = unknown>(
    effects: { [K in keyof T]: Effect<T[K], E, Ctx> },
    next: (values: [...T]) => Effect<R, E, Ctx>,
    options?: ParallelOptions
): ParallelState<[...T], R, E, Ctx>;

/**
 * Composes steps into a pipeline: each step receives the previous step's success value, and a Failure
 * from any step stops the pipeline. Typed for 1 to 20 steps, the same ceiling as Effect-TS's `pipe`. A
 * pipeline is itself a step, so a longer one nests: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.
 */
export declare function effectPipe<T0, T1, E1 = unknown, Ctx = unknown>(
    f1: (value: T0) => Effect<T1, E1, Ctx>
): (start: T0) => Effect<T1, E1, Ctx>;

export declare function effectPipe<T0, T1, T2, E1 = unknown, E2 = unknown, Ctx = unknown>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>
): (start: T0) => Effect<T2, E1 | E2, Ctx>;

export declare function effectPipe<T0, T1, T2, T3, E1 = unknown, E2 = unknown, E3 = unknown, Ctx = unknown>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>
): (start: T0) => Effect<T3, E1 | E2 | E3, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>
): (start: T0) => Effect<T4, E1 | E2 | E3 | E4, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>
): (start: T0) => Effect<T5, E1 | E2 | E3 | E4 | E5, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>
): (start: T0) => Effect<T6, E1 | E2 | E3 | E4 | E5 | E6, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>
): (start: T0) => Effect<T7, E1 | E2 | E3 | E4 | E5 | E6 | E7, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
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
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>
): (start: T0) => Effect<T8, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>
): (start: T0) => Effect<T9, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>
): (start: T0) => Effect<T10, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>
): (start: T0) => Effect<T11, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>
): (start: T0) => Effect<T12, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>
): (start: T0) => Effect<T13, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>
): (start: T0) => Effect<T14, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    E15 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>,
    f15: (value: T14) => Effect<T15, E15, Ctx>
): (start: T0) => Effect<T15, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    T16,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    E15 = unknown,
    E16 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>,
    f15: (value: T14) => Effect<T15, E15, Ctx>,
    f16: (value: T15) => Effect<T16, E16, Ctx>
): (
    start: T0
) => Effect<T16, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    T16,
    T17,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    E15 = unknown,
    E16 = unknown,
    E17 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>,
    f15: (value: T14) => Effect<T15, E15, Ctx>,
    f16: (value: T15) => Effect<T16, E16, Ctx>,
    f17: (value: T16) => Effect<T17, E17, Ctx>
): (
    start: T0
) => Effect<T17, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    T16,
    T17,
    T18,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    E15 = unknown,
    E16 = unknown,
    E17 = unknown,
    E18 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>,
    f15: (value: T14) => Effect<T15, E15, Ctx>,
    f16: (value: T15) => Effect<T16, E16, Ctx>,
    f17: (value: T16) => Effect<T17, E17, Ctx>,
    f18: (value: T17) => Effect<T18, E18, Ctx>
): (
    start: T0
) => Effect<T18, E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17 | E18, Ctx>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    T16,
    T17,
    T18,
    T19,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    E15 = unknown,
    E16 = unknown,
    E17 = unknown,
    E18 = unknown,
    E19 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>,
    f15: (value: T14) => Effect<T15, E15, Ctx>,
    f16: (value: T15) => Effect<T16, E16, Ctx>,
    f17: (value: T16) => Effect<T17, E17, Ctx>,
    f18: (value: T17) => Effect<T18, E18, Ctx>,
    f19: (value: T18) => Effect<T19, E19, Ctx>
): (
    start: T0
) => Effect<
    T19,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17 | E18 | E19,
    Ctx
>;

export declare function effectPipe<
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
    T6,
    T7,
    T8,
    T9,
    T10,
    T11,
    T12,
    T13,
    T14,
    T15,
    T16,
    T17,
    T18,
    T19,
    T20,
    E1 = unknown,
    E2 = unknown,
    E3 = unknown,
    E4 = unknown,
    E5 = unknown,
    E6 = unknown,
    E7 = unknown,
    E8 = unknown,
    E9 = unknown,
    E10 = unknown,
    E11 = unknown,
    E12 = unknown,
    E13 = unknown,
    E14 = unknown,
    E15 = unknown,
    E16 = unknown,
    E17 = unknown,
    E18 = unknown,
    E19 = unknown,
    E20 = unknown,
    Ctx = unknown
>(
    f1: (value: T0) => Effect<T1, E1, Ctx>,
    f2: (value: T1) => Effect<T2, E2, Ctx>,
    f3: (value: T2) => Effect<T3, E3, Ctx>,
    f4: (value: T3) => Effect<T4, E4, Ctx>,
    f5: (value: T4) => Effect<T5, E5, Ctx>,
    f6: (value: T5) => Effect<T6, E6, Ctx>,
    f7: (value: T6) => Effect<T7, E7, Ctx>,
    f8: (value: T7) => Effect<T8, E8, Ctx>,
    f9: (value: T8) => Effect<T9, E9, Ctx>,
    f10: (value: T9) => Effect<T10, E10, Ctx>,
    f11: (value: T10) => Effect<T11, E11, Ctx>,
    f12: (value: T11) => Effect<T12, E12, Ctx>,
    f13: (value: T12) => Effect<T13, E13, Ctx>,
    f14: (value: T13) => Effect<T14, E14, Ctx>,
    f15: (value: T14) => Effect<T15, E15, Ctx>,
    f16: (value: T15) => Effect<T16, E16, Ctx>,
    f17: (value: T16) => Effect<T17, E17, Ctx>,
    f18: (value: T17) => Effect<T18, E18, Ctx>,
    f19: (value: T18) => Effect<T19, E19, Ctx>,
    f20: (value: T19) => Effect<T20, E20, Ctx>
): (
    start: T0
) => Effect<
    T20,
    E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10 | E11 | E12 | E13 | E14 | E15 | E16 | E17 | E18 | E19 | E20,
    Ctx
>;

/**
 * Wraps one Command execution, or one `Parallel` (`type` `'Parallel'`, `name` `'Parallel'`), whose `op`
 * runs its branches and returns its decision. A hook must call `op` for a `Parallel`; returning without
 * calling it is legitimate only for a Command, which is how replay works. Only a replay passes `op` an
 * argument, the recorded decision. `path` is the step's position in the Effect tree rather than its
 * position in completion order, so it is the same in a replay as in the recorded run even when
 * `Parallel` branches finish in a different order. Hooks that take three parameters are unaffected.
 */
export type StepRunner = (
    name: string,
    type: string,
    op: (decision?: ParallelDecision) => Promise<unknown>,
    path?: string
) => Promise<unknown>;

/**
 * Which branch, if any, cancelled a `Parallel`: what a `Parallel`'s step returns and what its trace entry
 * records, so a replay reproduces the decision rather than recomputing it from timing. `branch: null`
 * means an enclosing `Parallel` cancelled it.
 */
export type ParallelDecision = { cancelled: false } | { cancelled: true; branch: number | null };

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
}

/**
 * Adds a layer to the global runner's wiring and returns a function that removes it. Layers merge:
 * `onStep` and `onRun` nest with the earliest layer outermost, `onBeforeCommand` interceptors all run
 * in the order installed. Several configurations passed
 * to one call form one layer, which is the same as installing them in separate calls. Calling with no
 * arguments at all removes every layer; a call whose arguments are all `undefined` adds and removes nothing.
 *
 * A `retry` key throws a `TypeError`: retry options are per-use, passed to `Retry(effect, options)`.
 */
export declare function configureEffect(...configs: (EffectConfiguration | undefined)[]): () => void;

/**
 * A per-call configuration for `runEffect`. With `inherit: true` (default) the call's hooks are added to
 * the wiring `configureEffect` installed: where both define a hook the two nest, global outermost. With
 * `inherit: false` the global wiring is ignored, so an unset hook falls back to the library default.
 * A `retry` key throws a `TypeError`, as it does for `configureEffect`.
 */
export type CallConfiguration = EffectConfiguration & { inherit?: boolean };

export declare function runEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    context?: Ctx,
    callConfig?: CallConfiguration
): Promise<SuccessState<T> | FailureState<E>>;

export type ReplayStep = {
    /**
     * Zero-based position in this run's completion order. Not stable for a flow containing `Parallel`,
     * whose branches finish in whatever order they finish in. Prefer `path`.
     */
    index: number;
    /** `meta.name`, `cmd.name`, or 'anonymous'; 'Parallel' for a `Parallel`'s step. */
    name: string;
    /**
     * 'Command', or 'Parallel' for the step a `Parallel` records its decision under. A Resolver that
     * answers a 'Parallel' step with `{ result: ParallelDecision }` has it reproduced; anything else
     * replays that `Parallel` under timing. A 'Parallel' step does not advance `index`.
     */
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

/**
 * A recorded step: a Command's result or error, or a `Parallel`'s decision, whose `command` is
 * 'Parallel', whose `path` ends in the `Parallel`'s `p` marker, and whose `result` is a `ParallelDecision`.
 */
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
    /**
     * Run the replay inside the global hooks, resolver innermost, so configured hooks observe it
     * (default `false`, which ignores the global hooks). Retry options are per-use, so a replay reads the
     * same ones the recorded run did.
     */
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
