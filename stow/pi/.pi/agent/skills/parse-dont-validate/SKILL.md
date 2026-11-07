---
name: parse-dont-validate
description: Design and refactor code so untrusted or loosely structured inputs are parsed into precise representations that preserve invariants. Use when implementing input boundaries, APIs, configuration, deserialization, domain models, or when reviewing repeated validation, partial functions, impossible states, and scattered checks.
---

# Parse, Don't Validate

Turn checks into data representations that **retain what was learned**. A successful parse should produce a value whose shape, type, or encapsulation makes downstream code simpler and safer.

Adapted from Alexis King's [*Parse, don’t validate*](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) (2019).

## Core rules

1. **Start from the consumer.** Define the representation the operation *wishes it had*, with the invariants it actually requires. Prefer a non-empty sequence, an enum, a map with an explicit duplicate policy, or a domain-specific type over a weakly structured bag of values.
2. **Parse at the boundary.** Convert external inputs (JSON, HTTP, environment variables, CLI arguments, files, database rows, network messages) into that representation before acting on them. For branch-specific requirements, refine immediately after selecting the branch.
3. **Return the refined value, not `bool` or `void`.** A `validate(x) -> success` check discards its proof; `parse(x) -> TrustedValue | Error` carries the result forward. Exceptions may represent errors, but successful output must still preserve the invariant.
4. **Keep ordinary business logic on the trusted side.** Functions should accept the refined representation rather than raw inputs and repeatedly checking them.
5. **Make illegal states unrepresentable where reasonable.** Use appropriate types, tagged unions, state-specific types, private constructors, smart constructors, and representations that enforce structural invariants.
6. **Reject invalid input before side effects.** Do not partially process unparsed inputs and only later discover invalid values. Multi-pass parsing is fine; mixing scattered checks into execution is not.
7. **Keep one source of truth.** Avoid duplicated mutable fields that can disagree. If redundant state is necessary, encapsulate synchronization in a small trusted module.
8. **Use proportional rigor.** Prefer simple data shapes and small constructors. Do not add an elaborate type hierarchy, third-party validation framework, or a wrapper per primitive when the benefit is negligible.

## Agent workflow

When implementing or refactoring:

1. **Identify the invariant.** Write it precisely: e.g., "at least one path," "known command variant," "unique keys," "port in 1..65535," or "authenticated request."
2. **Find the trust boundary.** Locate the first point at which the program receives the value from a source that does not guarantee the invariant.
3. **Choose the narrowest useful representation.** Prefer a built-in representation when it works. For duplicate keys, decide whether to reject duplicates, preserve them, or deliberately choose a winner; silently converting to a map can lose information.
4. **Implement one parser/constructor.** It must either return a fully usable refined value or fail with an actionable error. Validate all required fields, relationships, limits, and variants before returning.
5. **Change consumer signatures first.** Have consumers take the refined type/shape. Propagate that requirement toward the input boundary; insert parsing at the first appropriate construction point.
6. **Remove redundant downstream checks.** Only remove a check when the representation or controlled construction genuinely guarantees its condition. Keep checks for changing external state, authorization, concurrency, and other runtime conditions.
7. **Test the boundary and the trusted path.** Include valid, missing, malformed, duplicate, empty, out-of-range, and cross-field-invalid inputs as applicable. Verify invalid inputs trigger no business side effects.
8. **Report the contract.** Summarize which invariants the parsed representation guarantees and which failures remain possible during execution.

## JavaScript example: preserve non-emptiness

**Avoid:** checking once but returning the same unrestricted array, then relying on later code to remember the check.

```js
function validateDirs(dirs) {
  if (!Array.isArray(dirs) || dirs.length === 0) {
    throw new Error('Expected at least one directory');
  }
}

validateDirs(rawDirs);
initializeCache(rawDirs[0]); // Invariant is only a convention.
```

**Prefer:** parse into a shape with an explicit head; keep the parsed result as the value passed onward.

```js
function parseNonEmptyDirs(value) {
  if (!Array.isArray(value) || value.length === 0 ||
      !value.every(x => typeof x === 'string' && x.length > 0)) {
    throw new Error('Expected one or more non-empty directory paths');
  }
  return Object.freeze({
    first: value[0],
    rest: Object.freeze(value.slice(1)),
  });
}

function initializeFromDirs(dirs) {
  initializeCache(dirs.first); // No empty-array case.
}

const dirs = parseNonEmptyDirs(rawDirs);
initializeFromDirs(dirs);
```

JavaScript cannot statically prevent callers from forging the same object shape. Where that matters, use module encapsulation, an opaque class/private field, or TypeScript branded types with controlled constructors. `Object.freeze` protects against ordinary mutation, not hostile code or every possible misuse. Do not claim compile-time guarantees in plain JavaScript.

## C example: keep construction controlled

In C, use an explicit parsing result and pass a struct that stores a required first element separately. Keep the constructor and mutable representation inside a module when possible.

```c
/* dirs.h: trusted representation; callers should not mutate it. */
typedef struct {
    const char *first;
    const char *const *rest;
    size_t rest_count;
} nonempty_dirs;

/* Returns 0 on success. Output is valid only when return value is 0.
   Pointers borrow storage from the input; caller maintains its lifetime. */
int parse_nonempty_dirs(const char *const *paths, size_t count,
                        nonempty_dirs *out);

/* dirs.c */
int parse_nonempty_dirs(const char *const *paths, size_t count,
                        nonempty_dirs *out) {
    if (!paths || !out || count == 0) return -1;
    for (size_t i = 0; i < count; ++i) {
        if (!paths[i] || paths[i][0] == '\0') return -1;
    }
    *out = (nonempty_dirs){
        .first = paths[0], .rest = paths + 1, .rest_count = count - 1
    };
    return 0;
}
```

This public C struct is still forgeable and its borrowed storage may change. If you need a strong module invariant, make `nonempty_dirs` opaque in the header and manage construction, access, ownership, and destruction through functions. Keep allocation and ownership rules explicit; do not introduce heap allocation solely to imitate a richer type system if the weaker contract is sufficient.

## Review smells and corrective moves

| Smell | Prefer |
| --- | --- |
| `validate(x); use(x)` | `parsed = parse(x); use(parsed)` |
| Repeated `if (!x)` deep in business logic | A type or shape that excludes the missing case |
| `should never happen` after earlier checks | Carry proof forward in the representation |
| Several booleans encoding mutually exclusive states | Tagged variants / a discriminated union |
| Raw string or integer with domain constraints | An enum or smart-constructed domain value |
| Duplicate-key checks scattered around | A deliberate key model and boundary conversion |
| Parsing interleaved with writes, sends, or commits | Finish necessary parsing before effects |
| Mutable derived values stored in several places | One source of truth or encapsulated synchronization |

## Important exceptions

- **Not all validation is parsing.** Authorization, access control, live resource availability, race-sensitive conditions, and state transitions can need checks at the time of use. Parsing input does not grant permission or eliminate external failures.
- **Handle untrusted data safely during parsing.** Enforce appropriate input-size and resource limits, and authenticate early when necessary to avoid excessive parsing work.
- **A container is not automatically a proof.** Converting pairs into a map might silently discard duplicates; freezing a JavaScript object does not make its provenance trustworthy; a public C struct does not prevent invalid construction.
- **Failure still exists.** Parsers can reject input; trusted operations can still encounter I/O, memory, network, and other execution errors. Distinguish invalid input from operational failure.
- **Avoid overengineering.** If the invariant cannot reasonably be represented in the language, validate it in one controlled constructor and document what remains a convention. Use tests and encapsulation appropriately.

## Completion checklist

- [ ] Every required invariant is named and tied to an appropriate representation.
- [ ] Untrusted inputs are parsed before business side effects that depend on them.
- [ ] Parsing either produces a complete usable value or reports an error.
- [ ] Consumers accept the refined value instead of repeating checks on raw data.
- [ ] No formerly protected edge case became unchecked during the refactor.
- [ ] Duplicate handling, mutation, ownership, and lifetimes are explicit where applicable.
- [ ] Invalid and valid paths have tests; invalid input has no partial effects.
- [ ] Added complexity is proportional to the actual correctness benefit.

## Guiding question

**What representation would make this check unnecessary, and where should that representation first be constructed?**
