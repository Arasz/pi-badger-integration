/**
 * Vertex AI debug/warning message filter.
 *
 * `@google/genai` logs precedence notices (e.g. "The user provided project/location
 * will take precedence over the API key from the environment variables.") directly
 * via `console.debug`. When Vertex AI ADC is used while `GEMINI_API_KEY` is present in
 * `process.env`, these messages leak to stdout/stderr and render inside Pi's interactive
 * input prompt.
 *
 * In addition, `google-auth-library` / `google-logging-utils` logs unhandled auth errors
 * (such as 404 dumps) via `console.error` when rejecting requests.
 *
 * This module silences both leaks by disabling `google-logging-utils`'s backend
 * and filtering known Vertex precedence/conflict messages from console output.
 */

import { createRequire } from "node:module";

const VERTEX_PATTERNS: readonly string[] = [
	"precedence over the API key from the environment variable",
	"The user provided project/location will take precedence",
	"The user provided Google Cloud credentials will take precedence",
	"The user provided Vertex AI API key will take precedence",
	"The project/location from the environment variables will take precedence",
	"Both GOOGLE_API_KEY and GEMINI_API_KEY are set",
	"Warning: Both GOOGLE_GENAI_USE_ENTERPRISE and GOOGLE_GENAI_USE_VERTEXAI are set",
	"[auth|",
	"[gcp-metadata|",
];

/** Check if a log argument matches known Google Vertex SDK debug/warning patterns. */
export function isVertexDebugMessage(message: unknown): boolean {
	if (typeof message !== "string" || message.length === 0) return false;

	for (const pattern of VERTEX_PATTERNS) {
		if (message.includes(pattern)) return true;
	}

	// Raw Google Auth 404 dumps: {"error":{"message":"","code":404,"status":"Not Found"}}
	if (
		(message.includes('"code":404') || message.includes('"code": 404')) &&
		(message.includes('"status":"Not Found"') || message.includes('"status": "Not Found"'))
	) {
		return true;
	}

	return false;
}

/**
 * Install console filters and silence google-logging-utils to prevent Vertex AI
 * debug chatter from corrupting Pi's interactive prompt.
 *
 * Returns an `uninstall` cleanup function to restore the original console methods.
 */
export function installVertexDebugFilter(): () => void {
	// Silence google-logging-utils backend if present
	try {
		const req = createRequire(import.meta.url);
		const loggingUtils = req("google-logging-utils") as {
			setBackend?: (backend: unknown) => void;
		};
		loggingUtils?.setBackend?.(null);
	} catch {
		// Fail-open if google-logging-utils is not resolvable
	}

	const origDebug = console.debug;
	const origWarn = console.warn;
	const origError = console.error;

	console.debug = (...args: unknown[]) => {
		if (args.length > 0 && typeof args[0] === "string" && isVertexDebugMessage(args[0])) {
			return;
		}
		origDebug.apply(console, args);
	};

	console.warn = (...args: unknown[]) => {
		if (args.length > 0 && typeof args[0] === "string" && isVertexDebugMessage(args[0])) {
			return;
		}
		origWarn.apply(console, args);
	};

	console.error = (...args: unknown[]) => {
		if (args.length > 0 && typeof args[0] === "string" && isVertexDebugMessage(args[0])) {
			return;
		}
		origError.apply(console, args);
	};

	return () => {
		console.debug = origDebug;
		console.warn = origWarn;
		console.error = origError;
	};
}
