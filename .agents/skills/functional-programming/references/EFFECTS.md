# Effects and containers

Use when absence, errors, or effects must compose. Based on chapters 8–10; [source and adaptation details](SOURCES.md). Names below describe interfaces, not imports from an assumed package.

## Choose the context for the contract

| Context | Represents | Decision |
|---|---|---|
| Identity | An ordinary value in a uniform interface | Useful for explanations or generic code; rarely needed in business logic |
| Option / Maybe | A value may be absent | Use when no failure reason is required |
| Result / Either | A success or a typed alternative, often an error | Preserve the reason and handle both branches |
| IO / a thunk | A delayed synchronous action | Construct separately from executing |
| Task / an existing effect type | A controlled async computation | Inspect its start, failure, cancellation, and repeat-execution semantics |

Use the project's existing representation. In TypeScript, a discriminated union can express an optional value or result without a new runtime dependency. In another language, use its native equivalents rather than transplanting JavaScript classes.

## Absence is not falsehood

At a nullable boundary, use a nullish check when only `null` and `undefined` mean absence. Do not collapse `0`, `false`, or `''` with a truthiness check. Decide separately whether an empty string is invalid in the domain.

Distinguish a general constructor (`Some`, `Just`, `of`, or `pure`) from a nullable conversion (`fromNullable`). For lawful generic mapping, an explicitly present null can remain present; mapping a function that returns null must not silently reinterpret presence unless that is the chosen, restricted contract. The book's null-checking Maybe is a teaching simplification.

Do not reach into a container's private value or assert away its empty/error case. Continue inside the context, or consume it with an exhaustive match/fold at a deliberate boundary. A default is a policy decision; an absent retry count and a configured zero may mean different things.

## Map, chain, and of

- Use `map` when the callback returns a plain value: `A -> B`.
- Use `chain`/`flatMap` when the callback returns the same kind of context: `A -> F B`.
- Use `of`/`pure` to put a plain value in the success/minimal context. It is not a generic substitute for every constructor: `IO.of(effect())` runs `effect()` before wrapping its result.

For a Result with a fixed error type, this complete JavaScript example shows the distinction using a tagged union:

```js
const ok = value => ({ tag: 'ok', value });
const err = error => ({ tag: 'err', error });
const mapResult = f => result =>
  result.tag === 'ok' ? ok(f(result.value)) : result;
const chainResult = f => result =>
  result.tag === 'ok' ? f(result.value) : result;

// parseCount :: String -> Result String Number
// The domain accepts decimal digits only, including zero.
const parseCount = text => {
  if (typeof text !== 'string' || !/^\d+$/u.test(text)) {
    return err('Expected decimal digits');
  }
  const value = Number(text);
  return Number.isSafeInteger(value)
    ? ok(value)
    : err('Count exceeds the safe integer range');
};

// requirePositive :: Number -> Result String Number
const requirePositive = count =>
  count > 0 ? ok(count) : err('Expected a positive count');

const describeCount = text =>
  mapResult(count => `${count} queued`)(
    chainResult(requirePositive)(parseCount(text)),
  );

// describeCount('3') => { tag: 'ok', value: '3 queued' }
// describeCount('0') => { tag: 'err', error: 'Expected a positive count' }
```

Using `mapResult(requirePositive)` would produce a Result inside a Result. Using `chainResult` with a string-returning formatter would lose the outer Result. Neither helper catches exceptions automatically: adapt a throwing parser at its boundary if the contract calls for a Result, and retain meaningful failure information.

`join` removes one layer of the same context. A `Task (Result A)` does not become a plain Task by `join`; decide whether to retain Result, traverse it, or convert it with a documented error mapping. See [nested contexts](ALGEBRA.md).

## Independent inputs: applicatives

Use `ap` or a lifting helper when multiple contextual inputs can be constructed without knowing each other's results. Use `chain` for a step whose choice depends on the prior successful value.

With the book's **function-container-first** convention, `F.of(f).ap(fa).ap(fb)` applies a curried `f` to two contextual inputs. This is schematic notation: verify the installed library's argument order and currying requirements. Fantasy Land's method convention places the function-containing argument on the other side.

Two choices remain separate from the abstract interface:

- **Scheduling:** an applicative can expose independence, but does not guarantee parallel execution. A sequential `ap` derived from `chain` is possible. Preserve resource and concurrency limits.
- **Failure:** ordinary Either/Result application can stop at a failure. To collect every independent validation error, use an accumulating Validation instance or an explicit collection pass. Error accumulation needs an associative error-combination operation, such as ordered array concatenation.

For example, checking a form's title and category independently can collect both failures. Looking up details using a newly fetched account ID is dependent and needs sequencing. Choose the behavior first, then the abstraction.

## Construct effects separately from running them

Build descriptions or delayed functions during composition and interpret them at the application boundary. For example, `() => fetch(url)` delays starting that request until invocation, while `Promise.resolve(fetch(url))` does not. Keep captured inputs stable if the description is meant to denote a fixed request.

A Promise executor runs during construction; its handlers run asynchronously. Promises do not become lazy Tasks by renaming them, and `.then` assimilates returned Promises, so it is not simply a general functor `map`. Converting an already-started Promise into a Task cannot undo its start. Use a factory if delayed creation is required.

Existing `async`/`await` code can provide a clear effect boundary. Keep its pure transformations separate. For a group of operations, distinguish dependency, concurrency limits, result order, and partial-success policy. `Promise.all` rejects on a rejection and does not itself cancel the remaining work; use the project's appropriate collection and cancellation mechanisms.

Check when an effect starts, how often it runs, who handles failure, and who releases resources. Running the same IO/thunk/Task twice may repeat its effects. An effect wrapper alone does not ensure caching, idempotency, cancellation, or exactly-once execution.
