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

export type CommandState<R, T, E = unknown, Ctx = unknown> = {
    type: 'Command';
    cmd: () => Promise<R> | R;
    next: (result: R) => Effect<T, E, Ctx>;
    meta?: unknown;
    initialInput?: unknown;
};

export type AskState<T, E = unknown, Ctx = unknown> = {
    type: 'Ask';
    next: (context: Ctx) => Effect<T, E, Ctx>;
    initialInput?: unknown;
};

export type RetryOptions = {
    attempts?: number;
    delay?: number;
    backoff?: number;
};

export type RetryState<T, E = unknown, Ctx = unknown> = {
    type: 'Retry';
    effect: Effect<T, E, Ctx>;
    options: RetryOptions;
    next: (value: T) => Effect<T, E, Ctx>;
    initialInput?: unknown;
};

export type RetryExhaustedError<E = unknown> = {
    retryExhausted: true;
    lastError: E;
    attempts: number;
};

export type Effect<T, E = unknown, Ctx = unknown> =
    | SuccessState<T>
    | FailureState<E>
    | CommandState<any, T, E, Ctx>
    | AskState<T, E, Ctx>
    | RetryState<T, E, Ctx>;

export declare function Success<T>(value: T): SuccessState<T>;

export declare function Failure<E = unknown>(error: E, initialInput?: unknown): FailureState<E>;

export declare function Command<R, T, E = unknown, Ctx = unknown>(
    cmd: () => Promise<R> | R,
    next: (result: R) => Effect<T, E, Ctx>,
    meta?: unknown
): CommandState<R, T, E, Ctx>;

export declare function Ask<T, E = unknown, Ctx = unknown>(
    next: (context: Ctx) => Effect<T, E, Ctx>
): AskState<T, E, Ctx>;

export declare function Retry<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    options?: RetryOptions
): RetryState<T, E, Ctx>;

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

export type StepRunner = (name: string, type: string, op: () => Promise<unknown>) => Promise<unknown>;

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

export declare function configureEffect(options: EffectConfiguration): void;

export declare function runEffect<T, E = unknown, Ctx = unknown>(
    effect: Effect<T, E, Ctx>,
    context?: Ctx,
    callConfig?: EffectConfiguration
): Promise<SuccessState<T> | FailureState<E>>;
