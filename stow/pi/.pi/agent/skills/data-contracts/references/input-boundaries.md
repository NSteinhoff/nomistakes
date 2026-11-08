# Input Boundaries

## Preserve the proof

A successful parser must return a value that carries the facts that consumers require. A separate `validate(raw)` call leaves those facts as a convention if consumers still accept unrestricted raw data.

Prefer a non-empty sequence, an enum, a discriminated union, or a small domain type over a loosely structured collection of fields. Use private constructors or module encapsulation when callers must not forge the representation. If the language cannot enforce the invariant economically, use one controlled constructor and state the remaining convention.

## Workflow

1. Name the required invariant precisely, such as a non-empty path sequence, a known command variant, or unique keys.
2. Find the first source that does not guarantee it, such as JSON, environment variables, files, database rows, CLI arguments, or network messages.
3. Choose the narrowest useful representation from the consumer's requirements. For branch-specific requirements, refine immediately after branch selection.
4. Implement one parser or constructor that checks required fields, relationships, limits, and variants. Return a fully usable refined value or an actionable failure.
5. Have consumers accept the refined representation. Propagate that requirement toward the boundary within the authorized scope.
6. Remove only the downstream checks that the representation makes redundant.
7. Test valid, missing, malformed, duplicate, empty, out-of-range, and cross-field-invalid inputs as applicable. Verify that rejection causes no dependent business effects.

## Representation choices

- For a non-empty sequence, store a required first element separately from the remainder if the language lacks an appropriate type.
- For mutually exclusive states, use variants rather than independent booleans.
- For constrained strings or numbers, use a controlled constructor when it provides a meaningful guarantee.
- For duplicate keys, choose rejection, preservation, or an explicit winner policy before conversion to a map. A map can silently discard evidence of duplicates.
- For redundant fields, derive values from one authority or keep updates within a controlled module.
- For incomplete parser output, use a distinct representation. Do not pass it to consumers that require the complete domain invariant.

## Limits of the guarantee

- In JavaScript, an object shape alone does not prove provenance. `Object.freeze` prevents ordinary mutation, not forgery or mutation of every nested value.
- In TypeScript, branded types need controlled construction. An unchecked cast does not establish an invariant.
- In C, a public struct remains forgeable. Borrowed storage can change or expire. Use encapsulation when necessary, but do not introduce heap allocation solely to imitate a richer type system.
- Across languages, aliases and mutation can invalidate a past check. Use immutable data, a copy, or controlled mutation where the contract requires it.

## Checks that remain necessary

Authorization, access control, resource availability, race-sensitive conditions, and state transitions can require checks at the time of use. A parsed value does not grant permission or guarantee future external state.

Enforce input-size and resource limits within the parser. Authenticate before expensive work when required. A trust boundary is not permission to spend unbounded resources on untrusted data.

Use tests for both boundary rejection and ordinary trusted operations. Do not add elaborate type hierarchies, validation dependencies, or wrappers without a concrete correctness benefit.
