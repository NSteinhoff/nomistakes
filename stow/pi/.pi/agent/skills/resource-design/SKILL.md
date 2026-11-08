---
name: resource-design
description: >
  Data layout, ownership, lifetimes, allocation, identity, capacity,
  concurrency, and resource cleanup. Use when a task introduces or
  materially changes these contracts, or diagnoses defects in them.
  Do not activate for routine code changes that preserve established
  storage and resource contracts.
---

# Resource Design

## Scope

Apply this skill to design, implementation, or diagnosis that changes or examines resource contracts. A new API alone does not require it. Keep established resource models intact for unrelated local changes.

Use `data-contracts` for invariants, absence, defaults, and failure representation. Use `module-design` for responsibilities and dependency boundaries. This skill owns storage choices and the lifetime of state and resources.

Read `references/storage-patterns.md` when the task requires a choice among containers, allocation strategies, or identity models.

## Priorities

- Put correctness, security, memory safety, and explicit contracts first.
- Prefer fewer independent states and clear ownership over fewer lines or branches.
- Make object lifetimes, reference validity, and cleanup apparent from the API.
- Choose the simplest layout that supports actual access patterns and limits.
- Estimate capacity and performance during design. Require evidence before additional complexity.
- Use established containers and allocators when they provide a simpler correct solution. Do not impose static allocation or zero dependencies without an explicit project constraint.

## Discover constraints

1. Identify the operation, observable effects, platform, concurrency model, and throughput or latency requirements.
2. Establish realistic counts, sizes, and capacity limits. Identify the behavior at exhaustion.
3. Identify who creates, reads, mutates, transfers, and destroys each object and external resource.
4. Identify which references escape and what can invalidate them: growth, movement, deletion, reuse, reset, cancellation, or concurrent access.
5. Map access patterns and the state that must persist. Derive inexpensive temporary state rather than duplicate it.
6. Resolve missing requirements that affect correctness before implementation. Label performance estimates as hypotheses.

## Design rules

- Group allocations by lifetime only when their reset points truly match.
- Keep borrowed references within the owner's lifetime. Do not return references into scratch storage.
- Define invalidation explicitly. Pointers into a reallocatable array do not remain valid after movement.
- Separate identity from location when objects move or slots are reused. An index or generation handle does not provide synchronization or safe reclamation.
- Release file handles, sockets, locks, GPU resources, and other external resources explicitly. An arena reset only reclaims memory.
- Define ownership transfer and cleanup after partial initialization, failed acquisition, cancellation, and repeated calls.
- Enforce bounds, integer overflow checks, alignment, and platform limits at the relevant resource boundary.
- Define synchronization and the point at which another reader can no longer access an object before reclamation or reset.
- Keep one authoritative representation. If an auxiliary index is necessary, maintain it across every mutation path.
- Use assertions and sanitizers according to the language and project. Never put required side effects inside assertions.

## Proposal and verification

For a substantial design change, state the layout, ownership, invalidation rules, capacities, failure cleanup, concurrency assumptions, and principal tradeoff before code. For a narrow defect, use these as an internal checklist rather than a formal report. Implement only after authorization.

Test the relevant transitions: empty, one, many, growth, exhaustion, deletion, reuse, reset, failed acquisition, and cleanup. Test stale references and concurrent access when applicable. Use a minimal reproducer for a defect and add a regression test around the violated contract. Compare optimized indexes with a simple oracle where feasible.
