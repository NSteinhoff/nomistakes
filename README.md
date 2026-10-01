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
stays idle until a user message arrives. Implementation requires fresh
authority.

The new checkout starts at a detached snapshot of tracked content and
non-ignored untracked files. The source index stays unchanged. Snapshot symbolic
links follow normal Git worktree behavior. After each agent turn, including an
aborted turn, the session exports a cumulative patch against its initial
snapshot. The patch includes
binary changes and non-ignored new files. It resides in the parent's patch
directory with the originating session ID as its file name. The command adds a
local Git exclude rule for that directory. Each export replaces the file
atomically. If export fails, the previous patch remains and the session reports
that it is stale or absent. Manual edits after a turn enter the patch only after
the next turn. Integrate changes manually. Worktree and session cleanup remains
manual. The patch excludes ignored files, so preserve any required local files
before cleanup.

Use the include manifest for extra local files or directories, such as
dependencies. Declare one relative path per line. Blank lines are allowed.
Patterns, comments, parent traversal, Git metadata, and paths outside the
checkout are invalid. An absent manifest skips extra setup. Missing declared
paths or copy errors stop setup. Copies follow symbolic links only within the
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
