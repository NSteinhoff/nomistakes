# Pi extensions

TypeScript sources for pi agent extensions (custom tools) live in `src/`.

`stow/pi/.pi/agent/extensions` is a symlink to this directory's `src/`. The `pi`
stow package is already linked into `$HOME`, so the extensions are always in
place. There is no install or build step, ever.

Everything is self-contained: no `package.json`, no node project to manage.

## Path policy

`src/tools.ts` enforces agent guidance by blocking direct file-tool paths outside
the working directory, except for explicit read-only allowlist entries. It
canonicalizes paths for policy decisions and assumes the filesystem remains
stable between the check and tool execution. This is a guardrail against agent
mistakes, not a sandbox or an adversarial concurrency boundary.

## No deployment, no smoke tests

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
