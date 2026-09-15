---
name: error-free-design
description: >
  Apply when you design or review error handling, function signatures, or data
  structures in any programming language — especially before you reach for
  exceptions, Result-style union types, or defensive null checks. Based on Ryan
  Fleury's essay: handle errors by not having them, treat errors as ordinary
  data instead of a special category, and restructure code so failure paths
  collapse into the same codepath as success paths instead of many branches.
  Use this whenever the user writes a function that can fail, designs a module's
  public API, refactors nested null/error checks, or asks how to handle errors
  in some code, even if the user did not ask for it by name, and regardless of
  the language in use.
---

# Error-Free Design

Core idea: **an error is not a special kind of thing — it is just data.** Most "error handling" pain does not come from errors being hard, it comes from code being *structured* so that every possible failure doubles the number of codepaths (a check/early-exit/branch per failure point). The fix is not a fancier error-handling feature — it is designing data and APIs so failure and success flow through the *same* code.

Before reaching for a clever error-handling pattern, ask: **can this failure mode be designed away, or absorbed into the normal path, instead of handled?** That question comes before any of the techniques below, and before picking any language-specific mechanism (exceptions, error codes, union types, panics, etc.) to express the ones you cannot avoid.

These techniques are deliberately described independent of any language. Whatever the target language turns out to be, translate the shape of the idea into its idioms — a "valid empty value" is a nil-object in some languages, a zero-initialized struct in others, an empty collection or empty string almost everywhere.

## The five techniques

### 1. Guarantee valid reads — prefer a valid empty value over absence

The source article uses "nil structs" in place of null pointers, so that reading through a lookup that failed never crashes. The general version: when a lookup can fail, return a valid, inert, empty-shaped value instead of null/nothing/none — *if* the caller's next step is going to be another read.

Pseudocode:

```
EMPTY_PROFILE = Profile(displayName: "", friends: [])

function findProfile(id):
    found = profileTable.lookup(id)

    if found is absent:
        return EMPTY_PROFILE

    return found

// caller never checks for absence — it just reads
name = findProfile(id).displayName
```

Compare to the alternative, where every caller re-checks:

```
function findProfile(id):
    return profileTable.lookup(id)  // may be absent

// every call site now needs this branch
profile = findProfile(id)
name = profile.displayName if profile is present else ""
```

**Pros:** collapses every call site's presence-check down into one definition. Reads are always safe. Removes a branch that would otherwise be repeated at every call site.
**Cons:** only valid when "not found" and "found but empty" should behave identically to the caller. If the caller genuinely needs to distinguish "nothing exists here" from "something exists and happens to be blank," this technique throws away information they need — use technique 4 (attach info alongside the value, not instead of it) so both facts survive.

This does **not** apply to writes. Code that is about to mutate something should never be handed an empty/placeholder value as if it were the real thing — that is a bug waiting to happen. Reserve this technique for read paths.

### 2. Make empty values valid — design defaults so "nothing happened" is a legitimate state

Prefer data shapes where the empty/default value is automatically meaningful, so no explicit initialization is needed and no special-casing is needed downstream.

```
function emptyResults():
    return SearchResults(items: [], totalCount: 0)
```

Iterating over an empty collection, or checking a count of zero, already "just works" — you do not need a separate codepath for the empty case. This is why empty collections and empty strings are good default values, and sentinels like `-1` or magic strings are worse ones: a sentinel requires the caller to know about it and check for it explicitly, which reintroduces the branch this whole approach is trying to remove.

When you define a data shape, ask: **is there a value for it that means "empty/absent," and does the rest of the code already treat that value correctly for free?** If yes, that is your default. If not, consider reshaping the data until there is one.

### 3. If something is going to fail, fail as early as possible

The source article's example is a large memory allocation. The general version is anything that can fail for resource or environment reasons — a network call, a file open, a permission check, a quota limit.

The rule: **push the point where failure is discovered to the shallowest possible point in the sequence of operations**, ideally before any user-visible progress or irreversible state changes have happened. Do not let something deep in a call chain discover — after other work has already committed — that the whole operation was doomed from the start.

```
// Validate and reserve everything that could fail, up front,
// before doing anything that would need to be undone.
function submitOrder(input):
    validated = validateOrderInput(input)

    if validated has error:
        return error(validated.error)

    reserved = reserveInventory(validated.value)

    if reserved has error:
        return error(reserved.error)

    return chargeAndCreateOrder(validated.value, reserved.value)
```

Each check happens before the next step commits to anything irreversible. This is not about adding more checks — it is about *ordering* the checks you already need, so the cheap, early ones run before the expensive, hard-to-undo ones.

### 4. Prefer fewer types of results — attach error info alongside the value, not instead of it

This is the source article's most counterintuitive point, and it cuts against the usual "success-or-error" union instinct that most typed languages encourage by default — worth weighing deliberately rather than defaulting to either shape.

**Either/or shape — common default, forces a branch before the value can be used:**

```
// result is either a value, or an error — never both
function parseConfig(text):
    ...  // returns success(config) or failure(parseError)

result = parseConfig(text)

if result is failure:
    return failure(result.error)

// must check before touching the value — this is a second codepath
useConfig(result.value)
```

**Both/and shape — value and error info travel together, always both present:**

```
// result always carries a usable value (possibly the empty
// default from technique 2), plus whatever diagnostics accumulated
function parseConfig(text):
    ...  // returns { value: config, errors: [...] }, never absent

parsed = parseConfig(text)

// one codepath: use the value, it's always structurally valid
useConfig(parsed.value)

// separately, and optionally, look at what went wrong
if parsed.errors is not empty:
    logDiagnostics(parsed.errors)
```

**Pros of the both/and shape:** callers who do not care about the error path (logging, a debug view, best-effort rendering) do not need to branch at all — this is the "codepaths collapse" payoff the whole article is built around. Especially good for things like parsers or batch validators that can produce a partial result alongside error messages.
**Cons:** it only works when a partial/default value is a coherent thing to return alongside an error (ties back to technique 2 — you need a meaningful empty/default value for that type). If failure genuinely means "there is no value, full stop" — parsing a number from garbage input, a failed network request with nothing to show — fabricating a value does not make sense, and a shape that forces the caller to check before proceeding is the honest choice.

**How to decide, in any language:** use the either/or shape for functions where "no value" is genuinely possible and there is no sensible default to fall back on — let the type system or a required check catch every call site that needs to handle that. Reach for the both/and shape specifically for functions that can *partially* succeed (batch operations, parsers, validators collecting multiple problems), where forcing every caller through a false all-or-nothing branch would itself be the thing generating unnecessary codepaths. Treat this as a per-function decision, not a codebase-wide rule — mixing both is fine as long as each function's shape matches whether "no value" is actually possible for it.

### 5. Accumulate error info in a side-channel log instead of a single mutable slot

The source article's critique of C's `errno` — a single global slot that only holds the *most recent* error and loses where it came from — maps onto any pattern with a single "last error" field on an object or module. Prefer an append-only log when a caller might want to inspect everything that happened, not just the last thing:

```
DiagnosticLog:
    entries = []

    function record(message, source):
        entries.append({message, source, timestamp: now()})

    function all():
        return entries
```

Pass a diagnostics log (or return one, per technique 4) through a batch of operations instead of stopping at the first problem or overwriting a single "last error" field. This is most valuable for anything processing a collection — validating many form fields, running a build step across many files — where the point of "error handling" is to *keep going* and report everything at the end, not to stop at the first failure.

## Applying this to a review or a new design

When asked to review error handling or design a new function's signature, walk through in this order, regardless of language:

1. **Can the failure be designed away?** (technique 1 or 2 — is there a valid empty/default value that makes the "error" case just a normal case?)
2. **If the failure is real and unavoidable, where's the earliest point it can be discovered?** (technique 3 — push validation/allocation up front)
3. **Does this function's failure mode allow a partial/default result, or is it all-or-nothing?** Partial → both/and shape (technique 4). All-or-nothing → either/or shape (also technique 4).
4. **Is this a single operation or a batch?** Batch → consider a diagnostics log (technique 5) instead of stopping at the first error.

Present findings as options with tradeoffs rather than a single prescribed rewrite, then translate whichever shape fits into the idioms of whatever language is actually in use — which of these fits depends on whether "no value" is truly possible for that function, which only the person designing the API can say for sure.
