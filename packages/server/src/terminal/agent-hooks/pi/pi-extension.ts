import type { AgentHookPluginFileInstallStrategy } from "../agent-hook-installer.js";

// Pi loads this through jiti, so a plain CJS .js file works and `require` is
// available. Keep the queue so an older agent_start report cannot land after a
// later agent_settled report when CLI processes finish out of order.
export const PI_EXTENSION_SOURCE = [
  'const { spawn } = require("node:child_process");',
  "",
  "let pendingHook = Promise.resolve();",
  "",
  "function runPaseoHook(event) {",
  "  if (!process.env.PASEO_TERMINAL_ID) return;",
  "  pendingHook = pendingHook.then(async () => {",
  "    try {",
  '      const child = spawn(process.env.PASEO_HOOK_CLI || "paseo", ["hooks", "pi", event], {',
  '        stdio: "ignore",',
  "      });",
  "      await new Promise((resolve) => {",
  '        child.once("exit", resolve);',
  '        child.once("error", resolve);',
  "      });",
  "    } catch {}",
  "  });",
  "  return pendingHook;",
  "}",
  "",
  "module.exports = function paseoTerminalActivity(pi) {",
  '  pi.on("agent_start", () => runPaseoHook("agent_start"));',
  '  pi.on("agent_settled", () => runPaseoHook("agent_settled"));',
  '  pi.on("ui_prompt_start", () => runPaseoHook("ui_prompt_start"));',
  '  pi.on("ui_prompt_end", () => runPaseoHook("ui_prompt_end"));',
  "};",
  "",
].join("\n");

export function createPiExtensionInstallStrategy(): AgentHookPluginFileInstallStrategy {
  return {
    kind: "plugin-file",
    configDir: ".pi/agent",
    configFile: "extensions/paseo-terminal-activity.js",
    configDirEnvOverride: "PI_CODING_AGENT_DIR",
    hookMarker: "paseo hooks pi",
    source: PI_EXTENSION_SOURCE,
  };
}
