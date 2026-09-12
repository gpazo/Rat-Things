# Attribution and source map

This skill is an adaptation of **Professor Frisby's Mostly Adequate Guide to Functional Programming**, credited to the **Mostly Adequate Core Team and contributors** (the author credit in the source repository's package metadata).

- [Read the original guide](https://mostly-adequate.gitbook.io/mostly-adequate-guide).
- [Source repository](https://github.com/MostlyAdequate/mostly-adequate-guide).
- [Reviewed source revision: `239468e9bc4ce1f0143722f312eb2487cac846ea`](https://github.com/MostlyAdequate/mostly-adequate-guide/tree/239468e9bc4ce1f0143722f312eb2487cac846ea), accessed September 11, 2026.
- [Original title metadata](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/book.json), [author metadata](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/package.json), and [original license notice](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/LICENSE).
- The original text and this adaptation use [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/). See the skill's [license notice](../LICENSE.md).

## What changed

The adaptation condenses and reorganizes the guide into an agent workflow, decision tables, focused references, and acceptance scenarios. It uses new examples in place of the book's exercises and adds implementation cautions for JavaScript, TypeScript, and existing production code. It does not reproduce the book's artwork or vendor its support library. It is an independent adaptation; it does not imply endorsement by the original authors.

The main additions are behavior-preserving refactoring, shallow-copy and callback caveats, explicit nullable conversion, honest partial-function signatures, library-dependent applicative semantics, and effect lifetime checks. Promise/Task round trips are treated as potentially different in observable behavior. Algebraic equations are conditional on their domain and use behavioral equality rather than `===` between functions or containers.

## Coverage

Chapter links below refer to the reviewed revision; the local references are intended to be usable without fetching the book.

| Source chapters | Distilled material |
|---|---|
| [1: Intent](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch01.md), [2: First-class functions](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch02.md), [3: Purity](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch03.md) | [Foundations](FOUNDATIONS.md): explicit dependencies, ownership, function values, equational reasoning |
| [4: Currying](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch04.md), [5: Composition](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch05.md) | [Foundations](FOUNDATIONS.md): partial application, data-last helpers, readable composition |
| [6: Example application](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch06.md), [7: Type signatures](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch07.md) | [Foundations](FOUNDATIONS.md): pure calculations with effectful calling code, mapping laws, type-guided debugging |
| [8: Functors and effects](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch08.md), [9: Monads](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch09.md), [10: Applicatives](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch10.md) | [Effects](EFFECTS.md): contextual values, map/chain/ap, independent and dependent effects |
| [11: Natural transformations](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch11.md), [12: Traversal](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch12.md), [13: Monoids](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/ch13.md) | [Algebra](ALGEBRA.md): context conversions, collecting effects, combining data, laws |

The appendices explain the book's helper conventions: [A: functions](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/appendix_a.md), [B: structures](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/appendix_b.md), and [C: utilities](https://github.com/MostlyAdequate/mostly-adequate-guide/blob/239468e9bc4ce1f0143722f312eb2487cac846ea/appendix_c.md). They are teaching implementations, not a requirement to install those packages or emulate their APIs.

## Additional implementation references

Consult these when checking runtime or interface semantics, alongside the code and documentation of the installed library:

- [MDN: Array.prototype.map](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map) for callback arguments and array behavior.
- [MDN: Promise constructor](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/Promise) for executor timing.
- [MDN: Promise.all](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/all) for collection and rejection behavior.
- [Fantasy Land specification](https://github.com/fantasyland/fantasy-land) for algebraic laws and method conventions, particularly `ap`.
