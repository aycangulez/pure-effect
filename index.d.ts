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

export type CommandState<R, T, E = unknown> = {
    type: 'Command';
    cmd: () => Promise<R> | R;
    next: (result: R) => Effect<T, E>;
    meta?: unknown;
    initialInput?: unknown;
};

export type Effect<T, E = unknown> =
    | SuccessState<T>
    | FailureState<E>
    | CommandState<any, T, E>;

export declare function Success<T>(value: T): SuccessState<T>;

export declare function Failure<E = unknown>(
    error: E,
    initialInput?: unknown
): FailureState<E>;

export declare function Command<R, T, E = unknown>(
    cmd: () => Promise<R> | R,
    next: (result: R) => Effect<T, E>,
    meta?: unknown
): CommandState<R, T, E>;

export declare function effectPipe<A, B, E = unknown>(
    f1: (a: A) => Effect<B, E>
): (start: A) => Effect<B, E>;

export declare function effectPipe<A, B, C, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>
): (start: A) => Effect<C, E>;

export declare function effectPipe<A, B, C, D, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>,
    f3: (c: C) => Effect<D, E>
): (start: A) => Effect<D, E>;

export declare function effectPipe<A, B, C, D, F, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>,
    f3: (c: C) => Effect<D, E>,
    f4: (d: D) => Effect<F, E>
): (start: A) => Effect<F, E>;

export declare function effectPipe<A, B, C, D, F, G, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>,
    f3: (c: C) => Effect<D, E>,
    f4: (d: D) => Effect<F, E>,
    f5: (f: F) => Effect<G, E>
): (start: A) => Effect<G, E>;

export declare function effectPipe<A, B, C, D, F, G, H, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>,
    f3: (c: C) => Effect<D, E>,
    f4: (d: D) => Effect<F, E>,
    f5: (f: F) => Effect<G, E>,
    f6: (g: G) => Effect<H, E>
): (start: A) => Effect<H, E>;

export declare function effectPipe<A, B, C, D, F, G, H, I, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>,
    f3: (c: C) => Effect<D, E>,
    f4: (d: D) => Effect<F, E>,
    f5: (f: F) => Effect<G, E>,
    f6: (g: G) => Effect<H, E>,
    f7: (h: H) => Effect<I, E>
): (start: A) => Effect<I, E>;

export declare function effectPipe<A, B, C, D, F, G, H, I, J, E = unknown>(
    f1: (a: A) => Effect<B, E>,
    f2: (b: B) => Effect<C, E>,
    f3: (c: C) => Effect<D, E>,
    f4: (d: D) => Effect<F, E>,
    f5: (f: F) => Effect<G, E>,
    f6: (g: G) => Effect<H, E>,
    f7: (h: H) => Effect<I, E>,
    f8: (i: I) => Effect<J, E>
): (start: A) => Effect<J, E>;

export declare function runEffect<T, E = unknown>(
    effect: Effect<T, E>,
    context?: unknown
): Promise<SuccessState<T> | FailureState<E>>;

export type StepRunner = (
    name: string,
    type: string,
    op: () => Promise<unknown>
) => Promise<unknown>;

export type RunWrapper = (
    effect: Effect<unknown>,
    op: () => Promise<SuccessState<unknown> | FailureState<unknown>>,
    flowName?: string
) => Promise<SuccessState<unknown> | FailureState<unknown>>;

export type CommandInterceptor = (
    command: CommandState<unknown, unknown>,
    context?: any
) => Promise<void>;

export interface EffectConfiguration {
    onStep?: StepRunner;
    onRun?: RunWrapper;
    onBeforeCommand?: CommandInterceptor;
}

export declare function configureEffect(options: EffectConfiguration): void;
