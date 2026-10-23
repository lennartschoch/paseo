import type { TerminalWheelDirection } from "./headless-terminal-state";

/**
 * Where a vertical scroll gesture goes. Mirrors `MouseService._handleTouchChange` in
 * `@xterm/xterm`: an app that asked for mouse reports is scrolled by wheel events, an
 * app in the normal buffer is scrolled by the client's own viewport, and an app in the
 * alternate buffer that wants no mouse is scrolled by arrow keys.
 */
export type TerminalScrollRoute = "wheel" | "buffer" | "keys";

export interface TerminalScrollRouteInput {
  reportsMouseEvents: boolean;
  isAlternateBuffer: boolean;
}

export function resolveTerminalScrollRoute(input: TerminalScrollRouteInput): TerminalScrollRoute {
  if (input.reportsMouseEvents) {
    return "wheel";
  }
  if (!input.isAlternateBuffer) {
    return "buffer";
  }
  return "keys";
}

export interface TerminalGestureCellInput {
  x: number;
  y: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
}

export interface TerminalGridCell {
  col: number;
  row: number;
}

/**
 * Cell under a gesture point, in screen (not buffer) coordinates: mouse reports address
 * the visible grid, so a scrolled viewport has to report what the user is pointing at.
 */
export function resolveTerminalGestureCell(
  input: TerminalGestureCellInput,
): TerminalGridCell | null {
  if (
    input.cellWidth <= 0 ||
    input.cellHeight <= 0 ||
    input.cols <= 0 ||
    input.rows <= 0 ||
    input.x < 0 ||
    input.y < 0
  ) {
    return null;
  }
  return {
    col: clamp(Math.floor(input.x / input.cellWidth), 0, input.cols - 1),
    row: clamp(Math.floor(input.y / input.cellHeight), 0, input.rows - 1),
  };
}

export interface TerminalScrollKeysInput {
  direction: TerminalWheelDirection;
  rows: number;
  applicationCursorKeys: boolean;
}

/**
 * One arrow key per scrolled row. Alternate-screen apps without mouse reporting — pagers,
 * REPLs — only move their own history through the arrow keys.
 */
export function createTerminalScrollKeySequence(input: TerminalScrollKeysInput): string {
  if (input.rows <= 0) {
    return "";
  }
  const key = input.direction === "up" ? "A" : "B";
  const sequence = `\u001b${input.applicationCursorKeys ? "O" : "["}${key}`;
  return sequence.repeat(Math.floor(input.rows));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
