---
name: blackbox-design
description: >
  Modular black-box architecture design. Use when you design or refactor
  module boundaries, interfaces, or system structure.
---

# Black Box Design

- Design modules as black boxes: expose a documented API, hide implementation.
- Keep interfaces stable across implementation changes. Never leak internals.
- A module must be rewritable from scratch with only its interface.
- Scope each module to one purpose that one person can build and maintain.
- Identify the core primitives that flow through the system. Build complexity
  from the composition of simple primitives, not from their complication.
- Prefer one good way over many configurable options.
- Wrap external dependencies behind your own interface. Never depend directly
  on code you do not control.
- Optimize for the reader's cognitive load over cleverness or terseness.

## When Refactoring

1. Identify the primitives: the core data types and operations.
2. Draw black-box boundaries that separate "what" from "how".
3. Design a clean interface that hides the complexity.
4. Replace modules one at a time, and keep interfaces intact.
5. Verify that a module swap does not break its consumers.
