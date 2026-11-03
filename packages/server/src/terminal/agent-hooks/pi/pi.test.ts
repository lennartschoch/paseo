import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentHooksAreInstalled,
  installAgentHooks,
  resolveAgentHookConfigPath,
  uninstallAgentHooks,
} from "../agent-hook-installer.js";
import { PI_EXTENSION_SOURCE } from "./pi-extension.js";
import { piAgentHookProvider } from "./pi.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

describe("Pi terminal agent hooks", () => {
  it("installs a self-contained Pi extension idempotently", () => {
    const configDir = createTempDir("paseo-pi-config-");

    const firstInstall = installAgentHooks(piAgentHookProvider, { configDir });
    const secondInstall = installAgentHooks(piAgentHookProvider, { configDir });

    expect(firstInstall.configPath).toBe(
      join(configDir, "extensions", "paseo-terminal-activity.js"),
    );
    expect(firstInstall.changed).toBe(true);
    expect(secondInstall.changed).toBe(false);
    expect(readFileSync(firstInstall.configPath, "utf8")).toBe(PI_EXTENSION_SOURCE);
    expect(agentHooksAreInstalled(piAgentHookProvider, { configDir })).toBe(true);
  });

  it("registers the lifecycle handlers and reports their events", async () => {
    const { pi, commands } = loadInstalledExtension();

    const handlers = pi.handlers;
    await handlers.agent_start();
    await handlers.agent_settled();
    await handlers.ui_prompt_start();
    await handlers.ui_prompt_end();

    expect(commands).toEqual([
      ["paseo", "hooks", "pi", "agent_start"],
      ["paseo", "hooks", "pi", "agent_settled"],
      ["paseo", "hooks", "pi", "ui_prompt_start"],
      ["paseo", "hooks", "pi", "ui_prompt_end"],
    ]);
  });

  it("reports through PASEO_HOOK_CLI when the daemon resolved one", async () => {
    const { pi, commands } = loadInstalledExtension({ PASEO_HOOK_CLI: "/opt/paseo/paseo" });

    await pi.handlers.agent_start();

    expect(commands).toEqual([["/opt/paseo/paseo", "hooks", "pi", "agent_start"]]);
  });

  it("keeps the extension inert outside Paseo terminals", async () => {
    const { pi, commands } = loadInstalledExtension({ PASEO_TERMINAL_ID: "" });

    await pi.handlers.agent_start();

    expect(commands).toEqual([]);
  });

  it("preserves activity order when events are dispatched concurrently", async () => {
    let finishFirstHook = () => {};
    const firstExit = new Promise<number>((resolve) => {
      finishFirstHook = () => resolve(0);
    });
    const { pi, commands } = loadInstalledExtension({}, firstExit);

    const working = pi.handlers.agent_start();
    const idle = pi.handlers.agent_settled();
    await Promise.resolve();
    expect(commands).toEqual([["paseo", "hooks", "pi", "agent_start"]]);

    finishFirstHook();
    await Promise.all([working, idle]);
    expect(commands).toEqual([
      ["paseo", "hooks", "pi", "agent_start"],
      ["paseo", "hooks", "pi", "agent_settled"],
    ]);
  });

  it("uninstalls the Pi extension file", () => {
    const configDir = createTempDir("paseo-pi-config-uninstall-");
    const configPath = resolveAgentHookConfigPath(piAgentHookProvider, { configDir });
    installAgentHooks(piAgentHookProvider, { configDir });

    const result = uninstallAgentHooks(piAgentHookProvider, { configDir });

    expect(result).toEqual({ configPath, changed: true });
    expect(existsSync(configPath)).toBe(false);
    expect(agentHooksAreInstalled(piAgentHookProvider, { configDir })).toBe(false);
  });

  it("prefers PI_CODING_AGENT_DIR over the home agent dir", () => {
    const homeDir = createTempDir("paseo-home-");
    const configDir = createTempDir("paseo-pi-override-");

    const configPath = resolveAgentHookConfigPath(piAgentHookProvider, {
      env: { PI_CODING_AGENT_DIR: configDir },
      homeDir,
    });

    expect(configPath).toBe(join(configDir, "extensions", "paseo-terminal-activity.js"));
  });

  it("uses the home .pi/agent dir without PI_CODING_AGENT_DIR", () => {
    const homeDir = createTempDir("paseo-home-");

    const configPath = resolveAgentHookConfigPath(piAgentHookProvider, {
      env: {},
      homeDir,
    });

    expect(configPath).toBe(
      join(homeDir, ".pi", "agent", "extensions", "paseo-terminal-activity.js"),
    );
  });

  it.each([
    ["agent_start", "running"],
    ["agent_settled", "idle"],
    ["ui_prompt_start", "needs-input"],
    ["ui_prompt_end", "running"],
  ] as const)("maps %s to %s", async (event, state) => {
    await expect(
      piAgentHookProvider.resolveActivity({ event, input: { read: async () => null } }),
    ).resolves.toBe(state);
  });
});

interface InstalledExtension {
  pi: PiHarness;
  commands: string[][];
}

interface PiHarness {
  handlers: Record<string, () => Promise<void>>;
}

function loadInstalledExtension(
  env: Record<string, string> = {},
  exited = Promise.resolve(0),
): InstalledExtension {
  const configDir = createTempDir("paseo-pi-runtime-");
  const { configPath } = installAgentHooks(piAgentHookProvider, { configDir });
  const source = readFileSync(configPath, "utf8");
  const commands: string[][] = [];
  const handlers: Record<string, () => Promise<void>> = {};
  const context = {
    process: {
      env: { PASEO_TERMINAL_ID: "terminal-1", ...env },
    },
    require(id: string) {
      if (id !== "node:child_process") throw new Error(`Unexpected require: ${id}`);
      return {
        spawn(command: string, args: string[]) {
          commands.push([command, ...args]);
          return {
            once(event: string, listener: () => void) {
              if (event === "exit") void exited.then(listener);
            },
          };
        },
      };
    },
    module: { exports: {} },
  };
  runInNewContext(source, context);
  const factory = context.module.exports as (pi: {
    on(event: string, handler: () => Promise<void>): void;
  }) => void;
  factory({
    on(event, handler) {
      handlers[event] = handler;
    },
  });
  return { pi: { handlers }, commands };
}
