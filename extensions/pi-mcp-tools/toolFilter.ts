/** Names of tools that should stay active: everything except MCP tools
 * that are both registered by this extension and explicitly disabled. */
export function enabledToolNames(
  allNames: string[],
  registeredTools: ReadonlySet<string>,
  disabledTools: ReadonlySet<string>,
): string[] {
  return allNames.filter((name) => !registeredTools.has(name) || !disabledTools.has(name));
}

/** How many of the registered tools stay enabled after disabling. */
export function countEnabledTools(registeredTools: ReadonlySet<string>, disabledTools: ReadonlySet<string>): number {
  let count = 0;
  for (const name of registeredTools) {
    if (!disabledTools.has(name)) {
      count++;
    }
  }
  return count;
}
