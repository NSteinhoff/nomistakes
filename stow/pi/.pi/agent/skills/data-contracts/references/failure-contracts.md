# Failure Contracts

## Choose semantics before a mechanism

1. Determine whether the apparent failure is normal empty data or expected absence.
2. If a valid default preserves meaning, make that behavior explicit at one authority.
3. If no valid result exists, return an explicit failure through the language's established mechanism.
4. If useful partial output exists, define its guarantees and return diagnostics alongside it.
5. If the operation changes state, define commit, rollback, or observable partial progress.

Exceptions, status codes, and result unions are mechanisms, not competing universal policies. Choose the shape that preserves the facts that the caller needs.

## Empty values and absence

An empty collection can be a complete successful result. A failed read is not an empty collection unless the operation explicitly promises that fallback and callers need no distinction.

Use a nil or default object only for read paths whose semantics match absence. If callers need to distinguish missing from present-but-empty, preserve a presence signal. Never use a shared nil object as a mutation target or a real identity.

Prefer a valid default state where the domain permits it. Do not force an empty state into a domain that requires a value. In C, `{0}` supplies language-defined zero initialization. Raw zero bytes are not a universal substitute for valid pointers, floating representations, or external ABI requirements.

## Complete, partial, and failed results

- If an operation either produces a complete usable value or produces no value, use an all-or-nothing contract that requires the caller to handle failure.
- If an operation produces valid data with warnings, return the data and diagnostics together.
- If an operation produces incomplete data, expose a distinct partial representation with explicit permitted uses. A diagnostic list does not make incomplete data safe for a consumer that requires a complete value.
- If a default permits display or best-effort inspection but not a transaction, keep those contracts distinct. Do not silently substitute display defaults in authorization, financial operations, or persistence.

A compiler can expose an incomplete syntax tree for an editor. That does not make the tree a valid executable program. A configuration parser must not activate an incomplete configuration merely because it also returns diagnostics.

## Discover failure before dependent effects

Parse inputs and acquire or reserve required resources before irreversible work where feasible. Release reservations if a later step fails. Define rollback, idempotency, or partial progress when a sequence cannot be atomic.

Do not mistake a preflight check for a guarantee. Files, permissions, quotas, network peers, and concurrent state can change after the check. Preserve the failure path at the actual operation and use atomic acquisition where necessary.

Distinguish an internal invariant violation from an expected external failure. Use assertions for programmer errors according to project policy, not as a replacement for input rejection or operational failure signals. Report fatal failures at an explicit boundary with useful diagnostics.

## Diagnostics and batches

Use a collection of diagnostics when independent batch items can continue after a failure. Stop dependent work when its prerequisites fail. Do not continue a transaction solely to collect more errors.

Prefer structured entries with provenance over a mutable global last-error slot. Define the scope, owner, reset point, and consumer of a diagnostic channel. Bound its resource use according to the workload and prevent stale errors across operations.

A side channel must not be the only signal for a failure that requires immediate caller action. Preserve an explicit status even if richer context travels separately.

## Verification

Test the relevant distinctions: missing versus empty, invalid versus failed, usable partial output versus complete output, and warnings versus fatal errors. Exercise allocation or I/O failures when applicable. Verify rollback, resource release, repeated calls, and diagnostic provenance without false success.
