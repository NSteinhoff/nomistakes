/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension registers a `todo` tool and a plain-text `/todos` command.
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Todo = {
	id: number;
	text: string;
	done: boolean;
};

type TodoAction = "list" | "add" | "complete" | "toggle" | "clear";

type TodoDetails = {
	action: TodoAction;
	todos: Todo[];
	added: Todo[] | null;
	completed: Todo[] | null;
	nextId: number;
	error: string | null;
};

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "complete", "toggle", "clear"] as const),
	text: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Todo texts (for add)",
			minItems: 1,
		}),
	),
	ids: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1 }), {
			description: "Todo IDs (for complete)",
			minItems: 1,
			uniqueItems: true,
		}),
	),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/**
 * Deep-copy the todo list so stored snapshots never share element references
 * with live state. Without this, in-place mutation (toggle/complete) or `push`
 * (add) would retroactively corrupt every snapshot recorded on the branch.
 */
const cloneTodos = (list: Todo[]): Todo[] => list.map((t) => ({ ...t }));

const formatTodoList = (todos: readonly Todo[]): string =>
	todos.length > 0
		? todos
				.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`)
				.join("\n")
		: "No todos";

const isTodo = (value: unknown): value is Todo => {
	if (typeof value !== "object" || value === null) return false;
	const t = value as Record<string, unknown>;
	return (
		typeof t.id === "number" &&
		typeof t.text === "string" &&
		typeof t.done === "boolean"
	);
};

const isTodoAction = (value: unknown): value is TodoAction =>
	value === "list" ||
	value === "add" ||
	value === "complete" ||
	value === "toggle" ||
	value === "clear";

/**
 * Validate raw session data at the boundary. Session details are `unknown`
 * (possibly written by an older schema), so guard the shape before trusting it.
 */
const parseTodoDetails = (value: unknown): TodoDetails | null => {
	if (typeof value !== "object" || value === null) return null;
	const d = value as Record<string, unknown>;
	if (!isTodoAction(d.action)) return null;
	if (!Array.isArray(d.todos) || !d.todos.every(isTodo)) return null;
	if (typeof d.nextId !== "number") return null;
	if (
		d.error !== undefined &&
		d.error !== null &&
		typeof d.error !== "string"
	) {
		return null;
	}
	if (
		d.added !== undefined &&
		d.added !== null &&
		(!Array.isArray(d.added) || !d.added.every(isTodo))
	) {
		return null;
	}
	if (
		d.completed !== undefined &&
		d.completed !== null &&
		(!Array.isArray(d.completed) || !d.completed.every(isTodo))
	) {
		return null;
	}
	return {
		action: d.action,
		todos: d.todos as Todo[],
		added: Array.isArray(d.added) ? (d.added as Todo[]) : null,
		completed: Array.isArray(d.completed) ? (d.completed as Todo[]) : null,
		nextId: d.nextId,
		error: typeof d.error === "string" ? d.error : null,
	};
};

export default function (pi: ExtensionAPI): void {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = parseTodoDetails(msg.details);
			if (details) {
				// Clone so live mutations never write back into the stored snapshot.
				todos = cloneTodos(details.todos);
				nextId = details.nextId;
			}
		}
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list, add (text: non-empty string[]), complete (ids: non-empty number[]), toggle (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: formatTodoList(todos) }],
						details: {
							action: "list",
							todos: cloneTodos(todos),
							added: null,
							completed: null,
							nextId,
							error: null,
						} as TodoDetails,
					};

				case "add": {
					if (!params.text || params.text.length === 0) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: {
								action: "add",
								todos: cloneTodos(todos),
								added: null,
								completed: null,
								nextId,
								error: "text required",
							} as TodoDetails,
						};
					}
					const added: Todo[] = [];
					for (const text of params.text) {
						added.push({ id: nextId++, text, done: false });
					}
					todos.push(...added);
					return {
						content: [
							{
								type: "text",
								text: `Added todos: ${added.length}`,
							},
						],
						details: {
							action: "add",
							todos: cloneTodos(todos),
							added: cloneTodos(added),
							completed: null,
							nextId,
							error: null,
						} as TodoDetails,
					};
				}

				case "complete": {
					if (!params.ids || params.ids.length === 0) {
						return {
							content: [
								{ type: "text", text: "Error: ids required for complete" },
							],
							details: {
								action: "complete",
								todos: cloneTodos(todos),
								added: null,
								completed: null,
								nextId,
								error: "ids required",
							} as TodoDetails,
						};
					}

					const completed: Todo[] = [];
					const missingIds: number[] = [];
					for (const id of params.ids) {
						const todo = todos.find((candidate) => candidate.id === id);
						if (!todo) {
							missingIds.push(id);
							continue;
						}
						todo.done = true;
						completed.push(todo);
					}

					let message = `Completed todos: ${completed.length}`;
					if (missingIds.length > 0) {
						message += `\nMissing IDs: ${missingIds.join(", ")}`;
					}
					return {
						content: [{ type: "text", text: message }],
						details: {
							action: "complete",
							todos: cloneTodos(todos),
							added: null,
							completed: cloneTodos(completed),
							nextId,
							error: null,
						} as TodoDetails,
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [
								{ type: "text", text: "Error: id required for toggle" },
							],
							details: {
								action: "toggle",
								todos: cloneTodos(todos),
								added: null,
								completed: null,
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: cloneTodos(todos),
								added: null,
								completed: null,
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.done = !todo.done;
					return {
						content: [
							{
								type: "text",
								text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`,
							},
						],
						details: {
							action: "toggle",
							todos: cloneTodos(todos),
							added: null,
							completed: null,
							nextId,
							error: null,
						} as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: {
							action: "clear",
							todos: [],
							added: null,
							completed: null,
							nextId: 1,
							error: null,
						} as TodoDetails,
					};
				}
			}
		},

		renderCall(args, theme, _context) {
			let text =
				theme.fg("toolTitle", theme.bold("todo ")) +
				theme.fg("muted", args.action);
			if (args.text) {
				text += ` ${theme.fg("dim", `todos: ${args.text.length}`)}`;
			}
			if (args.ids) {
				text += ` ${theme.fg("dim", `todos: ${args.ids.length}`)}`;
			}
			if (args.id !== undefined)
				text += ` ${theme.fg("accent", `#${args.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = parseTodoDetails(result.details);
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = t.done
							? theme.fg("success", "✓")
							: theme.fg("dim", "○");
						const itemText = t.done
							? theme.fg("dim", t.text)
							: theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = details.added ?? todoList.slice(-1);
					if (added.length === 0) {
						return new Text(theme.fg("dim", "No todos added"), 0, 0);
					}
					let listText = theme.fg("success", `✓ Added todos: ${added.length}`);
					for (const todo of added) {
						listText += `\n${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.text)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "complete": {
					const completed = details.completed;
					const text = result.content[0];
					const message = text?.type === "text" ? text.text : "";
					if (!completed) {
						return new Text(
							theme.fg("success", "✓ ") + theme.fg("muted", message),
							0,
							0,
						);
					}
					let listText = theme.fg(
						"success",
						`✓ Completed todos: ${completed.length}`,
					);
					for (const todo of completed) {
						listText += `\n${theme.fg("accent", `#${todo.id}`)} ${theme.fg("muted", todo.text)}`;
					}
					const missingIds = message.split("\n")[1];
					if (missingIds) {
						listText += `\n${theme.fg("muted", missingIds)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(
						theme.fg("success", "✓ ") + theme.fg("muted", msg),
						0,
						0,
					);
				}

				case "clear":
					return new Text(
						theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"),
						0,
						0,
					);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show todos on the current branch",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatTodoList(todos), "info");
		},
	});
}
