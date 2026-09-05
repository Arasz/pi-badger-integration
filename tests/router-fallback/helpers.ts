import type { FakePi } from "../helpers/fake-pi.ts";

/** Invoke every handler registered for one extension event, in order; returns results. */
export async function fire(pi: FakePi, name: string, event: unknown, ctx: unknown): Promise<unknown[]> {
  const handlers = pi.handlers.get(name) ?? [];
  const results: unknown[] = [];
  for (const handler of handlers) results.push(await handler(event, ctx));
  return results;
}
