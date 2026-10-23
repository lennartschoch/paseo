import { describe, expect, test } from "vitest";

import {
  createTerminalScrollKeySequence,
  resolveTerminalGestureCell,
  resolveTerminalScrollRoute,
} from "./terminal-scroll-routing";

describe("native terminal scroll routing", () => {
  test("an app that reports the mouse is scrolled by wheel events", () => {
    expect(
      resolveTerminalScrollRoute({ reportsMouseEvents: true, isAlternateBuffer: true }),
    ).toEqual("wheel");
    expect(
      resolveTerminalScrollRoute({ reportsMouseEvents: true, isAlternateBuffer: false }),
    ).toEqual("wheel");
  });

  test("a normal-buffer app without mouse reporting keeps the client viewport scroll", () => {
    expect(
      resolveTerminalScrollRoute({ reportsMouseEvents: false, isAlternateBuffer: false }),
    ).toEqual("buffer");
  });

  test("an alternate-buffer app without mouse reporting is scrolled by keys", () => {
    expect(
      resolveTerminalScrollRoute({ reportsMouseEvents: false, isAlternateBuffer: true }),
    ).toEqual("keys");
  });
});

describe("native terminal gesture cell", () => {
  test("maps a gesture point to the cell under the finger", () => {
    expect(
      resolveTerminalGestureCell({
        x: 100,
        y: 38 * 4 + 1,
        cellWidth: 10,
        cellHeight: 38,
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ col: 10, row: 4 });
  });

  test("clamps to the visible grid", () => {
    expect(
      resolveTerminalGestureCell({
        x: 10_000,
        y: 10_000,
        cellWidth: 10,
        cellHeight: 38,
        cols: 80,
        rows: 24,
      }),
    ).toEqual({ col: 79, row: 23 });
  });

  test("rejects points outside the grid or without measurable cells", () => {
    const grid = { cellWidth: 10, cellHeight: 38, cols: 80, rows: 24 };

    expect(resolveTerminalGestureCell({ ...grid, x: -1, y: 0 })).toBeNull();
    expect(resolveTerminalGestureCell({ ...grid, x: 0, y: -1 })).toBeNull();
    expect(
      resolveTerminalGestureCell({
        x: 0,
        y: 0,
        cellWidth: 0,
        cellHeight: 38,
        cols: 80,
        rows: 24,
      }),
    ).toBeNull();
  });
});

describe("native terminal scroll keys", () => {
  test("sends one arrow key per scrolled row", () => {
    expect(
      createTerminalScrollKeySequence({
        direction: "up",
        rows: 3,
        applicationCursorKeys: false,
      }),
    ).toEqual("\u001b[A\u001b[A\u001b[A");
    expect(
      createTerminalScrollKeySequence({
        direction: "down",
        rows: 1,
        applicationCursorKeys: false,
      }),
    ).toEqual("\u001b[B");
  });

  test("uses the application cursor key encoding while it is set", () => {
    expect(
      createTerminalScrollKeySequence({
        direction: "up",
        rows: 2,
        applicationCursorKeys: true,
      }),
    ).toEqual("\u001bOA\u001bOA");
  });

  test("sends nothing for zero rows", () => {
    expect(
      createTerminalScrollKeySequence({
        direction: "up",
        rows: 0,
        applicationCursorKeys: false,
      }),
    ).toEqual("");
  });
});
