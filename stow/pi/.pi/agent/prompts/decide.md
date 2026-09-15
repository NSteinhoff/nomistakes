---
description: Resolve open questions and suggestions interactively
argument-hint: "<SCOPE>"
---

Walk through open questions, suggestions, or undecided recommendations one at a
time, then apply the recorded decisions.

Scope: $ARGUMENTS

If scope is empty, default to the open questions, suggestions, and undecided
recommendations raised earlier in the current session. If none can be
identified, use the `ask` tool to request a scope before you proceed.

For each item:
1. State the question or suggestion clearly.
2. State how many decisions remain, with the current one counted (for example 3/5).
3. Present the viable options with concise tradeoffs. Label every option with a
   capital letter (A, B, C, ...), never a number. Always include an explicit
   "defer" option, to revisit the item at the end.
4. Collect the decision with the `ask` tool. Pass the lettered options as
   `options`. Do not end the turn to ask. Do not proceed without an answer.
5. Record the decision and continue to the next item.

When all decisions are recorded, show a summary of every item and its chosen
option before you proceed.
