---
name: pi-docs
description: >
  Pi coding-agent documentation lookup. Use when asked about pi itself.
disable-model-invocation: false
---

# Pi Documentation

Locations:
- Main documentation: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/examples (extensions, custom tools, SDK)

Path resolution:
- Resolve `docs/...` under Additional docs and `examples/...` under Examples, not the current working directory.

Topic map:
- extensions: docs/extensions.md, examples/extensions/
- themes: docs/themes.md
- skills: docs/skills.md
- prompt templates: docs/prompt-templates.md
- TUI components: docs/tui.md
- keybindings: docs/keybindings.md
- SDK integrations: docs/sdk.md
- custom providers: docs/custom-provider.md
- adding models: docs/models.md
- pi packages: docs/packages.md

Reading rules:
- When you work on pi topics, read the docs and examples, and follow .md cross-references before you implement.
- Always read pi .md files completely and follow links to related docs (for example tui.md for TUI API details).
