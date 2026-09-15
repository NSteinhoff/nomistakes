---
name: nvim-docs
description: >
  Neovim help/documentation lookup. Use when asked about Neovim itself.
---

# Neovim Documentation

The help files live in the Neovim runtime `doc` directory:

```
/opt/homebrew/opt/neovim/share/nvim/runtime/doc
```

This is `$VIMRUNTIME/doc` for the currently installed Neovim.

If it is not accessible, ask the user to confirm the current path with this command:

```sh
nvim --headless +'echo $VIMRUNTIME' +q 2>&1
```

## Path resolution

- Resolve all `*.txt` help filenames under the doc directory above, not the
  current working directory.

## Entry points

- `help.txt` — top-level table of contents.
- `index.txt` — every default mapping and command.
- `options.txt` — all options (`:help 'option'`).
- `lua.txt` and `lua-guide.txt` — Lua API and idioms.
- `api.txt` — the RPC/`nvim_*` API.
- `vim_diff.txt` — differences from Vim.
- `tags` — name→file:anchor index. Grep it to jump straight to a topic.

## Reading rules

- To find a topic, grep `tags` (or `index.txt`) for the help tag, then open the
  referenced file. Help tags are the `*tag*` markers used by `:help <tag>`.
- Read the relevant section completely and follow `|cross-references|` to
  related help files before you answer.
