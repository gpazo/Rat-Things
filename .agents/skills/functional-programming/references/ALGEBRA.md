# Algebra and traversal

Use when combining or rearranging contexts, folding data, implementing an abstraction, or justifying a rewrite. Based on chapters 8–13; [source and adaptation details](SOURCES.md).

## Resolve nesting by its shape

Write the complete type before changing the code. Each operation solves a different problem:

| Current shape | Intended change | Tool |
|---|---|---|
| `F (F A)` | Merge one repeated context | `join`, or use `chain` where nesting was introduced |
| `F (G A)` | Transform the inner value, keeping both contexts | Nested `map`, or the project's composed-functor abstraction |
| `F A` | Convert to `G A` | A context conversion with explicit failure/information policy |
| `T (F A)` | Collect as `F (T A)` | `sequence`, if `T` is Traversable and `F` is Applicative |
| `T A`, with `A -> F B` | Transform and collect in one operation | `traverse` |

Nested contexts can encode useful distinctions. `Task Error (Result ValidationError A)` can distinguish transport failure from validation failure. Flattening everything into one error channel is a policy change, not just tidying syntax. Arbitrary monads do not automatically compose into another monad.

## Natural transformations and conversions

A natural transformation changes context uniformly while preserving mapping: `nt :: F A -> G A`. Its naturality condition is:

```text
nt(map(f, fa)) ≈ map(f, nt(fa))
```

The transformation may inspect structure or error branches, but must not special-case the successful payload's type or value. For example, converting `Result E A` to `Option A` can discard the error reason while preserving every successful value, including falsey ones. Name the information loss. Converting to a task should map error and success branches deliberately and preserve required effect timing.

Do not call every type conversion natural: parsing a string into a number changes the value type. Do not call a conversion an isomorphism unless both round trips preserve the behavior relevant to the contract. Task/Promise conversions may preserve an eventual result while changing start time, repeated execution, or cancellation; do not assume behavioral equivalence.

## Traverse and sequence

Using schematic, data-last signatures:

```text
sequence :: (Traversable T, Applicative F)
         => (A -> F A) -> T (F A) -> F (T A)
traverse :: (Traversable T, Applicative F)
         => (B -> F B) -> (A -> F B) -> T A -> F (T B)
traverse(F.of, f, values) ≈ sequence(F.of, map(f, values))
```

The first argument identifies the target applicative for empty or inactive branches. An empty list can become `F.of([])` even though there is no element from which to infer `F`. Sequencing an absent Option into an effect yields that effect containing absence, without inventing an action for the missing value. Exact argument order and whether `of` must be supplied depend on the library.

Choose the outer context according to desired behavior:

- `[Option A]` retains a per-position presence/absence result. It does not automatically filter missing elements.
- `Option [A]` expresses one optional collection; sequencing a list of Options usually makes it absent if any element is absent.
- `[Result E A]` keeps each success or error. `Result E [A]` commonly describes an all-success collection or a failure. An accumulating applicative can instead gather all independent errors.
- `[Task E A]` contains separate action descriptions. `Task E [A]` describes collecting their results; the chosen applicative controls execution policy.

Test empty structures, branch preservation, result order, and multiple failures. Do not assume traversal short-circuits construction of all later actions, guarantees parallelism, or limits concurrency: inspect the implementation and the selected applicative. Keep library-specific effect runners at a deliberate boundary.

## Semigroups, monoids, and folds

A semigroup combines two values of the same type with an associative operation. A monoid adds a two-sided identity. Select the operation and its domain before selecting the identity:

| Combination | Identity | Contract |
|---|---|---|
| String concatenation | `''` | Preserve text order |
| List concatenation | `[]` | Preserve element order |
| Boolean conjunction (All) | `true` | Every condition holds |
| Boolean disjunction (Any) | `false` | At least one condition holds |
| Exact addition (Sum) | `0`, or `0n` for BigInt | Use an appropriate numeric domain |
| Exact multiplication (Product) | `1`, or `1n` for BigInt | Use an appropriate numeric domain |
| Endomorphism composition, `A -> A` | Identity function | All stages must share the same input/output type |

Fold from the identity so empty input has a defined result. If only a semigroup exists, require a nonempty collection or return an explicit absence for empty input; do not invent a sentinel. A first-value operation on present values has no identity until the representation is extended with absence.

Associativity permits regrouping while preserving order. It does not permit arbitrary reordering, which additionally needs commutativity. Test the actual numeric domain: JavaScript floating-point addition is not associative, so changing a reduction tree may change the result. An average of averages also fails without weights; combine sufficient statistics such as sum and count before computing the final average.

Product records can combine field by field when each field has a compatible operation. Spell out collision and failure rules rather than treating arbitrary object spread as an automatic monoid.

## Laws as checks

Here `≈` means equivalent observable behavior, not JavaScript object/function reference equality. Use the type's equality or compare its branches and payloads. For functions, compare outputs on suitable inputs; for effects, compare outcomes and relevant execution traces using controlled dependencies.

Assume total pure callbacks on the stated domain and lawful operations. The following use function-container-first `ap(ff, fa)`, matching the book's examples. Let `id(x) = x` and `composeC(f)(g)(x) = f(g(x))`. Adapt this notation to the actual library before executing it.

```text
Composition:
  compose(f, compose(g, h)) ≈ compose(compose(f, g), h)
  compose(id, f) ≈ f ≈ compose(f, id)

Functor:
  map(id, u) ≈ u
  map(f, map(g, u)) ≈ map(x => f(g(x)), u)

Applicative:
  ap(F.of(id), u) ≈ u
  ap(F.of(f), F.of(x)) ≈ F.of(f(x))
  ap(u, F.of(x)) ≈ ap(F.of(f => f(x)), u)
  ap(ap(ap(F.of(composeC), u), v), w) ≈ ap(u, ap(v, w))

Monad (f and g return M values):
  chain(f, M.of(x)) ≈ f(x)
  chain(M.of, m) ≈ m
  chain(g, chain(f, m)) ≈ chain(x => chain(g, f(x)), m)

Semigroup:
  concat(concat(a, b), c) ≈ concat(a, concat(b, c))

Monoid:
  concat(empty, a) ≈ a ≈ concat(a, empty)
```

When implementing traversal, also check identity, composition, and naturality against the library's specification. Identity says traversing with Identity reproduces the original structure inside Identity. Composition says traversing composed applicatives agrees with performing the two traversals in sequence. Naturality says transforming the target applicative before or after sequencing agrees, for a transformation preserving its applicative operations.

Check coherence if implementing several interfaces: mapping should agree with lifting and application, and with chaining followed by `of`. Include failure and empty branches, not only success examples. Passing a few examples provides evidence, not a mathematical proof.
