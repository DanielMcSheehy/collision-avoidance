import type { Cell, Layer } from "../fleet/types";
import { cellKey } from "../fleet/types";
import type { Grid } from "./grid";
import { isBlocked, manhattan, neighbors } from "./grid";

/**
 * Multi-Agent Path Finding: prioritized planning with space-time A* over a
 * per-layer reservation table (vertex + edge/swap conflicts), plus a
 * CBS-lite fallback that reorders priorities when an agent cannot be routed.
 *
 * Ground and air are independent layers: a UAV never conflicts with a UGV.
 * Static robots (not part of the current wave) are permanent obstacles in
 * their layer.
 */

export interface MapfAgent {
  id: string;
  start: Cell;
  goal: Cell;
  layer: Layer;
}

export interface MapfOptions {
  /** hard cap on path length in timesteps */
  horizon?: number;
  /** max priority reorderings to attempt before giving up on an agent */
  maxReorders?: number;
}

export interface MapfResult {
  /** timestep-indexed cell sequences; paths[id][t] is the cell at step t */
  paths: Map<string, Cell[]>;
  /** agents for which no conflict-free path exists under any tried ordering */
  failed: string[];
}

interface Reservations {
  /** `${t}:${x},${y}` occupied vertices */
  vertex: Set<string>;
  /** `${t}:${fromKey}>${toKey}` traversed edges (for swap detection) */
  edge: Set<string>;
  /** cellKey -> timestep from which the cell is permanently parked on */
  parkedFrom: Map<string, number>;
  /** latest timestep any reservation touches a given cell (goal-wait rule) */
  lastTouched: Map<string, number>;
}

function emptyReservations(): Reservations {
  return { vertex: new Set(), edge: new Set(), parkedFrom: new Map(), lastTouched: new Map() };
}

function reservePath(res: Reservations, path: Cell[], horizon: number): void {
  for (let t = 0; t < path.length; t++) {
    const k = cellKey(path[t]);
    res.vertex.add(`${t}:${k}`);
    res.lastTouched.set(k, Math.max(res.lastTouched.get(k) ?? 0, t));
    if (t > 0) {
      res.edge.add(`${t - 1}:${cellKey(path[t - 1])}>${k}`);
    }
  }
  const goalKey = cellKey(path[path.length - 1]);
  res.parkedFrom.set(goalKey, path.length - 1);
  res.lastTouched.set(goalKey, horizon);
}

interface Node {
  cell: Cell;
  t: number;
  f: number;
  parent: Node | null;
}

/** Binary min-heap on f; FIFO tiebreak is irrelevant for correctness. */
class Heap {
  private items: Node[] = [];
  get size(): number {
    return this.items.length;
  }
  push(n: Node): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function spaceTimeAStar(
  grid: Grid,
  agent: MapfAgent,
  res: Reservations,
  staticCells: Set<string>,
  horizon: number,
): Cell[] | null {
  if (isBlocked(grid, agent.goal, agent.layer) || staticCells.has(cellKey(agent.goal))) {
    return null;
  }
  const goalKey = cellKey(agent.goal);
  if (res.parkedFrom.has(goalKey)) return null; // someone parks on our goal forever
  const earliestStop = res.lastTouched.get(goalKey) ?? 0;

  const open = new Heap();
  const seen = new Set<string>();
  open.push({ cell: agent.start, t: 0, f: manhattan(agent.start, agent.goal), parent: null });

  while (open.size > 0) {
    const cur = open.pop();
    const curKey = cellKey(cur.cell);
    const stateKey = `${cur.t}:${curKey}`;
    if (seen.has(stateKey)) continue;
    seen.add(stateKey);

    if (curKey === goalKey && cur.t >= earliestStop) {
      const path: Cell[] = [];
      for (let n: Node | null = cur; n; n = n.parent) path.push(n.cell);
      return path.reverse();
    }
    if (cur.t >= horizon) continue;

    const candidates = [...neighbors(grid, cur.cell, agent.layer), cur.cell]; // moves + wait
    for (const next of candidates) {
      const nk = cellKey(next);
      const nt = cur.t + 1;
      if (staticCells.has(nk)) continue;
      if (res.vertex.has(`${nt}:${nk}`)) continue;
      const parked = res.parkedFrom.get(nk);
      if (parked !== undefined && nt >= parked) continue;
      // swap conflict: someone moves next->cur exactly when we move cur->next
      if (res.edge.has(`${cur.t}:${nk}>${curKey}`)) continue;
      if (seen.has(`${nt}:${nk}`)) continue;
      open.push({ cell: next, t: nt, f: nt + manhattan(next, agent.goal), parent: cur });
    }
  }
  return null;
}

function planWithOrder(
  grid: Grid,
  agents: MapfAgent[],
  staticByLayer: Map<Layer, Set<string>>,
  horizon: number,
): MapfResult {
  const resByLayer: Record<Layer, Reservations> = {
    ground: emptyReservations(),
    air: emptyReservations(),
  };
  const paths = new Map<string, Cell[]>();
  const failed: string[] = [];
  for (const agent of agents) {
    const statics = staticByLayer.get(agent.layer) ?? new Set<string>();
    const path = spaceTimeAStar(grid, agent, resByLayer[agent.layer], statics, horizon);
    if (path === null) {
      failed.push(agent.id);
      // failed agent still occupies its start cell: park it so others route around
      reservePath(resByLayer[agent.layer], [agent.start], horizon);
      continue;
    }
    reservePath(resByLayer[agent.layer], path, horizon);
    paths.set(agent.id, path);
  }
  return { paths, failed };
}

export function planPaths(
  grid: Grid,
  agents: MapfAgent[],
  staticByLayer: Map<Layer, Set<string>>,
  opts: MapfOptions = {},
): MapfResult {
  const horizon = opts.horizon ?? grid.width * grid.height * 2;
  const maxReorders = opts.maxReorders ?? agents.length;

  let order = [...agents];
  let best = planWithOrder(grid, order, staticByLayer, horizon);
  let attempts = 0;
  // CBS-lite: promote the first failed agent to highest priority and replan.
  while (best.failed.length > 0 && attempts < maxReorders) {
    const failedId = best.failed[0];
    const idx = order.findIndex((a) => a.id === failedId);
    if (idx <= 0) break; // already highest priority and still failing -> genuinely stuck
    order = [order[idx], ...order.slice(0, idx), ...order.slice(idx + 1)];
    const retry = planWithOrder(grid, order, staticByLayer, horizon);
    if (retry.failed.length < best.failed.length) best = retry;
    attempts++;
    if (retry.failed.length === 0) return retry;
  }
  return best;
}
