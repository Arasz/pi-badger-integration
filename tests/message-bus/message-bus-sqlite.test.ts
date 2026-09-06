import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore, openBusDb } from "../../extensions/message-bus/index.ts";

function tempDb(): string {
	const dir = mkdtempSync(join(tmpdir(), "mbus-"));
	const path = join(dir, "ai-badger.db");
	writeFileSync(path, "");
	chmodSync(path, 0o644); // bun's sqlite build refuses owner-only sidecar-less opens (A11 precedent)
	return path;
}

describe("sqlite store round-trip", () => {
	test("send → list → deliver advances cursor → second deliver empty", () => {
		const store = createSqliteStore(tempDb(), () => 1_700_000_000_000);
		const id1 = store.send({ senderSession: "s-a", senderProject: "p1", content: "hello project", targetSession: null, targetProject: "p1" });
		const id2 = store.send({ senderSession: "s-a", senderProject: "p1", content: "hello you", targetSession: "s-me", targetProject: null });
		expect(id2).toBeGreaterThan(id1);
		const listed = store.listForSession("s-me", "p1");
		expect(listed.map((m) => m.id)).toEqual([id1, id2]);
		const first = store.deliverForSession("s-me", "p1");
		expect(first.messages.map((m) => m.id)).toEqual([id1, id2]);
		const second = store.deliverForSession("s-me", "p1");
		expect(second.messages).toEqual([]);
		expect(store.getCursor("s-me")).toBe(id2);
	});

	test("own rows excluded, session-wins stored", () => {
		const store = createSqliteStore(tempDb(), () => 1_700_000_000_000);
		store.send({ senderSession: "s-me", senderProject: "p1", content: "own broadcast", targetSession: null, targetProject: null });
		expect(store.listForSession("s-me", "p1")).toEqual([]);
	});

	test("deliverDirectForSession returns directs only and lands past MAX (broadcasts consumed)", () => {
		const store = createSqliteStore(tempDb(), () => 1_700_000_000_000);
		store.send({ senderSession: "s-a", senderProject: "p1", content: "project noise", targetSession: null, targetProject: "p1" });
		const directId = store.send({ senderSession: "s-a", senderProject: "p1", content: "private one", targetSession: "s-me", targetProject: null });
		store.send({ senderSession: "s-a", senderProject: "p1", content: "machine noise", targetSession: null, targetProject: null });
		const first = store.deliverDirectForSession("s-me", "p1");
		expect(first.messages.map((m) => m.id)).toEqual([directId]);
		// cursor past MAX: a following full deliver finds nothing (broadcasts skipped on start)
		const second = store.deliverForSession("s-me", "p1");
		expect(second.messages).toEqual([]);
	});

	test("missing DB file is data, never created", () => {
		const missing = join(mkdtempSync(join(tmpdir(), "mbus-")), "nope.db");
		let error = "";
		try {
			createSqliteStore(missing);
		} catch (e) {
			error = String(e);
		}
		expect(error).toMatch(/no user DB/);
		const { existsSync } = require("node:fs") as typeof import("node:fs");
		expect(existsSync(missing)).toBe(false);
	});
});

describe("contention hardening (database-is-locked)", () => {
	test("every opened handle carries busy_timeout 5000 (python parity — wait, never fail instantly)", () => {
		const db = openBusDb(tempDb());
		try {
			const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: unknown };
			expect(Number(row?.timeout)).toBe(5000);
		} finally {
			db.close();
		}
	});
});
