# Handling Failure

This guide continues the [README](../README.md). It covers which errors a flow returns and which it lets a Command throw, how a `try`/`catch` translates, and how to undo what succeeded when a later step fails. The exact rules are in [REFERENCE.md](../REFERENCE.md#building-flows).

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

The failed attempt is recorded as that Command's result, with the error's `code` and `message`, so a replay takes the same fallback branch. Copy the fields you need rather than returning the error itself: a trace keeps data, not objects, so an error stored inside a result loses its message (see [What a trace keeps](../REFERENCE.md#what-a-trace-keeps)).

A thrown error loses its class in a replay. It comes back as a plain `Error` that keeps its `name`. So wherever you check a thrown error, such as in `retryIf`, in `onExhausted` or in the run's result, check its `name` or `code`, not `instanceof`.

**A `Failure` stops the flow.** It goes back to the code that called `runEffect`, which decides what it means: an HTTP status, a queue retry, an alert. Nothing inside the flow can catch a `Failure`, so a reader never has to look elsewhere for a handler.

Rule of thumb: if you would handle it, return it as a value; if you would only report it, return a `Failure`. The one exception is retry exhaustion, which happens inside `Retry`; handle it with the `onExhausted` option in [Retrying Transient Failures](../README.md#retrying-transient-failures).

**Catch or retry, not both.** `Retry` only reacts to a function that throws. If you catch a 503 inside the function and return it as a value, then wrap the step in `Retry`, it makes one call and never retries. Catch the error when the flow should handle it as data, as `fetchPrice` above does; let it throw when `Retry` should try again:

```js
// Retried: the function lets the rejection out, so the interpreter sees an I/O fault.
Retry(
    Command(function cmdFetchPrice() {
        return pricing.get(sku);
    }),
    { retries: 3 }
);
```

To retry some errors and not others, let the function throw them all, and tell `Retry` which to try again. `retryIf` gets what the last attempt threw and returns whether another try could help. When it returns `false` the `Retry` gives up at once, and `onExhausted` gets the error as `lastError`, as it does when the attempts run out. Here a charge the gateway refuses is handled, and anything else, such as a timeout, is retried:

```js
const chargeAmount = (amount) => {
    const cmdChargeAmount = () => gateway.charge(amount);
    return Retry(Command(cmdChargeAmount), {
        retries: 2,
        // A refused charge will be refused again. Anything else may pass on a later try.
        retryIf: (error) => error.code !== 'invalid_amount',
        // The flow goes on with the refusal as data, and still fails with anything else.
        onExhausted: (gaveUp) =>
            gaveUp.lastError.code === 'invalid_amount'
                ? Success({ refused: true, code: gaveUp.lastError.code })
                : Failure(gaveUp)
    });
};

// A later step turns the handled error into the flow's outcome.
const requireCharge = (charge) => (charge.refused ? Failure(`Charge refused: ${charge.code}`) : Success(charge));
const pay = (amount) => effectPipe(chargeAmount, requireCharge)(amount);

assert.deepEqual(await runEffect(pay(0)), Failure('Charge refused: invalid_amount'));
assert.deepEqual(await runEffect(pay(25)), Success({ chargeId: 'ch_1', amount: 25 }));
```

The Command's function stays one call, and `retryIf` and `onExhausted` are plain functions, so a test can call each with an error and check what it returns. A hook sees the refused charge as a call that threw, not as one that worked.

`runEffect` tells these cases apart:

| what happened | what it is | what `Retry` does | what `onExhausted` sees | what the caller's `Failure` holds |
| --- | --- | --- | --- | --- |
| a step returned `Failure(...)`, or an `onBeforeCommand` hook threw | a stop | nothing; it propagates at once, unwrapped | nothing | the error returned or thrown |
| a Command's function threw | an I/O fault | retries it, unless `retryIf` returns `false` | the exhaustion, once the attempts are gone or `retryIf` gives up | the error thrown, or, once a `Retry` gives up, `{ retryExhausted, lastError, retries }` |
| a `next` function or a pure step threw, or the flow is malformed | a bug | nothing; it is thrown, not returned | nothing | nothing; `runEffect` rejects |

A throw anywhere else in the flow is a bug: `runEffect` rejects with it, or, from a step before the first Command, the call that builds the flow throws it. Nor does a Command's function return `Failure(...)`: whatever it returns is its result, so a returned `Failure` reaches `next` as a value and the flow keeps going. Return the data and let a step decide, as `requireCharge` does above.

Exact rules: [a malformed flow](../REFERENCE.md#a-malformed-flow).

## Translating `try`/`catch`

A `catch` around `yield*` can log and rethrow, but it cannot recover, and it sees a `FlowStopped` error rather than the original. So each `try`/`catch` in an `async` function moves to where its error happens. The four common shapes:

- **Carry on past a failed call.** Catch inside the Command's function and return the error as data, as below.
- **Undo the calls that succeeded when one running beside them fails.** Run the calls in a `Parallel` with `settled: true`, and have its `next` undo the ones that succeeded; see [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails).
- **Undo an earlier call when a later one fails.** Catch inside the later Command's function and return the error as data, and have its `next` return the Command that undoes the earlier one, as in the second example below. A later Command that throws instead stops the flow before its `next` runs, so nothing is undone. A `Retry` that gives up never reaches the Command's `next` either. So when the later Command is under `Retry`, give it no `next`, have `onExhausted` return the failure as data, and decide in the step after the `Retry`. Every failure then reaches one place that undoes, as in the third example below.
- **Retry, then give up.** Wrap the Command in `Retry`, and put what the `catch` did after the last try in `onExhausted`; see [Retrying Transient Failures](../README.md#retrying-transient-failures).

A welcome email whose failure the flow reports but does not stop for:

```js
// Takes the mailer, so a test can hand it one that fails.
const makeSendWelcome = (mailer) => (user) => {
    const cmdSendWelcome = () =>
        mailer
            .sendWelcome(user.email)
            .then(() => ({ sent: true }))
            .catch((error) => ({ sent: false, reason: error.message }));
    return Command(cmdSendWelcome);
};

const failingMailer = {
    sendWelcome: async () => {
        throw new Error('smtp down');
    }
};
const welcome = await runEffect(makeSendWelcome(failingMailer)({ email: 'test@test.com' }));
assert.deepEqual(welcome, Success({ sent: false, reason: 'smtp down' }));
```

A reservation made after a charge, which refunds the charge when the reservation fails:

```js
const refundCharge = (charge, reason) => {
    const cmdRefundCharge = () => payments.refund(charge.chargeId);
    return Command(cmdRefundCharge, (r) => {
        const error = `Reservation failed: ${reason}`;
        return Failure(r.refunded ? error : { error, undoFailed: ['refund_failed'] });
    });
};

const reserveStock = (charge) => {
    const cmdReserveStock = () =>
        warehouse
            .reserve(charge.orderId)
            .then(() => ({ reserved: true }))
            .catch((error) => ({ reserved: false, reason: error.message }));
    return Command(cmdReserveStock, (reservation) =>
        reservation.reserved ? Success(charge) : refundCharge(charge, reservation.reason)
    );
};

const reservation = await runEffect(reserveStock({ orderId: 'order_1', chargeId: 'ch_1' }));
assert.deepEqual(reservation, Failure('Reservation failed: out of stock'));
```

A courier booked after the charge, under `Retry`. Giving up answers like a refusal, so one step decides both, and refunds the charge with the `refundCharge` above:

```js
const bookCourier = (charge) => {
    const cmdBookCourier = () => courier.book(charge.orderId); // { ok: false } for a refusal; throws on a timeout
    return Retry(Command(cmdBookCourier), { onExhausted: () => Success({ ok: false, reason: 'courier unavailable' }) });
};

const confirmBooking = (charge, booking) => (booking.ok ? Success(booking) : refundCharge(charge, booking.reason));

assert.equal(commandName(confirmBooking({ chargeId: 'ch_1' }, { ok: false, reason: 'no slots' })), 'cmdRefundCharge');
```

In a generator flow, the body only puts them in order: `const booking = yield* step(bookCourier(charge))`, then `yield* step(confirmBooking(charge, booking))`. When several earlier calls need undoing, hand the deciding step their undo steps, latest first, and have it return `undoAll` with them, as in [Undoing what succeeded when a branch fails](#undoing-what-succeeded-when-a-branch-fails).

## Undoing what succeeded when a branch fails

Without `settled`, the failing branch's `Failure` is the whole result, and the values of the branches that succeeded are dropped. Sometimes one of them did something that has to be undone, such as charging a card for an order whose stock then ran out. The code that called `runEffect` no longer has the charge to refund. Use `settled: true`, so `next` sees every outcome, and have it return the steps that undo whatever succeeded, followed by the failure:

```js
const reserveStock = (order) => {
    const cmdReserveStock = () => inventory.reserve(order.items);
    return Command(cmdReserveStock, (r) => (r.ok ? Success(r.reservationId) : Failure('out_of_stock')));
};

const chargeOrder = (order) => {
    const cmdChargeOrder = () => payments.charge(order.customerId, order.total);
    return Command(cmdChargeOrder, (c) => (c.ok ? Success(c.chargeId) : Failure('card_declined')));
};

// Each undo step checks its answer, so an undo that did not happen is a Failure, not lost.
const releaseStock = (reservationId) => {
    const cmdReleaseStock = () => inventory.release(reservationId);
    return Command(cmdReleaseStock, (r) => (r.released ? Success(reservationId) : Failure('release_failed')));
};

const refundCharge = (chargeId) => {
    const cmdRefundCharge = () => payments.refund(chargeId);
    return Command(cmdRefundCharge, (r) => (r.refunded ? Success(chargeId) : Failure('refund_failed')));
};

// Runs every undo, then fails with the original error and any undo that failed.
const undoAll = (undos, error) =>
    Parallel(
        undos,
        (outcomes) => {
            const undoFailed = outcomes.filter((o) => o.type === 'Failure').map((o) => o.error);
            return Failure(undoFailed.length > 0 ? { error, undoFailed } : error);
        },
        { settled: true }
    );

// Passes both results on, or undoes whichever step succeeded and then fails.
const reserveAndCharge = (order) =>
    Parallel(
        [reserveStock(order), chargeOrder(order)],
        ([reservation, charge]) => {
            if (reservation.type === 'Failure') {
                return charge.type === 'Success'
                    ? undoAll([refundCharge(charge.value)], reservation.error)
                    : reservation;
            }
            if (charge.type === 'Failure') return undoAll([releaseStock(reservation.value)], charge.error);
            return Success({ order, reservationId: reservation.value, chargeId: charge.value });
        },
        { settled: true }
    );
```

`undoAll` takes any number of undo steps and runs them as a settled `Parallel`, so an undo that fails cancels none of the others. Without `settled`, it would cancel the rest and replace the original error. Add `limit: 1` to run them one at a time, in the order listed.

`next` is a plain function, so each case is tested by handing it the outcomes, with no I/O:

```js
const order = { id: 'order_1', customerId: 'cus_1', items: [], total: 120 };

// The card was charged, then the stock ran out: the flow refunds the charge and fails.
const undoing = reserveAndCharge(order).next([Failure('out_of_stock'), Success('ch_1')]);
assert.equal(commandName(undoing.effects[0]), 'cmdRefundCharge');
assert.deepEqual(
    undoing.next([Failure('refund_failed')]),
    Failure({ error: 'out_of_stock', undoFailed: ['refund_failed'] })
);

// Both succeeded, so there is nothing to undo.
assert.deepEqual(
    reserveAndCharge(order).next([Success('res_1'), Success('ch_1')]),
    Success({ order, reservationId: 'res_1', chargeId: 'ch_1' })
);
```

Exact rules: [undoing under `settled`](../REFERENCE.md#undoing-under-settled).
