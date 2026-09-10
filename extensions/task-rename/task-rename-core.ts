/** Pure task-rename core: parse `/rename` args and tracker REMINDER output. */

export const RENAME_COMMAND = "rename";

export const RENAME_USAGE = "usage: /rename <name>";

/** Trim command args; blank is usage, not a name. Multi-word names stay intact (parity with /name). */
export function parseRenameArg(args: string): string | undefined {
	const name = args.trim();
	return name === "" ? undefined : name;
}

/** Pull the id out of a `/rename <id>` mention (backticked REMINDER line or bare text). Task ids are `{alias}-{key}`, so a dash is required — a bare `/rename now` is usage, not an id. */
export function extractTaskIdFromText(text: string): string | undefined {
	const match = /\/rename\s+([A-Za-z0-9]+(?:-[A-Za-z0-9_]+)+)/.exec(text);
	return match?.[1];
}

/** Join text parts of a tool_result content array; images and junk contribute nothing. */
export function extractTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") out += text;
		}
	}
	return out;
}
