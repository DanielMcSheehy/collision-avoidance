import type { Cell, Layer } from "../fleet/types";
import { cellKey } from "../fleet/types";

export interface Grid {
  width: number;
  height: number;
  /** static obstacles; block the ground layer only (UAVs overfly them) */
  obstacles: Set<string>;
}

export function makeGrid(width: number, height: number, obstacles: Cell[]): Grid {
  return { width, height, obstacles: new Set(obstacles.map(cellKey)) };
}

export function inBounds(g: Grid, c: Cell): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < g.width && c.y < g.height;
}

export function isBlocked(g: Grid, c: Cell, layer: Layer): boolean {
  if (!inBounds(g, c)) return true;
  return layer === "ground" && g.obstacles.has(cellKey(c));
}

const MOVES: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

export function neighbors(g: Grid, c: Cell, layer: Layer): Cell[] {
  const out: Cell[] = [];
  for (const m of MOVES) {
    const n = { x: c.x + m.x, y: c.y + m.y };
    if (!isBlocked(g, n, layer)) out.push(n);
  }
  return out;
}

export const manhattan = (a: Cell, b: Cell): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * Demo warehouse: 24x16 cells, four shelf racks leaving corridors.
 * Ground robots must route around racks; UAVs overfly them.
 */
export function defaultWarehouse(): Grid {
  const obstacles: Cell[] = [];
  const racks: Array<[number, number, number, number]> = [
    // [x0, x1, y0, y1]
    [6, 7, 2, 6],
    [6, 7, 9, 13],
    [14, 15, 2, 6],
    [14, 15, 9, 13],
  ];
  for (const [x0, x1, y0, y1] of racks) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) obstacles.push({ x, y });
    }
  }
  return makeGrid(24, 16, obstacles);
}

/** Compact ASCII map for LLM prompts: '.' free, '#' rack (ground-blocked). */
export function renderGrid(g: Grid, marks: Record<string, Cell> = {}): string {
  const markAt = new Map<string, string>();
  for (const [label, c] of Object.entries(marks)) {
    markAt.set(cellKey(c), label.slice(0, 1).toUpperCase());
  }
  const rows: string[] = [];
  for (let y = g.height - 1; y >= 0; y--) {
    let row = "";
    for (let x = 0; x < g.width; x++) {
      const k = cellKey({ x, y });
      row += markAt.get(k) ?? (g.obstacles.has(k) ? "#" : ".");
    }
    rows.push(`${String(y).padStart(2)} ${row}`);
  }
  rows.push(`   ${Array.from({ length: g.width }, (_, i) => (i % 10 === 0 ? String(i / 10) : " ")).join("")}`);
  rows.push(`   ${Array.from({ length: g.width }, (_, i) => String(i % 10)).join("")}`);
  return rows.join("\n");
}
