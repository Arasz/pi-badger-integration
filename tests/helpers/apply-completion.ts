/**
 * pi's whole-argument completion application — regression GUARD, not independent evidence.
 *
 * Transcribed from `@earendil-works/pi-coding-agent` 0.84.4, class
 * `CombinedAutocompleteProvider` in `dist/bundle/chunks/chunk-OMWWHBTG.js`:
 *   - `getSuggestions`: for `/command args...` the provider calls
 *     `getArgumentCompletions(argumentText)` and returns `{ items, prefix: argumentText }` —
 *     the prefix is the WHOLE argument text, not the token under the cursor.
 *   - `applyCompletion`: `beforePrefix = currentLine.slice(0, cursorCol - prefix.length)` and
 *     `newLine = beforePrefix + item.value + afterCursor` — the item's `value` is spliced over
 *     the whole argument, so a completion for `log d` must return `value: "log d-2"`. Returning
 *     `value: "d-2"` rewrites the line to `/delegations d-2` (the reported bug).
 *
 * This helper mirrors that algorithm so a future provider change is caught; the independent
 * evidence for the fix is the manual TUI check (A1.5). It is intentionally tiny and exact:
 * cursor is assumed at the end of the line.
 */
export interface ArgumentCompletionItem {
	value: string;
	label?: string;
	description?: string;
}

/** Apply one argument-completion item to a full command line, exactly as pi does. */
export function applyArgumentCompletion(line: string, item: ArgumentCompletionItem): string {
	const spaceIndex = line.indexOf(" ");
	if (spaceIndex === -1) return line; // no argument text → command-name completion, not ours
	const beforeArgument = line.slice(0, spaceIndex + 1); // "/delegations "
	return beforeArgument + item.value;
}