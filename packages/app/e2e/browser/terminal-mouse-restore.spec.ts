import { test, expect } from "../support/fixtures";
import { TerminalE2EHarness, type TerminalInstance } from "../support/helpers/terminal-dsl";
import { readTerminalBufferType, withMouseTerminal } from "../support/helpers/terminal-mouse";
import { waitForTerminalContent } from "../support/helpers/terminal-perf";

/**
 * Regression: mouse tracking must survive the terminal restore that happens when
 * the client re-attaches.
 *
 * A restore repaints the snapshot after sending RIS (`\x1bc`), which clears every
 * DEC private mode, then replays a small "input mode" preamble. The preamble used
 * to omit mouse tracking, so a TUI that relies on mouse reporting (Claude Code)
 * lost wheel scrolling after a restore until it re-asserted the mode itself.
 */
test.describe("terminal mouse tracking across a restore", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-mouse-restore" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("the wheel keeps reporting after the terminal re-attaches", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    await withMouseTerminal(page, harness, async (terminal) => {
      await terminal.enableMouse();
      expect(await terminal.wheelReportsToApp()).toBe(true);

      await terminal.reattach();

      expect(await terminal.wheelReportsToApp()).toBe(true);
    });
  });
});

/**
 * Regression: the alternate screen must survive the restore too.
 *
 * RIS drops the alternate screen along with the DEC modes, and the program has no
 * reason to enter it a second time. Repainted into the normal buffer, a TUI keeps
 * writing frames there, and the wheel scrolls those stale frames instead of the
 * program scrolling its own transcript.
 */
const ALT_SCREEN_PROGRAM = [
  "process.stdin.setRawMode?.(true);",
  "process.stdin.resume();",
  'process.stdout.write("\u001b[?1049h");',
  'process.stdout.write("ALT_READY\r\n");',
  "setInterval(function () {}, 1000);",
].join("\n");

test.describe("terminal alternate screen across a restore", () => {
  let harness: TerminalE2EHarness;

  test.beforeEach(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-altscreen-restore" });
  });

  test.afterEach(async () => {
    await harness.cleanup();
  });

  test("the client stays on the alternate screen after re-attaching", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    const instance: TerminalInstance = await harness.createTerminal({
      name: "altscreen",
      command: process.execPath,
      args: ["-e", ALT_SCREEN_PROGRAM],
    });
    try {
      await harness.openTerminal(page, { terminalId: instance.id });
      await waitForTerminalContent(page, (text) => text.includes("ALT_READY"), 20_000);
      await expect.poll(() => readTerminalBufferType(page), { timeout: 10_000 }).toBe("alternate");

      await harness.openTerminal(page, { terminalId: instance.id });
      await waitForTerminalContent(page, (text) => text.includes("ALT_READY"), 20_000);

      await expect.poll(() => readTerminalBufferType(page), { timeout: 10_000 }).toBe("alternate");
    } finally {
      await harness.killTerminal(instance.id);
    }
  });
});
