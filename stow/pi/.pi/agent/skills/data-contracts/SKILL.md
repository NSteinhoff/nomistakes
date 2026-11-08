---
name: data-contracts
description: >
  Data invariants, input boundaries, absence semantics, and failure
  contracts. Use for every implementation or code review task.
  Preserve guarantees through representations and controlled
  construction. Apply within the requested scope without unrelated
  redesign.
---

# Data Contracts

## Scope

Apply the core rules to the changed or reviewed code, in the language's idioms. Preserve established contracts unless the task requires a change. Do not turn a local patch into an API redesign or a formal design report.

Read additional guidance only when the task involves its subject:

- For external inputs, configuration, deserialization, or refined domain values, read `references/input-boundaries.md`.
- For fallible operations, absence, defaults, partial results, or batch diagnostics, read `references/failure-contracts.md`.

Use `module-design` when responsibilities or module boundaries change. Use `resource-design` when storage, ownership, lifetimes, capacity, identity, or concurrency contracts change.

## Core rules

- Start from the consumer's required invariants. Choose the simplest representation that preserves them through ordinary use.
- Parse untrusted values into usable representations at the boundary. Return the refined value rather than a boolean that discards the proof.
- Keep ordinary business logic on the trusted side. Remove a downstream check only when controlled construction or the representation guarantees its condition.
- Distinguish expected absence, valid empty data, invalid input, and operational failure. Do not merge states that require different caller behavior.
- Use an empty or default value only when it preserves the operation's meaning. Never fabricate success to remove a branch or expose a shared nil object as a writable destination.
- If no valid result exists, preserve an explicit failure signal. Use data plus diagnostics only when the data satisfies its declared contract.
- Keep incomplete output distinct from a trusted domain value. A partial result is not proof that required invariants hold.
- Reject invalid input before dependent business effects. Discover resource failures early where feasible, but keep checks for live external state at the point of use.
- Preserve or restore valid state after a failed operation. Do not assume an early check prevents later I/O, authorization, allocation, or concurrency failures.
- Keep one source of truth. Derive redundant state when practical, or encapsulate its synchronization.
- Minimize independent meaningful states, not visible branches. Use proportional rigor rather than a wrapper or type hierarchy for every primitive.

## Local workflow

1. Identify the invariant and the point that establishes it.
2. Check that the representation retains the guarantee and that mutation cannot silently invalidate it.
3. Define the caller's behavior for absence, invalid input, partial success, and operational failure as applicable.
4. Apply the smallest change that preserves those contracts.
5. Test valid and invalid paths, relevant boundaries, and failed operations. Verify that rejected input causes no dependent business effects and that failures leave valid state.

During review, report only reachable defects with a concrete trigger and consequence. Do not report a missing check when construction already guarantees its condition.

## Sources

- [Parse, don't validate — Alexis King](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)
- [The Easiest Way To Handle Errors Is To Not Have Them — Digital Grove](https://www.dgtlgrove.com/p/the-easiest-way-to-handle-errors)
- [The Codepath Combinatoric Explosion — Digital Grove](https://www.dgtlgrove.com/p/the-codepath-combinatoric-explosion)
- [Defaulting to Zero — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/defaulting-to-zero/index.html)

These rules adapt the source ideas with explicit safety and failure contracts. They do not prescribe one error mechanism for every language or operation.
