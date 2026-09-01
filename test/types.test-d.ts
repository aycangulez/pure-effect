import { expectType, expectError } from 'tsd';
import { Success, Failure, Command, Ask, Retry, Parallel, effectPipe, runEffect, configureEffect } from '../index.js';
import type {
    SuccessState,
    FailureState,
    CommandState,
    AskState,
    RetryState,
    ParallelState,
    RetryExhaustedError,
    Effect,
    EffectConfiguration,
    StepRunner,
    RunWrapper,
    CommandInterceptor
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
expectError(Success()); // missing argument

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
expectError(Command());

const cmd = Command(
    async () => ({ id: 1, email: 'a@b.com' }) as SavedUser,
    (saved) => {
        expectType<SavedUser>(saved);
        return Success(saved);
    }
);
expectType<CommandState<SavedUser, SavedUser, unknown>>(cmd);

// --- effectPipe type propagation ---

const step1 = (input: User) => Success(input);
const step2 = (user: User) =>
    Command(
        async () => ({ id: 1, ...user }) as SavedUser,
        (s) => Success(s)
    );

const flow = effectPipe(step1, step2);
expectType<Effect<SavedUser>>(flow({ email: 'a@b.com', password: 'secret123' }));
expectError(flow({ email: 'a@b.com' })); // missing password

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

// Retry with options preserves T; the error type is the exhaustion failure, not the inner error,
// because the interpreter wraps the last inner error rather than letting it escape
const retried = Retry(innerCmd, { attempts: 3 });
expectType<RetryState<number, RetryExhaustedError<unknown>>>(retried);

// Retry without options is valid
const retriedNoOpts = Retry(innerCmd);
expectType<RetryState<number, RetryExhaustedError<unknown>>>(retriedNoOpts);

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
expectType<Effect<SavedUser, RetryExhaustedError<unknown>>>(retryFlow({ email: 'a@b.com', password: 'secret123' }));

// The inner error type survives inside the exhaustion failure, so lastError is typed
const retriedTyped = Retry(Success(1) as Effect<number, 'net_down'>);
expectType<RetryState<number, RetryExhaustedError<'net_down'>>>(retriedTyped);

const retryResult = await runEffect(Retry(Success(1) as Effect<number, 'flaky'>, { attempts: 1 }));
if (retryResult.type === 'Failure') {
    expectType<RetryExhaustedError<'flaky'>>(retryResult.error);
    expectType<'flaky'>(retryResult.error.lastError);
}

// onExhausted consumes the exhaustion, so the fallback's error type is what remains
const recovered = Retry(Success(1) as Effect<number, 'flaky'>, {
    attempts: 1,
    onExhausted: (err) => {
        expectType<RetryExhaustedError<'flaky'>>(err);
        return Success(0) as Effect<number, 'cache_miss'>;
    }
});
expectType<RetryState<number, 'cache_miss'>>(recovered);

const recoveredResult = await runEffect(recovered);
if (recoveredResult.type === 'Failure') {
    expectType<'cache_miss'>(recoveredResult.error);
}

// onExhausted is per-use only: global retry defaults cannot carry a fallback
expectError(configureEffect({ retry: { attempts: 2, onExhausted: () => Success(1) } }));

// RetryExhaustedError shape is usable for narrowing exhaustion failures
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
expectError(runEffect(ctxFlow({ email: 'a@b.com', password: 'secret123' }), { wrong: 'thing' }));

// --- configureEffect / EffectConfiguration ---

// accepts full configuration
configureEffect({
    onStep: async (_name, _type, op) => op(),
    onRun: async (_effect, op, _flowName) => op(),
    onBeforeCommand: async (_cmd, _ctx) => {},
    retry: { attempts: 3, delay: 100, backoff: 2 }
});

// accepts partial configuration
configureEffect({ retry: { attempts: 5 } });
configureEffect({});

// rejects invalid shapes
expectError(configureEffect({ onStep: 'not-a-function' }));
expectError(configureEffect({ retry: { attempts: 'three' } }));

// hook types are correctly shaped
const myStep: StepRunner = async (name, type, op) => {
    expectType<string>(name);
    expectType<string>(type);
    return op();
};

const myRun: RunWrapper = async (effect, op, flowName) => {
    expectType<Effect<unknown>>(effect);
    expectType<string | undefined>(flowName);
    return op();
};

const myInterceptor: CommandInterceptor = async (cmd, _ctx) => {
    expectType<CommandState<unknown, unknown>>(cmd);
};

// EffectConfiguration is a usable type
const config: EffectConfiguration = { onStep: myStep, onRun: myRun, onBeforeCommand: myInterceptor };
expectType<EffectConfiguration>(config);
