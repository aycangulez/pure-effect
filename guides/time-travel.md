# Time-Travel Debugging

This guide continues the [README](../README.md), and its examples use the Quick Start's `registerUserFlow` and `input`. The exact rules are in [REFERENCE.md](../REFERENCE.md#recording-and-replay).

Record what each Command returned, then feed those results back into the flow to retrace the path a request took, with no database or network.

Record a run with `recordEffect`, and `replayEffect` hands each Command what it returned the first time. A production run replays the same way, from the trace the [flight recorder](recording.md#recording-in-production) keeps, with nothing connected:

```js
import { recordEffect, replayEffect } from 'pure-effect';

// A real run returns its result, and a trace of what each Command returned.
const { result: live, trace } = await recordEffect(registerUserFlow(input));

// Anywhere else, with nothing connected, the same flow gets the same answers.
const { result: replayed } = await replayEffect(registerUserFlow(trace.initialInput), trace);
assert.deepEqual(replayed, live); // holds while results are plain data and errors plain Errors; see Keeping a replay faithful
```

Record each run with a version and a flow name, and replay its trace anywhere with `timeTravel`, which narrates each step. Here `recordEffect` records one run; to record every run of an application, use the flight recorder, in [Recording in Production](recording.md#recording-in-production):

```js
import { recordEffect, replayEffect, timeTravel } from 'pure-effect';

// Record a real run. flowName names the flow in the trace.
const { result, trace } = await recordEffect(checkoutFlow(input), {
    version: process.env.BUILD_ID,
    flowName: 'checkout'
});

// Later, somewhere else, with nothing connected. Given the build, timeTravel warns when the trace came from another one.
await timeTravel(checkoutFlow, trace, { version: process.env.BUILD_ID });
```

```
Replaying 'checkout': 3 recorded steps
Initial input: {
  "cartId": "cart_abc123",
  "promoCode": "FREE_YEAR_VIP"
}
├─ cmdFetchCart returned in 41.3ms {"totalAmount":"120.00"}
├─ cmdValidatePromo returned in 26.8ms {"isValid":true,"discountValue":100}
└─ cmdChargeCard threw in 181.5ms {"code":"invalid_amount","name":"Error","message":"Amount must be non-zero."}
Replay finished with state: Failure
Error: {
  "code": "invalid_amount",
  "name": "Error",
  "message": "Amount must be non-zero."
}
```

`timeTravel` takes the function that builds the flow, not the flow itself, and calls it with the recorded input. If that function also needs services, pass one that takes only the input, as in `timeTravel((input) => makeCheckout(services)(input), trace)`.

A production incident becomes a regression test, with no mocks:

```js
it('prod incident 8f3a: a 100% promo produces a $0 charge', async () => {
    const { result } = await replayEffect(checkoutFlow(trace.initialInput), trace);
    assert.equal(result.type, 'Failure');
    assert.equal(result.error.code, 'invalid_amount');
});
```

The test checks that the flow still takes the recorded path and handles the recorded outcomes the same way. It does not check the values the flow computes, since every result comes from the recording; see [What a replay cannot check](#what-a-replay-cannot-check). If a refactor reorders or replaces a step, the replay ends in a `Failure` whose error is a `TimeParadox` naming where it diverged. It is not thrown, so a test that expects a `Failure` should check the error too, as this one checks its `code`.

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

For every other recording, `unreached` should be empty, so a fix that skips a step by accident fails the test. A fix that removes or moves a step in the middle of the flow shifts every later step's path, so the old trace no longer replays as it is; [Proving a fix that changes the flow's shape](#proving-a-fix-that-changes-the-flows-shape) shows how to test it.

A test can also run a whole flow with no recording at all, answering each Command itself; see [Testing a whole flow](../README.md#testing-a-whole-flow).

Exact rules: [`replayEffect`](../REFERENCE.md#replayeffecteffect-traceorresolver-options).

## Checking that a replay ends the same way

A replay proves the flow asks for the same Commands. To check what it decided as well, a trace records how the run ended: a Success's value or a Failure's error, passed through `redact` like every other value. `recordEffect` and the flight recorder both do, unless given `recordOutcome: false`.

A replay of that trace returns `changed`: `null` when it ended as the run did, or where the two first differ. `assertReproduced`, from `pure-effect/testing`, checks it with the rest of what a replay can get wrong:

```js
import { recordEffect, replayEffect } from 'pure-effect';
import { assertReproduced } from 'pure-effect/testing';

const { trace } = await recordEffect(registerUserFlow(input));

const replay = await replayEffect(registerUserFlow(trace.initialInput), trace);
assert.equal(replay.changed, null); // it ended as the run did
assertReproduced(replay); // the same, and it stopped at no TimeParadox and asked for every recorded step
```

A refactor that chooses a different delivery slot asks for the same Commands, so `unreached` stays empty, but `changed` names the first decision that moved, with the value on each side:

```text
{ path: '$.value.placements[0].slot', recorded: 13, replayed: 17 }
```

`timeTravel` says the same in its last line. What to know about it:

- **It checks only what the flow returns.** A flow that returns a count of placed orders cannot tell which slots it chose, so return the decisions a replay should check. A value the flow reads from a Command's result comes back as recorded, whatever the code now does with it.
- **Changing what a flow returns changes every stored outcome.** Add a field to a flow's result and each of its old traces reports `changed`, so record its fixtures again.
- **`redact` sees the outcome as a result or an error named `'outcome'`.** A `redact` that masks by kind covers it as it is. One that masks results by Command name does not, so add `name === 'outcome'` to it, as [Keeping secrets out of a trace](recording.md#keeping-secrets-out-of-a-trace) does.
- **A replay computes from recorded results,** which are already redacted, so its outcome comes out masked the same way. Where `redact` masks a value the flow built itself, pass the same `redact` to `replayEffect` or `timeTravel`.
- **A value a pure step makes up,** such as the current time or a random id, differs on every replay. Read it in a Command, or from the context, so the trace records it.

Exact rules: [`replayEffect`](../REFERENCE.md#replayeffecteffect-traceorresolver-options) and [`assertReproduced`](../REFERENCE.md#pure-effecttesting).

## Reading a trace

A trace is plain JSON. This one is from a checkout whose card charge timed out once and then went through:

```text
{
  "flowName": "checkout",
  "version": "b42",
  "initialInput": { "cartId": "cart_1" },
  "context": {},
  "dropped": 0,
  "trace": [
    { "command": "cmdFetchCart", "path": "0", "result": { "total": 120 }, "durationMs": 41.3 },
    { "command": "cmdChargeCard", "path": "1r0/0", "threw": true,
      "error": { "__error": true, "name": "Error", "message": "gateway timeout", "code": "ETIMEDOUT" }, "durationMs": 5002.1 },
    { "command": "cmdChargeCard", "path": "1r1/0", "result": { "chargeId": "ch_1" }, "durationMs": 181.5 }
  ]
}
```

`trace` holds one entry per step, in the order the steps finished; [`recorder`](../REFERENCE.md#recorderoptions) lists each kind of entry. A replay matches each step by its `path`, its position in the flow, and a `TimeParadox` names the path where the flow and the trace part ways:

- A number counts the Commands, `Retry`s and `Parallel`s the flow reached, from `0`. A `Success` or an `Ask` between them adds nothing.
- `r` and a number is one attempt of the `Retry` at that position, `r0` being the first try, and `rf` is its `onExhausted` fallback.
- `p` and a number is one branch of the `Parallel` at that position, from `p0`. The `Parallel` has an entry of its own, at a path such as `2p`, which records whether a branch cancelled the others.
- `/` goes one level in. `1r1/0` is the first step of the second try of the `Retry` at position 1. `2p1/0` is the first step of the second branch of the `Parallel` at position 2.

## What a replay cannot check

A replay proves that the flow asks for the same Commands in the same order and handles the same answers. Every result comes from the recording, so it cannot check:

- **What the flow computes, unless the flow returns it.** Fix how a refund amount is calculated and replay the bad run: the charge step still gets the old amount from the recording. The replay reports `Success` and returns the value from before the fix. Only `changed` flags it, when the flow returns that amount; see [Checking that a replay ends the same way](#checking-that-a-replay-ends-the-same-way). Test a value change against the pure step that computes it.
- **A fix inside a Command's function.** The function never runs, so an old trace hands the flow what it returned or threw before the fix. Catch a duplicate-key error inside the function and return it as data, and the old trace still replays the throw. Cover such a fix with an integration test.
- **The arguments a Command was called with.** A trace records results only. Given the recorded input and results, the flow does the same thing again, so replaying up to a step rebuilds its arguments for a debugger, but a test cannot assert on them. Storing them would also double what `redact` has to cover, since arguments are usually the sensitive part of a call.
- **A step a hook vetoed.** A veto leaves no entry in the trace, so the replay stops at that step with a `ReplayError`.
- **A field `redact` replaced, if a step checks it.** The replay rebuilds the flow from the redacted input, so the check can decide differently. See [Keeping secrets out of a trace](recording.md#keeping-secrets-out-of-a-trace).

When a Command's result changes shape, rename the Command. A trace matches it by name. So under the old name, an old trace hands the new code a result in the old shape, which it can take for another answer without any `TimeParadox`.

## Proving a fix that changes the flow's shape

A fix that removes or moves a step in the middle of a flow changes the path of every step after it, so its old trace stops at a `TimeParadox`. Here the incident is a checkout that tried to charge a free cart, and the fix skips the charge, so the save moves to where the charge was:

```js
const fetchCart = (cartId) => {
    const cmdFetchCart = () => carts.find(cartId);
    return Command(cmdFetchCart);
};

const chargeCart = (cart) => {
    const cmdChargeCard = () => gateway.charge(cart.total);
    return Command(cmdChargeCard, () => Success(cart));
};

const saveOrder = (cart) => {
    const cmdSaveOrder = () => orderStore.save(cart);
    return Command(cmdSaveOrder);
};

// Production ran this, and recorded the charge failing.
const checkoutBefore = (cartId) => effectPipe(fetchCart, chargeCart, saveOrder)(cartId);
const { trace: incident } = await recordEffect(checkoutBefore('cart_free'));

// The fix: no charge when there is nothing to charge.
const chargeIfDue = (cart) => (cart.total === 0 ? Success(cart) : chargeCart(cart));
const checkoutFixed = (cartId) => effectPipe(fetchCart, chargeIfDue, saveOrder)(cartId);

// Against the old trace, the fixed flow stops where the save took the charge's place.
const { result: paradox } = await replayEffect(checkoutFixed(incident.initialInput), incident);
assert.equal(paradox.error.name, 'TimeParadox');
```

Prove such a fix in three parts. Test the decision that changed, as a pure step. Then walk the fixed flow from the incident's input, handing each step the answer production got for it, for as long as the fix leaves the steps as they were:

```js
import { commandName } from 'pure-effect';

// The decision that changed: a free cart is not charged.
assert.deepEqual(chargeIfDue({ id: 'cart_free', total: 0 }), Success({ id: 'cart_free', total: 0 }));

// Given the cart production fetched, the fixed flow saves the order without charging it.
const fetchedCart = incident.trace.find((entry) => entry.command === 'cmdFetchCart').result;
const first = checkoutFixed(incident.initialInput);
assert.equal(commandName(first), 'cmdFetchCart');
assert.equal(commandName(first.next(fetchedCart)), 'cmdSaveOrder');
```

The walk takes production's answers only up to the change. Past it, each recorded answer belongs to a step that has moved, so the trace has nothing more to say about the fixed flow. Last, once the fix ships, record the incident again, so its regression test is a plain replay once more.

## Keeping a replay faithful

Put anything that varies between runs inside a Command. For replay, the current time or a random ID counts as I/O. In a Command it is recorded and replayed like any other result. A step that calls `Date.now()` directly gets a new value on every replay, and drifts from the trace.

**A trace keeps data, not objects.** A value is copied into the form JSON stores when it is recorded, and copied again each time a replay hands it to the flow. Return plain data from a Command's function. Turn a class instance into a plain object before returning it, with a small named function you can test on its own, as in `() => db.findCart(id).then(cartToData)`. Rebuild the object in `next` if the flow needs its methods. When you catch an error to return it as data, copy the fields the flow branches on, as in `.catch((error) => ({ ok: false, code: error.code }))`, rather than returning the error itself.

To check a flow, record it, replay the trace, and compare the outcomes. A step that computes a fresh value shows up as a different final value, or as a `TimeParadox` if it changes which Commands run. A trace holds each result in the form JSON stores it, so this also catches a result your storage cannot keep, such as a `Date` the flow calls a method on:

```js
const { result, trace } = await recordEffect(registerUserFlow(input));
const { result: replayed } = await replayEffect(registerUserFlow(input), trace);
assert.deepEqual(replayed, result); // fails if a step computed a fresh value, or a result did not survive storage
```

Exact rules: [how errors come back](../REFERENCE.md#how-errors-come-back).

## Replaying from your own storage

`replayEffect` also accepts a resolver function instead of a trace, so you can replay from OpenTelemetry spans, a log pipeline, or a database table, not only from the JSON that `recorder` produces. Whatever you store needs each step's `path`, which `onStep` receives, and its result. The telemetry example puts the path on each span as `effect.path`, but not the result, since it keeps values off spans. So spans you replay from need the result added, stored here as `output`. Pass it through your `redact` first, since a tracing backend keeps what it receives:

```js
// A resolver answers one question: what did production get back for this step? Look the step up by its path, its
// position in the flow. `step.index` counts steps in the order they finished, which shifts around a Parallel.
const outputs = new Map(mySpans.map((span) => [span.attributes['effect.path'], span.attributes.output]));
const resolve = (step) => (outputs.has(step.path) ? { result: outputs.get(step.path) } : undefined);
await replayEffect(checkoutFlow(input), resolve);
```
