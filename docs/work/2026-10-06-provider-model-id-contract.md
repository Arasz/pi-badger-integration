# Provider/model ID contract

Delegation pins accept fully qualified IDs from any provider. The first slash separates the provider from the model; the model can have more slash-separated segments. IDs pass unchanged to `pi --model`. Admission checks shape only, without consulting credentials, providers, a catalog or the network.

The provider matches `[A-Za-z0-9][A-Za-z0-9._-]*`. Each model segment matches `[A-Za-z0-9~@][A-Za-z0-9._~@:+-]*`, with at least one nonempty segment. Examples include `openai/gpt-6.1-sol`, `anthropic/claude-sonnet-5`, `openrouter/vendor/name`, `local/qwen:7b`, `fireworks/accounts/fireworks/models/x` and `openai/@preview/gpt-6`.

`MODEL_ID_PATTERN` checks the entire raw string. Its `$(?![\s\S])` ending rejects final newlines as well as embedded whitespace, empty segments and bare aliases. Explicit pins keep their existing surrounding-whitespace trim before admission. Registry IDs receive no trim and must match as stored.

The admission and resolution rules from [the level registry ADR](2026-09-06-pkg5-level-registry-adr.md) still apply: malformed explicit pins warn and fall through the model ranks, malformed preferred registry IDs throw before argv emission, and inherited session models pass through. Defaults and registryVersion stay unchanged. Provider policy filtering remains deferred.

The shared `tests/fixtures/model-id-conformance.json` contains 48 literal verdicts also consumed by ai-badger's Python tests. `bun test tests/model-id-conformance.test.ts tests/subagent-model-level.test.ts` exercises raw matching, explicit admission, preferred IDs and `parsePersona` through `delegationArgs` without launching a child or contacting a model provider.

## Test design and evidence

The oracle is the grammar above, with literal expected IDs and fixture verdicts. Resolution and argv construction have no clock, network, filesystem, environment, random or shared mutable input. Parsing uses a supplied frontmatter string. The existing registry suite owns its temporary directories and fake child lifecycle.

| Behavior | Failure mode and proof mutation |
| --- | --- |
| Valid provider/model pins are admitted | Restore the OpenRouter-only regex; native admission fails |
| Raw full-string matching rejects whitespace and malformed segments | Replace the grammar with a permissive non-whitespace matcher; negative matrix rows fail |
| Explicit trim precedes the raw shape check | Remove `value.trim()` from `nonBlank`; trim test fails |
| Native preferred IDs retain telemetry | Restore the OpenRouter-only regex; preferred ID test throws |
| Frontmatter reaches argv unchanged | Change the argv model value to a different ID; persona and preferred argv tests fail |

The initial native admission test failed under the original OpenRouter-only pattern (0 pass, 1 fail), then passed after changing the grammar. Mutation results and the final scoped runner output are reported with the change.

S3 has a durable opt-in join check: `AI_BADGER_ROOT=/path/to/ai-badger AI_BADGER_PYTHON=/path/to/ai-badger/.venv/bin/python3 bun test tests/provider-model-join.test.ts`. It compares fixture bytes, Python registry/schema-pattern verdicts and TypeScript verdicts, then runs the actual Python scaffold adjustment twice in a temporary project and parses its result into delegation argv. Without the environment variable this test is skipped explicitly; ordinary CI cannot prove the cross-repo join unless it supplies the matching checkout. `AI_BADGER_PYTHON` defaults to `python3`. The join compares the schema ID pattern with Python stdlib regex; full JSON Schema validation belongs to the ai-badger suite. The join needs Python 3 and reads only the supplied source tree. Temporary output is removed on exit; no child model runs.

Mutation runs killed the restored OpenRouter regex (19 failures), permissive segment matcher (17), removed explicit trim (1), and rewritten argv model (5). The join also failed under the restored OpenRouter regex. Removing only the absolute-end assertion left all 55 contract tests green in Bun 1.4.2: its `$` without `/m` already rejects the matrix's trailing newlines. The assertion remains part of the shared contract, but this runtime cannot distinguish that redundant expression.

Final scoped verification with the join enabled passed 188 tests across four files. Type checking passed. The resource scanner found no hits in the pure contract test; its four join findings are the documented read-only filesystem, explicit subprocess and opt-in environment root. Those controls belong to this integration gate, not to the unit contract. No duration is asserted.
