import type { AgentHookActivityState, AgentHookProvider } from "../agent-hook-installer.js";
import { createPiExtensionInstallStrategy } from "./pi-extension.js";

// `agent_end` is not a final-idle signal (queued messages, retries, and
// compaction can start another run), so idle comes from `agent_settled`.
const PI_EVENT_STATES: Record<string, AgentHookActivityState> = {
  agent_start: "running",
  agent_settled: "idle",
  ui_prompt_start: "needs-input",
  ui_prompt_end: "running",
};

export const piAgentHookProvider: AgentHookProvider = {
  id: "pi",
  events: [
    { event: "agent_start" },
    { event: "agent_settled" },
    { event: "ui_prompt_start" },
    { event: "ui_prompt_end" },
  ],
  install: createPiExtensionInstallStrategy(),
  async resolveActivity({ event }) {
    return PI_EVENT_STATES[event] ?? null;
  },
};
