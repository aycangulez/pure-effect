# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect)
[![bundle size](https://img.shields.io/badge/minified%2Bgzipped-%3C1KB-brightgreen)](https://bundlephobia.com/package/pure-effect)
[![license](https://img.shields.io/npm/l/pure-effect)](./LICENSE)

**Pure Effect** is a zero-dependency effect library for JavaScript and TypeScript with built-in support for dependency injection, retry, and OpenTelemetry where business logic is plain data you can test without mocks.

- No mocks needed to test async pipelines
- Inject context without touching function signatures
- Built-in retry with configurable delay and backoff
- OpenTelemetry-ready via lifecycle hooks
- Zero dependencies, under 1 KB minified and gzipped
- Works in JavaScript and TypeScript (full generics, bundled `.d.ts`)
- Five primitives: learn the whole API in an afternoon

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Testing Without Mocks](#testing-without-mocks)
- [Passing Runtime Context](#passing-runtime-context)
- [Retrying Transient Failures](#retrying-transient-failures)
- [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context)
- [Why Pure Effect](#why-pure-effect)
- [API Reference](#api-reference)

## Installation

```bash
npm install pure-effect
```

## Quick Start

Here is a complete example of a user registration flow:

```js
import { Success, Failure, Command, effectPipe, runEffect } from 'pure-effect';

const validateRegistration = (input) => {
    if (!input.email.includes('@')) return Failure('Invalid email.');
    if (input.password.length < 8) return Failure('Password too short.');
    return Success(input);
};

// Theese function return a Command object. They do NOT call the database.
const findUser = (email) => {
    const cmdFindUser = () => db.findUser(email);
    return Command(cmdFindUser, (user) => Success(user));
};

const saveUser = (input) => {
    const cmdSaveUser = () => db.saveUser(input);
    return Command(cmdSaveUser, (saved) => Success(saved));
};

const ensureEmailAvailable = (user) => (user ? Failure('Email already in use.') : Success(true));

// effectPipe threads the output of each step into the next.
// When you need to use a captured variable instead of the piped value,
// wrap the call in an arrow function.
const registerUserFlow = (input) =>
    effectPipe(
        validateRegistration, // input -> Success(input)
        () => findUser(input.email), // ignores piped value, uses captured input
        ensureEmailAvailable, // found user (or null) -> Success(true)
        () => saveUser(input) // ignores piped value, uses captured input
    )(input);

// Imperative shell: this is the only place side effects run
async function registerUser(input) {
    const result = await runEffect(registerUserFlow(input));

    if (result.type === 'Success') {
        console.log('User created:', result.value);
    } else {
        console.error('Error:', result.error);
    }
}
```

## Testing Without Mocks

Because pipelines return plain objects, you can assert on _what the code intends to do_ without executing any of it. Using the registration flow defined in the previous section:

```js
// 1. Test validation failure synchronously
const badInput = { email: 'bad-email', password: '123' };
const result = registerUserFlow(badInput);

assert.deepEqual(result, Failure('Invalid email.', badInput));

// 2. Walk the pipeline to verify intent
const goodInput = { email: 'test@test.com', password: 'password123' };
const step1 = registerUserFlow(goodInput);

// First thing the code does: look up the user
assert.equal(step1.type, 'Command');
assert.equal(step1.cmd.name, 'cmdFindUser');

// Next thing: save the user (simulate "user not found" result)
const step2 = step1.next(null);
assert.equal(step2.type, 'Command');
assert.equal(step2.cmd.name, 'cmdSaveUser');
// The full flow is verified. The database was never touched.
```

## Passing Runtime Context

Some values come from the framework layer such as an authenticated tenant, a request trace ID, an environment config rather than from the data being processed. `Ask` lets a pipeline step read the `context` object passed to `runEffect` without threading it through every function signature.

In the example below, `ctx.tenant` is resolved from the JWT by the router. The domain layer never receives it as a parameter; it just asks for it when needed:

```js
import { Success, Failure, Command, Ask, effectPipe, runEffect } from 'pure-effect';

const findProduct = (productId) =>
    Ask((ctx) => {
        const cmdFindProduct = () => db[ctx.tenant].findProduct(productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('Product not found.')));
    });

const reserveStock = (product) =>
    Ask((ctx) => {
        const cmdReserveStock = () => db[ctx.tenant].reserveStock(product.id);
        return Command(cmdReserveStock, (reserved) => Success({ product, reserved }));
    });

const checkoutFlow = (productId) => effectPipe(findProduct, ({ product }) => reserveStock(product))(productId);

app.post('/checkout', async (req, res) => {
    const result = await runEffect(checkoutFlow(req.body.productId), {
        tenant: req.tenant
    });
    res.json(result);
});
```

## Retrying Transient Failures

`Retry` wraps any Effect tree with retry-on-failure semantics. Like everything else in Pure Effect, the retry configuration is a plain object you can inspect and assert on without running anything.

```js
import { Success, Failure, Command, Retry, effectPipe, runEffect } from 'pure-effect';

const fetchWeather = (city) => {
    const cmdFetchWeather = () =>
        fetch(`https://example-weather-api.com/v1/current?city=${city}`).then((r) => r.json());
    return Retry(
        Command(cmdFetchWeather, (data) => (data.error ? Failure(data.error) : Success(data))),
        { attempts: 3, delay: 200, backoff: 2 } // 200ms, 400ms, 800ms
    );
};

// Assert on the retry config without making any network calls
const weatherFn = fetchWeather('Tokyo');
assert.equal(weatherFn.type, 'Retry');
assert.equal(weatherFn.options.attempts, 3);
assert.equal(weatherFn.effect.type, 'Command');
```

When all attempts are exhausted, `runEffect` returns a structured `Failure`:

```js
{
    retryExhausted: true,
    lastError: <the last error>,
    attempts: 3
}
```

Global defaults can be set via `configureEffect` and overridden per-use:

```js
configureEffect({
    retry: { attempts: 3, delay: 100, backoff: 1 } // flat delay by default
});

// Per-use options are merged on top of global defaults
Retry(effect, { delay: 500 }); // uses global attempts, custom delay
```

## TypeScript: Typed Errors and Context

### Error union across pipeline steps

Each step in `effectPipe` carries its own error type. The compiler collects them into a union automatically, so the return type of `runEffect` tells you exactly which errors are possible with full exhaustive narrowing, no extra boilerplate.

```ts
import { effectPipe, runEffect, Failure, Success, Command } from 'pure-effect';
import type { Effect } from 'pure-effect';

type ValidationError = 'invalid_email' | 'weak_password';
type ApiError = 'network_timeout' | 'rate_limited';

const validate = (input: { email: string }): Effect<{ email: string }, ValidationError> => {
    if (!input.email.includes('@')) return Failure('invalid_email');
    return Success(input);
};

const submit = (input: { email: string }): Effect<{ id: number }, ApiError> => {
    const cmdSubmitUser = () =>
        fetch('/api/users', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.json());
    return Command(cmdSubmitUser, (data) => Success(data));
};

const flow = effectPipe(validate, submit);
const result = await runEffect(flow({ email: 'user@example.com' }));
// result: SuccessState<{ id: number }> | FailureState<ValidationError | ApiError>

if (result.type === 'Failure') {
    result.error; // 'invalid_email' | 'weak_password' | 'network_timeout' | 'rate_limited'
}
```

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object. TypeScript enforces that `runEffect` receives a matching value when you annotate `Ask` with a context type:

```ts
import { Ask, Command, Success, Failure, effectPipe, runEffect } from 'pure-effect';
import type { Effect } from 'pure-effect';

type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => {
        const cmdFindProduct = () => db[ctx.tenant].findProduct(productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('not_found')));
    });

// ctx is typed as AppContext, no cast needed
const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

## Why Pure Effect

**vs. Effect-TS:** Effect-TS is a full functional programming ecosystem with fibers, streaming, schema validation, dependency injection, and is probably the right choice if you need that breadth. It arguably comes with a steep learning curve though. Pure Effect targets a narrower scope (testable pipelines, context injection, retry) and can be learned in an afternoon.

**vs. fp-ts:** fp-ts applies category theory abstractions (functors, monads) to TypeScript. Pure Effect borrows only the concept of effects as data and expresses it without that vocabulary.

**vs. plain async/await with mocks:** Mocks can drift from real implementations silently. Pure Effect sidesteps the problem: business logic never executes I/O, so there is nothing to mock.

**When to use something else:** If your codebase has little async I/O or test isolation isn't a pain point, plain async/await is the simpler choice.

## API Reference

### `Success(value)`

Returns `{ type: 'Success', value }`. Represents a successful computation result.

### `Failure(error, initialInput?)`

Returns `{ type: 'Failure', error, initialInput }`. Stops the pipeline immediately and short-circuits any remaining steps.

### `Command(cmdFn, nextFn, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmdFn`: A function (sync or async) that performs the side effect.
- `nextFn`: Receives the result of `cmdFn` and returns the next Effect.
- `meta`: Optional metadata (available to `onBeforeCommand`).

### `Ask(nextFn)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`, which returns the next Effect. Works at any point in a pipeline.

```js
const findProduct = (productId) =>
    Ask((ctx) => {
        const cmdFindProduct = () => db[ctx.tenant].findProduct(productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('Product not found.')));
    });
```

### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`. Wraps any Effect with retry-on-failure semantics.

- `effect`: Any Effect: a `Command`, an `effectPipe` result, or another `Retry`.
- `options.attempts`: Max retries, not counting the first try (default: `3`).
- `options.delay`: Ms before the first retry (default: `100`).
- `options.backoff`: Multiplier applied to delay on each attempt (default: `1`, flat).

On exhaustion, returns `Failure({ retryExhausted: true, lastError, attempts })`.

### `effectPipe(...functions)`

Composes functions into a sequential pipeline. Each function receives the unwrapped `Success` value from the previous step. A `Failure` from any step stops the pipeline immediately.

When a step needs to use a captured variable instead of the piped value, wrap it in an arrow function:

```js
const flow = (input) =>
    effectPipe(
        validate, // receives input
        () => findUser(input.email), // ignores piped value, uses captured input
        ensureAvailable,
        () => saveUser(input) // ignores piped value, uses captured input
    )(input);
```

### `runEffect(effect, context?, callConfig?)`

The interpreter. Traverses the effect tree, executes Commands with `async/await`, resolves `Ask` with the supplied `context`, and returns the final `Success` or `Failure`.

- `context`: Optional object passed to `Ask` continuations and `onBeforeCommand`. `context.flowName` names the workflow in telemetry.
- `callConfig`: Per-call overrides for `onStep`, `onRun`, `onBeforeCommand`, and `retry`. Takes precedence over `configureEffect` globals.
- `onRun` fires exactly once per `runEffect` call. Retry attempts run inside that single span. The interpreter does not re-enter `runEffect` per attempt.

### `configureEffect(options)`

- `onRun(effect, pipeline, flowName)` wraps the entire workflow; must `await pipeline()`.
- `onStep(name, type, op)` wraps each Command; must `await op()` and return its result.
- `onBeforeCommand(command, context)` ires before each Command; throw to abort the pipeline.
- `retry: { attempts?, delay?, backoff? }` global retry defaults.

See **opentelemetry-example.js** in the repository for a complete OpenTelemetry wiring example.
