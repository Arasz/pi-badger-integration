/**
 * Task-rename for pi: `/rename <name>` plus auto-rename on task_tracker output.
 *
 * The task skill ends Phase 1 with "ask the user to run `/rename {taskId}`",
 * but pi's builtin is `/name` — so the reminder rots into a manual step every
 * task. This extension registers `/rename` as a thin alias over
 * `pi.setSessionName` and watches tool results for the tracker's REMINDER
 * line, applying the task id as the session name without anyone typing.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	extractTaskIdFromText,
	extractTextFromContent,
	parseRenameArg,
	RENAME_COMMAND,
	RENAME_USAGE,
} from "./task-rename-core.ts";

export default function (pi: ExtensionAPI) {
	if (typeof pi?.registerCommand !== "function") {
		console.error(
			"task-rename: pi.registerCommand is not a function — this pi build's extension API has moved; /rename is not installed.",
		);
		return;
	}

	pi.registerCommand(RENAME_COMMAND, {
		description: "Rename the current session (matches the task skill's /rename {task-id}).",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const name = parseRenameArg(args);
			if (name === undefined) {
				ctx.ui.notify(RENAME_USAGE, "info");
				return;
			}
			if (typeof pi.setSessionName !== "function" || typeof pi.getSessionName !== "function") return;
			if (pi.getSessionName() === name) return;
			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed: ${name}`, "info");
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			const text = extractTextFromContent(event.content);
			if (!text.includes("/rename")) return;
			const taskId = extractTaskIdFromText(text);
			if (taskId === undefined) return;
			if (typeof pi.setSessionName !== "function") return;
			if (typeof pi.getSessionName === "function" && pi.getSessionName() === taskId) return;
			pi.setSessionName(taskId);
			if (ctx.hasUI) ctx.ui.notify(`Session renamed: ${taskId}`, "info");
		} catch {
			// Never break tool flow over a label.
		}
		return undefined;
	});
}
