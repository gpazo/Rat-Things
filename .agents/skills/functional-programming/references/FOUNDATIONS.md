# Foundations

Use for ordinary transformations and functional refactors. Based on chapters 1–7; [source and adaptation details](SOURCES.md).

## Purity and ownership

A pure calculation depends on its explicit inputs and stable captured values, returns a result for its stated domain, and has no observable side effects. Reads of a changing clock, environment, DOM, or database are effects too. Injecting a callable dependency improves control but does not establish purity if calling it performs effects.

Prefer returning new values over modifying caller-owned data. `const`, object spread, and `Object.freeze` are shallow mechanisms, not recursive immutability. Copy each changed path when updating nested structures. Local mutation of a fresh, unshared accumulator can still implement a pure function; a loop is not itself a side effect.

For example, let the calling boundary obtain configuration and persist results. The calculation works on supplied values and does not reorder the caller's array:

```js
// selectJobIds :: Number -> [Job] -> [String]
// Job has a string id and a finite numeric priority.
const selectJobIds = minimumPriority => jobs =>
  jobs
    .filter(job => job.priority >= minimumPriority)
    .sort((a, b) => b.priority - a.priority)
    .map(job => job.id);
```

`filter` creates the array that `sort` mutates; the job objects are only read. Preserve the existing tie-order contract. If the original API promises to mutate its input, extracting this helper does not authorize silently changing that API.

Memoization is a separate optimization. It requires an appropriate input equivalence, stable values, a bounded cache policy where needed, and correct handling of cached falsey results. A JSON serialization key is not a universal equality function. Caching an action description is different from caching its execution result.

## First-class functions without semantic changes

Pass a function directly when an adapter adds no behavior. Before replacing `x => f(x)` with `f`, check what the caller supplies and what `f` observes:

- Native array callbacks receive more than the element. `values.map(text => parseInt(text, 10))` cannot become `values.map(parseInt)`; the index would be interpreted as a radix.
- Extracting `service.save` can lose its `this` receiver. Preserve a required binding with an adapter or `bind`.
- A wrapper may deliberately limit arguments, defer a property lookup, translate an error, or preserve a scheduling boundary. Keep it if that behavior matters.

Prefer meaningful domain names for business operations and general names for truly reusable helpers. Removing parameters is not a reason to remove useful vocabulary.

## Currying and partial application

Currying represents a multi-argument function as a sequence of single-argument functions. Partial application fixes some arguments to produce a more specialized function. They work together but are not synonymous.

Place stable configuration first and the frequently varying data last when that makes call sites reusable:

```js
// hasTag :: String -> Record -> Boolean
// Record has a tags array of strings.
const hasTag = tag => record => record.tags.includes(tag);
const isUrgent = hasTag('urgent');

// selectUrgent :: [Record] -> [Record]
const selectUrgent = records => records.filter(isUrgent);
```

`hasTag('urgent')(record)` is the contract here. `hasTag('urgent', record)` does not automatically apply both arguments. A library curry helper may support grouped arguments or placeholders; check its actual API, especially around default/rest parameters and function arity.

Do not reorder established public parameters just to get data-last style. A small internal adapter is often enough.

## Composition and type-guided debugging

`compose(f, g)` applies `g` before `f`; a conventional `pipe(g, f)` applies its arguments left to right. Use the repository's convention consistently. Adjacent output and input types must agree, including wrapper types.

This dependency-free example composes unary functions:

```js
const pipe = (...steps) => input =>
  steps.reduce((value, step) => step(value), input);

const trim = text => text.trim();
const splitWords = text => text === '' ? [] : text.split(/\s+/u);
const lowerWords = words => words.map(word => word.toLowerCase());
const normalizeWords = pipe(trim, splitWords, lowerWords);

// normalizeWords('  Green  BLUE ') => ['green', 'blue']
// normalizeWords('   ') => []
```

After `splitWords`, the value is an array: a string-only function needs to be mapped over it. If a step returns an Option or Result, the following operation must account for that context. Ordinary synchronous composition does not await Promises.

To debug, expand the composition into named intermediate values, annotate their actual types, and inspect the first mismatch. Temporary logging is an effect; remove it or place it at the calling boundary after diagnosis.

## Honest type signatures

Read `A -> B -> C` as `A -> (B -> C)`. Repeated type variables refer to the same type; a constraint such as `Ord A` requires ordering operations. Write contracts for the real domain:

| Operation | Honest shape |
|---|---|
| First element of a possibly empty list | `[A] -> Option A`, or `[A] -> A \| undefined` in JS/TS |
| First element with a nonempty guarantee | `NonEmptyList A -> A` |
| Regex matching that can fail | `Regex -> String -> Option Match`, or the actual nullable return type |
| Parse untrusted text | `String -> Result ParseError Value` |
| Perform an async lookup | `Id -> Task Error Value`, or the project's actual Promise/error contract |

Use native type annotations or concise comments as appropriate. JavaScript comments and TypeScript generics do not enforce totality, purity, parametricity, or runtime input validity. Type-based reasoning is useful only when the implementation respects those assumptions.

## Law-based refactoring

Composition permits regrouping compatible pure functions while preserving their order. For lawful unary mapping, `xs.map(g).map(f)` and `xs.map(x => f(g(x)))` produce equivalent values. Use this to extract meaningful stages or remove an intermediate array when justified.

Do not fuse arbitrary callbacks blindly: the index/array argument, mutation, thrown errors, and side-effect order can change the behavior. Do not infer that every functional rewrite improves performance. See [algebraic laws](ALGEBRA.md) when the rewrite depends on them.
