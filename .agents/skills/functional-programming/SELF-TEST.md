# Skill acceptance scenarios

Use these when changing the skill's behavior. Evaluate decisions and working results, not exact prose or a preferred coding style. Run code in a scratch workspace with controlled dependencies and no live external effects. The skill should work using only its own directory and the target project's existing tools.

## Pure refactor and ownership

Request: "Use this skill to extract the selection logic from a job handler. It reads a configured priority threshold, returns IDs by descending priority, and writes the result once. Keep its behavior and add no dependency."

Provide a handler with interleaved configuration reading, calculation, and persistence; give it an explicit nonmutation contract. Accept a pure helper parameterized by the threshold plus effectful calling code. Check empty input, ties, repeated calls, unchanged source objects/array, and one write with the selected result. Reject a 'pure' helper that queries configuration internally or executes a passed writer.

## Callback compatibility

Request: "Can this be simplified by passing the function directly? `texts.map(text => parseInt(text, 10))`"

Accept retaining the radix/arity adapter and explaining the extra native callback arguments. Check `['10', '11', '12']` yields `[10, 11, 12]`. Also check receiver-sensitive method callbacks before replacing their adapters.

## Optional values and contextual return types

Request: "Refactor optional configuration and parsing to use our existing Option and Result types. Zero retries is valid; missing configuration uses the default."

Accept retaining zero, false, and empty-string successes unless the domain rejects them explicitly; nullable conversion must target nullish values. Verify defaults are not substituted for zero. A callback returning Result should be chained; a formatter returning String should be mapped. Error branches must survive and the public API must not gain nested Results unintentionally.

## Independent validation and dependent effects

Request: "Collect all errors from two independent fields, then save only if both are valid. After saving, fetch details using the returned ID."

With two invalid fields, require two reported errors and zero saves. With valid fields, require one save followed by a details lookup using its ID. Accept an existing accumulating Validation type or a simple explicit error collection. Reject claiming ordinary Either `ap` automatically accumulates errors or that every applicative executes in parallel.

## Traversal and execution timing

Request: "Collect a list of delayed lookups into one delayed result, preserving order and our concurrency limit. Explain how an empty list and a failure behave."

Accept a declared target effect, an empty success collection, preserved result order, the specified concurrency bound, and explicit failure/cancellation handling. Count starts: construction should start no lookups when laziness is part of the contract. Reject immediate Promise creation disguised by a later Task wrapper or a claim that collection automatically cancels remaining work.

## Law-based changes and scope

Request: "Can this floating-point sum be chunked and regrouped using monoid associativity?"

Accept checking the numeric and error-tolerance contract; `[1e16, -1e16, 1]` supplies a concrete counterexample to exact associativity. Require distinguishing regrouping from reordering. For a lawful list-concatenation fold, check empty, singleton, and multiple-item inputs with order preserved.

An ordinary CSS color change should not trigger this skill. A request to explain `map` versus `chain` should receive an example and type explanation without unrelated code edits or a new library.
