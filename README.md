# Pi extensions

TypeScript sources for pi agent extensions (custom tools) live in `src/`.

## Design Direction

This Pi harness treats an agent as a capable but fallible collaborator, not an
unrestricted shell user.

- **Explicit authority:** Discussion mode blocks restricted tools in the parent
  conversation unless the current user message authorizes implementation.
  Delegation remains allowed. Subagents execute assigned tasks under their own
  authority through dedicated tools. Sensitive paths require confirmation.
- **Narrow capabilities:** Purpose-built tools replace unrestricted shell and Git
  access where structured operations provide safer behavior.
- **Inspectable state:** Turn snapshots, Git inspection, task state, branch
  context, and user decisions remain visible in the session.
- **Evidence before action:** Agents inspect repository state, discover documented
  Make targets, and run project checks before and after changes.
- **Reversible work:** Snapshots support self-review and restore Git-visible
  worktree content without taking ownership of the Git index.
- **Focused delegation:** Specialized subagents isolate reconnaissance, audits,
  verification, issue curation, and commit gates.
- **Bounded scope:** Instructions require concrete evidence, concise reports, and
  the smallest sufficient change.

The goal is disciplined autonomy: automate routine work while preserving user
consent, clear boundaries, recoverability, and reviewable evidence.

## Path policy

`src/tools.ts` enforces agent guidance by blocking direct file-tool paths outside
the working directory, except for explicit read-only allowlist entries. It
canonicalizes paths for policy decisions and assumes the filesystem remains
stable between the check and tool execution. This is a guardrail against agent
mistakes, not a sandbox or an adversarial concurrency boundary. Hidden-path
checks apply below the session's working directory, so hidden ancestors do not
require approval for ordinary files. Hidden paths inside the checkout still
require approval unless an explicit exception permits access.

## Worktree sessions

Use `/worktree <goal>` to transfer context into a separate checkout in the same
TUI. Review the prompt before the command creates the checkout. The new session
stays idle until a user message arrives. Implementation requires fresh authority.
Use `/handoff <goal>` for a new session in the current checkout.

The new checkout starts at a detached snapshot of tracked content and non-ignored
untracked files. The source index stays unchanged. Later edits remain separate.
New worktrees reside outside the source checkout, under the agent directory.
Worktree sessions persist their identity and block session creation through
`/new`, `/fork`, `/thread`, `/handoff`, `/summarize`, and `/worktree`, including
native creation calls from extensions. `/resume` remains available. Existing
sessions in the same checkout inherit that identity and share the patch
destination. A reference in the worktree's Git metadata points to the originating
session. Keep that session file while the worktree remains active.
Sessions without this metadata or reference receive no automatic patch export.
Sessions with an obsolete patch destination fail metadata validation.
No migration exists. If setup fails after worktree allocation, the error includes
the retained path.

After each agent turn, including an aborted turn, the session exports a cumulative
patch against its initial snapshot. The patch includes binary changes and
non-ignored new files. It resides in the parent's patch directory, defined in
`src/utils/worktree-patch.ts`, with the originating session ID as its file name.
The command adds a local Git exclude rule for that directory. Each export replaces the file
atomically. If export fails, the previous patch remains and the session reports
that it is stale or absent. Manual edits after a turn enter the patch only after
the next turn. Integrate changes manually.

Use `/destroy` in an idle worktree session for confirmed cleanup. The command
exports the final patch and resumes the originating parent session before it
removes the checkout and deletes only the active session file. It preserves the
patch and other saved sessions. Cleanup deletes ignored files, which the patch
excludes. If export or parent resume fails, cleanup stops. Session files must
reside outside the worktree. Session changes remain blocked until cleanup ends.
If worktree removal fails, the active session file remains.

Use the include manifest defined in `src/utils/worktree.ts` for extra local
files or directories, such as dependencies. Declare one relative path per line.
Blank lines are allowed. Patterns, comments, parent traversal, Git metadata,
and paths outside the checkout are invalid. An absent manifest skips extra
setup. Missing declared paths or copy errors stop setup. Copies follow symbolic
links only within the source checkout. Tracked absolute links and links outside
the checkout stop worktree creation so tools cannot write through them into the
source checkout.

## No deployment, no smoke tests

`stow/pi/.pi/agent/extensions` is a symlink to this directory's `src/`. The `pi`
stow package is already linked into `$HOME`, so the extensions are always in
place. There is no install or build step, ever.

Everything is self-contained: no `package.json`, no node project to manage.

Because `src/` is symlinked into `$HOME` via stow, edits are live the moment
they are saved. pi loads extensions fresh at the start of every session, so a
changed extension takes effect on the next `pi` launch - there is nothing to
install, build, restart, or smoke-test.

Verification for an extension change is therefore just:

    make check

If `make check` passes, the change is done. Do not propose deployment,
installation, or runtime smoke-test steps for these extensions.

## Dependencies

Type-checking and linting need the vendored type stubs:

    make deps

## Checks

    make check   # typecheck and lint
    make fix     # autofix formatting and linting
