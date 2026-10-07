import type {
  InstallerOptions,
  InstallerResult,
} from "../packages/create-deepseek-harness-action/src/installer.mjs";
export type AgentArtsInstallerOptions = Omit<
  InstallerOptions,
  "templateDirectory" | "transformTemplate" | "printSuccess"
>;
export function runAgentArtsInstaller(
  options?: AgentArtsInstallerOptions,
): Promise<InstallerResult>;
