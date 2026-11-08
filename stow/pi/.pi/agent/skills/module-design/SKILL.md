---
name: module-design
description: >
  Module responsibilities, public interfaces, information exposure,
  and dependency direction. Use when a task defines or changes module
  boundaries, assigns responsibilities across modules, or addresses
  architectural coupling. Do not activate for ordinary calls through
  an established interface.
---

# Module Design

## Scope

Apply this skill to architecture discussions and implementation tasks that change module boundaries. Keep established boundaries intact for unrelated local changes. Use `data-contracts` for value and failure semantics. Use `resource-design` when ownership or storage contracts also change.

## Principles

- Give each module one coherent responsibility that one person can understand and maintain.
- Expose the contract that consumers need. Hide implementation choices and internal state.
- Make a module replaceable from its public contract alone. Specify observable behavior, not implementation mechanics.
- Keep interfaces stable across internal changes. If a contract must change, make the consumer migration explicit.
- Identify the core data types and operations. Build complexity through their composition rather than special cases within each primitive.
- Assign each policy and mutable fact one authority. Make dependency direction explicit and avoid cycles.
- Prefer one clear operation over several configurable variants without distinct use cases.
- Wrap an external dependency when the boundary isolates policy, translates representations, or supports substitution. Do not add a wrapper solely because code is external.
- Prefer low cognitive load over cleverness or terseness. Do not invent a framework for a local operation.

## Workflow

1. Identify the responsibility or coupling problem within the requested scope.
2. Map the relevant consumers, dependencies, core values, and operations.
3. Define the public contract and the implementation details that it hides.
4. Compare the proposed boundary with the smallest change to the current structure.
5. If implementation is authorized, replace one module at a time and migrate consumers only when the contract requires it.
6. Verify observable behavior through consumer tests and interface tests. Confirm that internal changes do not require consumer knowledge of the implementation.

For a substantial boundary change, state the responsibilities, dependency direction, public contract, and migration tradeoff before code. Do not implement a proposal without authorization.
