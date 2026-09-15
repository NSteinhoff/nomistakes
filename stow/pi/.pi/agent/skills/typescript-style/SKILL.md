---
name: typescript-style
description: >
  TypeScript coding style and conventions. Use before you review or edit
  TypeScript source.
---

# TypeScript Style

- Prefer native loops over `forEach` and `reduce`
- `strict` is on. Do not weaken it. No implicit `any`.
- Separate type-only imports: `import type { X } from "..."`.
- Prefer explicit return types on exported functions.
- Use readonly / immutability by default
- Prefer `type` over `interface`
- `unknown` at boundaries, never `any`
- `async/await` over raw promises.
- Prefer returned error values over thrown exceptions
- Optional properties need `?: T | undefined`.
- Prefer nullable properties over optional properties to force caller decisions
