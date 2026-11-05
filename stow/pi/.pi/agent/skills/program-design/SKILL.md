---
name: simple-systems-program-design
description: Use only when the user explicitly asks to design a new system, subsystem, or API. Guide data layout, ownership, lifetimes, and failure contracts. Do not load for routine implementation, code review, debugging, or C code alone.
---

# Simple Systems Program Design

## Purpose

Use this skill only when the user explicitly asks to design a new system, subsystem, or API. Do not load it for routine implementation, code review, debugging, or C code alone. Minimize _meaningful states, ownership ambiguity, failure opportunities, and maintenance cost_ within the design's correctness, performance, and platform constraints. Do not minimize line count, branches, allocations, or dependencies at the expense of those goals.

This skill synthesizes articles from **Our Machinery** and **Digital Grove** (links at the end). It is an operational interpretation, not a verbatim restatement or a substitute for the source articles.

## Priority order

1. **Correctness and explicit contracts**, including security, memory safety, concurrency, and honest error reporting.
2. **Understandability and low state-space complexity**: fewer invariants and independent cases.
3. **Predictable lifetimes and ownership**, including failure cleanup.
4. **Appropriate simple data layout and containers** based on actual usage.
5. **Measured performance**. Optimize only demonstrated costs.
6. **Small APIs and minimal dependencies**, without reinventing a well-tested component unnecessarily.

### Non-negotiable guardrails

- Never silently turn a failure into a successful result merely to remove an `if` statement.
- Never use a nil object as a writable shared destination for accidental mutations.
- Never assume all-bits-zero is a valid representation for **every** type or external ABI. In ISO C, `{0}` gives language-defined zero initialization; `memset` and freshly committed zeroed pages are not universal substitutes for every pointer/floating representation in strictly portable C.
- Never rely on a pointer into a reallocating array remaining valid. Neither an index nor a generation handle is automatically thread-safe.
- Never treat arena clearing as object-by-object destructors: release file handles, locks, sockets, GPU resources, and other non-memory resources explicitly.
- Always handle allocator exhaustion, integer overflow, alignment, bounds, and platform limits according to the program's contract.
- Do not generalize examples from games/engines to every environment; adjust for safety-critical, embedded, untrusted-input, real-time, and long-running services.

## Agent workflow

### 1. Discover constraints before coding

Examine existing project style, C dialect, build rules, platform and dependencies. Ask or infer from code:

- What is the **real operation**? What inputs, outputs, observable effects, failure modes, and throughput/latency limits exist?
- What are the maximum counts and sizes? Can explicit bounded capacity solve the problem?
- Who creates, reads, mutates, and destroys each object? Which references may outlive their target?
- What invalidation is allowed when arrays grow, elements move, or arenas reset?
- Is the code single-threaded, externally synchronized, lock-free, or used across threads?
- Is `0` a meaningful, safe empty value for the type? Does the caller need to distinguish _absent_, _empty_, _invalid_, and _failed_?
- Which lookups dominate? Which mutations are frequent? What is the actual data volume?

If requirements are missing, record assumptions rather than inventing complex generality.

### 2. Present a small design proposal

Before implementing nontrivial functionality, briefly specify:

1. **State/invariants** — including zero/empty state, valid ID space, allowed transitions.
2. **Data layout** — base storage, optional indexes, stable/unstable addresses.
3. **Ownership and lifetimes** — stack, caller arena, region, pool, explicit heap, resource cleanup.
4. **API and failures** — what every operation returns and which failures must propagate.
5. **Complexity and capacity** — approximate memory and time costs; explicit bounds.
6. **Tests** — empty, first/last, deletion/reuse, capacity, allocation failure, concurrency if relevant.

Prefer a small concrete implementation over a framework of abstract policies.

### 3. Implement and verify

Implement the smallest version that satisfies observed requirements. Document invariant-bearing boundaries. Run tests with assertions and sanitizers where available. Verify state transitions and lifetime resets. Profile before replacing a simple array with a complicated structure.

## Design principles and patterns

### A. Make zero a useful default (ZII / zero-is-initialization)

**Rule:** Where semantics permit, make a newly zero-initialized value represent an empty, harmless, usable state. This reduces constructor work and partial initialization hazards.

Useful conventions:

- `0` as _no index / invalid handle_, with real items numbered from `1`.
- Enum zero means `NONE` or `UNKNOWN`, not an arbitrary active option.
- `{0}` initializes an empty struct with null pointers and counts/capacities of zero.
- The empty container should ideally be a valid input for inspect, clear, append, and destroy operations.
- When legitimate zero is valid data (e.g. numeric value 0 or index 0), add an explicit presence signal or change representation; never conflate them.

```c
typedef enum { STATE_NONE = 0, STATE_READY, STATE_FAILED } State;

typedef struct {
    unsigned char *data;
    size_t count;
    size_t capacity;
} Buffer;

Buffer b = {0}; /* empty, not yet allocated */
```

**Decision:** Reserve index zero if it eliminates invalid-index special cases **and** you can afford one slot and clearly define zero's semantics. If external APIs use zero as a real ID, adapt at the boundary rather than hiding collisions.

**Test:** `{0}` value is safe to inspect and destroy; repeated destroy is defined if promised; partial initialization and failed allocation leave predictable state.

### B. Nil objects, null objects, and safe defaults

**Rule:** A real benign object can often replace repeated `NULL` checks: for reads, walking a tree, or asking for an optional property's default.

- A self-referential immutable nil node can replace missing children in some tree/list traversals.
- A zero-backed dummy array slot can return safe default fields for absent IDs.
- Provide an explicit predicate whenever users must distinguish missing from present-but-zero.
- Default-return behavior should be deliberate: a missing asset yielding an empty string may be harmless in UI rendering but dangerous in authorization, accounting, or persistence.

**Avoid:** writing through nil objects, hiding a failure that must stop the transaction, allowing nil to participate in real identity comparisons, or assuming sentinel memory is initialized correctly before access.

### C. Collapse _effective_ code paths with invariants

**Rule:** Complexity comes from independent possible states and their interactions, not just visible `if` counts. Design APIs so common and empty cases follow the same reliable path.

- Prefer an invariant that holds for every valid object over scattered conditionals.
- Avoid caches, mirrored fields, and duplicate ownership unless measured benefits justify synchronization burden.
- Prefer explicit phases and resets over complicated partially initialized states.
- Keep state local where practical; externally shared mutable state adds temporal dependencies.
- Do not delete checks merely to score fewer branches: validate untrusted inputs and preserve safety.

**Review question:** What facts must a maintainer know at this line? Can the API guarantee them instead of forcing every caller to rediscover them?

### D. Error handling: prevent where possible, report where necessary

Distinguish failures by effect:

| Situation                                                   | Default policy                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Impossible internal state / violated invariant              | Assertion in development; defensible release behavior for exposed surfaces              |
| Expected absence (lookup miss)                              | Empty/nil result **when** absence is normal and distinguishable if needed               |
| Recoverable operational failure (I/O, OOM, malformed input) | Return explicit status/result; preserve or roll back valid state; diagnostics alongside |
| Fatal unrecoverable failure                                 | Fail clearly at a documented boundary, with useful diagnostics                          |
| Warning / partial success                                   | Return meaningful usable data **and** diagnostics if caller needs both                  |

A diagnostic side channel (e.g. a structured per-thread log) can collect context without distorting every intermediate return type. It must **not** be the only signal for a failure requiring immediate caller action. Define who clears and consumes that log; include provenance and avoid stale errors.

Suggested C pattern:

```c
typedef enum { RESULT_OK = 0, RESULT_OOM, RESULT_INVALID } Result;

/* Report whether an operation succeeded; only commit count after success. */
Result buffer_reserve(Buffer *b, size_t needed);
```

**Test:** Fail the Nth allocation, test zero-length input, invalid IDs, malformed data, partial writes, repeated calls, rollback, and diagnostic provenance.

### E. Choose memory management from lifetimes, not habit

**Rule:** Group allocations that die together. The lifetime model should be apparent from API parameters and ownership rules.

Prefer, roughly:

1. **Stack/local** for small, bounded, short-lived objects.
2. **Fixed buffer** for realistically bounded workloads.
3. **Arena/region** for many allocations sharing one lifetime; expose `Arena *` to the caller when output ownership matters.
4. **Pool + free list** for same-size objects with independent reuse and a common backing region.
5. **General-purpose heap** when objects genuinely have arbitrary sizes/lifetimes or when simpler than building a specialized allocator.

Do not use a single arena for allocations that must outlive its reset. Do not return pointers into scratch memory. Do not reset a region while another thread can still read its contents.

**Typical arena ownership:** persistent/project arena for long-lived data; per-operation arena for request results; temporary scratch arena for intermediates; per-frame arena for frame-local data. State the reset point and borrowed-pointer rules. Temporary arenas must not alias output arenas when doing a reset.

**Arena implementation checklist:** alignment calculation, size overflow, growth strategy, reserve/commit limits, failure result, multi-thread contract, reset semantics, memory usage observability, virtual memory platform compatibility.

**Note:** A bump allocation is cheap; it does not imply freed resources, destructors, or safe use after a reset. `malloc/free` is a legitimate default when it produces a simpler correct solution at the needed scale.

### F. Start with arrays and minimal containers

**Rule:** Store bulk homogeneous data in arrays unless the workload proves otherwise. Arrays offer simple iteration and compact layout. Add secondary structures only for specific access patterns.

Container decision table:

| Need                                      | First candidate                   | Tradeoff                                 |
| ----------------------------------------- | --------------------------------- | ---------------------------------------- |
| Known small maximum                       | Fixed array + count               | Must enforce cap                         |
| Growing sequence                          | Geometrically growing array       | Reallocation may move items              |
| Dense iteration / cheap arbitrary removal | Packed array, swap-remove         | Order and indices change                 |
| Stable IDs while recycling slots          | Slot array + free list            | Holes/metadata; validation required      |
| Stable external references across reuse   | Index + generation                | Generation wraparound must be considered |
| Key-based lookup                          | Array + hash index                | Keep index synchronized on mutations     |
| Many small variable-length child arrays   | Pooled/chunked storage or offsets | More management complexity; benchmark    |
| Frequent splice/reorder of stable nodes   | Intrusive list                    | Pointer chasing, worse locality          |

Avoid introducing a generic container abstraction if a few simple operations solve the actual problem. Avoid copying the entire interface of a language's standard containers without a concrete need.

### G. Index-zero sentinels and circular linked lists

**Rule:** A circular doubly linked list with a dummy head removes the `NULL`/first/last special cases for insertion and removal. A separate dummy head can manage reusable nodes.

Example with **array indices** (robust against array base-pointer relocation):

```c
typedef struct { uint32_t prev, next; } Link;

/* nodes[0] is the active list head; empty = self-linked. */
/* nodes[1] may be the free-list head; slots 0,1 reserved. */
static void link_init(Link *nodes, uint32_t head) {
    nodes[head].prev = head;
    nodes[head].next = head;
}

static void link_insert_after(Link *nodes, uint32_t at, uint32_t n) {
    uint32_t following = nodes[at].next;
    nodes[n].prev = at;
    nodes[n].next = following;
    nodes[following].prev = n;
    nodes[at].next = n;
}

static void link_unlink(Link *nodes, uint32_t n) {
    uint32_t p = nodes[n].prev, q = nodes[n].next;
    nodes[p].next = q;
    nodes[q].prev = p;
}
```

**Invariants:** Every live node is in exactly one expected list; `next[prev[n]] == n` and `prev[next[n]] == n`; empty head links to itself; reserved heads are never returned as user objects. A node is removed before being inserted in a different list. Callers validate indices and must not reuse a removed node via a stale handle. These functions assume valid indices, adequate storage, and external synchronization.

**Use when:** actual splicing/reordering matters, or free-list bookkeeping benefits from uniform list algorithms. **Do not use** linked lists for bulk iteration by default; arrays generally offer better locality and simpler storage.

### H. Stable references and generational handles

**Rule:** Separate identity from location whenever elements can move or slots can be reused. Example conceptual handle: `{slot, generation}`; reserve `{0, 0}` as invalid if suitable.

- Validate slot bounds, active state, and generation before dereference.
- Increment generation when releasing/recycling; consider wraparound and use sufficiently wide counters.
- A recycled slot with a newer generation must reject an older handle.
- If packed storage moves objects, maintain an ID-to-location table; do not expose raw array indices as permanent identity.
- A handle is an **identity/liveness check**, not concurrency synchronization or safe reclamation on its own.

**Test:** allocate, resolve, release, reuse same slot, reject old handle; grow backing storage; remove first/middle/last; test generation boundary strategy.

### I. Secondary indices: pay for lookup speed deliberately

**Rule:** Keep a simple primary array, then add an index to answer a defined query quickly. The index may map keys to IDs/slots, or represent membership in a subset.

- Define index maintenance for insert, delete, key mutation, slot movement, and bulk reset.
- Decide whether hash collisions require key equality verification. A 64-bit hash alone is not a proof of string equality.
- Keep a slow linear-scan implementation/test as an oracle during development where feasible.
- Avoid storing multiple independently mutable representations of the same truth without enforced synchronization.
- Benchmark scans versus indexes at representative sizes; a linear scan is often fast enough for small datasets.

### J. Variable-sized elements, chunking, and virtual memory

**Rule:** For an array of objects that own strings or variable-length subarrays, choose storage by mutation and lifetime requirements: offsets into an arena, separate allocations, size-class chunks, or page-backed stable storage.

- Chunking/pools reduce small-allocation overhead and can support reuse, but introduce fragmentation inside chunks and metadata.
- Reserving virtual address space separately from committing pages can keep addresses stable on suitable 64-bit platforms. This is a platform-specific optimization, **not** a promise that huge arrays require no resources or can grow indefinitely.
- Distinguish virtual reservation, committed memory, resident memory, and actual initialized elements. Enforce capacity and integer bounds.
- Prefer a conventional growing array until stable address requirements and measurements justify a more complex strategy.

### K. Immediate-mode and derivable state

**Rule:** When state can be cheaply reconstructed from authoritative inputs every iteration (notably UI), consider deriving it instead of storing and synchronizing a duplicate retained representation.

- Keep persistent only information that truly spans iterations (e.g. interaction state or animation parameters).
- Use stable identifiers for elements whose interaction state persists.
- Do not force immediate mode onto domains where reconstructing data is expensive or where persistent models are inherently required.

### L. Debugging and design feedback

**Rule:** Make the behavior reproducible, inspect the actual state transition, compare it to the invariant, and fix the model—not just the symptom.

1. Make a minimal reproducer.
2. Assert invariants at structure boundaries.
3. Inspect with debugger/traces around the first divergence.
4. Classify: invalid lifetime, stale handle, out-of-bounds, bad ownership, stale index, race, unchecked result, broken assumption.
5. Add regression test and simplify the invariant/API if a whole class of mistakes can be ruled out.

In C, use the available compiler warnings, ASan/UBSan, leak checks, and thread analysis where appropriate. Test both debug and release behavior; never depend on side effects inside `assert`.

## Design review rubric

For each proposed component, answer **yes/no** and explain exceptions:

- [ ] Is empty/zero initialization safe and documented?
- [ ] Do absent, zero-valued, invalid, and failed states have unambiguous semantics?
- [ ] Does the API reduce independent states rather than hide them?
- [ ] Are object ownership, allocation lifetime, pointer validity, and reset points explicit?
- [ ] Are failure and cleanup contracts clear, including OOM and partial progress?
- [ ] Are capacities, alignment, overflow, and bounds enforced?
- [ ] Is the primary data layout the simplest that supports actual access patterns?
- [ ] Can deleted/reused IDs or moved elements invalidate external references safely?
- [ ] Are auxiliary indexes updated for _every_ mutation path?
- [ ] Are sentinels immutable/isolated where needed and list invariants testable?
- [ ] Are concurrency assumptions explicit?
- [ ] Do tests cover empty, one, many, deletion, reuse, growth, failure, and reset?
- [ ] Was added abstraction/indirection/dependency justified by a concrete benefit?
- [ ] Are performance claims measured or clearly identified as hypotheses?

## Output format for the coding agent

When this skill is invoked for a design or substantial refactor, give a compact report **before code**:

```text
Problem and constraints:
Chosen representation and invariants:
Zero/nil/absence semantics:
Lifetime and ownership model:
Operations and failure contracts:
Tradeoffs and rejected alternatives:
Validation plan:
```

Then implement using repository conventions, show tests and actual results, and call out unresolved risks. For narrow bug fixes, use this as a silent internal checklist rather than burdening the user with a formal design document.

## Anti-patterns to challenge

- A class hierarchy or generic framework where two structs and three functions suffice.
- Per-object heap allocation when objects naturally die as one group.
- Pointer-based object identity when deletion, compaction, or growth can invalidate it.
- A `NULL` check at every call site instead of one documented safe-default contract **when** semantics permit.
- An always-success API that silently masks real corruption, authorization failure, or OOM.
- A large collection of mirrors/caches that all need synchronization for small gains.
- A hash table for ten elements without evidence a scan is insufficient.
- A linked list for repeated sequential traversal of bulk data.
- Premature virtual-memory tricks when a fixed array or geometric growth works.
- Custom allocators or macros introduced for novelty instead of real constraints.

## Source map and reading order

These links are external source material. The guidance above combines the authors' ideas with additional safety qualifications and engineering practice.

1. [Defaulting to Zero — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/defaulting-to-zero/index.html) — zero/nil defaults, index 0, enum defaults.
2. [The Easiest Way To Handle Errors Is To Not Have Them — Digital Grove](https://www.dgtlgrove.com/p/the-easiest-way-to-handle-errors) — unified paths, nil structs, error information.
3. [The Codepath Combinatoric Explosion — Digital Grove](https://www.dgtlgrove.com/p/the-codepath-combinatoric-explosion) — state-space and effective code paths.
4. [Minimalist Container Library in C (Part 1) — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/minimalist-container-library-in-c-part-1/index.html) — minimal containers, zero-friendly collections.
5. [Minimalist Container Library in C (Part 2) — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/minimalist-container-library-in-c-part-2/index.html) — bounded arrays, circular lists, dummy and free-list nodes.
6. [In Defense of Linked Lists — Digital Grove](https://www.dgtlgrove.com/p/in-defense-of-linked-lists) — intrusive lists and composition.
7. [Data Structures Part 1: Bulk Data — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/data-structures-part-1-bulk-data/index.html) — arrays, free lists, weak references, generations.
8. [Data Structures Part 2: Indices — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/data-structures-part-2-indices/index.html) — primary arrays and secondary indices.
9. [Data Structures Part 3: Arrays of Arrays — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/data-structures-part-3-arrays-of-arrays/index.html) — variable-size data, allocation strategies.
10. [Untangling Lifetimes: The Arena Allocator — Digital Grove](https://www.dgtlgrove.com/p/untangling-lifetimes-the-arena-allocator) — grouped lifetimes, arenas, scratch, pools.
11. [Virtual Memory Tricks — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/virtual-memory-tricks/index.html) — virtual address reservation and stable layouts.
12. [Enter The Arena (Talk) — Digital Grove](https://www.dgtlgrove.com/p/enter-the-arena-talk) — arena overview (talk).
13. [Codebase Walkthrough: Memory Management — Digital Grove](https://www.dgtlgrove.com/p/intro-to-the-codebase-part-iii-memory) — subscriber-only walkthrough; not used as a substantive primary source here.
14. [Codebase Walkthrough: From-Scratch Data Structures — Digital Grove](https://www.dgtlgrove.com/p/from-scratch-data-structures-in-the) — subscriber-only walkthrough; not used as a substantive primary source here.
15. [A Taxonomy of Bugs — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/a-taxonomy-of-bugs/index.html) — reproducing/debugging failure modes.
16. [UI, Part 2: Every Single Frame (IMGUI) — Digital Grove](https://www.dgtlgrove.com/p/ui-part-2-build-it-every-frame-immediate) — immediate-mode UI and derived state.
