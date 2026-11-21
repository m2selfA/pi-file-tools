import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSettings } from "./managed/settings.js";

export const PREFLIGHT_SECTION = "pi_file_tools";
export const PREFLIGHT_MARKER = "PI_FILE_TOOLS_PREFLIGHT";
export const PREFLIGHT_GUIDANCE = [
  PREFLIGHT_MARKER,
  "Plan scratch outputs and recovery points before the first filesystem write.",
  '- Before creating disposable scratch files/directories, one-off probe scripts, intermediate results or throwaway downloads, call temp with action:"create" and write only within the returned path. Do not hand-create scattered tmp folders.',
  '- Before risky overwrites or migrations of valuable existing files/directories, or when creating backup copies, call backup with action:"create" first and retain its recovery ID. Do not hand-roll .bak or backup_old copies.',
  "- Respect user-specified source and final-deliverable destinations; those are not disposable scratch output.",
  "- Protect active work and failure/evidence receipts with pin/touch as appropriate. Respect configured retention; do not silently shorten it or change policy for a one-off task.",
  "- Review cleanup dry-runs before execution. Never empty unrelated user recycle-bin items.",
  "- If tools are wrapped by Fabric code mode, use extensions.temp(...) and extensions.backup(...) inside fabric_exec; otherwise use the available native tools.",
].join("\n");

const OWNED_BLOCK = `<${PREFLIGHT_SECTION}>\n${PREFLIGHT_GUIDANCE}\n</${PREFLIGHT_SECTION}>`;
const OWNED_APPEND = `\n\n${OWNED_BLOCK}`;

export interface PreflightPromptEvent {
  readonly systemPrompt: string;
  systemPromptOptions?: {
    sections?: Record<string, string>;
    forceSystemPrompt?: string;
  };
}

/** Remove only this exact complete block, never arbitrary user text between markers. */
function stripOwnedBlock(prompt: string): string {
  return prompt.split(OWNED_APPEND).join("").split(OWNED_BLOCK).join("");
}

/** Preserve structured prompts; append only when an opaque/legacy prompt requires it. */
export function applyPreflightPrompt(
  event: PreflightPromptEvent,
  enabled: boolean,
): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions;
  if (options?.sections) {
    delete options.sections[PREFLIGHT_SECTION];
    if (options.forceSystemPrompt !== undefined) {
      const original = stripOwnedBlock(options.forceSystemPrompt);
      options.forceSystemPrompt = enabled ? original + OWNED_APPEND : original;
    } else if (enabled) {
      options.sections[PREFLIGHT_SECTION] = PREFLIGHT_GUIDANCE;
    }
    return undefined;
  }
  const original = stripOwnedBlock(event.systemPrompt);
  if (enabled) return { systemPrompt: original + OWNED_APPEND };
  return original === event.systemPrompt
    ? undefined
    : { systemPrompt: original };
}

export function registerPreflightPrompt(
  pi: ExtensionAPI,
  settingsPath?: string,
): void {
  pi.on("before_agent_start", (event) => {
    const enabled = settingsPath
      ? (readSettings(settingsPath).preflightPrompt ?? true)
      : true;
    return applyPreflightPrompt(event, enabled);
  });
}
