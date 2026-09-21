import { afterEach, describe, expect, test } from "bun:test";
import {
	installVertexDebugFilter,
	isVertexDebugMessage,
} from "../../extensions/session-signals/silence-vertex-debug.ts";

describe("isVertexDebugMessage", () => {
	test("identifies @google/genai precedence debug messages", () => {
		expect(
			isVertexDebugMessage(
				"The user provided project/location will take precedence over the API key from the environment variables.",
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				"The user provided Google Cloud credentials will take precedence over the API key from the environment variable.",
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				"The user provided Vertex AI API key will take precedence over the project/location from the environment variables.",
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				"The project/location from the environment variables will take precedence over the API key from the environment variables.",
			),
		).toBe(true);
	});

	test("identifies @google/genai conflicting key and enterprise warnings", () => {
		expect(
			isVertexDebugMessage(
				"Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.",
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				"Warning: Both GOOGLE_GENAI_USE_ENTERPRISE and GOOGLE_GENAI_USE_VERTEXAI are set with conflicting values. The value of GOOGLE_GENAI_USE_ENTERPRISE will be used.",
			),
		).toBe(true);
	});

	test("identifies google-logging-utils auth error lines and raw 404 dumps", () => {
		expect(
			isVertexDebugMessage(
				'5732 [auth|ERROR] error {"message":"","code":404,"status":"Not Found"}',
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				'13343 [auth|INFO] [322] request {"url":"https://oauth2.googleapis.com/token","headers":{}}',
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				'13343 [gcp-metadata|DEBUG] instance request',
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				'{"error":{"message":"","code":404,"status":"Not Found"}}',
			),
		).toBe(true);
		expect(
			isVertexDebugMessage(
				'{"message":"","code":404,"status":"Not Found"}',
			),
		).toBe(true);
	});

	test("passes through unrelated messages", () => {
		expect(isVertexDebugMessage("Session started")).toBe(false);
		expect(isVertexDebugMessage("Failed to connect to database")).toBe(false);
		expect(isVertexDebugMessage("")).toBe(false);
		expect(isVertexDebugMessage(null)).toBe(false);
		expect(isVertexDebugMessage(undefined)).toBe(false);
		expect(isVertexDebugMessage({ some: "object" })).toBe(false);
	});
});

describe("installVertexDebugFilter", () => {
	let uninstall: (() => void) | undefined;

	afterEach(() => {
		if (uninstall) {
			uninstall();
			uninstall = undefined;
		}
	});

	test("suppresses Vertex debug messages while allowing normal console output", () => {
		const debugLogs: string[] = [];
		const warnLogs: string[] = [];
		const errorLogs: string[] = [];

		const origDebug = console.debug;
		const origWarn = console.warn;
		const origError = console.error;

		console.debug = (...args: unknown[]) => {
			debugLogs.push(args.map(String).join(" "));
		};
		console.warn = (...args: unknown[]) => {
			warnLogs.push(args.map(String).join(" "));
		};
		console.error = (...args: unknown[]) => {
			errorLogs.push(args.map(String).join(" "));
		};

		uninstall = installVertexDebugFilter();

		// Emitted Vertex debug message should be dropped
		console.debug(
			"The user provided project/location will take precedence over the API key from the environment variables.",
		);
		expect(debugLogs).toHaveLength(0);

		// Emitted Vertex warning should be dropped
		console.warn("Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.");
		expect(warnLogs).toHaveLength(0);

		// Emitted auth error dump should be dropped
		console.error('{"error":{"message":"","code":404,"status":"Not Found"}}');
		expect(errorLogs).toHaveLength(0);

		// Normal logs must pass through
		console.debug("Legitimate debug message");
		expect(debugLogs).toEqual(["Legitimate debug message"]);

		console.warn("Legitimate warning message");
		expect(warnLogs).toEqual(["Legitimate warning message"]);

		console.error("Legitimate error message");
		expect(errorLogs).toEqual(["Legitimate error message"]);

		// Uninstall restores original functions
		uninstall();
		uninstall = undefined;

		console.debug = origDebug;
		console.warn = origWarn;
		console.error = origError;
	});
});
