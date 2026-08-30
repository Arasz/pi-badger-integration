/**
 * Unit tests for pi-mcp-tools' SchemaConverter (JSON Schema -> TypeBox mapping,
 * including the fallback branches).
 *
 * Out of unit scope, by design: McpClient, McpRegistry and index.ts are
 * integration-flavoured (they need a live MCP server or heavy stubbing) and are
 * deliberately NOT covered here — no faked coverage.
 *
 * F7 (fresh clones): `@sinclair/typebox` resolves only from the gitignored
 * extensions/pi-mcp-tools/node_modules — run `bun install` inside
 * extensions/pi-mcp-tools/ before running this suite. That dependency does NOT
 * resolve from tests/, so these assertions read the produced TypeBox shapes via
 * the library's well-known symbol descriptions (`TypeBox.Kind`,
 * `TypeBox.Optional`) instead of importing the package.
 */
import { describe, expect, test } from "bun:test";
import { SchemaConverter } from "../../extensions/pi-mcp-tools/SchemaConverter.ts";

const convert = SchemaConverter.convertJsonSchemaToTypeBox.bind(SchemaConverter);

/** TypeBox tags every produced schema with `Symbol(TypeBox.Kind)` = its kind name. */
function kindOf(schema: object): string | undefined {
	const sym = Object.getOwnPropertySymbols(schema).find((s) => s.description === "TypeBox.Kind");
	return sym !== undefined ? (schema as Record<symbol, string>)[sym] : undefined;
}

/** TypeBox tags optionals with `Symbol(TypeBox.Optional)`; required props lack it. */
function isOptional(schema: object): boolean {
	return Object.getOwnPropertySymbols(schema).some((s) => s.description === "TypeBox.Optional");
}

describe("scalar mappings", () => {
	test("boolean maps to a boolean schema", () => {
		const out = convert({ type: "boolean" });
		expect(kindOf(out)).toBe("Boolean");
		expect((out as { type?: string }).type).toBe("boolean");
	});

	test("null maps to a null schema", () => {
		const out = convert({ type: "null" });
		expect(kindOf(out)).toBe("Null");
		expect((out as { type?: string }).type).toBe("null");
	});

	test("a plain string maps to a bare string schema (no constraint keys invented)", () => {
		const out = convert({ type: "string" }) as Record<string, unknown>;
		expect(kindOf(out)).toBe("String");
		expect(out.type).toBe("string");
		expect(out).not.toHaveProperty("minLength");
		expect(out).not.toHaveProperty("maxLength");
		expect(out).not.toHaveProperty("pattern");
	});

	test("string constraints survive onto the produced schema", () => {
		const out = convert({ type: "string", minLength: 1, maxLength: 5, pattern: "^x" }) as Record<
			string,
			unknown
		>;
		expect(kindOf(out)).toBe("String");
		expect(out.minLength).toBe(1);
		expect(out.maxLength).toBe(5);
		expect(out.pattern).toBe("^x");
	});

	test("a plain number maps to a number schema", () => {
		const out = convert({ type: "number" }) as Record<string, unknown>;
		expect(kindOf(out)).toBe("Number");
		expect(out.type).toBe("number");
		expect(out).not.toHaveProperty("minimum");
	});

	test("number bounds survive onto the produced schema", () => {
		const out = convert({ type: "number", minimum: 0, maximum: 10 }) as Record<string, unknown>;
		expect(out.minimum).toBe(0);
		expect(out.maximum).toBe(10);
	});

	test("integer maps to an integer schema, not a number schema", () => {
		const out = convert({ type: "integer", minimum: 1 }) as Record<string, unknown>;
		expect(kindOf(out)).toBe("Integer");
		expect(out.type).toBe("integer");
		expect(out.minimum).toBe(1);
	});
});

describe("enum maps to a union of literals", () => {
	test("each enum value becomes a literal member carrying its const", () => {
		const out = convert({ type: "string", enum: ["read", "write"] }) as {
			anyOf?: Array<Record<string, unknown>>;
		};
		expect(kindOf(out)).toBe("Union");
		expect(out.anyOf).toHaveLength(2);
		expect(out.anyOf?.map((m) => m.const)).toEqual(["read", "write"]);
		expect(out.anyOf?.every((m) => kindOf(m) === "Literal")).toBe(true);
	});

	test("an empty enum falls through to a plain string, not an empty union", () => {
		const out = convert({ type: "string", enum: [] }) as Record<string, unknown>;
		expect(kindOf(out)).toBe("String");
		expect(out).not.toHaveProperty("anyOf");
	});
});

describe("array mapping", () => {
	test("items are converted and attached as the array's item schema", () => {
		const out = convert({ type: "array", items: { type: "number" } }) as {
			items?: Record<string, unknown>;
		};
		expect(kindOf(out)).toBe("Array");
		expect((out as { type?: string }).type).toBe("array");
		expect(out.items).toBeDefined();
		expect(kindOf(out.items!)).toBe("Number");
		expect(out.items!.type).toBe("number");
	});

	test("an items schema with an enum converts recursively into a union", () => {
		const out = convert({
			type: "array",
			items: { type: "string", enum: ["a", "b"] },
		}) as { items?: object };
		expect(kindOf(out.items!)).toBe("Union");
	});

	test("a missing items schema degrades to Array of Any", () => {
		const out = convert({ type: "array" }) as { items?: object };
		expect(kindOf(out)).toBe("Array");
		expect(kindOf(out.items!)).toBe("Any");
	});
});

describe("object mapping", () => {
	test("required properties stay required; unlisted ones are wrapped as optional", () => {
		const out = convert({
			type: "object",
			properties: {
				name: { type: "string" },
				limit: { type: "number" },
			},
			required: ["name"],
		}) as { properties?: Record<string, object>; required?: string[] };

		expect(kindOf(out)).toBe("Object");
		expect(out.required).toEqual(["name"]);
		expect(kindOf(out.properties!.name)).toBe("String");
		expect(isOptional(out.properties!.name)).toBe(false);
		expect(kindOf(out.properties!.limit)).toBe("Number");
		expect(isOptional(out.properties!.limit)).toBe(true);
	});

	test("with no required list every property is optional", () => {
		const out = convert({
			type: "object",
			properties: { a: { type: "string" } },
		}) as { properties?: Record<string, object> };
		expect(isOptional(out.properties!.a)).toBe(true);
	});

	test("an object with no properties produces an empty properties map", () => {
		const out = convert({ type: "object" }) as { properties?: Record<string, unknown> };
		expect(kindOf(out)).toBe("Object");
		expect(out.properties).toEqual({});
	});

	test("nested object properties convert recursively", () => {
		const out = convert({
			type: "object",
			properties: {
				inner: {
					type: "object",
					properties: { deep: { type: "boolean" } },
					required: ["deep"],
				},
			},
		}) as { properties?: Record<string, { properties?: Record<string, object> }> };

		const inner = out.properties!.inner;
		expect(kindOf(inner)).toBe("Object");
		expect(kindOf(inner.properties!.deep)).toBe("Boolean");
		expect(isOptional(inner.properties!.deep)).toBe(false);
	});
});

describe("fallbacks land on Any", () => {
	test("null input maps to Any", () => {
		expect(kindOf(convert(null as unknown as Record<string, unknown>))).toBe("Any");
	});

	test("non-object input (string, number, undefined) maps to Any", () => {
		for (const bad of ["nope", 42, undefined]) {
			expect(kindOf(convert(bad as unknown as Record<string, unknown>))).toBe("Any");
		}
	});

	test("an empty object maps to Any (no type key)", () => {
		expect(kindOf(convert({}))).toBe("Any");
	});

	test("an unknown type string maps to Any", () => {
		expect(kindOf(convert({ type: "bananas" }))).toBe("Any");
	});

	test("a JSON-Schema array-typed `type` (unmodelled here) maps to Any, not a guess", () => {
		expect(kindOf(convert({ type: ["string", "null"] }))).toBe("Any");
	});
});
