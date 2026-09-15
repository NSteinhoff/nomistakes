---
name: tiger-style
description: >
  TigerStyle coding conventions for safety, performance, and developer
  experience. Use before you review, design, or edit code where these
  disciplines apply — assertions, static allocation, bounded loops, naming,
  off-by-one hazards, and back-of-the-envelope performance. Language-agnostic.
  Examples are C.
---

# TigerStyle

Style is design: how the code works, not how it looks. Readability is table
stakes, not the goal.

## Design Goals

- Optimize for three goals, in this order: **safety, performance, developer
  experience.** All three matter. Good style advances all three.
- Simplicity is the super-idea that solves the goals simultaneously. It is the
  hardest revision, not the first attempt. Spend the mental energy upfront: an
  hour of design saves weeks in production.
- **Zero technical debt.** Do it right the first time. Code, like steel, is
  cheaper to change while hot. A showstopper found is a showstopper solved. Do
  not let latency spikes or exponential-complexity algorithms slip through.

## Safety

- Use **only simple, explicit control flow**. **Do not use recursion**, so that
  every bounded execution stays bounded.
- Use **a minimum of excellent abstractions**, and only when they make the best
  sense of the domain. Abstractions are never zero cost and risk leaking.
- **Put a limit on everything.** Every loop and every queue must have a fixed
  upper bound to prevent infinite loops and tail-latency spikes (fail-fast).
  Where a loop cannot terminate (an event loop), assert that.
- Use **explicitly-sized types** (`uint32_t`) for domain data that is persisted,
  wire-encoded, or holds fixed-width counts and offsets, not architecture-specific
  types whose width varies by platform. `size_t` remains appropriate for
  in-memory buffer sizes and indices.
- **Statically allocate all memory at startup.** Allocate no memory dynamically
  after initialization. This avoids unpredictable latency and use-after-free,
  and forces you to consider all memory usage patterns upfront.
- Declare variables at the **smallest possible scope**, and minimize the number
  of variables in scope, to reduce misuse.
- **Hard limit of 70 lines per function.** A function must fit on a screen.
  - Good function shape is the inverse of an hourglass: few parameters, a simple
    return type, meaty logic between the braces.
  - **Centralize control flow.** Keep switch/if statements in the parent
    function. Move non-branchy fragments to helpers. Push `if`s up and `for`s
    down.
  - **Centralize state manipulation.** Keep state in the parent's locals. Use
    helpers to compute what changes, not to apply it. Keep leaf functions pure.
- Enable and heed **all compiler warnings at the strictest setting** from day
  one.
- **Do not react directly to external events.** Run at your own pace. This keeps
  control flow yours, enables batching over context-switching, and bounds work
  per time period.
- **Split compound conditions into simple conditions** using nested `if/else`.
  Split `else if` chains into `else { if { } }` trees. Consider whether each
  `if` needs a matching `else` to handle or assert the negative space.
- **State invariants positively.** Negations are hard. Prefer the form that
  reads naturally:
  ```c
  if (index < count) {
      // The invariant holds.
  } else {
      // The invariant does not hold.
  }
  ```
  over the harder `if (index >= count)`.
- **Handle all errors.** Most catastrophic failures come from incorrect handling
  of non-fatal errors that were explicitly signaled. Test the error paths.
- **Always motivate, always say why.** Explaining the rationale increases
  understanding, compliance, and shares the criteria to evaluate the decision.
- **Pass options explicitly at the call site**, never rely on library defaults.
  This avoids latent, catastrophic bugs if a default ever changes.

## Assertions

Assertions detect programmer errors, which are unexpected. Operating errors are
expected and must be handled. The only correct response to corrupt code is to
crash. Assertions downgrade catastrophic correctness bugs into liveness bugs and
multiply the bug-finding power of fuzzing.

- **Assert all function arguments, return values, pre/postconditions, and
  invariants.** A function must not operate blindly on unchecked data. Average a
  minimum of **two assertions per function**.
- **Pair assertions.** For every property, find at least two code paths to
  assert it. Assert data validity right before a write to disk, and again
  immediately after the read.
- Use a blatantly true assertion instead of a comment where the condition is
  critical and surprising.
- **Split compound assertions:** prefer `assert(a); assert(b);` over
  `assert(a && b);`. It reads simpler and pinpoints the failure.
- Use single-line `if` to assert an implication: `if (a) assert(b);`.
- **Assert relationships of compile-time constants** to document and enforce
  subtle invariants and type sizes before the program even runs.
- **Assert the positive space you expect AND the negative space you do not.**
  Bugs hide where data crosses the valid/invalid boundary. For the same reason,
  **test exhaustively** with valid data, invalid data, and data as it turns
  invalid.
- Assertions are a safety net, not a substitute for understanding. A fuzzer
  proves the presence of bugs, not their absence. Therefore:
  1. Build a precise mental model first.
  2. Encode your understanding as assertions.
  3. Write code and comments that justify the model to your reviewer.
  4. Use the fuzzer as the final line of defense.

## Performance

- **Solve performance in the design phase**, before you can measure or profile.
  That is where the 1000x wins live and where fixes are cheapest. Have
  mechanical sympathy. Work with the grain.
- **Sketch on the back of an envelope** across the four resources (network,
  disk, memory, CPU) and their two characteristics (bandwidth, latency).
  Sketches are cheap. Use them to land within 90% of the maximum.
- **Optimize the slowest resource first** (network, disk, memory, CPU), after
  weighting by frequency of use. A frequent cache miss can cost as much as a
  rare disk fsync.
- **Separate the control plane from the data plane.** Batching across this
  boundary buys high assertion safety without losing performance.
- **Amortize costs by batching** network, disk, memory, and CPU accesses.
- Let the CPU sprint in a straight line. Be predictable. Give it large chunks of
  work. This comes back to batching.
- **Be explicit. Minimize dependence on the compiler.** Extract hot loops into
  standalone functions taking primitive arguments, not a `self`/receiver. The
  compiler need not prove it can cache fields in registers, and a human spots
  redundant computation faster.

## Developer Experience

### Naming

- **Get the nouns and verbs just right.** Great names capture what a thing is or
  does and show you understand the domain. Take the time.
- **Do not abbreviate**, except established short domain names (`len`, `cap`,
  `size`, `count`) and a primitive integer used as an argument to a sort or
  matrix calculation. Use long-form flags in scripts (`--force`, not `-f`).
  Single letters are for interactive use.
- Use proper capitalization for acronyms (`VSRState`, not `VsrState`).
- **Add units and qualifiers last, sorted by descending significance.** Prefer
  `latency_ms_max` over `max_latency_ms`, so `latency_ms_min` lines up beside it
  and all latency variables group together.
- **Infuse names with meaning.** `allocator` is boring but fine. `gpa` and
  `arena` tell the reader whether they own cleanup.
- **Give related names equal length** so they line up in source. `source` and
  `target` beat `src` and `dest`, because `source_offset` and `target_offset`
  then align in slices and calculations.
- **Prefix a helper with its caller** to show call history: `read_sector` and
  `read_sector_callback`.
- **Callbacks go last** in the parameter list, mirroring that they are invoked
  last.
- **Order for top-down reading.** Put important things near the top. `main` goes
  first. For a struct, order is fields, then nested types, then methods. Promote
  a complex nested type to a top-level type. When no single order is right,
  sort alphabetically (big-endian naming helps).
- **Do not overload names** with context-dependent meanings. Reusing consensus
  terminology for an unrelated feature causes confusion.
- **Prefer nouns to participles.** `replica.pipeline` reads directly in a
  document. `replica.preparing` needs rephrasing. Nouns compose for derived
  identifiers (`config.pipeline_max`).
- **Group mix-up-prone parameters into a struct** with named fields. Two
  same-typed integer parameters must not sit side by side unnamed. Thread
  singleton dependencies (allocator, tracer) through constructors positionally,
  most general to most specific.
- **Say why.** Code is not documentation. Comment why you wrote it this way.
- Comments are prose: a space after the slash, a capital letter, and a full stop
  (or colon if something follows). Trailing end-of-line comments can be phrases
  without punctuation.

### Cache Invalidation

- **Do not duplicate variables or take aliases.** This reduces state getting out
  of sync.
- If a by-value argument larger than 16 bytes must not be copied, pass it as a
  pointer-to-const. This catches accidental stack copies at the call site.
- **Construct large structs in-place via an out-pointer** during init. This
  assumes pointer stability, removes intermediate copy-moves, and avoids stack
  growth. In-place init is viral: if one field is in-place, the whole container
  must be.
  ```c
  // Prefer: initialize through an out-pointer.
  void large_struct_init(struct LargeStruct *out) {
      *out = (struct LargeStruct){
          // in-place initialization
      };
  }

  // Over: returning a fully-formed value that must be moved.
  struct LargeStruct large_struct_init(void);
  ```
- **Shrink the scope** to minimize variables at play and the chance of using the
  wrong one.
- **Compute and check variables close to their use.** Do not introduce a
  variable before it is needed or leave it around after. This reduces the
  place-of-check to place-of-use gap (POCPOU), a cousin of TOCTOU. Most bugs are
  a semantic gap caused by distance in time or space.
- **Use simpler signatures and return types** to cut dimensionality at the call
  site, which is viral through the call chain. As a return type: `void` beats
  `bool`, `bool` beats an integer, an integer beats a nullable pointer, and that
  beats an error-code-plus-out-parameter.
- **Run functions to completion without suspending**, so precondition assertions
  hold throughout the function's lifetime.
- **Guard against buffer bleeds.** A buffer underflow, where a buffer is not
  fully used and padding is not zeroed, can leak sensitive data and violate
  determinism.
- **Group resource allocation and deallocation with newlines** — before the
  allocation and after its matching cleanup — to make leaks easier to spot.

### Off-By-One Errors

- **Treat `index`, `count`, and `size` as distinct types** with explicit
  conversion rules. `index` is 0-based. `count` is 1-based, so add one to
  convert. Multiply a `count` by the unit to get a `size`. This is why units in
  names matter.
- **Show your intent with division.** Make it explicit whether you divide
  exactly, floor, or ceil, so the reader knows you thought through the rounding.

### Formatting

- Run the language formatter.
- Use **at least 4 spaces** of indentation. It is more obvious at a distance.
- **Hard limit lines to 100 columns**, without exception. Nothing hidden behind
  a horizontal scrollbar. Set a column ruler. To wrap a signature, call, or
  data structure, add a trailing comma and let the formatter do the rest. The
  100 is physical: two copies of the code side by side on a screen.
- **Brace every `if`** unless it fits on a single line. Defense in depth against
  "goto fail;" bugs.

### Dependencies

- **Zero dependencies** apart from the language toolchain. Dependencies invite
  supply-chain attacks, safety and performance risk, and slow installs. For
  foundational infrastructure the cost amplifies up the stack.

### Tooling

- **Keep a small, standardized toolbox.** Tools have costs. A specialized
  instrument carries a dedicated manual. Invest in your primary toolchain so you
  can tackle new problems with minimal accidental complexity.
- Standardizing reduces dimensionality as the team grows. Slower for one person
  short-term, more velocity for the team long-term.
- Write scripts in your standard toolchain, not shell, for portability, type
  safety, and reproducibility across the team.
