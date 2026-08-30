/**
 * Behavioural tests for the shift-enter-newline extension.
 * Each test names the failure mode it targets; see README for the mutation table.
 */
import { describe, expect, test } from "bun:test";
import {
	type EditorHarness,
	loadExtension,
	makeEditor,
	themeStub,
	tuiStub,
} from "../setup";

const SHIFT_HELD = { isModifierPressed: () => true };
const SHIFT_UP = { isModifierPressed: () => false };

describe("ShiftEnterEditor rewrite behaviour", () => {
	test("shift held + bare CR inserts a newline and does not submit", async () => {
		// Failure mode: rewrite never fires (helper ignored / condition inverted).
		const { editor, submitted } = (await makeEditor(SHIFT_HELD)) as EditorHarness;
		editor.handleInput("a");
		editor.handleInput("\r");
		editor.handleInput("b");
		expect(editor.getText()).toBe("a\nb");
		expect(submitted.value).toBeNull();
	});

	test("shift up + bare CR submits and does not insert a newline", async () => {
		// Failure mode: rewrite fires when shift is not held (Enter would break).
		const { editor, submitted } = (await makeEditor(SHIFT_UP)) as EditorHarness;
		editor.handleInput("hello");
		editor.handleInput("\r");
		expect(submitted.value).toBe("hello");
		expect(editor.getText()).toBe("");
	});

	test("missing helper degrades to default editor behaviour (submit)", async () => {
		// Failure mode: crash or behaviour divergence when the helper is unavailable.
		const { editor, submitted } = (await makeEditor(undefined)) as EditorHarness;
		editor.handleInput("fallback");
		editor.handleInput("\r");
		expect(submitted.value).toBe("fallback");
		expect(editor.getText()).toBe("");
	});

	test("printable input passes through untouched while shift is held", async () => {
		// Failure mode: overzealous rewriting of non-CR input.
		const { editor } = (await makeEditor(SHIFT_HELD)) as EditorHarness;
		editor.handleInput("x");
		editor.handleInput("y");
		expect(editor.getText()).toBe("xy");
	});
});

describe("rewrite target sequence", () => {
	test("SHIFT_ENTER_SEQUENCE is the Kitty CSI-u encoding for Shift+Enter", async () => {
		// Failure mode: constant typo (e.g. the tilde-terminated variant).
		const ext = await loadExtension();
		expect(ext.SHIFT_ENTER_SEQUENCE).toBe("\x1b[13;2u");
	});

	test("the sequence inserts a newline in the real editor chain (no stub involvement)", async () => {
		// Failure mode: the emitted sequence is not understood by pi's editor
		// (mutation: emit "\x1b[13;2~" — tilde variant — and this stays red).
		const ext = await loadExtension();
		const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
		const { getKeybindings } = await import("@earendil-works/pi-tui");
		const editor = new CustomEditor(
			// a partial TUI stub: CustomEditor only reaches requestRender on these paths,
			// but its parameter type is the full interface
			tuiStub() as never,
			themeStub(),
			// the extension's own wiring (extensions/shift-enter-newline/index.ts) builds the manager via
			// pi-tui's getKeybindings(); the cast papers over the dual-package type identity
			// (local node_modules copy vs the jiti-aliased global the extension loads with)
			getKeybindings() as never,
		);
		editor.handleInput("a");
		editor.handleInput(ext.SHIFT_ENTER_SEQUENCE);
		editor.handleInput("b");
		expect(editor.getText()).toBe("a\nb");
	});
});

describe("ESC+CR — the bytes JetBrains terminals send for Shift+Enter", () => {
	/** Defensive macrotask flush before assertions. In pi 0.84.4 the newline branch is
	 * fully synchronous, but one cold-start run observed the rewrite landing after the
	 * assertion; flushing costs nothing and a dropped rewrite condition still goes red
	 * (verified by mutation). */
	async function settle(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	test("ESC+CR with shift held inserts a newline and never reaches follow-up", async () => {
		// THE Rider bug: ESC+CR parses as alt+enter, which app.message.followUp
		// intercepts before the editor's newline branch. The rewrite must fire
		// first. (Mutation: drop "\x1b\r" from the rewrite condition — this goes red.)
		const { editor, submitted, followUpCalled } = (await makeEditor(SHIFT_HELD)) as EditorHarness;
		editor.handleInput("line1");
		editor.handleInput("\x1b\r");
		await settle();
		editor.handleInput("line2");
		expect(editor.getText()).toBe("line1\nline2");
		expect(submitted.value).toBeNull();
		expect(followUpCalled.value).toBe(false);
	});

	test("ESC+CR without shift still triggers the follow-up action (option+enter preserved)", async () => {
		// Failure mode: over-rewriting steals the genuine alt+enter follow-up binding.
		const { editor, followUpCalled } = (await makeEditor(SHIFT_UP)) as EditorHarness;
		editor.handleInput("queued");
		editor.handleInput("\x1b\r");
		expect(followUpCalled.value).toBe(true);
		expect(editor.getText()).toBe("queued");
	});

	test("ESC+CR with missing helper degrades to follow-up (no crash)", async () => {
		const { editor, followUpCalled } = (await makeEditor(undefined)) as EditorHarness;
		editor.handleInput("x");
		editor.handleInput("\x1b\r");
		expect(followUpCalled.value).toBe(true);
	});
});

describe("native helper", () => {
	test.skipIf(process.platform !== "darwin")("loadShiftHelper returns a callable helper", async () => {
		// Failure mode: native module not found in any install layout.
		// Skipped off-macOS or on unsupported arch where undefined is correct.
		const ext = await loadExtension();
		if (process.arch !== "arm64" && process.arch !== "x64") return;
		const helper = ext.loadShiftHelper();
		expect(helper).toBeDefined();
		expect(typeof helper?.isModifierPressed).toBe("function");
		// The poll must answer without throwing (state may be true or false).
		expect(typeof helper?.isModifierPressed("shift")).toBe("boolean");
	});

	test.skipIf(process.platform !== "darwin")("lazy retry loads the helper on first bare CR", async () => {
		// Failure mode: an editor built without a helper stays dead forever
		// (mutation: remove the lazy retry inside handleInput).
		const ext = await loadExtension();
		if (process.arch !== "arm64" && process.arch !== "x64") return;
		const { editor } = (await makeEditor(undefined)) as EditorHarness;
		editor.handleInput("x");
		editor.handleInput("\r");
		const internal = (editor as unknown as { shiftHelper?: unknown }).shiftHelper;
		expect(internal).toBeDefined();
	});
});

describe("extension factory wiring", () => {
	async function runFactory() {
		const ext = await loadExtension();
		const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
				handlers.set(event, handler);
			},
			registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
				commands.set(name, def);
			},
		};
		let factory: unknown;
		const notifications: string[] = [];
		const ctx = {
			ui: {
				setEditorComponent: (f: unknown) => {
					factory = f;
				},
				getEditorComponent: () => factory,
				notify: (message: string) => {
					notifications.push(message);
				},
			},
		};
		ext.default(pi);
		handlers.get("session_start")?.({ reason: "startup" }, ctx);
		return { commands, factory, notifications };
	}

	test("session_start installs the ShiftEnterEditor factory", async () => {
		// Failure mode: handler missing or setEditorComponent never called.
		const { factory } = await runFactory();
		expect(String(factory)).toContain("ShiftEnterEditor");
	});

	test("/shift-enter-debug is registered and reports state", async () => {
		// Failure mode: diagnostics missing — failures become silent again.
		const { commands, notifications } = await runFactory();
		const command = commands.get("shift-enter-debug");
		expect(command).toBeDefined();
		await command?.handler("", {
			ui: {
				getEditorComponent: () => () => "new ShiftEnterEditor(tui, theme, keybindings, shiftHelper)",
				notify: (message: string) => notifications.push(message),
			},
		});
		expect(notifications.join("\n")).toContain("shift-enter:");
		expect(notifications.join("\n")).toContain("last CR");
	});
});
