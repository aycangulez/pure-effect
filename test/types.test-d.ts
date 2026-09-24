import { expectType, expectAssignable } from 'tsd';
import {
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
    timeTravel
} from '../index.js';
import type {
    SuccessState,
    FailureState,
    CommandState,
    AskState,
    RetryState,
    ParallelState,
    ParallelOutcomes,
    ParallelOptions,
    ParallelDecision,
    RetryExhaustedError,
    Effect,
    EffectConfiguration,
    StepRunner,
    RunWrapper,
    CommandInterceptor,
    TraceEntry,
    TraceLog,
    TraceMeta,
    RecorderOptions,
    ReplayStep,
    ReplayOutcome,
    Resolver,
    ReplayOptions,
    Replay
} from '../index.js';

interface User {
    email: string;
    password: string;
}
interface SavedUser {
    id: number;
    email: string;
}

// --- Success ---

const s = Success(42);
expectType<SuccessState<number>>(s);
// @ts-expect-error missing argument
Success();

// --- Failure ---

const f = Failure('oops');
expectType<FailureState<string>>(f);

// --- Command ---

// next is optional, defaulting to Success
expectType<CommandState<number, number>>(Command(() => 42));
expectType<CommandState<number, string>>(
    Command(
        () => 42,
        (n: number) => Success(String(n))
    )
);
Command(() => 42, undefined, { name: 'readRow' });
// @ts-expect-error missing cmd
Command();

const cmd = Command(
    async () => ({ id: 1, email: 'a@b.com' }) as SavedUser,
    (saved) => {
        expectType<SavedUser>(saved);
        return Success(saved);
    }
);
expectType<CommandState<SavedUser, SavedUser, unknown>>(cmd);

// A cmd that only throws, or returns Promise.reject, infers R as never. That has to stay assignable
// to Effect under strictFunctionTypes, which is why every state's `next` is a method signature
// (bivariant parameter) rather than a function-typed property (contravariant, so `never` could not
// widen to the `any` in `Effect`'s CommandState member).
const throwing = Command(() => {
    throw new Error('boom');
});
expectAssignable<Effect<never>>(throwing);
expectAssignable<Effect<never>>(Command(() => Promise.reject(new Error('down'))));
expectAssignable<Effect<never>>(Retry(throwing));
expectAssignable<Effect<never>>(effectPipe(() => throwing)(null));

// --- effectPipe type propagation ---

const step1 = (input: User) => Success(input);
const step2 = (user: User) =>
    Command(
        async () => ({ id: 1, ...user }) as SavedUser,
        (s) => Success(s)
    );

const flow = effectPipe(step1, step2);
expectType<Effect<SavedUser>>(flow({ email: 'a@b.com', password: 'secret123' }));
// @ts-expect-error missing password
flow({ email: 'a@b.com' });

// --- runEffect return type ---

const result = await runEffect(flow({ email: 'a@b.com', password: 'secret123' }));
expectType<SuccessState<SavedUser> | FailureState<unknown>>(result);

// --- discriminated union narrowing ---

if (result.type === 'Success') {
    expectType<SavedUser>(result.value);
} else {
    expectType<unknown>(result.error);
}

// --- Failure error type flows through runEffect ---

const failFlow = effectPipe((input: User): Effect<User, string> => Failure<string>('bad'));
const failResult = await runEffect(failFlow({ email: 'a@b.com', password: 'x' }));
expectType<SuccessState<User> | FailureState<string>>(failResult);

// --- Ask ---

const ask = Ask((ctx) => Success(ctx as User));
expectType<AskState<User, unknown>>(ask);

const askFlow = effectPipe((input: User) => Ask((_ctx) => Success(input)));
expectType<Effect<User>>(askFlow({ email: 'a@b.com', password: 'secret123' }));

// --- Retry ---

const innerCmd = Command(
    async () => 42,
    (n) => Success(n)
);

// Retry with options preserves T. The error type is both of the things a Retry can contribute: an
// abort the wrapped tree returned, which is not retried and leaves unwrapped, and the exhaustion
// failure that follows an I/O fault the loop could not get past.
const retried = Retry(innerCmd, { attempts: 3 });
expectType<RetryState<number, unknown | RetryExhaustedError>>(retried);

// Retry without options is valid
const retriedNoOpts = Retry(innerCmd);
expectType<RetryState<number, unknown | RetryExhaustedError>>(retriedNoOpts);

// Retry in effectPipe preserves type flow
const retryFlow = effectPipe((input: User) =>
    Retry(
        Command(
            async () => ({ id: 1, ...input }) as SavedUser,
            (s) => Success(s)
        ),
        { attempts: 2 }
    )
);
expectType<Effect<SavedUser, unknown | RetryExhaustedError>>(retryFlow({ email: 'a@b.com', password: 'secret123' }));

// The wrapped tree's error type is an abort, which is never retried, so it leaves as itself and
// cannot be what lastError holds: that is only ever a thrown value, which nothing types.
const retriedTyped = Retry(Success(1) as Effect<number, 'net_down'>);
expectType<RetryState<number, 'net_down' | RetryExhaustedError>>(retriedTyped);

const retryResult = await runEffect(Retry(Success(1) as Effect<number, 'flaky'>, { attempts: 1 }));
if (retryResult.type === 'Failure') {
    expectType<'flaky' | RetryExhaustedError>(retryResult.error);
    // An abort arrives as itself, so the union has to be narrowed before `lastError` is there.
    if (typeof retryResult.error === 'object') {
        expectType<unknown>(retryResult.error.lastError);
        // @ts-expect-error lastError is what a Command's function threw, never the wrapped tree's abort type
        const abortAsLastError: 'flaky' = retryResult.error.lastError;
    }
}

// onExhausted consumes the exhaustion, so the fallback's error type is what remains
const recovered = Retry(Success(1) as Effect<number, 'flaky'>, {
    attempts: 1,
    onExhausted: (err) => {
        expectType<RetryExhaustedError>(err);
        return Success(0) as Effect<number, 'cache_miss'>;
    }
});
// The fallback consumes the exhaustion, and an abort still leaves as itself, so both remain.
expectType<RetryState<number, 'flaky' | 'cache_miss'>>(recovered);

const recoveredResult = await runEffect(recovered);
if (recoveredResult.type === 'Failure') {
    expectType<'flaky' | 'cache_miss'>(recoveredResult.error);
}

// A step annotated with its return type can return a retried Command that keeps its default next, which is the
// shape the README recommends. Command's value type was inferred from the annotation rather than from the
// function, as unknown, until the no-next case got its own overload.
type Seat = { seat: string };
const cmdHoldSeat = async (): Promise<Seat> => ({ seat: '12A' });
const holdSeat = (): Effect<Seat, RetryExhaustedError> => Retry(Command(cmdHoldSeat), { attempts: 2 });
const holdSeatOnce = (): Effect<Seat, never> => Command(cmdHoldSeat);

// @ts-expect-error retry options, onExhausted included, are per-use rather than configured
configureEffect({ retry: { attempts: 2, onExhausted: () => Success(1) } });

// RetryExhaustedError shape is usable for narrowing exhaustion failures, and its parameter annotates a
// thrown type the caller already knows
const exhaustedErr: RetryExhaustedError<Error> = {
    retryExhausted: true,
    lastError: new Error('boom'),
    attempts: 3
};
expectType<true>(exhaustedErr.retryExhausted);
expectType<Error>(exhaustedErr.lastError);
expectType<number>(exhaustedErr.attempts);

// --- error channel union across effectPipe steps ---

type ValidationError = 'invalid_email' | 'weak_password';
type DbError = 'db_connection' | 'duplicate_key';

const validateStep = (_input: User): Effect<User, ValidationError> => Failure<ValidationError>('invalid_email');
const saveStep = (_user: User): Effect<SavedUser, DbError> => Failure<DbError>('db_connection');

const typedFlow = effectPipe(validateStep, saveStep);
expectType<Effect<SavedUser, ValidationError | DbError>>(typedFlow({ email: 'a@b.com', password: 'secret123' }));

const typedResult = await runEffect(typedFlow({ email: 'a@b.com', password: 'secret123' }));
expectType<SuccessState<SavedUser> | FailureState<ValidationError | DbError>>(typedResult);

// --- long pipelines: typed for up to 20 steps, the same ceiling as Effect-TS ---

const stepWith =
    <E extends string>(error: E) =>
    (n: number): Effect<number, E, AppCtx> =>
        n < 0 ? Failure(error) : Success(n + 1);

// Nine steps, past the old ceiling of eight. The last step is inline and unannotated, and still typed.
const nineSteps = effectPipe(
    stepWith('e1'),
    stepWith('e2'),
    stepWith('e3'),
    stepWith('e4'),
    stepWith('e5'),
    stepWith('e6'),
    stepWith('e7'),
    stepWith('e8'),
    (n): Effect<string, 'e9', AppCtx> => {
        expectType<number>(n);
        return Success(String(n));
    }
);
expectType<Effect<string, 'e1' | 'e2' | 'e3' | 'e4' | 'e5' | 'e6' | 'e7' | 'e8' | 'e9', AppCtx>>(nineSteps(0));

// Twenty steps: the value, every step's error, and the context all reach the end.
const twentySteps = effectPipe(
    stepWith('e1'),
    stepWith('e2'),
    stepWith('e3'),
    stepWith('e4'),
    stepWith('e5'),
    stepWith('e6'),
    stepWith('e7'),
    stepWith('e8'),
    stepWith('e9'),
    stepWith('e10'),
    stepWith('e11'),
    stepWith('e12'),
    stepWith('e13'),
    stepWith('e14'),
    stepWith('e15'),
    stepWith('e16'),
    stepWith('e17'),
    stepWith('e18'),
    stepWith('e19'),
    (n): Effect<{ total: number }, 'e20', AppCtx> => {
        expectType<number>(n);
        return Success({ total: n });
    }
);
type TwentyErrors =
    | 'e1'
    | 'e2'
    | 'e3'
    | 'e4'
    | 'e5'
    | 'e6'
    | 'e7'
    | 'e8'
    | 'e9'
    | 'e10'
    | 'e11'
    | 'e12'
    | 'e13'
    | 'e14'
    | 'e15'
    | 'e16'
    | 'e17'
    | 'e18'
    | 'e19'
    | 'e20';
expectType<Effect<{ total: number }, TwentyErrors, AppCtx>>(twentySteps(0));

// Twenty-one is past the ceiling. A pipeline is itself a step, so a longer one nests.
const step = stepWith('e');
const eleven = [step, step, step, step, step, step, step, step, step, step, step] as const;
const ten = [step, step, step, step, step, step, step, step, step, step] as const;
// @ts-expect-error typed for up to 20 steps; nest pipelines for more
effectPipe(...eleven, ...ten);
const nested = effectPipe(effectPipe(...eleven), effectPipe(...ten));
expectType<Effect<number, 'e', AppCtx>>(nested(0));

// --- Parallel ---

// Values tuple is correctly typed
const par = Parallel([Success(42), Success('hello')], ([n, s]) => {
    expectType<number>(n);
    expectType<string>(s);
    return Success({ n, s });
});
expectType<ParallelState<[number, string], { n: number; s: string }>>(par);

// Parallel in effectPipe preserves type flow
const parallelFlow = effectPipe((input: User) =>
    Parallel([Success(input.email), Success(input.password)], ([email, password]) => Success({ email, password }))
);
expectType<Effect<{ email: string; password: string }>>(parallelFlow({ email: 'a@b.com', password: 'secret123' }));

// runEffect return type flows through Parallel
const parallelResult = await runEffect(Parallel([Success(1), Success('x')], ([n, s]) => Success({ n, s })));
expectType<SuccessState<{ n: number; s: string }> | FailureState<unknown>>(parallelResult);

// With next omitted, the Parallel resolves to the values tuple itself
const parBare = Parallel([Success(42), Success('hello')]);
expectType<ParallelState<[number, string], [number, string]>>(parBare);
const parBareResult = await runEffect(parBare);
if (parBareResult.type === 'Success') {
    expectType<[number, string]>(parBareResult.value);
}

// Options in the second slot leave the value types alone
const parLimited = Parallel([Success(42), Success('hello')], { limit: 2 });
expectType<ParallelState<[number, string], [number, string]>>(parLimited);

// Options alongside a next
const parLimitedNext = Parallel([Success(42), Success('hello')], ([n, s]) => Success({ n, s }), { limit: 2 });
expectType<ParallelState<[number, string], { n: number; s: string }>>(parLimitedNext);

// Settled hands next the branch outcomes rather than the values
const parSettled = Parallel([Success(42), Success('hello')], { settled: true });
const parSettledResult = await runEffect(parSettled);
if (parSettledResult.type === 'Success') {
    expectType<[SuccessState<number> | FailureState<unknown>, SuccessState<string> | FailureState<unknown>]>(
        parSettledResult.value
    );
}

const parSettledNext = Parallel(
    [Success(42), Success('hello')],
    ([first, second]) => {
        expectType<SuccessState<number> | FailureState<unknown>>(first);
        expectType<SuccessState<string> | FailureState<unknown>>(second);
        return Success(first.type === 'Success' ? first.value : 0);
    },
    { settled: true }
);
expectType<ParallelState<[number, string], number, unknown, unknown, ParallelOutcomes<[number, string], unknown>>>(
    parSettledNext
);

// @ts-expect-error a settled next receives outcomes, so a bare value cannot be used as one
Parallel([Success(42)], ([n]) => Success(n + 1), { settled: true });

// @ts-expect-error limit is a number
Parallel([Success(42)], { limit: 'five' });

// @ts-expect-error settled is a boolean
Parallel([Success(42)], { settled: 'yes' });

// A settled flag known only as a boolean could be true at runtime, so it matches no overload rather than the
// one that types next as the values
const batchOptions = { limit: 2, settled: true };
// @ts-expect-error settled widened to boolean: write it inline, or add `as const`
Parallel([Success(42)], batchOptions);
// @ts-expect-error the same with a next
Parallel([Success(42)], (values) => Success(values), batchOptions);
declare const optionsFromCaller: ParallelOptions;
// @ts-expect-error a caller's ParallelOptions may carry settled: true
Parallel([Success(42)], optionsFromCaller);
// settled: false, or no settled at all, still types next as the values, and `as const` keeps a shared flag exact
expectType<ParallelState<[number], [number]>>(Parallel([Success(42)], { limit: 2, settled: false }));
const settledOptions = { limit: 2, settled: true } as const;
const parSettledShared = Parallel([Success(42)], settledOptions);
expectType<
    ParallelState<[number], ParallelOutcomes<[number], unknown>, unknown, unknown, ParallelOutcomes<[number], unknown>>
>(parSettledShared);

// --- Ctx (context type) ---

interface AppCtx {
    db: string;
}

// Ask infers Ctx from callback parameter type
const askWithCtx = Ask((ctx: AppCtx) => Success(ctx.db));
expectType<AskState<string, unknown, AppCtx>>(askWithCtx);

// effectPipe propagates Ctx through steps
const ctxFlow = effectPipe((input: User) => Ask((ctx: AppCtx) => Success({ ...input, conn: ctx.db })));
expectType<Effect<{ email: string; password: string; conn: string }, unknown, AppCtx>>(
    ctxFlow({ email: 'a@b.com', password: 'secret123' })
);

// runEffect enforces context argument matches Ctx
const ctxResult = await runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { db: 'conn' });
expectType<SuccessState<{ email: string; password: string; conn: string }> | FailureState<unknown>>(ctxResult);

// wrong context shape should error
// @ts-expect-error context does not match Ctx
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { wrong: 'thing' });
// @ts-expect-error the flow reads AppCtx, so a context is required
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }));
// a flow that reads no context still needs none
runEffect(Success(1));

// each step contributes its own context, so a step that reads none does not erase a later step's
const parseConnId = (raw: string): Effect<string, 'bad_id'> => (raw ? Success(raw) : Failure('bad_id'));
const findConn = (id: string): Effect<string, 'not_found', AppCtx> =>
    Ask<string, 'not_found', AppCtx>((ctx) => Success(ctx.db + id));
const validateThenLookup = effectPipe(parseConnId, findConn);
expectType<(start: string) => Effect<string, 'bad_id' | 'not_found', AppCtx>>(validateThenLookup);
// @ts-expect-error the lookup reads AppCtx, whichever step comes first
runEffect(validateThenLookup('p1'), { wrong: 'thing' });
// and a pipeline needs every context its steps read
interface TenantCtx {
    tenant: string;
}
const findTenant = (conn: string): Effect<string, never, TenantCtx> =>
    Ask<string, never, TenantCtx>((ctx) => Success(conn + ctx.tenant));
const needsBoth = effectPipe(findConn, findTenant);
expectType<(start: string) => Effect<string, 'not_found', AppCtx & TenantCtx>>(needsBoth);
// @ts-expect-error the tenant is missing
runEffect(needsBoth('p1'), { db: 'conn' });

// --- configureEffect / EffectConfiguration ---

// accepts full configuration
configureEffect({
    onStep: async (_name, _type, op) => op(),
    onRun: async (_effect, op, _flowName) => op(),
    onBeforeCommand: async (_cmd, _ctx) => {}
});

// accepts partial configuration
configureEffect({ onRun: async (_effect, op) => op() });
configureEffect({});

// rejects invalid shapes
// @ts-expect-error onStep must be a function
configureEffect({ onStep: 'not-a-function' });

// --- runEffect callConfig: `inherit` ---
runEffect(flow({ email: 'a@b.com', password: 'secret123' }), {}, { inherit: true });
runEffect(flow({ email: 'a@b.com', password: 'secret123' }), {}, { inherit: false });
// @ts-expect-error retry options are per-use, never per-call
runEffect(flow({ email: 'a@b.com', password: 'secret123' }), {}, { retry: { attempts: 1 } });
// @ts-expect-error a boolean, not the old three-way string
runEffect(flow({ email: 'a@b.com', password: 'secret123' }), {}, { inherit: 'all' });
// @ts-expect-error `inherit` is a per-call option; the global wiring has nothing to inherit from
configureEffect({ inherit: true });

// hook types are correctly shaped
const myStep: StepRunner = async (name, type, op) => {
    expectType<string>(name);
    expectType<string>(type);
    return op();
};

const myRun: RunWrapper = async (effect, op, flowName) => {
    expectType<Effect<unknown>>(effect);
    expectType<string>(flowName);
    return op();
};

const myInterceptor: CommandInterceptor = async (cmd, _ctx) => {
    expectType<CommandState<unknown, unknown>>(cmd);
};

// the runtime always passes a path and a flow name, so a hook may declare them as present
const pathStep: StepRunner = async (name, type, op, path: string) => op();
const namedRun: RunWrapper = async (effect, op, flowName: string) => op();
// a guard that throws to abort needs no async
const syncGuard: CommandInterceptor = (cmd, ctx) => {
    if (!ctx) throw new Error('no context');
};
// @ts-expect-error a wrapper has to pass path on, or its trace cannot replay a Parallel
const forgetsPath: StepRunner = async (name, type, op) => myStep(name, type, op);

// EffectConfiguration is a usable type
const config: EffectConfiguration = { onStep: myStep, onRun: myRun, onBeforeCommand: myInterceptor };
expectType<EffectConfiguration>(config);

// replayEffect returns the flow's outcome beside the unreached entries for a trace, and no unreached for a Resolver
const traceLog: TraceLog = { trace: [{ command: 'cmdRead', path: '0', result: 1 }] };
const readRow = Command(() => 42);
const replayOptions: ReplayOptions = {
    onResolved: (step, outcome) => {
        expectType<string>(step.name);
        expectType<number>(step.index);
    }
};
expectType<Promise<Replay<number, unknown>>>(replayEffect(readRow, traceLog, replayOptions));
expectType<Promise<Replay<number, unknown>>>(replayEffect(readRow, traceLog.trace));
(async () => {
    const { result, unreached } = await replayEffect(readRow, traceLog);
    expectType<SuccessState<number> | FailureState<unknown>>(result);
    expectType<TraceEntry[]>(unreached);
    const fromResolver = await replayEffect(readRow, () => ({ result: 42 }));
    expectType<SuccessState<number> | FailureState<unknown>>(fromResolver.result);
    // @ts-expect-error a Resolver cannot know what was left unreached
    fromResolver.unreached;
})();
// A source typed as the union (a wrapper forwarding whatever it was handed) still type-checks, with unreached optional
declare const traceOrResolver: TraceLog | TraceEntry[] | Resolver;
(async () => {
    const forwarded = await replayEffect(readRow, traceOrResolver);
    expectType<SuccessState<number> | FailureState<unknown>>(forwarded.result);
    expectType<TraceEntry[] | undefined>(forwarded.unreached);
})();
// @ts-expect-error strict was removed: paths make it unnecessary
replayEffect(readRow, traceLog, { strict: false });
// @ts-expect-error unreached is returned, not observed
replayEffect(readRow, traceLog, { onUnreached: () => {} });

// --- recorder / recordEffect / timeTravel ---

// recorder returns an onStep hook, the live entries, and a trace packager
const rec = recorder({ redact: (value, name, kind) => value, maxEntries: 100, stack: true });
expectType<StepRunner>(rec.onStep);
expectType<TraceEntry[]>(rec.entries);
expectType<TraceLog>(rec.toTrace());
expectType<TraceLog>(rec.toTrace({ initialInput: 1, flowName: 'f', context: {}, version: 'v' }));
expectAssignable<EffectConfiguration>({ onStep: rec.onStep });
expectAssignable<TraceMeta>({ version: 'abc' });

// redact sees every kind of value a trace holds, and only those kinds
const redactor: RecorderOptions['redact'] = (value, name, kind) => {
    expectType<any>(value);
    expectType<string>(name);
    expectType<'result' | 'error' | 'initialInput' | 'context'>(kind);
    return value;
};
// @ts-expect-error 'argument' is not a kind a trace records
const narrowRedactor: RecorderOptions['redact'] = (value, name, kind: 'argument') => value;
// the README's redact spreads the value it is given
recorder({ redact: (value, name, kind) => (kind === 'initialInput' ? { ...value, password: '[redacted]' } : value) });

// recordEffect returns the typed outcome beside the trace, and types its context
(async () => {
    const recorded = await recordEffect(typedFlow, { email: 'a@b.c', password: 'x' }, { version: 'v1' });
    expectType<SuccessState<SavedUser> | FailureState<ValidationError | DbError>>(recorded.result);
    expectType<TraceLog>(recorded.trace);
    const withCtx = await recordEffect(ctxFlow, { email: 'a@b.c', password: 'x' }, { context: { db: 'conn' } });
    expectType<SuccessState<{ email: string; password: string; conn: string }> | FailureState<unknown>>(withCtx.result);
})();
// @ts-expect-error context does not match the flow's Ctx
recordEffect(ctxFlow, { email: 'a@b.c', password: 'x' }, { context: { db: 42 } });
// @ts-expect-error the flow reads AppCtx, so recording it needs a context
recordEffect(ctxFlow, { email: 'a@b.c', password: 'x' });
// @ts-expect-error the input has to be what the flow takes
recordEffect(typedFlow, { email: 'a@b.c', pasword: 'x' });

// a Resolver answers with a wrapped outcome or undefined for an unrecorded step
const resolver: Resolver = (step) => {
    expectType<ReplayStep>(step);
    expectType<string>(step.name);
    expectType<string>(step.path);
    return step.index === 0 ? { result: 1 } : undefined;
};
expectAssignable<ReplayOutcome>({ error: new Error('x') });

// @ts-expect-error a bare value is not an outcome; the wrapper is what distinguishes undefined from unrecorded
const bareResolver: Resolver = () => 42;

// a Parallel's step records its decision, and a Resolver can supply one from another storage format
expectAssignable<ParallelDecision>({ cancelled: false });
expectAssignable<ParallelDecision>({ cancelled: true, branch: 0 });
expectAssignable<ParallelDecision>({ cancelled: true, branch: null });
// @ts-expect-error a cancelled decision names the branch that cancelled it, or null for an enclosing Parallel
const unnamedBranch: ParallelDecision = { cancelled: true };
const decisionResolver: Resolver = (step) =>
    step.type === 'Parallel' ? { result: { cancelled: true, branch: 0 } } : undefined;
// op takes an argument only when a replay passes it the recorded decision
const passesDecision: StepRunner = async (name, type, op) => (type === 'Parallel' ? op({ cancelled: false }) : op());

// timeTravel returns the bare outcome and takes the trace's own type
expectType<Promise<SuccessState<SavedUser> | FailureState<ValidationError | DbError>>>(
    timeTravel(typedFlow, traceLog, { log: () => {}, version: 'v1' })
);
// @ts-expect-error a bare entries array is replayEffect's shape, not timeTravel's
timeTravel(typedFlow, traceLog.trace);
