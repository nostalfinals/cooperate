import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

function nativeSuffixStart(systemPrompt: string, options: BuildSystemPromptOptions): number {
  if ((options.contextFiles?.length ?? 0) > 0) {
    const context = systemPrompt.lastIndexOf("\n\n<project_context>\n\n");
    if (context >= 0) return context;
  }

  const exposesSkills = (options.skills?.some((skill) => !skill.disableModelInvocation) ?? false)
    && (!options.selectedTools || options.selectedTools.includes("read"));
  if (exposesSkills) {
    const skills = systemPrompt.lastIndexOf("\n\nThe following skills provide specialized instructions for specific tasks.");
    if (skills >= 0) return skills;
  }

  const cwd = `\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
  const cwdStart = systemPrompt.lastIndexOf(cwd);
  return cwdStart >= 0 ? cwdStart : systemPrompt.length;
}

/** Insert caller discovery at the front of Pi's native append-system slot. */
export function injectDefinitionDiscovery(
  systemPrompt: string,
  options: BuildSystemPromptOptions,
  discovery: string,
): string {
  // Child resource loading has already inserted its caller-scoped block before
  // extensions bind. Do not let the independently loaded cooperate extension
  // replace that scope with its root catalog.
  if (
    systemPrompt.includes("No subagent is defined yet")
    || systemPrompt.includes("Available subagent definitions:\n\n-")
  ) return systemPrompt;

  if (options.appendSystemPrompt) {
    const existingAppend = `\n\n${options.appendSystemPrompt}`;
    const appendStart = systemPrompt.lastIndexOf(existingAppend, nativeSuffixStart(systemPrompt, options));
    if (appendStart >= 0) {
      return `${systemPrompt.slice(0, appendStart)}\n\n${discovery}${systemPrompt.slice(appendStart)}`;
    }
  }

  const insertion = nativeSuffixStart(systemPrompt, options);
  return `${systemPrompt.slice(0, insertion)}\n\n${discovery}${systemPrompt.slice(insertion)}`;
}
