/** Pure helpers for the rtk statusline: parse `rtk gain` / `rtk llm-proxy status` and format the footer text. */

export type ProxyState = "routed" | "routed-down" | "up" | "off";

export type StatusInput = {
	proxy: ProxyState;
	cmdPct?: number;
	proxyPct?: number;
	post?: { compressed: number; sent: number };
};

const dash = "–";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const pctText = (v: number | undefined) => (isNum(v) ? `${Math.round(v)}%` : dash);

/** Weighted savings (total_saved / total_input) from `rtk gain -f json`; undefined when malformed. */
export function parseGain(json: string): { pct: number | undefined; commands: number } | undefined {
	try {
		const summary = (JSON.parse(json) as { summary?: Record<string, unknown> } | null)?.summary;
		if (!summary || typeof summary !== "object") return undefined;
		const { total_commands: commands, total_input: input, total_saved: saved } = summary;
		if (!isNum(commands)) return undefined;
		const pct = isNum(input) && input > 0 && isNum(saved) ? (saved / input) * 100 : undefined;
		return { pct, commands };
	} catch {
		return undefined;
	}
}

/** `up` only for exit 0 with a "running at" line; everything else is `down`. */
export function parseProxyStatus(stdout: string, code: number): "up" | "down" {
	return code === 0 && typeof stdout === "string" && /^\s*running at\b/.test(stdout) ? "up" : "down";
}

const HEAD: Record<ProxyState, string> = {
	routed: "rtk ⇄proxy",
	"routed-down": "rtk proxy down!",
	up: "rtk proxy up · pi direct",
	off: "rtk proxy off",
};

/** One bracketed footer segment (pi joins extension statuses with a bare space): proxy state, project cmd %, proxy % (a dash when routed but unmeasured), session post counter. */
export function formatStatus(input: StatusInput): string {
	const parts = [HEAD[input.proxy], `cmd ${pctText(input.cmdPct)}`];
	const known = input.proxyPct !== undefined && Number.isFinite(input.proxyPct);
	if (input.proxy === "routed" || known) parts.push(`proxy ${pctText(input.proxyPct)}`);
	if (input.post && input.post.sent > 0) parts.push(`post ${input.post.compressed}/${input.post.sent}`);
	return `[${parts.join(" · ")}]`;
}

export function shouldRefresh(now: number, last: number | undefined, minMs = 10_000): boolean {
	return last === undefined || now - last >= minMs;
}
