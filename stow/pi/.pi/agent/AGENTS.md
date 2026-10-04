# Agent Guidelines

- Request approval before you modify these: build config, project settings,
  dependencies
- Never credit yourself in commit messages or otherwise!
- Before you review or edit source code, read any available
  programming-language or style-guide skill that matches the file's language,
  and follow its conventions.

## Configuration

- Define each configurable value in one authority.
- Do not repeat a configurable literal in production code, diagnostics,
  comments, or documentation.
- Refer to the authority in code. Use generic terms in documentation.
- Define one fixture variable for each configurable value in tests.

## Testing

- Execute relevant checks post-modification
- Once implementation is authorized, if a test framework exists, apply TDD for behavior under test where it makes sense:
  1. Update tests
  2. Confirm failure
  3. Fix implementation
  4. Confirm passing
- Blocker handling follows the Verification rules in the base workflow. Raise an unclean baseline to the user before you implement. Once the baseline is clean, any regression you introduce blocks all other work until you resolve it.

## Comments

Permitted uses:

- Section delimiters
- Non-obvious reasoning
- Justifications

Prohibited:

- Restating code semantics
- Restating a previous version of the code

On edit: re-read adjacent comments and delete or rewrite any that no longer fit the present.

## Documentation

- Document why and what-for, not how. State the contract a caller cannot infer from the signature. Never restate mechanics the code already shows.
- Comment the surprising, not the obvious. If the behavior matches the name, write nothing.
- One line by default. Add more only when a caller can misuse the item without it.
- Do not enumerate invariants the type or signature already encodes.
- Ban specifics that rot: exact byte ranges, field-by-field breakdowns, step lists, cross-references to sibling types, restated parameter names. Prefer one durable sentence of intent. A shorter comment that stays true beats a precise one that goes stale.
- On edit: if a comment now restates the code or repeats a prior version, delete it. Do not "update" a comment that should not exist.

## Git Index Tracking

- Do not invoke Git directly to mutate the index.
- Before an index-sensitive build requires created or deleted files, call
  `git_index_track` with each affected repository-relative file path.
- Do not modify build commands to work around a stale Git index.

## Insufficient Tooling

Explain requirements. Propose: `make` target, `status` view, or specialized tool.
