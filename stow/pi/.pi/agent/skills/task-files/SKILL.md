---
name: task-files
description: Read and edit the tasks file in the current directory. Use for tasks, notes, and questions in this plain-text format.
---

Use only `./tasks`. Do not search parent directories.

Each entry occupies one line:
- `[ ] text`: open task
- `[x] text`: completed task
- `!!! text`: note
- `??? text`: question

Read the file before each edit.
Preserve unrelated content and entry order.
Use targeted edits for existing content.
Append new entries unless the user specifies a position.

For a list of active entries, show open tasks, notes, and questions.
Include completed tasks only when requested.

To complete a task, replace `[ ]` with `[x]`.
To delete an entry, remove its entire line.
Do not delete completed tasks unless requested.

If an edit request matches multiple entries, ask which entry to change.
If the file does not exist, report that fact for read requests.
Create it for an explicit request to add an entry.
