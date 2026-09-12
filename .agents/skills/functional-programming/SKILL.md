---
name: functional-programming
description: >-
  Apply functional programming when designing, refactoring, reviewing, or explaining
  code, especially JavaScript and TypeScript. Use for pure functions, immutable
  transformations, currying, composition, explicit effects, algebraic data types,
  or questions about the Mostly Adequate Guide. Avoid activating for ordinary code
  changes that have no functional design concern.
license: CC-BY-SA-4.0
---

# Functional Programming

Make dependencies, data flow, and effects explicit so code can be composed and reasoned about locally. Distilled from *Professor Frisby's Mostly Adequate Guide to Functional Programming*; see [attribution and source map](references/SOURCES.md) and [license](LICENSE.md).

## Apply to the task

1. Identify the requested outcome and the existing contracts: accepted inputs, output shape, failure behavior, mutation visible to callers, and effect order. A functional refactor should preserve these unless the user requests a change.
2. Trace the relevant path from input to output. Separate calculations from reads, writes, time, randomness, logging, and mutable shared state. Write down ambiguous intermediate types, including their error or effect context.
3. Extract a pure calculation where it simplifies the task. Pass the values it needs explicitly; leave obtaining those values and performing effects at a clear calling boundary. Passing a database client into a function does not make a query inside that function pure.
4. Choose the least powerful abstraction that expresses the behavior. Start with ordinary functions and the project's existing types; introduce contexts when absence, errors, or effects actually need composition.
5. Verify the observable result and any behavior that moved across a boundary. Explain what became easier to reason about and identify intentional behavior changes.

For a review, report concrete problems and focused fixes. For an explanation, use one small example, show the types before and after each operation, and relate the law to a practical decision. An explanation request does not call for repository edits.

## Choose the operation by its types

Here `F` is a context such as Option, Result, or a task; `T` is a traversable structure such as a list. Names vary by language and library.

| Need | Operation | Shape / decision |
|---|---|---|
| Feed a plain result to the next function | Compose / pipe | `A -> B`, then `B -> C` |
| Transform a value inside a context | `map` | `(A -> B) -> F A -> F B` |
| Continue with a computation in the same context | `chain` / `flatMap` / bind | `(A -> F B) -> F A -> F B` |
| Combine independent contextual inputs | `ap` / `liftA2` | Lift a curried combining function; scheduling depends on the instance |
| Remove one layer of the same context | `join` | `F (F A) -> F A`; cannot flatten `F (G A)` generically |
| Collect contextual results while preserving structure | `traverse` / `sequence` | `T (F A) -> F (T A)`; choose failure and ordering semantics |
| Convert contexts | Natural transformation | `F A -> G A`; state what information or effects change |
| Combine many values | Semigroup / monoid fold | Associative combination; use an identity for empty input |

Read only the supporting material needed for the task:

- [Foundations](references/FOUNDATIONS.md): purity, immutable updates, first-class functions, currying, composition, and type signatures.
- [Effects and containers](references/EFFECTS.md): Option/Maybe, Either/Result, `map` versus `chain`, applicative validation, and async boundaries.
- [Algebra and traversal](references/ALGEBRA.md): nested contexts, natural transformations, traversal, monoids, and laws for validating abstractions or rewrites.

## Keep the design practical

- Follow the host language and repository's idioms. Use existing Option/Result/effect types and utilities where present. A plain function, tagged union, or `async` function may be sufficient; do not add a library or invent a generic FP runtime merely to resemble the book.
- Prefer named intermediate functions and explicit parameters when they clarify intent. Pointfree style is optional. Currying earns its place through useful partial application, not by changing every public API.
- Keep domain calculations on plain values where possible; lift them with `map` at the composition site. Introduce effect types only where they describe real behavior.
- Keep absence distinct from failure when callers need a reason. Preserve legitimate `0`, `false`, and empty strings. Handle expected missing/invalid input explicitly instead of relying on an unsafe unwrap or type assertion.
- Do not assume a method name establishes its laws or semantics. Check callback arity, receiver binding, argument order, laziness, error propagation, and the installed library's `ap`/`traverse` conventions before rewriting code.
- Treat laws as conditional on the actual domain and implementation. Mutation, partial functions, observable callback arguments, and floating-point arithmetic can invalidate a seemingly algebraic rewrite.
- Confine effects to clear boundaries. Delaying an action does not cache its result or make its eventual execution pure. Preserve execution count, sequencing, concurrency limits, cancellation, and cleanup where relevant.

## Verify the result

Use the project's existing checks and small, targeted examples. For a refactor, compare outputs, input ownership, failures, and effect traces where those are part of the contract. Include empty input, missing values, and falsey successes when applicable. For a new algebraic abstraction or a law-based optimization, test the relevant laws with suitable value equality and representative inputs; ordinary business edits do not need a type-class test suite.

Keep any temporary tracing out of the claimed pure core. Report checks performed and limitations without claiming that a type signature proves runtime behavior.

When maintaining this skill, use [SELF-TEST.md](SELF-TEST.md) for realistic acceptance scenarios. The [source map](references/SOURCES.md) records the book revision, coverage, and adaptations for redistribution.
