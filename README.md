# Pure Effect

**Pure Effect** is a tiny, zero-dependency effect system for writing pure, testable JavaScript without mocks.

It implements the "Functional Core, Imperative Shell" pattern, allowing you to decouple your business logic from external side effects like database calls or API requests. Instead of executing side effects immediately, your functions return Commands which are executed later by an interpreter.

## Installation

```bash
npm install pure-effect
```

## Usage

Here is a complete example of a User Registration flow.

```js
import { Success, Failure, Command, effectPipe, runEffect } from 'pure-effect';

const validateRegistration = (input) => {
    if (!input.email.includes('@')) return Failure('Invalid email.');
    if (input.password.length < 8) return Failure('Password too short.');
    return Success(input);
};

// These functions do NOT run the DB call. They return a Command object.
// The 'next' function defines what happens with the result of the async call.
const findUser = (email) => {
    const cmdFindUser = () => db.findUser(email); // The work to do later
    const next = (user) => Success(user); // Wrap result in Success
    return Command(cmdFindUser, next);
};

const saveUser = (input) => {
    const cmdSaveUser = () => db.saveUser(input);
    const next = (saved) => Success(saved);
    return Command(cmdSaveUser, next);
};

const ensureEmailAvailable = (user) => {
    return user ? Failure('Email already in use.') : Success(true);
};

// The Pipeline uses arrow functions to capture 'input' from the scope where needed.
const registerUserFlow = (input) =>
    effectPipe(
        validateRegistration,
        () => findUser(input.email),
        ensureEmailAvailable,
        () => saveUser(input)
    )(input);

// The Imperative Shell
async function registerUser() {
    // logic is just a data structure until we pass it to runEffect
    const logic = registerUserFlow(input);

    // runEffect performs the actual async work
    const result = await runEffect(logic);

    if (result.type === 'Success') {
        console.log('User created:', result.value);
    } else {
        console.error('Error:', result.error);
    }
}
```

## Testing Without Mocks

The biggest benefit of **Pure Effect** is testability. Because `registerUserFlow` returns a data structure (a tree of objects) instead of running a Promise, you can test your logic without mocking the database.

```js
// 1. Test Validation Failure
const badInput = { email: 'bad-email', password: '123' };
const result = registerUserFlow(badInput);

assert.deepEqual(result, Failure('Invalid email.'));
// ✅ Logic tested instantly, no async needed.

// 2. Test Flow Intent (Introspection)
const goodInput = { email: 'test@test.com', password: 'password123' };
const step1 = registerUserFlow(goodInput);

// Check if the first thing the code does is try to find a user
assert.equal(step1.type, 'Command');
assert.equal(step1.cmd.name, 'cmdFindUser');

// Check if the next thing the code will do is to save a user
const step2 = step1.next(null);
assert.equal(step2.type, 'Command');
assert.equal(step2.cmd.name, 'cmdSaveUser');
// ✅ We verified the *intent* of the code without touching a real DB.
```

## API Reference

### `Success(value)`

Returns an object `{ type: 'Success', value }`. Represents a successful computation.

### `Failure(error)`

Returns an object `{ type: 'Failure', error }`. Represents a failed computation. Stops the pipeline immediately.

### `Command(cmdFn, nextFn)`

Returns an object `{ type: 'Command', cmd, next }`.

-   `cmdFn`: A function (sync or async) that performs the side effect.
-   `nextFn`: A function that receives the result of `cmdFn` and returns the next Effect (Success, Failure, or another Command).

### `effectPipe(...functions)`

A combinator that runs functions in sequence. It automatically handles unpacking `Success` values and passing them to the next function. If a `Failure` occurs, the pipe stops.

### `runEffect(effect)`

The interpreter. It takes an `effect` object, executes any nested Commands recursively using `async/await`, and returns the final `Success` or `Failure`.
