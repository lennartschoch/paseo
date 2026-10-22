import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

function readTerminalBufferType(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terminal = (
      window as Window & {
        __paseoTerminal?: { buffer: { active: { type: string } } };
      }
    ).__paseoTerminal;
    return terminal?.buffer.active.type ?? "";
  });
}

function readNormalBufferText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terminal = (
      window as Window & {
        __paseoTerminal?: {
          buffer: {
            normal: {
              length: number;
              getLine: (
                index: number,
              ) => { translateToString: (trimRight?: boolean) => string } | undefined;
            };
          };
        };
      }
    ).__paseoTerminal;
    const buffer = terminal?.buffer.normal;
    if (!buffer) return "";
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  });
}

/**
 * Regression: the alternate screen must survive a terminal restore.
 *
 * A restore repaints the snapshot after sending RIS (`\x1bc`), which clears the
 * alternate screen as well as the DEC modes. A TUI has no reason to enter the
 * alternate screen again, so without recording the buffer the snapshot is painted
 * into the normal buffer and the app's later frames land in scrollback.
 */
test.describe("terminal alternate screen across a restore", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-altscreen-restore" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("the client stays on the alternate screen after re-attaching", async ({ page }) => {
    const instance = await harness.createTerminal({ name: "altscreen" });
    try {
      await harness.openTerminal(page, { terminalId: instance.id });
      await harness.setupPrompt(page);

      // Enter the alternate screen from a normal shell, then keep the foreground
      // process alive so the re-attach sees a live TUI rather than a fresh terminal.
      await harness
        .terminalSurface(page)
        .first()
        .pressSequentially(
          "printf 'NORMAL_UNDER_TUI\\n'; printf '\\033[?1049hALT_READY\\n'; sleep 300\n",
          { delay: 0 },
        );
      await waitForTerminalContent(page, (text) => text.includes("ALT_READY"), 20_000);
      await expect.poll(() => readTerminalBufferType(page), { timeout: 10_000 }).toBe("alternate");

      await harness.openTerminal(page, { terminalId: instance.id });
      await waitForTerminalContent(page, (text) => text.includes("ALT_READY"), 20_000);

      await expect.poll(() => readTerminalBufferType(page), { timeout: 10_000 }).toBe("alternate");
      // The normal buffer is the shell history the TUI is covering. It must be
      // restored underneath the alternate screen, not left empty.
      await expect
        .poll(() => readNormalBufferText(page), { timeout: 10_000 })
        .toContain("NORMAL_UNDER_TUI");
    } finally {
      await harness.killTerminal(instance.id);
    }
  });
});
