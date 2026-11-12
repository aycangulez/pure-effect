# TypeScript: Typed Errors and Context

This guide continues the [README](../README.md). The exact rules are in [REFERENCE.md](../REFERENCE.md#typescript).

The bundled declarations need TypeScript 5.1 or later.

## Error union across pipeline steps

Each step in `effectPipe` carries its own error type. The compiler collects them into a union automatically:

```ts
type ValidationError = 'invalid_email' | 'weak_password';
type ApiError = 'network_timeout' | 'rate_limited';

const validate = (input: { email: string }): Effect<{ email: string }, ValidationError> =>
    input.email.includes('@') ? Success(input) : Failure('invalid_email');
const submit = (input: { email: string }): Effect<{ id: number }, ApiError> => submitSignup(input);

const result = await runEffect(effectPipe(validate, submit)({ email: 'user@example.com' }));
if (result.type === 'Failure') {
    result.error; // 'invalid_email' | 'weak_password' | 'network_timeout' | 'rate_limited'
}
```

The annotations are optional. Without them, the union holds whatever each step can pass to `Failure`, each error kept exactly as written, whether a string or an object, so `Failure('invalid_email')` needs no `as const`, and errors of different shapes join into one union with no type argument. A step that cannot fail, such as a Command without a `next`, adds nothing.

If you do annotate a step, give the error type too. `Effect<User>` leaves the error as `unknown`, and `unknown` swallows the rest of the union, so the whole flow's error becomes `unknown`. That holds for a step written inline too, as in `(outcomes): Effect<Outcome> => ...`. For a step that cannot fail, write `Effect<Outcome, never>`. TypeScript also treats an annotated step as able to return any kind of Effect, so code that calls it directly checks `result.type === 'Failure'` before reading `result.error`; an `else` after a check for `'Success'` is not enough.

Annotating also makes hovers and error messages easier to read. Without it, they list every `Failure(...)` the flow can return. With it, they show the type you named, as `validate` and `submit` do above.

**A result's error also holds `Error`, for what a Command's function threw.** A Command whose function throws, or that an `onBeforeCommand` hook vetoes, ends the run with a `Failure` holding what was thrown, so `result.error` is typed as your steps' union plus `Error`, and so is each outcome a settled `Parallel` hands `next`. Check for it first with `result.error instanceof Error` and treat it as a server error; what remains is the union your steps declare, and TypeScript refuses to read a field of it until the check is there. One check covers the whole flow: catch inside a Command's function only what the flow can handle, and let the rest throw, which is also what lets `Retry` act on it.

Value types are checked through the pipeline too, so a step that reads a field the previous step does not return is a compile error. This only works while every step uses the value it receives. A step written as `() => doSomething(outer)` ignores it, and the types stop being checked at that point.

Exact rules: [TypeScript](../REFERENCE.md#typescript).

## Handling every error

A `switch` over a flow's error union can make TypeScript refuse a case you forgot. Check first for a thrown error with `instanceof Error`, and end the `switch` with a `never`, so a case added to the union later is a compile error until it is handled. TypeScript narrows a `switch` only over a union, so with a single error type, leave out the `default` and its `never`; the check for a thrown error stays the fallback:

```ts
type BillingError = { type: 'NoSubscription' } | { type: 'CardDeclined'; code: string };

async function billAndReport(tenantId: string) {
    const result = await runEffect(billTenant(tenantId));
    if (result.type === 'Success') return billed(result.value);
    if (result.error instanceof Error) return serverError(result.error); // a Command's function threw
    if ('retryExhausted' in result.error) return retryLater(result.error.retries); // the charge kept failing
    switch (result.error.type) {
        case 'NoSubscription':
            return skipTenant();
        case 'CardDeclined':
            return notifyDecline(result.error.code);
        default: {
            const unhandled: never = result.error;
            return serverError(unhandled);
        }
    }
}
```

`billTenant` retries its charge, so its union also holds `RetryExhaustedError`, for a call that kept failing until the `Retry` gave up; its `retryExhausted` field tells it apart. When the union also holds strings, check `typeof result.error === 'object'` before the `in`, which TypeScript accepts only on an object.

## Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => {
        const cmdFindProduct = () => catalog.find(ctx.tenant, productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('not_found')));
    });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

Given a function, `Ask`'s first type argument is the value, not the context, so `Ask<AppContext>((ctx) => ...)` leaves `ctx` typed `unknown`. Give all three, as above, or annotate the parameter, `Ask((ctx: AppContext) => ...)`, and let the rest be inferred.

Exact rules: [context in TypeScript](../REFERENCE.md#context).

## Generator flows

`effectGen` infers everything from the body. Each `yield*` is typed by its own step, the error union collects every step's errors and every `Failure` the body returns, and the context collects what every step reads:

```ts
const registerUser = effectGen(function* (input: { email: string }) {
    const found = yield* step(findUser(input.email)); // User | null
    if (found) return Failure('EMAIL_TAKEN');
    return yield* step(saveUser(input));
});
// (input: { email: string }) => Effect<User, 'EMAIL_TAKEN' | the errors findUser and saveUser declare>
```

Exact rules: [generator flows in TypeScript](../REFERENCE.md#generator-flows).

## A flow with no input

A flow takes its input as one parameter. For one that needs none, such as a nightly job that gets everything from its Commands, type the parameter `void`, so the flow is called with no argument. In a pipeline, that is the first step's parameter. Without it, `nightlyReport()` fails to compile with "Expected 1 arguments, but got 0":

```ts
const nightlyReport = effectGen(function* (_input: void) {
    const users = yield* step(listUsers());
    return users.length;
});

const result = await runEffect(nightlyReport());

// The same as a pipeline.
const nightlyCount = effectPipe(
    (_input: void) => listUsers(),
    (users) => Success(users.length)
);

const counted = await runEffect(nightlyCount());
```

The flight recorder warns once that such a flow's traces hold no input. For a flow that takes none, that is expected, and the warning can be ignored; see [`pure-effect/flight-recorder`](../REFERENCE.md#pure-effectflight-recorder).

## Testing a flow in TypeScript

A flow is typed as any kind of step it could start with, since validation may already have returned a `Success` or a `Failure`. So `.cmd` and `.next` compile only after the test checks that the step is a Command. `node:assert`'s `assert(step.type === 'Command')` is such a check, and TypeScript follows it. Jest's and Vitest's `expect` is not. `pure-effect/testing` has two helpers that work with any test framework. `assertStep` checks the kind of step, and `assertCommand` checks a Command's name too. Each returns the step typed as what it checked. Otherwise each throws an `AssertionError` that names what it found, such as `Expected Command 'cmdSaveUser', got Failure("Email already in use.")`:

```ts
import { assertCommand, assertStep } from 'pure-effect/testing';

const step1 = assertCommand(registerUserFlow(input), 'cmdFindUser');
assertCommand(step1.next(null), 'cmdSaveUser');

// A Retry holds its Command as effect, and the step after it is the Retry's next, not the Command's.
const retry = assertStep(saveUserWithRetry(input), 'Retry');
assertCommand(retry.effect, 'cmdSaveUser');
assertStep(retry.next({ id: 1 }), 'Success');
```

They work the same in JavaScript.

Exact rules: [walking a flow in a test](../REFERENCE.md#walking-a-flow-in-a-test).

## Replaying in TypeScript

A replay test needs three things the types leave to you: a table of answers, the input of a trace read back from storage, and the error a replay stops with.

```ts
import assert from 'node:assert/strict';
import { replayEffect } from 'pure-effect';
import type { ReplayFault, ReplayOutcome, Resolver, TraceLog } from 'pure-effect';

type Signup = { email: string; password: string };

// Answers by Command name, handed out in turn. Typed as ReplayOutcome lists, the table needs no cast.
const answers: Record<string, ReplayOutcome[]> = {
    cmdFindUser: [{ result: null }],
    cmdSaveUser: [{ result: { id: 1, email: 'ada@example.com' } }]
};
const inTurn: Resolver = (asked) => answers[asked.name]?.shift();
const answered = await replayEffect(registerUserFlow({ email: 'ada@example.com', password: 'password123' }), inTurn);
assert.equal(answered.result.type, 'Success');

// A stored trace's input is whatever type you give it, and a trace can hold none.
const stored: TraceLog<Signup> = JSON.parse(await readTrace('incident-8f3a'));
if (stored.initialInput === undefined) throw new Error('the trace holds no input to rebuild the flow from');
const { result } = await replayEffect(registerUserFlow(stored.initialInput), stored);

// A replay that stops ends in a Failure holding a TimeParadox or a ReplayError, each an Error: check its name, then cast.
const stopped = result.type === 'Failure' && result.error instanceof Error ? result.error : undefined;
if (stopped && (stopped.name === 'TimeParadox' || stopped.name === 'ReplayError')) {
    const fault = stopped as ReplayFault;
    assert.fail(`the replay stopped at ${fault.path}: ${fault.message}`);
}
```

Exact rules: [`replayEffect`](../REFERENCE.md#replayeffecteffect-traceorresolver-options).
