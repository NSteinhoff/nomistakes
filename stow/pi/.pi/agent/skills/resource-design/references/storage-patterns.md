# Storage Patterns

## Choose allocation from lifetimes

- Use local or stack storage for small, bounded, short-lived values.
- Use a fixed buffer when a realistic capacity limit fits the contract.
- Use an arena or region for allocations with one shared lifetime. Expose the owner and reset point when results borrow that storage.
- Use a pool and free list for equal-sized objects with independent reuse and a common storage region.
- Use a general-purpose allocator for arbitrary sizes or lifetimes, or when it is simpler than a specialized allocator.

Do not reset a region while a result or another thread still refers to it. Keep scratch and output lifetimes distinct. If a scratch reset can affect the output region, forbid that alias or redesign the operation.

For an arena implementation, define alignment, overflow behavior, growth, capacity, allocation failure, synchronization, reset semantics, and memory observability. Cheap allocation does not imply automatic cleanup of external resources.

## Start with simple containers

Use arrays for bulk homogeneous data unless the workload requires another shape. Prefer a conventional container over a custom generic framework without a concrete need.

- For a small known maximum, use an array and a count with an enforced capacity.
- For a variable-length sequence, use a geometrically expandable array and state its invalidation rules.
- For dense iteration and cheap unordered removal, use a packed array with swap removal. Order and positions change.
- For reusable stable slots, use a slot array and free list. Track active state and reject stale access.
- For references across slot reuse, add generations and define a wraparound policy.
- For key lookup, add a secondary index only when the access pattern justifies its maintenance cost.
- For frequent node splice or reorder operations, consider an intrusive list. Do not choose a linked list for bulk sequential traversal by default.

## Sentinels and circular lists

A circular doubly linked list with a dummy head can make insertion and removal uniform across empty, first, and last positions. Array indices can keep links independent of relocation of the base array. Reserve sentinel slots explicitly and keep them out of user identity.

Maintain reciprocal links, membership in exactly the expected list, and a self-linked empty head. Remove a node before insertion into another list. Validate indices and active state at the appropriate boundary. A correct list algorithm still requires a lifetime and synchronization contract.

## Stable identity

When objects move or slots are reused, distinguish identity from location. A conceptual handle can pair a slot with a generation.

Check slot bounds, active state, and generation before access. Change the generation at release or reuse according to one policy. Define counter wraparound behavior. If packed storage moves an object, update its identity-to-location mapping.

A handle detects some stale identities. It does not keep memory alive between a check and access, and it does not replace locks, reference ownership, or safe reclamation.

## Secondary indexes

Keep primary data simple and add an index for a defined query. Define maintenance for insertion, deletion, key changes, element movement, and bulk reset. A hash is not proof of key equality unless the contract explicitly accepts collisions.

For small collections, compare an index with a linear scan. Use representative workloads. Keep a simple scan as a test oracle where feasible.

## Variable-sized data and virtual memory

For objects with strings or variable-sized children, choose offsets into an arena, separate allocations, chunks, or stable page-backed storage according to mutation and lifetime requirements.

Chunks and pools can reduce allocation overhead but add internal fragmentation and metadata. Virtual address reservation can preserve addresses on suitable platforms, but it does not guarantee unlimited capacity or free physical resources.

Distinguish reserved address space, committed memory, resident memory, and initialized elements. Enforce arithmetic and capacity limits. Prefer a conventional array until address stability and measured costs justify a more complex strategy.

## Sources

These patterns adapt the following articles with explicit lifetime and safety qualifications:

- [Minimalist Container Library in C, Part 1 — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/minimalist-container-library-in-c-part-1/index.html)
- [Minimalist Container Library in C, Part 2 — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/minimalist-container-library-in-c-part-2/index.html)
- [In Defense of Linked Lists — Digital Grove](https://www.dgtlgrove.com/p/in-defense-of-linked-lists)
- [Data Structures, Part 1: Bulk Data — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/data-structures-part-1-bulk-data/index.html)
- [Data Structures, Part 2: Indices — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/data-structures-part-2-indices/index.html)
- [Data Structures, Part 3: Arrays of Arrays — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/data-structures-part-3-arrays-of-arrays/index.html)
- [Untangling Lifetimes: The Arena Allocator — Digital Grove](https://www.dgtlgrove.com/p/untangling-lifetimes-the-arena-allocator)
- [Virtual Memory Tricks — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/virtual-memory-tricks/index.html)
- [Enter The Arena — Digital Grove](https://www.dgtlgrove.com/p/enter-the-arena-talk)
- [A Taxonomy of Bugs — Our Machinery](https://ruby0x1.github.io/machinery_blog_archive/post/a-taxonomy-of-bugs/index.html)
- [UI, Part 2: Every Single Frame — Digital Grove](https://www.dgtlgrove.com/p/ui-part-2-build-it-every-frame-immediate)
