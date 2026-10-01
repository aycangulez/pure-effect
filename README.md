# Pure Effect

[![npm version](https://img.shields.io/npm/v/pure-effect)](https://www.npmjs.com/package/pure-effect) [![minified size (gzip)](https://img.shields.io/bundlejs/size/pure-effect)](https://bundlejs.com/?q=pure-effect) [![license](https://img.shields.io/npm/l/pure-effect)](https://github.com/aycangulez/pure-effect/blob/main/LICENSE)

**Pure Effect** records what your business logic did in production and replays it anywhere: time-travel debugging for JavaScript and TypeScript, with zero dependencies. Business logic is plain data you can test without mocks.

- Replay a production failure locally, with no database and no network
- No mocks needed to test async pipelines
- Inject context without touching function signatures
- Built-in retry, plus parallel execution that cancels sibling branches on the first failure
- OpenTelemetry-ready via lifecycle hooks
- Zero dependencies, under 8 KB minified and gzipped
- Works in JavaScript, and in TypeScript 5.1 or later (full generics, bundled `.d.ts`)

## Table of Contents

- **Getting started:** [Installation](#installation) · [Quick Start](#quick-start) · [How It Works](#how-it-works) · [Testing Without Mocks](#testing-without-mocks) · [Coming from async/await](#coming-from-asyncawait)
- **Recording and replay:** [Time-Travel Debugging](#time-travel-debugging) · [Recording in Production](#recording-in-production)
- **Building flows:** [Passing Runtime Context](#passing-runtime-context) · [Retrying Transient Failures](#retrying-transient-failures) · [Running Effects in Parallel](#running-effects-in-parallel) · [Composing Larger Flows](#composing-larger-flows) · [Which Errors Are Data](#which-errors-are-data) · [TypeScript](#typescript-typed-errors-and-context)
- **Reference:** [Why Pure Effect](#why-pure-effect) · [Load Tests](#load-tests) · [API Reference](#api-reference) · [Limitations](#limitations)

The five sections under Getting started are enough to write and test a flow. Come back to the rest when a flow needs it: recording, retries, steps that run at the same time, or TypeScript.

## Installation

```
npm install pure-effect
```

## Quick Start

A user registration flow. Each step receives the value the previous step produced. An I/O step is a pair: the call to make, and a `next` function that receives the answer and decides what happens next.

```js
import { Success, Failure, Command, effectPipe, runEffect } from 'pure-effect';

// Pure. No I/O, instantly testable.
const validateRegistration = (input) => {
    if (!input.email.includes('@')) return Failure('Invalid email.');
    if (input.password.length < 8) return Failure('Password too short.');
    return Success(input);
};

// The next two functions return a Command object. They do not call the database.
// Name the commands: traces, replay matching, and telemetry spans use the names.
const ensureEmailAvailable = (input) => {
    const cmdFindUser = () => db.findUser(input.email);
    const next = (found) => (found ? Failure('Email already in use.') : Success(input));
    return Command(cmdFindUser, next);
};

// With no next function, the result passes straight through.
const saveUser = (input) => {
    const cmdSaveUser = () => db.saveUser(input);
    return Command(cmdSaveUser);
};

// Build the flow. Validation runs now; no I/O happens until runEffect.
const registerUserFlow = (input) => effectPipe(validateRegistration, ensureEmailAvailable, saveUser)(input);

// This is the only place side effects actually run
async function registerUser(input) {
    const result = await runEffect(registerUserFlow(input));

    if (result.type === 'Success') {
        console.log('User created:', result.value);
    } else {
        console.error('Error:', result.error);
    }
}
```

## How It Works

A flow is a chain of pairs: an I/O call, and a `next` function that receives its answer and returns the next Command, a Success, or a Failure. `runEffect` walks the chain in a loop.

Recording and replay hook into the one place where a Command's function is called. Recording writes down each answer. Replay supplies the recorded answer instead of making the call, so a replayed flow does no I/O.

Building a flow runs the pure steps right away: `registerUserFlow(badInput)` returns the validation `Failure` synchronously, so the tests below do not need `runEffect`. Only Commands need it.

## Testing Without Mocks

Pipelines return plain objects, so you can check what the code will do without running it.

Validation runs as soon as you build the flow, so testing it needs nothing else:

```js
const badInput = { email: 'bad-email', password: '123' };
assert.deepEqual(registerUserFlow(badInput), Failure('Invalid email.', badInput));
```

Next, test the steps. Hand a step an answer and check what it returns:

```js
const input = { email: 'test@test.com', password: 'password123' };

// The email is free, so the step passes the input on.
assert.deepEqual(ensureEmailAvailable(input).next(null), Success(input));

// The email is taken, so the flow stops here.
assert.deepEqual(ensureEmailAvailable(input).next({ id: 1 }), Failure('Email already in use.'));
```

Then test the flow: the right calls, in the right order. `commandName` gives the name a Command is recorded under:

```js
import { commandName } from 'pure-effect';

const step1 = registerUserFlow(input);
assert.equal(commandName(step1), 'cmdFindUser');

const step2 = step1.next(null); // pretend no user was found
assert.equal(commandName(step2), 'cmdSaveUser');
// The database was never touched.
```

Write both kinds, because they catch different bugs. Only step tests see the value passed from one step to the next.

For example, if the email guard returned `Success(true)` instead of `Success(input)`, the step test would fail: it expects the input back and gets `true`. The flow test would still pass, because `cmdFindUser` is still the first call and `cmdSaveUser` the second, while the flow saves `true` to the database instead of the user.

A step tested on its own returns a `Failure` without `initialInput`. That is why the assertion above is `Failure('Email already in use.')`, while the validation one is `Failure('Invalid email.', badInput)`: `effectPipe` adds the input when it builds a flow.

A walk stops at each Command to be handed its answer. To run the whole flow instead, `Retry` and `Parallel` included, hand `replayEffect` a function that answers each Command by name. Nothing is called and a retry does not wait, and answering `{ error }` makes that Command throw, which is how a test reaches a `Retry`'s fallback:

```js
const answers = { cmdFindUser: null, cmdSaveUser: { id: 1, ...input } };
const answer = (step) => (step.name in answers ? { result: answers[step.name] } : undefined);
const { result } = await replayEffect(registerUserFlow(input), answer);
assert.deepEqual(result, Success({ id: 1, ...input }));
```

Tests cannot see inside a Command's function without running it. If `cmdFindUser` said `db.findUser(input.name)` instead of `input.email`, every test on this page would still pass. Keep those functions to a single call, and let an integration test cover them.

**In TypeScript**, a flow is typed as any kind of step it could start with, since validation may already have returned a `Success` or a `Failure`, so `.cmd` and `.next` compile only after the test checks that the step is a Command. `node:assert`'s `assert(step.type === 'Command')` is such a check, and TypeScript follows it. Jest's and Vitest's `expect` is not, so a walk needs a check at every step, and a small helper makes that one line per step with any test framework:

```ts
import assert from 'node:assert/strict';
import { commandName } from 'pure-effect';
import type { Effect } from 'pure-effect';

// Fails unless the step is the Command named, and returns it typed as one.
function assertCommand<T, E, C>(step: Effect<T, E, C>, name: string) {
    assert(step.type === 'Command', `expected ${name}, got ${step.type}`);
    assert.equal(commandName(step), name);
    return step;
}

const step1 = assertCommand(registerUserFlow(input), 'cmdFindUser');
assertCommand(step1.next(null), 'cmdSaveUser');
```

For a step that returns its Command directly, as in `ensureEmailAvailable(input).next(found)`, `next` is checked against what the Command's function returns, so where the tests above pass `{ id: 1 }` for a user that was found, a TypeScript test passes a whole user, of the type `db.findUser` returns. A Command reached any other way, by walking the whole flow or through an `Ask`'s `next`, accepts any value, since its type does not say which Command it is.

## Coming from async/await

A flow does what `async`/`await` code does, as data. Instead of making a call and waiting for it, a step returns a Command that says which call to make and what to do with the answer. That is what lets a test hand a step an answer instead of mocking the database, and a replay hand it the recorded one. Each thing you would write with `async`/`await` has an equivalent:

| With `async`/`await` | In a flow |
| --- | --- |
| `const user = await db.findUser(email)` | a Command: `Command(() => db.findUser(email), next)` |
| the code after the `await`, which uses `user` | the Command's `next`, which receives `user` |
| an `if` on `user` after the `await` | a branch in `next` |
| `return value` | `Success(value)` |
| `throw` to stop | `Failure(error)` |
| a call inside `try`/`catch` | catch inside the Command's function and return a value for `next` to branch on; see [Which Errors Are Data](#which-errors-are-data) |
| a loop that retries a call | `Retry(Command(...), options)` |
| `await Promise.all([...])` | `Parallel([...])` |
| a `for` loop with an `await` inside | a step that gets the list, then `Parallel(list.map(...), { limit: 1 })` |
| a `try`/`catch` inside a loop, to keep going past a failure | the same `Parallel`, with `settled: true` |
| a later call that needs two earlier results | a named step that passes both on; see [Composing Larger Flows](#composing-larger-flows) |
| a value from the request, such as the tenant | `Ask`; see [Passing Runtime Context](#passing-runtime-context) |
| `Date.now()` or a random ID | a Command, so a replay gets the recorded value |

The Quick Start's `registerUserFlow` is this function, translated row by row: each `await` became a Command, the code after it became that Command's `next`, and each `throw` became a `Failure`.

```js
async function registerUserAsync(input) {
    if (!input.email.includes('@')) throw new Error('Invalid email.');
    const found = await db.findUser(input.email);
    if (found) throw new Error('Email already in use.');
    return db.saveUser(input);
}
```

The difference shows most in the tests. To reach the branch where the email is taken, a test of `registerUserAsync` has to replace the database's methods, run the function, and put the methods back. Here it is with Node's built-in mocks; Jest's `spyOn` works the same way:

```js
import { mock } from 'node:test';

const input = { email: 'test@test.com', password: 'password123' };

mock.method(db, 'findUser', async () => ({ id: 1 }));
const saveUser = mock.method(db, 'saveUser', async (user) => user);

await assert.rejects(registerUserAsync(input), { message: 'Email already in use.' });
assert.equal(saveUser.mock.callCount(), 0);
mock.restoreAll();
```

The flow's test of the same branch hands one step the answer, with nothing to replace, wait for, or put back:

```js
assert.deepEqual(ensureEmailAvailable(input).next({ id: 1 }), Failure('Email already in use.'));
```

This is what the small functions are for. Each step is a place a test can start, so a branch is tested by calling the step it lives in. An `async` function has one way in, so a test of any branch runs everything before it, with every call on the way replaced. The mocks can check one thing these tests cannot: the arguments each call received, which [Testing Without Mocks](#testing-without-mocks) leaves to an integration test.

A loop is written in two parts: a step that gets the list, and a `Parallel` over it. `Parallel` runs a list of flows, at the same time unless told otherwise, and `limit: 1` makes it run them one after another, like a `for` loop. The `async` version is usually split the same way. Paying a customer's unpaid invoices in order, and stopping at the first that fails:

```js
async function payUnpaidAsync(customerId) {
    const invoices = await billing.findUnpaid(customerId);
    for (const invoice of invoices) {
        const receipt = await payments.charge(invoice);
        await mailer.sendReceipt(receipt);
    }
}

// First part: get the list.
const findUnpaidInvoices = (customerId) => {
    const cmdFindUnpaid = () => billing.findUnpaid(customerId);
    return Command(cmdFindUnpaid);
};

// Second part: the loop's body, a flow of its own for one invoice.
const chargeInvoice = (invoice) => {
    const cmdChargeInvoice = () => payments.charge(invoice);
    return Retry(Command(cmdChargeInvoice), { attempts: 3 });
};

const sendReceipt = (receipt) => {
    const cmdSendReceipt = () => mailer.sendReceipt(receipt);
    return Command(cmdSendReceipt);
};

const payInvoice = (invoice) => effectPipe(chargeInvoice, sendReceipt)(invoice);

// The loop: one body per invoice, run one at a time.
const payAll = (invoices) => Parallel(invoices.map(payInvoice), { limit: 1 });

const payUnpaid = (customerId) => effectPipe(findUnpaidInvoices, payAll)(customerId);

// The flow starts by getting the list, and hands what it gets to the loop.
const flow = payUnpaid('cus_1');
assert.equal(commandName(flow), 'cmdFindUnpaid');
assert.equal(flow.next([{ id: 1 }, { id: 2 }]).effects.length, 2);

// The body is tested on its own: the Retry holds only the charge, and the receipt comes after it.
const body = payInvoice({ id: 1 });
assert.equal(commandName(body.effect), 'cmdChargeInvoice');
assert.equal(commandName(body.next({ id: 'receipt_1' })), 'cmdSendReceipt');

// An empty list runs nothing.
assert.deepEqual(await runEffect(payAll([])), Success([]));
```

Each invoice is paid after the one before it has finished, and the first that fails stops the rest from starting, as in the `async` version. When the payments can overlap, a higher `limit` runs several at a time.

The loop's body is a flow built for one item, so it can hold as many steps as the body of a `for` loop. Put a `Retry` inside it, on the step that needs one. Around the whole loop, a `Retry` would pay every invoice again after one failed, charging the ones already paid; around the whole body, a receipt that failed to send would charge the card again. See [Retrying Transient Failures](#retrying-transient-failures).

The `Parallel`'s `next` receives what each body returned, in order, so a total or a summary of the loop goes there: `Parallel(invoices.map(payInvoice), (receipts) => Success(receipts.length), { limit: 1 })`. To keep going past a failure, as a `try`/`catch` inside the loop would, add `settled: true`: every invoice is tried, and `next` receives one `Success` or `Failure` per invoice. See [Running Effects in Parallel](#running-effects-in-parallel).

Sometimes getting the list is a loop of its own. Paging through an API with a cursor is one: each request needs the cursor from the page before, so the requests cannot be listed in advance. Write that loop as an ordinary `async` function, call it from one Command, and map over the list it returns, as above:

```js
async function fetchAllOrders() {
    const orders = [];
    let cursor = null;
    do {
        const page = await api.listOrders(cursor);
        orders.push(...page.items);
        cursor = page.nextCursor;
    } while (cursor);
    return orders;
}

const listAllOrders = () => {
    const cmdListAllOrders = () => fetchAllOrders();
    return Command(cmdListAllOrders);
};
```

To the flow, the whole loop is one step. A trace records the finished list as that step's result, and a replay hands the list back without replaying the pages. A `Retry` around the Command starts again from the first page. A flow test cannot see inside it, so, like any Command's function, it is left to an integration test.

The loop belongs in the flow only when the flow has to decide something on each pass, such as stopping at the first order that matches, or saving each page as it arrives. Then the Command's `next` returns the Command for the next page instead of a `Success`, until there are no more pages.

## Time-Travel Debugging

Record what each Command returned, then feed those results back into the flow to retrace the path a request took, with no database or network.

```js
import { recordEffect, replayEffect, timeTravel } from 'pure-effect';

// Record a real run. The context's flowName names the flow in the trace.
const { result, trace } = await recordEffect(checkoutFlow, input, {
    version: process.env.BUILD_ID,
    context: { flowName: 'checkout' }
});

// Later, somewhere else, with nothing connected:
await timeTravel(checkoutFlow, trace);
```

```
Replaying 'checkout' (3 recorded steps)
Initial input: {
  "cartId": "cart_abc123",
  "promoCode": "FREE_YEAR_VIP"
}
Step 1: cmdFetchCart returned in 41.277ms {
  "totalAmount": "120.00"
}
Step 2: cmdValidatePromo returned in 26.814ms {
  "isValid": true,
  "discountValue": 100
}
Step 3: cmdChargeCard threw in 181.507ms {
  "code": "invalid_amount",
  "name": "Error",
  "message": "Amount must be non-zero."
}
Replay finished with state: Failure
Error: {
  "code": "invalid_amount",
  "name": "Error",
  "message": "Amount must be non-zero."
}
```

A production incident becomes a regression test, with no mocks or fixtures:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test checks that the flow still takes the recorded path and handles the recorded outcomes the same way. If a refactor reorders or replaces a step, the replay ends in a `Failure` whose error is a `TimeParadox` naming where it diverged. It is not thrown, so a test that expects a `Failure` should check the error too, as this one checks its `code`. If the error handling changes, the assertion fails.

A flow that stops issuing Commands before the recording ends (for example, a fix that skips the charge) produces no `TimeParadox`, and the replay can end in `Success` with recorded steps left over. `replayEffect` returns those steps as `unreached`, so a test can assert which ones it expects to skip:

```js
it('incident 8f3a fixed: a 100% promo checks out without a charge', async () => {
    const { result, unreached } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Success');
    assert.deepEqual(
        unreached.map((e) => e.command),
        ['cmdChargeCard']
    );
});
```

For every other recording, `unreached` should be empty, so a fix that skips a step by accident fails the test.

This works when the removed step is the last one the flow reaches. Remove a step from the middle and every later step moves to a different path, so the replay stops at a `TimeParadox`. In that case `unreached` lists the steps the replay never got to, not the steps the fix made unnecessary.

**Replay checks the path, not the values.** It shows that the flow asks for the same Commands in the same order and handles the same answers. It cannot check what the flow computes, because every Command's result comes from the recording, not from the new code. If you fix how a refund amount is calculated and replay the bad run, the charge step gets the old amount from the recording: the replay reports `Success`, returns the value from before the fix, and flags nothing. Test a change to a value against the pure step that computes it.

**A replay cannot check a fix inside a Command's function either.** The function never runs, so the replay hands the flow what it returned or threw before the fix: catch a duplicate-key error inside the function and return it as data, and the old trace still replays the throw. Cover such a fix with an integration test. And when a Command's result changes shape, rename the Command, since a trace matches it by name: under the old name, an old trace hands the new code a result in the old shape, which it can take for another answer without any `TimeParadox`.

**A trace records what each Command returned, not the arguments it was called with.** Given the recorded input and results, the flow does the same thing again, so replaying up to a step rebuilds the arguments that Command ran with. You can inspect them in a debugger, but you cannot assert on them. Storing arguments would also double what `redact` has to cover, since arguments are usually the sensitive part of a call.

**Put anything that varies between runs inside a Command.** For replay, the current time or a random ID counts as I/O. Wrapped in a Command, it is recorded and replayed like any other result. A step that calls `Date.now()` directly gets a new value on every replay and drifts from the trace.

**To check for this,** record a flow, send the trace through JSON as your storage would, replay it, and compare the outcomes. A step that computes a new value on each run shows up as a `TimeParadox` if it changes which Commands run, or as a different final value. Going through JSON also catches a result that storage cannot keep, such as a `Date`, a class instance, or `undefined` in an array, which is where a replay from memory and a replay from storage part ways:

```js
const { result, trace } = await recordEffect(registerUserFlow, input);
const stored = JSON.parse(JSON.stringify(trace)); // what your storage gives back
const { result: replayed } = await replayEffect(registerUserFlow(input), stored);
assert.deepEqual(replayed, result); // fails if a step computed a fresh value, or a result did not survive JSON
```

This also works for a `Failure`: an error read back from a trace keeps its message, name, cause, custom properties, and an `AggregateError`'s list of errors, and is deep-equal to the one the Command threw, including one whose `name` or `cause` was set after it was created. The exception is a custom error class, which comes back as a plain `Error` with that class's name; compare `error.name` and `error.message` instead.

**You choose the trace format.** `replayEffect` also accepts a resolver function instead of a trace, so you can replay from OpenTelemetry spans, a log pipeline, or a database table, not only from the JSON that `recorder` produces.

```js
// A resolver answers one question: what did production get back for this step?
const resolve = (step) => ({ result: mySpans[step.index].attributes.output });
await replayEffect(checkoutFlow(input), resolve);
```

## Recording in Production

`recordEffect` suits tests and scripts, where one call covers the whole run. To record an application without changing any call site, install the hooks once at startup. The two files imported below ship in the package's `examples` folder, `node_modules/pure-effect/examples`, and in the repository's [examples folder](https://github.com/aycangulez/pure-effect/blob/main/examples); copy them into your project.

```js
import { randomUUID } from 'node:crypto';
import { configureEffect } from 'pure-effect';
import { recordingHooks } from './recording-example.js';
import { telemetryHooks } from './opentelemetry-example.js';

configureEffect(
    telemetryHooks(),
    recordingHooks({
        sink: (trace) => putObject(`traces/${trace.flowName}/${randomUUID()}.json`, JSON.stringify(trace)),
        // A replay runs validation again on the stored input, so the stand-in keeps the password rule's verdict.
        redact: (value, name, kind) =>
            kind === 'initialInput' ? { ...value, password: value.password.length >= 8 ? '[redacted]' : '' } : value,
        maxEntries: 500,
        keep: (result) => result.type === 'Failure' // the default; keep everything, or sample
    })
);
```

By default, successful runs are held in memory and then discarded. A run that rejects because your own code threw, such as a `TypeError` after an API changed the shape of its response, is offered to `keep` as a `Failure` carrying the thrown error, so by default its trace is kept, and the run still rejects. Replaying that trace reproduces the throw. If `keep` or the sink throws, for example because `JSON.stringify` meets a value it cannot serialize, the run keeps its own outcome and the error goes to `onSinkError`, which defaults to `console.error`. `redact` runs before anything enters the trace, including the stored `initialInput` and `context`. `maxEntries` caps the length of a trace and reports the overflow as `dropped`; a capped trace replays only up to the first step it lacks, so the example warns through `onWarning` the first time it keeps one for a flow. It warns the same way about a flow whose steps include any named `'anonymous'`. The sink can write a trace to S3 or a database column as JSON, as long as your Commands return plain data.

The example reads the input from the flow itself, where `effectPipe` stores it, so build the outermost flow with `effectPipe`. A flow that starts with a bare `Command`, `Ask`, `Retry`, or `Parallel` records no input, and `timeTravel` would rebuild it from `undefined`. A one-step pipeline is enough, as in `runEffect(effectPipe(loadProfile)(userId))`. The example warns through `onWarning`, which defaults to `console.warn`, the first time it keeps a trace of such a flow, and `timeTravel` warns when it replays one. The example also takes the context from the run's first Command, so a run that stops before any Command, for example at an `Ask` check, records no context. Such a run did no I/O, so running the flow again with its input and the context from your logs reproduces it.

**A trace keeps data, not objects.** A result is copied when it is recorded, and copied again each time a replay hands it to the flow, so neither a later step nor a replay can change what the trace says. The copy keeps values but not classes: a money object or a database entity comes back as a plain object without its methods, and a `Buffer` as a plain byte array. An error returned inside a result keeps its message but loses properties such as `code`. Writing the trace as JSON loses more: a `Date` becomes a string, a `Map` becomes `{}`, an error inside a result becomes `{}`, `undefined` in an array becomes `null`, and a `BigInt` makes the sink throw.

So return plain data from a Command's function. Turn a class instance into a plain object before returning it, with a small named function you can test on its own, as in `() => db.findCart(id).then(cartToData)`, and rebuild the object in `next` if the flow needs its methods. When you catch an error to return it as data, copy the fields the flow branches on, as in `.catch((error) => ({ ok: false, code: error.code }))`, rather than returning the error itself.

## Passing Runtime Context

Some values come from the framework (an authenticated tenant, a request ID, environment config) rather than from the data being processed. `Ask` lets a step read the `context` object passed to `runEffect` without passing it through every function:

```js
import { Success, Failure, Command, Ask, effectPipe, runEffect } from 'pure-effect';

const findProduct = (productId) =>
    Ask((ctx) => {
        const cmdFindProduct = () => db[ctx.tenant].findProduct(productId);
        return Command(cmdFindProduct, (product) => (product ? Success(product) : Failure('Product not found.')));
    });

app.post('/checkout', async (req, res) => {
    const result = await runEffect(checkoutFlow(req.body.productId), { tenant: req.tenant });
    if (result.type === 'Success') return res.json(result.value);
    // A Failure also carries the flow's input, so send the client only an error meant for it.
    // Answer the errors the flow returns by name, and anything else, such as a database outage, as a server error.
    if (result.error === 'Product not found.') return res.status(400).json({ error: result.error });
    res.status(500).json({ error: 'Checkout failed.' });
});
```

Recording stores the context alongside the trace, so `Ask` replays with the values the original request saw. It is copied once per run, so read a value that can change while a run is under way, such as a switch an operator can flip to stop a batch, in a Command, whose result the trace records each time.

## Retrying Transient Failures

`Retry` runs part of a flow again when its I/O fails, meaning a Command's function throws. It does not retry a `Failure` that a step returned: that means the flow decided to stop, so the `Failure` is passed on at once, unchanged. Options are given where `Retry` is used, since they describe one dependency. An option set to `undefined` keeps its default, so settings read from configuration can leave a key out. To reuse the same settings, share an object:

```js
const flakyNetwork = { attempts: 3, delay: 200, backoff: 2 };
Retry(fetchPrice(sku), flakyNetwork);
```

The retry settings are a plain object, so you can inspect and assert on them without running anything:

```js
import { Success, Failure, Command, Retry, runEffect } from 'pure-effect';

const fetchWeather = (city) => {
    const cmdFetchWeather = () =>
        fetch(`https://example-weather-api.com/v1/current?city=${city}`).then((r) => r.json());
    return Retry(
        Command(cmdFetchWeather, (data) => (data.error ? Failure(data.error) : Success(data))),
        { attempts: 3, delay: 200, backoff: 2 } // 200ms, 400ms, 800ms
    );
};

const weatherFn = fetchWeather('Tokyo');
assert.equal(weatherFn.type, 'Retry');
assert.equal(weatherFn.options.attempts, 3);
```

**Wrap the Command that fails, not the pipeline.** Each attempt re-runs everything inside the `Retry`, including Commands that already succeeded:

```js
// Dangerous: a flaky receipt step charges the customer again on every attempt.
Retry(effectPipe(chargeCard, sendReceipt)(order), { attempts: 3 });

// Correct: only the step that fails transiently is retried.
effectPipe(chargeCard, (charge) => Retry(sendReceipt(charge), { attempts: 3 }))(order);
```

Wrapping a pipeline is safe only when every Command in it is idempotent (safe to run more than once).

**Wrapping one Command is not always enough.** A Command's `next` is inside the `Retry` too, so if `next` continues the flow, everything after it is retried as well. This looks like it follows the advice above, but it does not:

```js
// Dangerous: `next` continues the booking, so every later step is inside the Retry.
Retry(
    Command(cmdHoldSeat, (seat) => chargeCard(trip, seat)),
    { attempts: 2 }
);
```

If a later Command's function throws, the `Retry` runs again, which repeats the seat hold and the charge. With two of these nested, a failure in the last step of a booking charges the card nine times.

Instead, leave the retried Command with its default `next` and continue in a later pipeline step, outside the `Retry`:

```js
// Safe: the tree the Retry repeats is that one Command.
effectPipe(
    () => Retry(Command(cmdHoldSeat), { attempts: 2 }),
    (seat) => chargeCard(trip, seat)
);
```

When every attempt fails, `runEffect` returns a `Failure` with this error:

```text
{ retryExhausted: true, lastError: <the last error>, attempts: 3 }
```

In TypeScript, a `Retry` adds `RetryExhaustedError` to the pipeline's error union, next to the error type of the steps it wraps, since a `Failure` those steps return passes through unchanged. `lastError` is typed `unknown`: it is whatever the Command's function threw, and nothing in the types says what that is, so check it before using it, for example with `instanceof Error`.

**Use `onExhausted` to fall back when every attempt fails.** The fallback runs instead of returning the `Failure`. If it succeeds, its value continues down the pipeline. If it fails, its own `Failure` is returned as is:

```js
const fetchPrice = (sku) =>
    Retry(fetchLivePrice(sku), {
        attempts: 3,
        onExhausted: (err) => fetchCachedPrice(sku) // err = { retryExhausted, lastError, attempts }
    });
```

Fallback steps are recorded, so a replay repeats the fallback too. A fallback never starts in a `Parallel` branch that has already been cancelled. With `onExhausted` set, the `Retry` adds the fallback's error type to the TypeScript error union instead of `RetryExhaustedError`.

Every attempt is recorded, so a replay repeats the same sequence of failures, without the delays.

## Running Effects in Parallel

`Parallel` runs several flows at the same time and passes their results to `next` as an array, in order. If a branch fails, the other branches are cancelled, `next` is not called, and that branch's `Failure` is returned.

```js
import { Success, Command, Parallel } from 'pure-effect';

const loadProfile = (userId) =>
    Parallel([getUser(userId), getPermissions(userId)], ([user, permissions]) => Success({ user, permissions }));
```

`next` is optional, as with `Command`. Without it, `Parallel(effects)` returns the array of values.

Every branch can read the `Ask` context.

**Options for batches.** The second argument can be either `next` or an options object:

```js
// At most 5 branches in flight, for a gateway that rate limits.
Parallel(subscriptions.map(billOne), { limit: 5 });

// Every branch runs to completion, and `next` receives the outcomes rather than the values.
Parallel(subscriptions.map(billOne), { limit: 5, settled: true });
```

Without `settled`, one failing branch cancels the rest and becomes the result of the whole `Parallel`, so one bad record can stop a batch halfway through. With `settled: true`, every branch runs to the end and `next` receives one `Success` or `Failure` per branch, in order, so a failed record is something you can count instead of the end of the job. In TypeScript, write `settled: true` where you call `Parallel`, or mark a shared options object `as const`: since `settled` decides what `next` receives, a value the compiler only knows as `true` or `false` is refused.

```js
Parallel(subscriptions.map(billOne), (outcomes) => Success(outcomes.map(summarize)), { limit: 5, settled: true });
```

A `Failure` in the list carries its branch's input when that branch was built with `effectPipe`, and no input otherwise, so match outcomes to records by their position in the list. When you report the outcomes, pick the fields you need rather than logging the whole object:

```js
Parallel(work, (outcomes) => Success(outcomes.map((o) => (o.type === 'Success' ? o.value : o.error.message))), {
    settled: true
});
```

Logging the outcomes as they are would include each branch's input, which for a registration or login contains credentials.

The outcomes are plain `Success` and `Failure` objects. Returning one of them from `next` is the same as returning any other `Failure`: the flow stops, and `Retry` does not run it again.

Bugs in the flow are not collected. An `EffectTypeError`, thrown for a malformed flow, and an error thrown by a `next` function or a pure step both still escape a settled `Parallel`, after the other branches are cancelled.

`limit` caps how many branches run at once; the rest start as others finish. Results and recorded paths stay in array order, so a limit changes only the pacing, and a trace recorded with a limit replays the same without one. A `limit` that is not a positive integer throws a `TypeError`.

**Cancelling is a request, not a guarantee.** A cancelled branch starts no new Commands: a three-step branch whose first step is running when a sibling fails finishes that step and stops. To stop the running step itself, its function has to accept the `AbortSignal` it is given and pass it on to the I/O:

```js
// Cancellable: the request is aborted the moment a sibling branch fails.
const fetchProfile = (userId) => Command((signal) => fetch(`/users/${userId}`, { signal }).then((r) => r.json()));

// Not cancellable: this runs to completion even after a sibling fails.
const fetchProfileUncancellable = (userId) => Command(() => fetch(`/users/${userId}`).then((r) => r.json()));
```

Outside a `Parallel`, the function is called with no arguments. A `Retry` inside a cancelled branch stops retrying.

Which branch failed first and cancelled the others depends on timing, so it is recorded with the trace. A replay of a cancelled `Parallel` returns the same failure production did, and stops each other branch where production stopped it, rather than letting whichever branch the replay reaches first decide. The same holds when the branch that cancelled the others was a `next` function or a pure step that threw: the replay throws the same error. If the branch that cancelled the others no longer fails, or the `Parallel` no longer has that branch, the replay ends in a `TimeParadox` naming it.

**Undoing what succeeded when a branch fails.** Without `settled`, the failing branch's `Failure` is the whole result, and the values of the branches that succeeded are dropped. When one of them did something that has to be undone, such as charging a card for an order whose stock then ran out, the code that called `runEffect` no longer has the charge to refund. Use `settled: true`, so `next` sees every outcome, and have it return the steps that undo whatever succeeded, followed by the failure:

```js
const reserveStock = (order) => {
    const cmdReserveStock = () => inventory.reserve(order.items);
    return Command(cmdReserveStock, (r) => (r.ok ? Success(r.reservationId) : Failure('out_of_stock')));
};

const chargeOrder = (order) => {
    const cmdChargeOrder = () => payments.charge(order.customerId, order.total);
    return Command(cmdChargeOrder, (c) => (c.ok ? Success(c.chargeId) : Failure('card_declined')));
};

const releaseStock = (reservationId) => {
    const cmdReleaseStock = () => inventory.release(reservationId);
    return Command(cmdReleaseStock);
};

const refundCharge = (chargeId) => {
    const cmdRefundCharge = () => payments.refund(chargeId);
    return Command(cmdRefundCharge);
};

// Passes both results on, or undoes whichever step succeeded and then fails.
const reserveAndCharge = (order) =>
    Parallel(
        [reserveStock(order), chargeOrder(order)],
        ([reservation, charge]) => {
            if (reservation.type === 'Failure') {
                const undo = charge.type === 'Success' ? [refundCharge(charge.value)] : [];
                return Parallel(undo, () => Failure(reservation.error));
            }
            if (charge.type === 'Failure') {
                return Parallel([releaseStock(reservation.value)], () => Failure(charge.error));
            }
            return Success({ order, reservationId: reservation.value, chargeId: charge.value });
        },
        { settled: true }
    );
```

`next` is a plain function, so each case is tested by handing it the outcomes, with no I/O:

```js
const order = { id: 'order_1', customerId: 'cus_1', items: [], total: 120 };

// The card was charged, then the stock ran out: the flow refunds the charge and fails.
const undoing = reserveAndCharge(order).next([Failure('out_of_stock'), Success('ch_1')]);
assert.equal(commandName(undoing.effects[0]), 'cmdRefundCharge');
assert.deepEqual(undoing.next([null]), Failure('out_of_stock'));

// Both succeeded, so there is nothing to undo.
assert.deepEqual(
    reserveAndCharge(order).next([Success('res_1'), Success('ch_1')]),
    Success({ order, reservationId: 'res_1', chargeId: 'ch_1' })
);
```

A settled `Parallel` cancels nothing, so both steps always run to the end, and the undoing starts once both have finished. The undo steps are part of the flow, so a trace records them and a replay repeats them. An undo step that fails ends the flow with its own error rather than the original one; wrap it in `Retry` if it can fail for a moment.

## Composing Larger Flows

`effectPipe` runs steps in a straight line. Branching and joining use the same pieces:

**A step can return a sub-pipeline.** `effectPipe(...)(value)` returns an Effect like any other, so a step can branch into another flow. A `Failure` in that flow stops the outer pipeline too:

```js
const processOrder = (order) => (order.isGift ? giftFlow(order) : standardFlow(order));

const fulfillment = effectPipe(validateOrder, processOrder, scheduleShipping);
```

**Use `Parallel` to join values that do not depend on each other.** When a later step needs several such values, fetch them at the same time. Without `next`, the results arrive as an array, in order:

```js
const loadCheckout = effectPipe(
    (input) => Parallel([fetchCart(input.cartId), fetchUser(input.userId)]),
    ([cart, user]) => Success({ cart, user, total: cartTotal(cart) })
);
```

**Join values that depend on each other in a named step.** When step B needs step A's result and step C needs both, write a small step that runs B and passes both forward in one value. Give it a name, and the pipeline reads as a list of steps:

```js
// Fetches the order's customer and passes on both.
const withCustomer = (order) => effectPipe(fetchCustomer, (customer) => Success({ order, customer }))(order.customerId);

const applyLoyaltyDiscount = (orderId) =>
    effectPipe(fetchOrder, withCustomer, ({ order, customer }) => Success(discountedTotal(order, customer)))(orderId);
```

When the lookup is written in place rather than reused, the Command's own `next` does the join, with no pipeline inside the step: `Command(() => db.findCustomer(order.customerId), (customer) => Success({ order, customer }))`.

**Pass only what the next steps need.** Avoid one object that collects everything computed so far. When a step's input is all it gets, it cannot depend on a value from far upstream without showing it, stale fields do not linger, and two steps cannot clash over the same key. Data also lives only as long as the flow needs it, which matters for credentials and personal data. In TypeScript, it keeps the pipeline type-checked: if an upstream step changes what it returns, the step that reads the value fails to compile instead of getting `undefined` at runtime.

## Which Errors Are Data

Pure Effect has no catch, on purpose. A flow's outcomes are of two kinds, and each is written differently.

**An outcome the flow handles is data.** A Command's `next` receives the result and can return any Effect, including a fallback pipeline. When the I/O can reject, catch the error inside the Command's function and return it as a value:

```js
const fetchCachedPrice = (sku) => {
    const cmdFetchCachedPrice = () => cache.get(sku);
    return Command(cmdFetchCachedPrice, (price) => Success({ ...price, stale: true }));
};

const fetchPrice = (sku) => {
    const cmdFetchLivePrice = () =>
        pricing
            .get(sku)
            .then((price) => ({ ok: true, price }))
            .catch((error) => ({ ok: false, code: error.code, message: error.message }));
    return Command(cmdFetchLivePrice, (r) => (r.ok ? Success({ ...r.price, stale: false }) : fetchCachedPrice(sku)));
};
```

The failed attempt is recorded as that Command's result, with the error's `code` and `message`, so a replay takes the same fallback branch. Copy the fields you need rather than returning the error itself: a trace keeps data, not objects, so an error stored inside a result loses its properties (see [Recording in Production](#recording-in-production)).

**A `Failure` means abort.** It stops the flow and goes back to the code that called `runEffect`, which decides what it means: an HTTP status, a queue retry, an alert. Nothing inside the flow can catch a `Failure`, so a reader never has to look elsewhere for a handler.

Rule of thumb: if you would handle it, return it as a value; if you would only report it, return a `Failure`. The one exception is retry exhaustion, which happens inside `Retry`; handle it with the `onExhausted` option in [Retrying Transient Failures](#retrying-transient-failures).

**Catch or retry, not both.** `Retry` only reacts to a function that throws. If you catch a 503 inside the function and return it as a value, then wrap the step in `Retry`, it makes one call and never retries. Catch the error when the flow should handle it as data; let it throw when `Retry` should try again.

```js
// Handled as data: one call, and `next` decides what the miss means.
Command(
    function cmdFetchPrice() {
        return pricing
            .get(sku)
            .then((price) => ({ ok: true, price }))
            .catch((error) => ({ ok: false, code: error.code, message: error.message }));
    },
    (r) => (r.ok ? Success(r.price) : fetchCachedPrice(sku))
);

// Retried: the function lets the rejection out, so the interpreter sees an I/O fault.
Retry(
    Command(function cmdFetchPrice() {
        return pricing.get(sku);
    }),
    { attempts: 3 }
);
```

`runEffect` tells these cases apart:

| what happened | what it is | what `Retry` does | what `onExhausted` sees |
| --- | --- | --- | --- |
| a step returned `Failure(...)`, or an `onBeforeCommand` hook threw | an abort | nothing; it propagates at once, unwrapped | nothing |
| a Command's function threw | an I/O fault | retries it | the exhaustion, once the attempts are gone |
| a `next` function or a pure step threw, or the flow is malformed | a bug | nothing; it is thrown, not returned | nothing |
| an `onStep` hook threw after the Command's function succeeded | a bug | nothing; it is thrown, not returned | nothing |
| an `onStep` hook returned `undefined` after the Command's function returned a value | a bug | nothing; it is thrown, not returned | nothing |

In short, **you can recover from an error your I/O produced, but you cannot catch a `Failure` a step returned.** Only the code that called `runEffect` acts on it. For the same reason, do not throw business errors from a Command's function: a throw there tells `Retry` that the I/O broke, and `Retry` will try again. A throw anywhere else in the flow is treated as a bug: `runEffect` rejects with the thrown error instead of returning a `Failure`.

## TypeScript: Typed Errors and Context

The bundled declarations need TypeScript 5.1 or later.

### Error union across pipeline steps

Each step in `effectPipe` carries its own error type. The compiler collects them into a union automatically:

```ts
type ValidationError = 'invalid_email' | 'weak_password';
type ApiError = 'network_timeout' | 'rate_limited';

const validate = (input: { email: string }): Effect<{ email: string }, ValidationError> => { ... };
const submit = (input: { email: string }): Effect<{ id: number }, ApiError> => { ... };

const result = await runEffect(effectPipe(validate, submit)({ email: 'user@example.com' }));
if (result.type === 'Failure') {
    result.error; // 'invalid_email' | 'weak_password' | 'network_timeout' | 'rate_limited'
}
```

The annotations are optional. Without them, the union holds whatever each step can pass to `Failure`, each error kept exactly as written, whether a string or an object, and a step that cannot fail, such as a Command without a `next`, adds nothing. The union covers the `Failure`s your steps return. A Command whose function throws, or that an `onBeforeCommand` hook vetoes, also ends the run with a `Failure` the union does not name, so where the result is handled, give it one fallback, such as a `default` in a `switch` over `result.error`, and treat what reaches it as a server error. One fallback covers the whole flow: catch inside a Command's function only what the flow can handle, and let the rest throw, which is also what lets `Retry` act on it. To check for a thrown error, copy it into a variable typed `unknown` first, as in `const error: unknown = result.error`, since TypeScript refuses `instanceof Error` on an error type made only of strings, or on a flow that declares none.

To type what a Command's function returns, such as a JSON response, write the function's result type, as in `Command((): Promise<User | null> => fetchJson(url), next)`. `Command<User | null>(…)` also compiles, but with some type arguments given TypeScript infers none of the others, so that Command's errors are typed `unknown`, which hides the rest of the union.

Value types are checked through the pipeline too, so a step that reads a field the previous step does not return is a compile error. This only works while every step uses the value it receives. A step written as `() => doSomething(outer)` ignores it, and the types stop being checked at that point.

`effectPipe` is typed for up to 20 steps. A pipeline is itself a step, so a longer one nests, which is usually easier to read anyway: `effectPipe(effectPipe(s1, s2), effectPipe(s3, s4))`.

### Typed context with `Ask`

`Effect<T, E, Ctx>` carries a third type parameter for the context object:

```ts
type AppContext = { tenant: string; requestId: string };

const findProduct = (productId: string): Effect<Product, 'not_found', AppContext> =>
    Ask<Product, 'not_found', AppContext>((ctx) => { ... });

const result = await runEffect(findProduct('abc'), { tenant: 'acme', requestId: '123' });
```

Every step's context counts, so a pipeline needs all the contexts its steps read, even when the first step reads none, and a `Parallel` needs every context its branches read. `runEffect` requires a context whenever the flow reads one, since the flow would otherwise get an empty object.

## Why Pure Effect

**vs. Temporal and durable execution (Restate, Inngest):** The closest relatives, built on the same idea: record what every step returned and replay it. Those engines store the history on a server and resume workflows automatically after a crash. Pure Effect leaves storage and restarts to your application, and there is no infrastructure to run.

**vs. Effect-TS (and fp-ts):** A full ecosystem with fibers, streaming, schema validation, structured concurrency, and more, with a steep learning curve and its own vocabulary. Pure Effect takes only the idea of describing side effects as data, and does less: testable pipelines, context injection, retry, parallel execution, and replayable traces. If you need fibers or streaming, use Effect-TS.

**vs. plain async/await with mocks:** A mock can pass every test while behaving differently from the real driver. Here, business logic never does I/O, so there is nothing to mock.

**When to use something else:** If your code does little async I/O, or testing and debugging production are not problems for you, plain async/await is simpler.

## Load Tests

Timings are from Node 22 on a MacBook Pro with M4 Pro CPU:

**A web service under load.** A `node:http` service ran signup and checkout flows, where each checkout was a `Parallel` of a retried stock reservation and a card charge, with the OpenTelemetry and recording examples installed.

- 800 requests at once, across 4 tenants: every response and every recorded trace belonged to its own request, and no tenant, user, or request ID crossed between runs.
- The ~3,500 telemetry spans formed 800 request traces, with every span inside its own request's trace.
- Side effects matched the outcomes: 320 charges and 320 orders, and 80 declined cards stopped 30 stock reservations that were still running.
- 30,000 runs in a row kept memory between 10 and 11 MB, and left nothing running afterwards.
- A background worker that ran 20,000 jobs in one flow, looping through a Command's `next`, finished in under ~400 ms without holding on to memory.
- Stopping the server with flows still running, or clients hanging up mid-request: every flow that had started finished and was recorded, with no unhandled rejections.

**Batches and parallel work.**

- A settled `Parallel` over 200 records with `limit: 7` never had more than 7 records in flight, and returned the outcomes in order.
- 5,000 branches in one `Parallel` ran in ~25 ms.
- Running a Command through `runEffect` costs about 0.2 microseconds, against 0.06 for a plain `await`.

## API Reference

Every `options` argument below throws for a name it does not read, so a misspelt option fails instead of running with its default.

### Building blocks

#### `Success(value)`

Returns `{ type: 'Success', value }`.

#### `Failure(error, initialInput?)`

Returns `{ type: 'Failure', error, initialInput }`. Stops the pipeline immediately.

#### `Command(cmdFn, nextFn?, meta?)`

Returns `{ type: 'Command', cmd, next, meta }`.

- `cmd`: the function, sync or async, that does the I/O. Inside a `Parallel` branch it gets an `AbortSignal` that fires when a sibling fails, and elsewhere no argument, so wrap a function that takes an optional first argument (see [Limitations](#limitations)).
- `next`: receives `cmd`'s result and returns the next Effect; by default `(result) => Success(result)`.
- `meta`: metadata passed to `onBeforeCommand`. A string `meta.name` names the Command.

**Every Command needs a name**, which tests, traces, replay matching and telemetry all use. It is `meta.name`, else the function's name, else `'anonymous'`:

```js
Command(cmdFn, next, { name: 'chargeCard' }); // 1. meta.name, independent of how cmdFn was written
Command(function cmdChargeCard() {
    return api.charge();
}, next); // 2. the function's own name
Command(() => api.charge(), next); // 3. neither, so 'anonymous'
```

Use `meta.name` in code that gets minified, since a minifier renames functions and with them every step in every trace. Otherwise naming the function is enough, as the examples do: an arrow assigned to a `const` first, as in `const cmdChargeCard = () => api.charge()`, takes the `const`'s name. An inline arrow does not, and a replay cannot tell two `'anonymous'` Commands apart, so a refactor that swaps them replays without complaint, each handed the other's recorded result.

#### `commandName(command)`

Returns a Command's name, chosen in the order above, so a test checks a step by the name its trace would record: `assert.equal(commandName(step), 'cmdFindUser')`. Anything but a Command throws an `EffectTypeError`.

#### `Ask(nextFn)`

Returns `{ type: 'Ask', next }`. Passes the `context` from `runEffect` into `nextFn`.

#### `Retry(effect, options?)`

Returns `{ type: 'Retry', effect, options, next }`.

- `options.attempts`: Max retries, not counting the first try (default: `3`). Must be a positive integer; anything else, including `0`, throws a `TypeError`. To handle an outcome without retrying, branch on it in the Command's `next`, or isolate a failing branch with `Parallel`'s `settled`.
- `options.delay`: Ms before the first retry (default: `100`). Must be a finite number of 0 or more, or it throws a `TypeError`.
- `options.backoff`: Multiplier applied to the delay on each attempt (default: `1`, flat). Must be a finite number of 0 or more, or it throws a `TypeError`.

An option set to `undefined` keeps its default.

- `options.onExhausted(error)`: Runs a fallback Effect when every attempt has failed, receiving `{ retryExhausted, lastError, attempts }`. The fallback's success feeds `next`; its failure propagates unwrapped. Per-use only. See [Retrying Transient Failures](#retrying-transient-failures).

#### `Parallel(effects, next?, options?)`

Returns `{ type: 'Parallel', effects, next, options }`, which runs the branches at the same time and hands `next` their values in order; by default `(values) => Success(values)`. The first branch to fail cancels the others and its `Failure` is the result, with `next` skipped. Which branch that is depends on timing, so it is recorded, and a replay returns the same one. Each branch's Commands get an `AbortSignal` to pass to their I/O; see [Running Effects in Parallel](#running-effects-in-parallel).

The second argument is `next` or the options, so `Parallel(effects, { limit: 5 })` works; after the options, a third argument throws.

- `limit`: the most branches running at once, a positive integer. Results and recorded paths stay in array order, so it changes only the pacing.
- `settled`: run every branch to the end and hand `next` one `Success` or `Failure` per branch, in array order: no branch cancels the others or fails the `Parallel`. A bug still rejects the run, since a step or `next` that throws, or returns something other than an Effect, is not a branch outcome.

### Building pipelines

#### `effectPipe(...functions)`

Composes steps into a pipeline: each step gets the previous step's `Success` value, and a `Failure` from any step stops it. A step may ignore the value it gets and close over the enclosing scope instead, which is fine in JavaScript:

```js
// The last step ignores what came before and uses the enclosing input instead.
const registerUserFlow = (input) => effectPipe(validateRegistration, () => saveUser(input))(input);
```

In TypeScript, type checking stops at that step, since a function that ignores its parameter constrains nothing before it; passing the value through every step, as the [Quick Start](#quick-start) does, keeps the whole pipeline checked. See [TypeScript: Typed Errors and Context](#typescript-typed-errors-and-context).

In either language, a Command a step builds and does not return never runs, and any `Failure` it would have produced is lost:

```js
(value) => {
    sendWelcomeEmail(value); // built and thrown away: the email is never sent
    return Success(value);
};
```

Return the Command, and have its `next` return the value the rest of the pipeline needs.

### Running a flow

#### `runEffect(effect, context?, callConfig?)`

Runs a flow and resolves with its `Success` or `Failure`.

- `context`: what `Ask` reads, also passed to `onBeforeCommand`. `context.flowName` names the run in traces and telemetry.
- `callConfig`: `onStep`, `onRun` and `onBeforeCommand` for this call only, added to the `configureEffect` wiring, or used alone with `inherit: false`; see [`configureEffect`](#configureeffectconfigs). `onRun` wraps the run once, retries included. A `retry` key throws a `TypeError`, since retry options belong to each `Retry`.

A flow that is not made of Effects is a bug, so `runEffect` rejects with an `EffectTypeError` that says where, rather than returning a `Failure`:

```
Step 'validateRegistration' returned a plain object. Return Success, Failure, Command, Ask,
Retry, or Parallel: a plain value has to be wrapped, as in Success(value).
```

That covers a missing `return`, a `next` that returns a plain value, a step or `next` written as `async` (do the awaited work in a Command instead), and `runEffect(flow)` where `runEffect(flow(input))` was meant. The building blocks check their arguments as the flow is built, before any of its I/O runs, so `Command(db.findUser(email))`, which makes the call while the flow is built, `Command(fn, { name })`, with the metadata in `next`'s place, and a `Parallel` or `effectPipe` given the wrong thing each throw an `EffectTypeError` there. A throw from a Command's function, or from an `onBeforeCommand` veto, is a `Failure`; a throw from a `next` or a pure step is a bug too, and `runEffect` rejects with it as thrown.

#### `configureEffect(...configs)`

Adds a layer of hooks for the whole process and returns a function that removes it. Several configurations passed to one call form one layer, the same as installing each on its own. Removing a layer removes only that layer, even when others were installed after it, so a library can add and remove its own hooks without touching the application's. `configureEffect()` with no arguments removes every layer, and a call whose arguments are all `undefined`, such as `configureEffect(flag ? hooks : undefined)`, changes nothing. A `retry` key throws a `TypeError`, since retry options belong to each `Retry`.

```js
const remove = configureEffect(telemetryHooks(), recordingHooks({ sink }));
// the same as configureEffect(telemetryHooks()) followed by configureEffect(recordingHooks({ sink }))
remove();
```

- `onRun(effect, pipeline, flowName)`: wraps the whole run. It must `await pipeline()` and return its result.
- `onStep(name, type, op, path)`: wraps each Command, and each `Parallel` with `name` and `type` both `'Parallel'`. It must `await op()` and return its result, and pass `path` on to any hook it calls, since a replay matches steps on it.
    - For a Command, `op()` returns a promise, even for a synchronous function. Returning a value without calling `op()` answers for the Command, which is how replay works, and throwing without calling it counts as the Command failing.
    - A throw after `op()` succeeded, or `undefined` returned in place of its value, as a hook that forgot its `return` or its `await` does, is a bug in the hook: the run rejects, and `Retry` does not run the Command again.
    - For a `Parallel`, `op()` runs the branches, so a hook must call it or the run rejects with a `TypeError`. It returns which branch, if any, cancelled the others, as in `{ cancelled: true, branch: 0 }`, even when a branch threw.
- `onBeforeCommand(command, context)`: runs before each Command. A throw vetoes the Command: the run returns a `Failure` carrying the thrown error, and `Retry` does not retry it.

Layers run in the order they were installed, the first outermost, so a result or a thrown error unwinds from the innermost hook out:

```
runEffect(flow(input))
│
├─ telemetry.onRun                       first configuration: outermost
│  └─ recording.onRun                    last configuration: innermost
│     │
│     │  for each Command:
│     ├─ telemetry.onBeforeCommand       interceptors all run, in the order given
│     ├─ recording.onBeforeCommand
│     ├─ telemetry.onStep
│     │  └─ recording.onStep             closest to the Command
│     │     └─ cmd()
│     │  ┌─ recording.onStep returns     a result, or a thrown error, unwinds
│     ├─ telemetry.onStep returns        from the inside out
│     │
│  ┌─ recording.onRun returns
├─ telemetry.onRun returns
```

**Per-call hooks.** The hooks in a `callConfig` are merged over the configured ones by the same rules, the configured wrappers outside and the configured `onBeforeCommand` hooks first. `inherit: false` leaves the configured hooks out. With configured hooks `C` and a call `K` that supplies only `onStep`:

```
                  inherit: true (default)        inherit: false

onRun             C.onRun                        (none)
onBeforeCommand   C.onBeforeCommand              (none)
onStep            C.onStep( K.onStep( cmd ) )    K.onStep
```

`recordEffect` inherits, so recording inside an application that already traces still produces spans. `replayEffect` passes `inherit: false` unless `hooks: true`.

### Recording and replay

#### `recorder(options?)`

Returns `{ onStep, entries, toTrace }`, a hook that records every step of a run, passed as `runEffect(flow, context, { onStep })`. Give each run its own recorder: one shared by a whole application mixes requests into one trace, which a replay refuses. `recordEffect` and the [recording example](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js) both do this for you.

- `onStep`: the hook. Recording never changes a run's outcome; a value `redact` fails on is recorded as `'[redaction failed]'`.
- `entries`: the steps recorded so far, one per Command and one per `Parallel`. `path` is the step's position in the flow, which a replay matches on; an older entry with `error` and no `threw` still counts as a throw.

```text
{ command, path, result, durationMs }                          a Command that returned
{ command, path, threw: true, error, durationMs }              a Command that threw
{ command: 'Parallel', path, result: { cancelled, branch } }   which branch, if any, cancelled the others
```

- `toTrace(meta)`: the entries as a trace, with `meta`'s `initialInput`, `context`, `flowName` and `version`, copied when it is called (a part that cannot be copied, such as a function, is kept as it is). If a Command can change the input or the context, as an ORM save that adds an id does, call it before the run for those and again afterwards for the entries, as `recordEffect` does.
- `options.redact(value, name, kind)`: returns what the trace stores in place of `value`. `kind` is `'result'`, `'error'`, `'initialInput'` or `'context'`, and `name` is the Command's name, or the kind. It gets a copy, so changing it in place is safe.
- `options.maxEntries`: the most entries a trace keeps; the rest are counted in `dropped`, and a replay stops at the first step the trace lacks.
- `options.stack`: record stack traces for thrown errors (off by default).

Results are copied as they are recorded, so a later step cannot change them; see [Recording in Production](#recording-in-production) for what a copy keeps. When writing `redact`, check a value before replacing a field in it, since `{ ...value, email: '[redacted]' }` turns a `null` into an object and the replay takes the other branch:

```js
// Masks a field only where there is one, so a lookup that found nothing still records null.
const mask = (value, field) =>
    value && typeof value === 'object' && field in value ? { ...value, [field]: '[redacted]' } : value;

const redact = (value, name, kind) => {
    if (kind === 'initialInput') return mask(value, 'cardNumber');
    if (kind === 'context') return mask(value, 'authToken');
    if (kind === 'error') return mask(value, 'attempted');
    return name === 'cmdFetchUser' ? mask(value, 'email') : value;
};
recorder({ redact });

assert.equal(redact(null, 'cmdFetchUser', 'result'), null); // still nothing found
assert.equal(redact('card_declined', 'cmdCharge', 'error'), 'card_declined'); // still a string
```

A replay rebuilds the flow from the redacted input and context, so a field a step checks, such as a password, needs a stand-in the check treats the same way, as the recording example in [Recording in Production](#recording-in-production) does, and a context field an `Ask` reads should stay.

#### `recordEffect(flowFn, initialInput, options?)`

Runs a flow for real while recording, returning `{ result, trace }`. Accepts `recorder` options plus `context` and `version`. For tests and scripts. To record an application without changing call sites, use the wiring in [`examples/recording-example.js`](https://github.com/aycangulez/pure-effect/blob/main/examples/recording-example.js), which gives each run its own recorder.

#### `replayEffect(effect, traceOrResolver, options?)`

Runs a flow with each Command answered from a trace instead of run, and returns `{ result, unreached }`: the flow's outcome, and the recorded steps it never asked for, which is where a flow that stops early shows up. A flow that no longer matches the trace ends in a `Failure` whose `error` is a `TimeParadox`, or a `ReplayError` for a step the trace lacks. Neither is thrown, so a test checks `error.name`, which tells them apart, and not only `result.type`. A malformed trace rejects with a `ReplayError`.

- `traceOrResolver`: a trace, its bare entries, or a resolver, a function that answers each step with `{ result }`, `{ error }`, or `undefined` for a step it has no record of, so a trace stored in any shape can be replayed. With a resolver, `unreached` is absent, since a resolver cannot list what it holds. A resolver is also asked about each `Parallel`, with `step.type` set to `'Parallel'`: answering with the recorded cancellation as `{ result }` replays it as production decided, and anything else replays it by timing.
- `options.context`: the context for `Ask`, by default the one the trace recorded. A resolver has none, so pass one if the flow reads `Ask`.
- `options.onMissing`: `'throw'` (default) stops at a step the trace lacks. `'execute'` runs its Command for real, so use it only where Commands reach test doubles or only read. A trace can lack a step because a hook vetoed it in production, because it was added to the flow since the recording, or because the recorder dropped it under `maxEntries`; a trace that dropped entries refuses `'execute'`, so record the flow again with a higher `maxEntries`. After a flow changes shape, as when a Command is newly wrapped in `Retry`, every step sits at a new position and `'execute'` would run them all live: record the flow again instead.
- `options.fastRetry` (default `true`): strip `Retry` delays.
- `options.hooks` (default `false`): run the replay inside the configured hooks, a configured recorder included, so they see the replayed steps. Off, a replay cannot reach a telemetry backend or a trace sink.
- `options.onResolved(step, outcome)`: observes each replayed step. A throw stops the replay, and `replayEffect` rejects with it; it never changes an outcome.

A trace whose entries have no `path`, written by hand or recorded before paths existed, is matched by position. That works for a sequential flow, and a `Parallel` step in such a trace is refused with a `ReplayError`, since the order branches finish in cannot tell them apart.

#### `timeTravel(flowFn, traceLog, options?)`

Replays a trace and narrates each step with its recorded duration, naming any recorded steps that were never reached, and warning when the trace's `version` differs from `options.version` or when steps are named `'anonymous'`. Returns the flow's outcome; for the unreached entries as data, use `replayEffect`. Takes `options.context` to override the trace's, and `options.log` in place of `console.log`.

## Limitations

- **`Retry` repeats everything it wraps, including a Command's `next`.** When a Command's function throws, every Command inside the `Retry` runs again, including the ones that already succeeded. If a retried Command's `next` continues the flow, everything after it is retried too. Give a retried Command the default `next` and continue in a later pipeline step, or make sure every Command it reaches is safe to run more than once. A `Failure` a step returned is not retried at all, so a function that catches its own error and returns it as a value is never retried: see [Which Errors Are Data](#which-errors-are-data).
- **Cancelling a `Parallel` branch cannot stop everything.** A cancelled branch starts no new Commands, and a function that uses the `AbortSignal` it is given can be stopped while running. A function that ignores the signal runs to completion, so a branch whose _first_ Command is a write can still write after another branch has failed. `Parallel` waits for every branch to finish before returning, so no cancelled work is still running after the `Failure` is returned.
- **Inside a `Parallel`, a Command's function gets the `AbortSignal` as its first argument.** A function passed by name that has an optional first argument takes the signal for it, so the same Command behaves differently inside a `Parallel` than outside one: `Command(nanoid)` returns an empty ID, since `nanoid(size = 21)` reads the signal as the size, and a repository helper with a default page size gets the signal as its page size. Wrap such a function, as in `Command(() => nanoid())`. In TypeScript, a function whose first parameter cannot be an `AbortSignal` does not compile as a Command.
- **A `Failure` carries everything.** It holds the full error and the `initialInput` that `effectPipe` attached, and neither is trimmed, because tests and debugging need both. `redact` keeps sensitive data out of a **trace**. Keeping it out of your **logs** is up to you: log `result.error` rather than the whole `Failure`. The same goes for the outcomes a settled `Parallel` passes to `next`, which can carry their branch's input; for a login or registration flow, that input holds credentials.
- **Replay checks the path, not the values.** Replaying an old trace cannot check a fix that changes what a flow computes, because every Command's result comes from the recording: the replay hands the step the value from before the fix, reports `Success`, and flags nothing. It can check a fix that changes which Commands run. A removed step shows up in `unreached` only if it was the last step the flow reached; removed from the middle, it shifts the later paths and the replay stops at a `TimeParadox`.
- **A trace keeps data, not objects.** Recorded results come back without their classes: a money object or a database entity as a plain object, a `Buffer` as a plain byte array, and an error inside a result without properties such as `code`. Through JSON, a `Date` also comes back as a string and a `Map` as `{}`. A flow whose `next` calls a method on a result, or branches on one of those properties, replays differently from production. Return plain data from Commands; see [Recording in Production](#recording-in-production).
- **Replay reproduces what one flow saw, not timing.** A stale read replays exactly. A race between two concurrent requests does not, because a trace records one flow. `Parallel` branches replay with the results each branch saw, and a cancelled `Parallel` with the branch that cancelled it, but not the order they ran in, so replay cannot settle a race between branches that share state.
- **Configuration belongs to one copy of the library.** `configureEffect` stores hooks in module state, so two copies of the library in one process (from a dual ESM and CJS setup, two versions in the dependency tree, or a worker thread) each have their own. Hooks configured in one do not apply to the other, and nothing warns you.
- **A Command needs a name.** `meta.name` survives minification. `cmd.name` does not, unless the minifier is set to keep function names.
