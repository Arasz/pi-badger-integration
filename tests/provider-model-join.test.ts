import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MODEL_ID_PATTERN } from "../extensions/subagent/delegation-core.ts";
import { delegationArgs, parsePersona } from "../extensions/subagent/index.ts";
import matrix from "./fixtures/model-id-conformance.json";

// S3 cross-repo gate: opt in with AI_BADGER_ROOT pointing at the matching ai-badger checkout.
// Filesystem is read-only except Python's scoped TemporaryDirectory, removed on exit.
// No model/provider calls, clocks or random expectations; subprocess uses argument arrays.
const aiBadgerRoot = process.env.AI_BADGER_ROOT;
const aiBadgerPython = process.env.AI_BADGER_PYTHON ?? "python3";
test.skipIf(!aiBadgerRoot)("S3 join: registry/schema-pattern parity and regenerated scaffold pin reaches argv (requires AI_BADGER_ROOT)", () => {
  const root = aiBadgerRoot!;
  expect(readFileSync(join(root, "tests/fixtures/model-id-conformance.json"), "utf8")).toBe(
    readFileSync(new URL("./fixtures/model-id-conformance.json", import.meta.url), "utf8"),
  );
  const python = spawnSync(aiBadgerPython, ["-B", "-c", String.raw`
import importlib.util, json, pathlib, re, sys, tempfile
root = pathlib.Path(sys.argv[1])
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod
mg = load('model_groups', root/'features/common/skills/task/scripts/model_groups.py')
sys.path.insert(0, str(root/'engine'))
adjust = load('adjust_agents', root/'features/pi/adjustments/adjust_agents.py')
rows = json.loads((root/'tests/fixtures/model-id-conformance.json').read_text())
schema = json.loads((root/'schemas/model-groups.schema.json').read_text())
pattern = schema['$defs']['member']['properties']['id']['pattern']
verdicts = [bool(mg.MODEL_ID_RE.fullmatch(row['id'])) for row in rows]
schema_verdicts = [bool(re.search(pattern, row['id'])) for row in rows]
with tempfile.TemporaryDirectory(prefix='provider-model-join-') as tmp:
    project = pathlib.Path(tmp)
    source = project/'.ai-badger/agents/architect.md'
    source.parent.mkdir(parents=True)
    source.write_text('---\nname: architect\ndescription: d\nlevel: high\nmodel: openai/gpt-6.1-sol\n---\n\nBody.\n')
    ctx = {'config': {'agents': ['pi']}, 'target': project, 'target_dir': project/'.ai-badger'}
    adjust.adjust(ctx)
    adjust.adjust(ctx)
    persona = (project/'.pi/agents/architect.md').read_text()
print(json.dumps({'verdicts': verdicts, 'schemaVerdicts': schema_verdicts, 'persona': persona}))
`, root], { encoding: "utf8" });
  expect(python.status, python.stderr).toBe(0);
  const result = JSON.parse(python.stdout) as { verdicts: boolean[]; schemaVerdicts: boolean[]; persona: string };
  expect(result.verdicts).toEqual(matrix.map((row) => row.valid));
  expect(result.schemaVerdicts).toEqual(matrix.map((row) => row.valid));
  expect(matrix.map((row) => MODEL_ID_PATTERN.test(row.id))).toEqual(result.verdicts);
  const persona = parsePersona(result.persona, "/project/.pi/agents/architect.md");
  if ("error" in persona) throw new Error(persona.error);
  expect(persona.model).toBe("openai/gpt-6.1-sol");
  const args = delegationArgs(persona, "task", "openrouter/parent/model");
  expect(args[args.indexOf("--model") + 1]).toBe("openai/gpt-6.1-sol");
  expect(args.filter((value) => value === "--model")).toHaveLength(1);
});
