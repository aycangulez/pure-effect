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
    timeTravel,
    commandName
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

// A literal keeps its type without `as const`, so an error union stays exact
const f = Failure('oops');
expectType<FailureState<'oops'>>(f);
const objectError = Failure({ code: 'out_of_stock', sku: 'lamp' });
expectType<FailureState<{ readonly code: 'out_of_stock'; readonly sku: 'lamp' }>>(objectError);
const readonlyStillAssignable: { code: string; sku: string } = objectError.error;
// @ts-expect-error an array error is a readonly tuple, which a mutable array does not accept
const arrayErrorAsMutable: string[] = Failure(['a', 'b']).error;
declare const dynamicMessage: string;
expectType<FailureState<string>>(Failure(dynamicMessage));
// @ts-expect-error a Failure carries only its error; onRun is handed the flow's input
Failure('oops', { id: 1 });
// @ts-expect-error nor does one a flow returns
f.initialInput;
const quickStartValidate = (input: User) => {
    if (!input.email.includes('@')) return Failure('invalid_email');
    if (input.password.length < 8) return Failure('weak_password');
    return Success(input);
};
const quickStartResult = await runEffect(effectPipe(quickStartValidate)({ email: 'a@b.c', password: 'secret123' }));
expectType<SuccessState<User> | FailureState<'invalid_email' | 'weak_password'>>(quickStartResult);

// --- Command ---

// next is optional, defaulting to Success
expectType<CommandState<number, number, never>>(Command(() => 42));
// A next that only succeeds cannot fail, so it adds never, as the default next does
expectType<CommandState<number, string, never>>(
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
expectType<CommandState<SavedUser, SavedUser, never>>(cmd);

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
expectType<Effect<SavedUser, never>>(flow({ email: 'a@b.com', password: 'secret123' }));
// @ts-expect-error missing password
flow({ email: 'a@b.com' });

// --- runEffect return type ---

const result = await runEffect(flow({ email: 'a@b.com', password: 'secret123' }));
expectType<SuccessState<SavedUser> | FailureState<never>>(result);

// --- discriminated union narrowing ---

if (result.type === 'Success') {
    expectType<SavedUser>(result.value);
} else {
    expectType<never>(result.error);
}

// --- commandName ---

// It takes a Command, as the runtime does, so a walk narrows each step first
expectType<string>(commandName(cmd));
const walked = flow({ email: 'a@b.com', password: 'secret123' });
// @ts-expect-error a flow can start with a Success or a Failure, which has no name
commandName(walked);
if (walked.type === 'Command') expectType<string>(commandName(walked));

// --- Failure error type flows through runEffect ---

const failFlow = effectPipe((input: User): Effect<User, string> => Failure<string>('bad'));
const failResult = await runEffect(failFlow({ email: 'a@b.com', password: 'x' }));
expectType<SuccessState<User> | FailureState<string>>(failResult);

// --- Ask ---

const ask = Ask((ctx) => Success(ctx as User));
expectType<AskState<User, never>>(ask);

const askFlow = effectPipe((input: User) => Ask((_ctx) => Success(input)));
expectType<Effect<User, never>>(askFlow({ email: 'a@b.com', password: 'secret123' }));

// --- Retry ---

const innerCmd = Command(
    async () => 42,
    (n) => Success(n)
);

// Retry with options preserves T. The error type is both of the things a Retry can contribute: an
// abort the wrapped tree returned, which is not retried and leaves unwrapped, and the exhaustion
// failure that follows an I/O fault the loop could not get past.
const retried = Retry(innerCmd, { attempts: 3 });
expectType<RetryState<number, RetryExhaustedError>>(retried);

// Retry without options is valid
const retriedNoOpts = Retry(innerCmd);
expectType<RetryState<number, RetryExhaustedError>>(retriedNoOpts);

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
expectType<Effect<SavedUser, RetryExhaustedError>>(retryFlow({ email: 'a@b.com', password: 'secret123' }));

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

// A Retry that starts a pipeline hands its next what the retried Command returned, not the pipeline's value, so a
// test walking the flow passes that. It was typed as the pipeline's value, which the Retry's next never receives.
const chargeThenReceipt = effectPipe(
    (orderId: string) => Retry(Command(async () => ({ chargeId: orderId }))),
    (charge: { chargeId: string }) => Command(async () => ({ receiptFor: charge.chargeId }))
);
const walkedRetry = chargeThenReceipt('order_1');
if (walkedRetry.type === 'Retry') walkedRetry.next({ chargeId: 'ch_1' });
// @ts-expect-error a Retry built on its own still types what its next receives
Retry(innerCmd).next('not a number');

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

// The union needs no annotations. A step that cannot return a Failure, such as a Command with the default next or a
// pure step that only succeeds, contributes never, where it used to contribute unknown and absorb every other member.
declare const users: { find(email: string): Promise<SavedUser | null>; save(user: User): Promise<SavedUser> };
const validateInferred = (input: User) =>
    input.email.includes('@') ? Success(input) : Failure('invalid_email' as const);
const ensureFree = (input: User) =>
    Command(
        () => users.find(input.email),
        (found) => (found ? Failure('email_taken' as const) : Success(input))
    );
const normalize = (input: User) => Success({ ...input, email: input.email.toLowerCase() });
const saveInferred = (input: User) => Command(() => users.save(input));
const inferredFlow = effectPipe(validateInferred, ensureFree, normalize, saveInferred);
const inferredResult = await runEffect(inferredFlow({ email: 'a@b.com', password: 'secret123' }));
expectType<SuccessState<SavedUser> | FailureState<'invalid_email' | 'email_taken'>>(inferredResult);

// A Retry whose fallback cannot fail declares no error of its own
const savedOrPlaceholder = Retry(
    Command(() => users.save({ email: 'a@b.com', password: 'secret123' })),
    {
        onExhausted: () => Success<SavedUser>({ id: 0, email: 'a@b.com' })
    }
);
expectType<RetryState<SavedUser, never>>(savedOrPlaceholder);

// A next that can only fail adds nothing to the value, as a step that cannot fail adds nothing to the error.
// Command took its function's result as the value, and Ask, Parallel and effectPipe took unknown, so a step
// that either succeeds or compensates and then fails did not compile in a pipeline.
type AppCtxForFailing = { tenant: string };
const onlyFailsCommand = Command(
    () => 42,
    () => Failure('declined' as const)
);
const onlyFailsAsk = Ask((_ctx: AppCtxForFailing) => Failure('declined' as const));
const onlyFailsParallel = Parallel([Success(1)], () => Failure('declined' as const));
const onlyFailsPipe = effectPipe(
    (chargeId: string) => Command(() => `refunded ${chargeId}`),
    () => Failure('declined' as const)
);
expectType<CommandState<number, never, 'declined'>>(onlyFailsCommand);
expectType<AskState<never, 'declined', AppCtxForFailing>>(onlyFailsAsk);
expectType<ParallelState<[number], never, 'declined'>>(onlyFailsParallel);
expectType<Effect<never, 'declined'>>(onlyFailsPipe('ch_1'));
const refundCharge = (chargeId: string) => Command(() => `refunded ${chargeId}`);
declare const inStock: boolean;
const fulfilOrCompensate = effectPipe(
    (id: number) =>
        inStock
            ? Success({ id })
            : Command(
                  () => 'released',
                  () => Failure('declined' as const)
              ),
    (order: { id: number }) => Success(order.id)
);
expectType<(start: number) => Effect<number, 'declined'>>(fulfilOrCompensate);
const compensateInPipeline = effectPipe(
    (id: number) => (inStock ? Success({ id }) : effectPipe(refundCharge, () => Failure('declined' as const))('ch_1')),
    (order: { id: number }) => Success(order.id)
);
expectType<(start: number) => Effect<number, 'declined'>>(compensateInPipeline);

// A function returning Failures of different shapes needs no annotation, wherever a flow takes one. Inferring one
// error parameter from several object errors picks one of them, so a string and an object error did not compile,
// and neither, once `const` kept literals, did two objects told apart by a literal `code`.
type Banned = { readonly code: 'banned'; readonly id: string };
declare const findSaved: () => Promise<SavedUser | null>;
declare const bannedId: string;
const mixedStep = (u: SavedUser) =>
    u.id < 0 ? Failure('invalid_id') : u.id === 0 ? Failure({ code: 'banned', id: u.email }) : Success(u);
expectType<Effect<SavedUser, 'invalid_id' | Banned>>(effectPipe(mixedStep)({ id: 1, email: 'a@b.com' }));
const sameKey = effectPipe((u: SavedUser) =>
    u.id ? Failure({ code: 'missing' }) : Failure({ code: 'banned', id: u.email })
);
expectType<Effect<never, { readonly code: 'missing' } | Banned>>(sameKey({ id: 1, email: 'a@b.com' }));
const mixedNext = Command(findSaved, (u) =>
    !u ? Failure('not_found') : u.id === 0 ? Failure({ code: 'banned', id: u.email }) : Success(u)
);
expectType<CommandState<SavedUser | null, SavedUser, 'not_found' | Banned>>(mixedNext);
const mixedAsk = Ask((ctx: { tenant: string }) =>
    ctx.tenant ? Failure('no_tenant') : Failure({ code: 'banned', id: ctx.tenant })
);
expectType<AskState<never, 'no_tenant' | Banned, { tenant: string }>>(mixedAsk);
const mixedParallel = Parallel([Success(1)], ([n]) =>
    n > 0 ? Failure('too_many') : Failure({ code: 'banned', id: String(n) })
);
expectType<ParallelState<[number], never, 'too_many' | Banned>>(mixedParallel);
const mixedSettled = Parallel(
    [Success(1)],
    ([o]) => (o.type === 'Success' ? Failure('too_many') : Failure({ code: 'banned', id: bannedId })),
    { settled: true }
);
expectType<
    ParallelState<[number], never, 'too_many' | Banned, unknown, [SuccessState<number> | FailureState<never>], never>
>(mixedSettled);
const mixedFallback = Retry(Command(findSaved), {
    onExhausted: () => (inStock ? Failure('down') : Failure({ code: 'banned', id: bannedId }))
});
expectType<RetryState<SavedUser | null, 'down' | Banned>>(mixedFallback);
// A step's value is joined the same way, from a Success on one branch and a Command on another
const eitherValue = effectPipe((n: number) => (n > 0 ? Success({ big: n }) : Command(async () => ({ small: n }))));
expectType<Effect<{ big: number } | { small: number }, never>>(eitherValue(1));
// An Ask or Retry written inline in a step keeps its own error and context: the step's return is constrained by
// AnyEffect, which has no type parameters, so it gives a call written there nothing to infer from.
const inlineAsk = effectPipe((u: SavedUser) =>
    Ask((ctx: { tenant: string }) => (ctx.tenant ? Success(u) : Failure('no_tenant')))
);
expectType<Effect<SavedUser, 'no_tenant', { tenant: string }>>(inlineAsk({ id: 1, email: 'a@b.com' }));
const inlineRetry = effectPipe((u: SavedUser) => Retry(Command(async () => u)));
expectType<Effect<SavedUser, RetryExhaustedError, unknown>>(inlineRetry({ id: 1, email: 'a@b.com' }));
// A step typed any leaves nothing to infer, so it reads as no value, no error and no context, and runEffect needs
// none; falling back to the constraint made its context never, which runEffect then demanded.
declare const untypedStep: any;
const untyped = effectPipe(untypedStep)(1);
expectType<Effect<never, never, unknown>>(untyped);
await runEffect(untyped);

// Some type arguments given, as to type a JSON response: TypeScript infers none of the rest, so they take their
// defaults. The never defaults refused a next that can fail in such a call, which compiled before them, so Command's
// last overload keeps the defaults it had. Each call is assigned first, so expectType cannot feed its inference.
declare function fetchJson(url: string): Promise<any>;
const typedResponse = Command<SavedUser | null>(
    () => fetchJson('/me'),
    (u) => (u ? Success(u) : Failure('not_found'))
);
expectType<CommandState<SavedUser | null, SavedUser | null, unknown>>(typedResponse);
// Ask and Retry have no such overload, since one more lengthens the error for their commonest mistake, so a step that
// can fail there needs every type argument or none
const mayFail = Command(
    () => fetchJson('/me'),
    (u: SavedUser) => (u.id ? Success(u) : Failure('no_id'))
);
// @ts-expect-error Ask given only its value refuses a callback that can fail
Ask<SavedUser>(() => Failure('not_found'));
// @ts-expect-error so does Retry given only its value
Retry<SavedUser>(mayFail);
// @ts-expect-error and with onExhausted
Retry<SavedUser>(mayFail, { onExhausted: () => Failure('down') });
const fullyTypedAsk = Ask<SavedUser, 'not_found'>(() => Failure('not_found'));
expectType<AskState<SavedUser, 'not_found'>>(fullyTypedAsk);
const toUserId = (u: SavedUser) => Success(u.id);
// @ts-expect-error with only R given, the value defaults to R, so a next that changes it needs every argument or none
Command<SavedUser>(() => fetchJson('/me'), toUserId);
// Writing the function's result type instead keeps every other type inferred exactly
const typedByReturn = Command(
    (): Promise<SavedUser | null> => fetchJson('/me'),
    (u) => (u ? Success(u) : Failure('not_found'))
);
expectType<CommandState<SavedUser | null, SavedUser, 'not_found'>>(typedByReturn);

// --- long pipelines: typed for up to 20 steps ---

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
expectType<ParallelState<[number, string], { n: number; s: string }, never>>(par);

// Parallel in effectPipe preserves type flow
const parallelFlow = effectPipe((input: User) =>
    Parallel([Success(input.email), Success(input.password)], ([email, password]) => Success({ email, password }))
);
expectType<Effect<{ email: string; password: string }, never>>(
    parallelFlow({ email: 'a@b.com', password: 'secret123' })
);

// runEffect return type flows through Parallel
const parallelResult = await runEffect(Parallel([Success(1), Success('x')], ([n, s]) => Success({ n, s })));
expectType<SuccessState<{ n: number; s: string }> | FailureState<never>>(parallelResult);

// With next omitted, the Parallel resolves to the values tuple itself
const parBare = Parallel([Success(42), Success('hello')]);
expectType<ParallelState<[number, string], [number, string], never>>(parBare);
const parBareResult = await runEffect(parBare);
if (parBareResult.type === 'Success') {
    expectType<[number, string]>(parBareResult.value);
}

// Options in the second slot leave the value types alone
const parLimited = Parallel([Success(42), Success('hello')], { limit: 2 });
expectType<ParallelState<[number, string], [number, string], never>>(parLimited);

// Options alongside a next
const parLimitedNext = Parallel([Success(42), Success('hello')], ([n, s]) => Success({ n, s }), { limit: 2 });
expectType<ParallelState<[number, string], { n: number; s: string }, never>>(parLimitedNext);

// Settled hands next the branch outcomes rather than the values
const parSettled = Parallel([Success(42), Success('hello')], { settled: true });
const parSettledResult = await runEffect(parSettled);
if (parSettledResult.type === 'Success') {
    expectType<[SuccessState<number> | FailureState<never>, SuccessState<string> | FailureState<never>]>(
        parSettledResult.value
    );
}

const parSettledNext = Parallel(
    [Success(42), Success('hello')],
    ([first, second]) => {
        expectType<SuccessState<number> | FailureState<never>>(first);
        expectType<SuccessState<string> | FailureState<never>>(second);
        return Success(first.type === 'Success' ? first.value : 0);
    },
    { settled: true }
);
expectType<
    ParallelState<
        [number, string],
        number,
        never,
        unknown,
        ParallelOutcomes<[SuccessState<number>, SuccessState<string>]>,
        never
    >
>(parSettledNext);

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
expectType<ParallelState<[number], [number], never>>(Parallel([Success(42)], { limit: 2, settled: false }));
const settledOptions = { limit: 2, settled: true } as const;
const parSettledShared = Parallel([Success(42)], settledOptions);
expectType<
    ParallelState<
        [number],
        ParallelOutcomes<[SuccessState<number>]>,
        never,
        unknown,
        ParallelOutcomes<[SuccessState<number>]>,
        never
    >
>(parSettledShared);

// @ts-expect-error a branch has to be an Effect
Parallel([42]);

// Each branch's error is its own. A Parallel fails with any of them, or with what next returns, which is
// inferred from next alone.
const failsA = Command(
    () => 1,
    (n) => (n ? Success(n) : Failure('a' as const))
);
const failsB = Command(
    () => 'x',
    (s) => (s ? Success(s) : Failure('b' as const))
);
expectType<ParallelState<[number, string], [number, string], 'a' | 'b'>>(Parallel([failsA, failsB]));
const parWithNextError = Parallel([failsA, failsB], ([n, s]) => (n > 1 ? Success(s) : Failure('small' as const)));
expectType<ParallelState<[number, string], string, 'a' | 'b' | 'small'>>(parWithNextError);
// @ts-expect-error an annotation has to cover the branches' errors, not only next's
const tooNarrow = (): Effect<string, 'small'> => Parallel([failsA], () => Failure('small' as const));

// Under settled, each outcome carries its own branch's error, and only next's failure escapes
const settledBatch = Parallel(
    [failsA, failsB],
    ([first, second]) => {
        expectType<SuccessState<number> | FailureState<'a'>>(first);
        expectType<SuccessState<string> | FailureState<'b'>>(second);
        return first.type === 'Failure' && second.type === 'Failure' ? Failure('all_failed' as const) : Success(true);
    },
    { settled: true }
);
const settledBatchResult = await runEffect(settledBatch);
if (settledBatchResult.type === 'Failure') {
    expectType<'all_failed'>(settledBatchResult.error);
}

// Branches built with map, as the README writes a loop, keep their error, and so does a pipeline holding one
const chargeOne = (id: number) =>
    Command(
        () => id,
        (n) => (n ? Success(n) : Failure('declined' as const))
    );
expectType<ParallelState<number[], number[], 'declined'>>(Parallel([1, 2].map(chargeOne), { limit: 1 }));
const chargeAll = effectPipe(
    (ids: number[]) => (ids.length ? Success(ids) : Failure('no_invoices' as const)),
    (ids: number[]) => Parallel(ids.map(chargeOne), { limit: 1 })
);
const chargeAllResult = await runEffect(chargeAll([1, 2]));
expectType<SuccessState<number[]> | FailureState<'no_invoices' | 'declined'>>(chargeAllResult);

// A Parallel written inside effectPipe's arguments, whose next cannot fail, adds no error. Its next's error
// was once inferred from the pipeline's expected type as well, and came out as any.
const countCharged = effectPipe((ids: number[]) => Parallel(ids.map(chargeOne), (charged) => Success(charged.length)));
expectType<Effect<number, 'declined'>>(countCharged([1]));

// --- Ctx (context type) ---

interface AppCtx {
    db: string;
}

// Ask infers Ctx from callback parameter type
const askWithCtx = Ask((ctx: AppCtx) => Success(ctx.db));
expectType<AskState<string, never, AppCtx>>(askWithCtx);

// effectPipe propagates Ctx through steps
const ctxFlow = effectPipe((input: User) => Ask((ctx: AppCtx) => Success({ ...input, conn: ctx.db })));
expectType<Effect<{ email: string; password: string; conn: string }, never, AppCtx>>(
    ctxFlow({ email: 'a@b.com', password: 'secret123' })
);

// runEffect enforces context argument matches Ctx
const ctxResult = await runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { db: 'conn' });
expectType<SuccessState<{ email: string; password: string; conn: string }> | FailureState<never>>(ctxResult);

// wrong context shape should error
// @ts-expect-error context does not match Ctx
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { wrong: 'thing' });
// @ts-expect-error the flow reads AppCtx, so a context is required
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }));
// a flow that reads no context still needs none
runEffect(Success(1));
// flowName names a run in traces and spans, so a typed context takes it beside what the flow reads, while a key the
// flow does not read is still refused
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { db: 'conn', flowName: 'signup' });
recordEffect(ctxFlow, { email: 'a@b.c', password: 'x' }, { context: { db: 'conn', flowName: 'signup' } });
replayEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), [], { context: { db: 'conn', flowName: 'signup' } });
timeTravel(ctxFlow, { trace: [] }, { context: { db: 'conn', flowName: 'signup' } });
// @ts-expect-error a key the flow does not read is still refused
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { db: 'conn', flowname: 'signup' });
// @ts-expect-error flowName is a string
runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { db: 'conn', flowName: 1 });
// a flow that reads no context takes any, as before, including an undefined one passed on with a call configuration
runEffect(Success(1), { tenant: 'acme' });
runEffect(Success(1), undefined, {});

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

// A Parallel needs every context its branches read, as a pipeline needs its steps'. The branches were once
// typed with one shared context that nothing inferred, so a Parallel read as needing none.
const readsDb = Ask((ctx: AppCtx) => Success(ctx.db));
const readsTenant = Ask((ctx: TenantCtx) => Success(ctx.tenant));
const dbBeside = Parallel([readsDb, Command(() => 1)]);
expectType<ParallelState<[string, number], [string, number], never, AppCtx>>(dbBeside);
// @ts-expect-error a branch reads AppCtx, so a context is required
runEffect(dbBeside);
// @ts-expect-error the branches read AppCtx and TenantCtx, and the tenant is missing
runEffect(Parallel([readsDb, readsTenant]), { db: 'conn' });
runEffect(Parallel([readsDb, readsTenant]), { db: 'conn', tenant: 't1' });
// @ts-expect-error settled branches read the context the same way
runEffect(Parallel([readsDb], { settled: true }));
// @ts-expect-error so do branches built with map
runEffect(Parallel(['a', 'b'].map(() => readsDb)));
// @ts-expect-error and a Parallel inside a pipeline
runEffect(effectPipe((id: string) => Parallel([readsDb, Command(() => id)]))('u1'));
// @ts-expect-error next's context counts too
runEffect(Parallel([Success(1)], ([n]) => Ask((ctx: AppCtx) => Success(ctx.db + n))));
// A branch written inside the array infers its own error and context, where the parameter's type once gave
// it any for both
const inlineBranches = Parallel([Ask((ctx: AppCtx) => Success(ctx.db)), Retry(Command(() => 1))]);
expectType<ParallelState<[string, number], [string, number], RetryExhaustedError, AppCtx>>(inlineBranches);

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

const myRun: RunWrapper = async (effect, op, flowName, initialInput) => {
    expectType<Effect<unknown>>(effect);
    expectType<string>(flowName);
    expectType<unknown>(initialInput);
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
// @ts-expect-error a wrapper has to pass the input on, or a recorder inside it stores none
const forgetsInput: RunWrapper = async (effect, op, flowName) => myRun(effect, op, flowName);

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
expectType<Promise<Replay<number, never>>>(replayEffect(readRow, traceLog, replayOptions));
expectType<Promise<Replay<number, never>>>(replayEffect(readRow, traceLog.trace));
(async () => {
    const { result, unreached } = await replayEffect(readRow, traceLog);
    expectType<SuccessState<number> | FailureState<never>>(result);
    expectType<TraceEntry[]>(unreached);
    const fromResolver = await replayEffect(readRow, () => ({ result: 42 }));
    expectType<SuccessState<number> | FailureState<never>>(fromResolver.result);
    // @ts-expect-error a Resolver cannot know what was left unreached
    fromResolver.unreached;
})();
// A source typed as the union (a wrapper forwarding whatever it was handed) still type-checks, with unreached optional
declare const traceOrResolver: TraceLog | TraceEntry[] | Resolver;
(async () => {
    const forwarded = await replayEffect(readRow, traceOrResolver);
    expectType<SuccessState<number> | FailureState<never>>(forwarded.result);
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
// toTrace keeps the types of the input and context it is given, as recordEffect's trace does
const packaged = rec.toTrace({ initialInput: 1, flowName: 'f', context: { tenant: 't' }, version: 'v' });
expectType<TraceLog<number, { tenant: string }>>(packaged);
const typedHead: TraceLog<{ id: string }> = rec.toTrace({ initialInput: { id: 'a' } });
expectAssignable<EffectConfiguration>({ onStep: rec.onStep });
expectAssignable<TraceMeta>({ version: 'abc' });

// an entry for a step that threw says so, and one without the flag, as older traces have, is still an entry
expectType<boolean | undefined>(rec.entries[0].threw);
expectAssignable<TraceEntry>({ command: 'cmdCharge', path: '0', threw: true, durationMs: 1 });
expectAssignable<TraceEntry>({ command: 'cmdCharge', path: '0', error: 'card_declined' });
// A trace imported as a JSON module has `threw: boolean`, since JSON imports widen `true`, and it has to replay:
// `threw: true` once refused every fixture with a failed step, which is how an incident becomes a regression test
declare const importedFixture: {
    initialInput: { email: string; password: string };
    trace: {
        command: string;
        path: string;
        threw: boolean;
        error: { name: string; message: string };
        durationMs: number;
    }[];
};
expectAssignable<TraceLog>(importedFixture);
replayEffect(typedFlow(importedFixture.initialInput), importedFixture);
// A value the recorder could not record is marked rather than stored, and declared as JSON imports widen it, as `threw` is
expectType<boolean | undefined>(rec.entries[0].unrecorded);
expectType<string[] | undefined>(rec.toTrace().unrecorded);
declare const unrecordedFixture: {
    unrecorded: string[];
    trace: { command: string; path: string; unrecorded: boolean; durationMs: number }[];
};
expectAssignable<TraceLog>(unrecordedFixture);

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
    // The trace keeps the input's type, so a replay rebuilds the flow from it with no cast
    expectType<TraceLog<User, unknown> & { initialInput: User }>(recorded.trace);
    expectType<User>(recorded.trace.initialInput);
    const replayedFromMemory = await replayEffect(typedFlow(recorded.trace.initialInput), recorded.trace);
    expectType<SuccessState<SavedUser> | FailureState<ValidationError | DbError>>(replayedFromMemory.result);
    const withCtx = await recordEffect(ctxFlow, { email: 'a@b.c', password: 'x' }, { context: { db: 'conn' } });
    expectType<SuccessState<{ email: string; password: string; conn: string }> | FailureState<never>>(withCtx.result);
    expectType<AppCtx | undefined>(withCtx.trace.context);
    // A trace read back from storage is untyped until the caller says otherwise
    const stored: TraceLog = JSON.parse(JSON.stringify(recorded.trace));
    expectType<unknown>(stored.initialInput);
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
