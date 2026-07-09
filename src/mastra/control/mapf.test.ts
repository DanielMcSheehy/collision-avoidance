import { describe, test, expect } from "bun:test";
import type { Cell, Layer } from "../fleet/types";
import { cellKey } from "../fleet/types";
import { defaultWarehouse, makeGrid, manhattan } from "./grid";
import type { Grid } from "./grid";
import { planPaths } from "./mapf";
import type { MapfAgent, MapfResult } from "./mapf";

const NO_STATICS = new Map<Layer, Set<string>>();

/** Build a grid whose free cells are exactly `free`; everything else is a rack. */
function gridFromFree(width: number, height: number, free: Cell[]): Grid {
  const freeset = new Set(free.map(cellKey));
  const obstacles: Cell[] = [];
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (!freeset.has(cellKey({ x, y }))) obstacles.push({ x, y });
    }
  }
  return makeGrid(width, height, obstacles);
}

/**
 * Independent conflict checker: walks every same-layer path pair across the
 * longest path length, clamping a finished agent to its (parked) goal cell,
 * and returns a human-readable description of every vertex/swap conflict found.
 * A conflict-free plan yields [].
 */
function findConflicts(result: MapfResult, agents: MapfAgent[]): string[] {
  const conflicts: string[] = [];
  const byLayer = new Map<Layer, MapfAgent[]>();
  for (const a of agents) {
    if (!result.paths.has(a.id)) continue;
    const arr = byLayer.get(a.layer) ?? [];
    arr.push(a);
    byLayer.set(a.layer, arr);
  }
  for (const [layer, group] of byLayer) {
    const maxLen = Math.max(...group.map((a) => result.paths.get(a.id)!.length));
    const at = (id: string, t: number): Cell => {
      const path = result.paths.get(id)!;
      return t < path.length ? path[t] : path[path.length - 1];
    };
    for (let t = 0; t < maxLen; t++) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const ai = group[i].id;
          const aj = group[j].id;
          const ci = at(ai, t);
          const cj = at(aj, t);
          if (ci.x === cj.x && ci.y === cj.y) {
            conflicts.push(`${layer} vertex conflict: ${ai} & ${aj} both at (${ci.x},${ci.y}) @t=${t}`);
          }
          if (t + 1 < maxLen) {
            const ni = at(ai, t + 1);
            const nj = at(aj, t + 1);
            const swap = ci.x === nj.x && ci.y === nj.y && cj.x === ni.x && cj.y === ni.y && (ci.x !== cj.x || ci.y !== cj.y);
            if (swap) {
              conflicts.push(`${layer} swap conflict: ${ai} & ${aj} exchange (${ci.x},${ci.y})<->(${cj.x},${cj.y}) @t=${t}`);
            }
          }
        }
      }
    }
  }
  return conflicts;
}

function assertEndpoints(result: MapfResult, agents: MapfAgent[]): void {
  for (const a of agents) {
    const path = result.paths.get(a.id);
    if (!path) continue;
    expect(path[0]).toEqual(a.start);
    expect(path[path.length - 1]).toEqual(a.goal);
  }
}

describe("planPaths conflict-freedom", () => {
  test("two ground agents swapping endpoints stay conflict-free via a detour cell", () => {
    // 3x3 open grid: the middle-row swap forces the pair to interact.
    const grid = makeGrid(3, 3, []);
    const agents: MapfAgent[] = [
      { id: "A", start: { x: 0, y: 1 }, goal: { x: 2, y: 1 }, layer: "ground" },
      { id: "B", start: { x: 2, y: 1 }, goal: { x: 0, y: 1 }, layer: "ground" },
    ];
    const result = planPaths(grid, agents, NO_STATICS);
    expect(result.failed).toEqual([]);
    expect(findConflicts(result, agents)).toEqual([]);
    assertEndpoints(result, agents);
    // a real swap must have happened: someone left the shared middle row
    const paths = [...result.paths.values()];
    const detoured = paths.some((p) => p.some((c) => c.y !== 1));
    expect(detoured).toBe(true);
  });

  test("four ground agents crossing a small open grid produce conflict-free paths", () => {
    const grid = makeGrid(4, 4, []);
    const agents: MapfAgent[] = [
      { id: "A", start: { x: 0, y: 0 }, goal: { x: 3, y: 3 }, layer: "ground" },
      { id: "B", start: { x: 3, y: 3 }, goal: { x: 0, y: 0 }, layer: "ground" },
      { id: "C", start: { x: 3, y: 0 }, goal: { x: 0, y: 3 }, layer: "ground" },
      { id: "D", start: { x: 0, y: 3 }, goal: { x: 3, y: 0 }, layer: "ground" },
    ];
    const result = planPaths(grid, agents, NO_STATICS);
    expect(result.failed).toEqual([]);
    expect(result.paths.size).toBe(4);
    expect(findConflicts(result, agents)).toEqual([]);
    assertEndpoints(result, agents);
  });

  test("ground paths never enter a rack cell", () => {
    const grid = defaultWarehouse();
    // route a ground robot from left of the left rack to its right side
    const agents: MapfAgent[] = [
      { id: "A", start: { x: 5, y: 4 }, goal: { x: 8, y: 4 }, layer: "ground" },
    ];
    const result = planPaths(grid, agents, NO_STATICS);
    expect(result.failed).toEqual([]);
    const path = result.paths.get("A")!;
    for (const c of path) {
      expect(grid.obstacles.has(cellKey(c))).toBe(false);
    }
  });
});

describe("planPaths CBS-lite reordering", () => {
  test("rescues a low-priority agent that the default order boxes in", () => {
    // 4x2 corridor with a single passing alcove at (1,0). With A planned first
    // it sweeps the corridor and B has no gap; promoting B to highest priority
    // (the CBS-lite retry) lets A duck into the alcove instead.
    const grid = gridFromFree(4, 2, [
      { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 0 },
    ]);
    const agents: MapfAgent[] = [
      { id: "A", start: { x: 0, y: 1 }, goal: { x: 3, y: 1 }, layer: "ground" },
      { id: "B", start: { x: 3, y: 1 }, goal: { x: 0, y: 1 }, layer: "ground" },
    ];
    // no reordering allowed -> the boxed-in agent genuinely fails
    const noReorder = planPaths(grid, agents, NO_STATICS, { maxReorders: 0 });
    expect(noReorder.failed).toContain("B");

    // default reordering rescues everyone, and the rescued plan is conflict-free
    const rescued = planPaths(grid, agents, NO_STATICS);
    expect(rescued.failed).toEqual([]);
    expect(rescued.paths.size).toBe(2);
    expect(findConflicts(rescued, agents)).toEqual([]);
    assertEndpoints(rescued, agents);
  });
});

describe("planPaths blocking", () => {
  test("agent whose goal is a static cell is reported as failed with no path", () => {
    const grid = makeGrid(5, 5, []);
    const statics = new Map<Layer, Set<string>>([["ground", new Set([cellKey({ x: 4, y: 4 })])]]);
    const agents: MapfAgent[] = [
      { id: "A", start: { x: 0, y: 0 }, goal: { x: 4, y: 4 }, layer: "ground" },
    ];
    const result = planPaths(grid, agents, statics);
    expect(result.failed).toEqual(["A"]);
    expect(result.paths.has("A")).toBe(false);
  });

  test("a static cell forces a detour rather than passing straight through it", () => {
    const grid = makeGrid(3, 3, []);
    const statics = new Map<Layer, Set<string>>([["ground", new Set([cellKey({ x: 1, y: 0 })])]]);
    const agents: MapfAgent[] = [
      { id: "A", start: { x: 0, y: 0 }, goal: { x: 2, y: 0 }, layer: "ground" },
    ];
    const result = planPaths(grid, agents, statics);
    expect(result.failed).toEqual([]);
    const path = result.paths.get("A")!;
    expect(path.some((c) => c.x === 1 && c.y === 0)).toBe(false);
    expect(path[path.length - 1]).toEqual({ x: 2, y: 0 });
  });
});

describe("planPaths air layer", () => {
  test("air agents overfly racks: shortest path length equals Manhattan distance + 1", () => {
    const grid = defaultWarehouse();
    // start and goal are both rack cells for the ground layer; air ignores them
    const start = { x: 6, y: 2 };
    const goal = { x: 15, y: 13 };
    const agents: MapfAgent[] = [{ id: "U", start, goal, layer: "air" }];
    const result = planPaths(grid, agents, NO_STATICS);
    expect(result.failed).toEqual([]);
    const path = result.paths.get("U")!;
    expect(path.length).toBe(manhattan(start, goal) + 1);
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(goal);
  });

  test("air and ground agents share cells without conflicting (separate layers)", () => {
    const grid = makeGrid(5, 5, []);
    const agents: MapfAgent[] = [
      { id: "G", start: { x: 0, y: 2 }, goal: { x: 4, y: 2 }, layer: "ground" },
      { id: "U", start: { x: 4, y: 2 }, goal: { x: 0, y: 2 }, layer: "air" },
    ];
    const result = planPaths(grid, agents, NO_STATICS);
    expect(result.failed).toEqual([]);
    // both take the straight middle row despite crossing head-on: layers do not interact
    expect(result.paths.get("G")!.every((c) => c.y === 2)).toBe(true);
    expect(result.paths.get("U")!.every((c) => c.y === 2)).toBe(true);
    // cross-layer overlaps must NOT be flagged by the same-layer checker
    expect(findConflicts(result, agents)).toEqual([]);
  });
});
