import type {
  Assignment,
  Cell,
  Layer,
  RobotFailure,
  RobotSpec,
  Subtask,
  SubtaskResult,
  Telemetry,
  Vec2,
  WorldState,
} from "../fleet/types";
import { cellKey } from "../fleet/types";
import type { CbfBody, CbfConfig } from "./cbf";
import { applyCbfFilter, DEFAULT_CBF } from "./cbf";
import type { Grid } from "./grid";
import { neighbors } from "./grid";
import type { MapfAgent } from "./mapf";
import { planPaths } from "./mapf";

/**
 * Deterministic execution layer.
 *
 * Pipeline per PEFA round:
 *   assignments -> dependency waves -> MAPF (discrete, conflict-free)
 *   -> continuous path following -> CBF velocity filter -> integration.
 *
 * The LLM never sees this module's internals; it only receives the
 * SubtaskResult[] + Telemetry feedback that comes out of it.
 */

export interface ExecuteOptions {
  grid: Grid;
  fleet: RobotSpec[];
  world: WorldState;
  subtasks: Subtask[];
  assignments: Assignment[];
  /** subtask ids completed in previous rounds */
  alreadyCompleted: string[];
  /** injected breakdowns (sim-tick within this round) for failure drills */
  failures?: RobotFailure[];
  cbf?: Partial<CbfConfig>;
  dt?: number;
  maxTicksPerWave?: number;
}

export interface ExecuteReport {
  results: SubtaskResult[];
  world: WorldState;
  telemetry: Telemetry;
  events: string[];
}

interface ActiveRobot {
  spec: RobotSpec;
  p: Vec2;
  down: boolean;
  distance: number;
}

const WAYPOINT_EPS = 0.25;
const ARRIVAL_EPS = 0.3;

function desiredVelocity(robot: ActiveRobot, waypoints: Vec2[], wpIndex: number, dt: number): Vec2 {
  if (wpIndex >= waypoints.length) return { x: 0, y: 0 };
  const wp = waypoints[wpIndex];
  const dx = wp.x - robot.p.x;
  const dy = wp.y - robot.p.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) return { x: 0, y: 0 };
  const speed = Math.min(robot.spec.maxSpeed, dist / dt);
  return { x: (dx / dist) * speed, y: (dy / dist) * speed };
}

/** BFS to the nearest same-layer cell that is neither a wave target nor occupied. */
function findVacateCell(
  grid: Grid,
  from: Cell,
  layer: Layer,
  forbiddenTargets: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
): Cell | null {
  const seen = new Set<string>([cellKey(from)]);
  const queue: Cell[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of neighbors(grid, cur, layer)) {
      const k = cellKey(n);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!forbiddenTargets.has(k) && !occupied.has(k)) return n;
      queue.push(n);
    }
  }
  return null;
}

export function executeAssignments(opts: ExecuteOptions): ExecuteReport {
  const dt = opts.dt ?? 0.25;
  const maxTicksPerWave = opts.maxTicksPerWave ?? 800;
  const cbfCfg: CbfConfig = { ...DEFAULT_CBF, ...opts.cbf };

  const specById = new Map(opts.fleet.map((r) => [r.id, r]));
  const taskById = new Map(opts.subtasks.map((t) => [t.id, t]));
  const assignmentByTask = new Map(opts.assignments.map((a) => [a.subtaskId, a]));

  const robots = new Map<string, ActiveRobot>();
  for (const spec of opts.fleet) {
    const cell = opts.world.positions[spec.id] ?? spec.dock;
    robots.set(spec.id, {
      spec,
      p: { x: cell.x, y: cell.y },
      down: opts.world.downRobots.includes(spec.id),
      distance: 0,
    });
  }

  const completed = new Set(opts.alreadyCompleted);
  const results: SubtaskResult[] = [];
  const events: string[] = [];
  const resolved = new Set<string>(); // resolved this round (any status)
  const pendingFailures = [...(opts.failures ?? [])].sort((a, b) => a.atTick - b.atTick);

  let globalTick = 0;
  let waves = 0;
  let cbfInterventions = 0;
  let minSeparation = Infinity;

  const fail = (taskId: string, robotId: string | null, reason: string): void => {
    results.push({ subtaskId: taskId, robotId, status: "failed", reason, completedAtTick: null });
    resolved.add(taskId);
    events.push(`task ${taskId} FAILED: ${reason}`);
  };

  // tasks this round = assigned, not yet completed
  const pendingIds = new Set<string>();
  for (const t of opts.subtasks) {
    if (completed.has(t.id)) continue;
    pendingIds.add(t.id);
    const a = assignmentByTask.get(t.id);
    if (!a) {
      fail(t.id, null, "no robot assigned");
      continue;
    }
    if (!specById.has(a.robotId)) {
      fail(t.id, a.robotId, `unknown robot '${a.robotId}'`);
    }
  }

  for (;;) {
    // resolve blocked tasks: any dependency failed/blocked this round
    for (const id of pendingIds) {
      if (resolved.has(id)) continue;
      const t = taskById.get(id)!;
      const deadDep = t.dependsOn.find(
        (d) => resolved.has(d) && !completed.has(d) && taskById.has(d),
      );
      if (deadDep) {
        results.push({
          subtaskId: id,
          robotId: assignmentByTask.get(id)?.robotId ?? null,
          status: "blocked",
          reason: `dependency ${deadDep} did not complete`,
          completedAtTick: null,
        });
        resolved.add(id);
        events.push(`task ${id} BLOCKED on ${deadDep}`);
      }
    }

    // build next wave: deps satisfied, robot available, one task per robot
    const busy = new Set<string>();
    const wave: Array<{ task: Subtask; robotId: string }> = [];
    for (const id of pendingIds) {
      if (resolved.has(id)) continue;
      const t = taskById.get(id)!;
      if (!t.dependsOn.every((d) => completed.has(d) || !taskById.has(d))) continue;
      const a = assignmentByTask.get(id)!;
      if (busy.has(a.robotId)) continue;
      const robot = robots.get(a.robotId)!;
      if (robot.down) {
        fail(id, a.robotId, `robot ${a.robotId} is unresponsive`);
        continue;
      }
      busy.add(a.robotId);
      wave.push({ task: t, robotId: a.robotId });
    }

    if (wave.length === 0) {
      const unresolvedLeft = [...pendingIds].filter((id) => !resolved.has(id));
      for (const id of unresolvedLeft) {
        // unreachable deps (cycle or cross-round wait) -> blocked
        results.push({
          subtaskId: id,
          robotId: assignmentByTask.get(id)?.robotId ?? null,
          status: "blocked",
          reason: "dependencies not satisfiable this round",
          completedAtTick: null,
        });
        resolved.add(id);
      }
      break;
    }

    waves++;

    // MAPF: wave robots plan; everyone else is a static obstacle in its layer,
    // EXCEPT idle robots parked on an active target — those get a vacate move.
    const targetByLayer = new Map<"ground" | "air", Set<string>>([
      ["ground", new Set<string>()],
      ["air", new Set<string>()],
    ]);
    for (const { task, robotId } of wave) {
      targetByLayer.get(robots.get(robotId)!.spec.layer)!.add(cellKey(task.target));
    }
    const occupied = new Set<string>();
    for (const r of robots.values()) {
      occupied.add(cellKey({ x: Math.round(r.p.x), y: Math.round(r.p.y) }));
    }

    const yielders: MapfAgent[] = [];
    const staticByLayer = new Map<"ground" | "air", Set<string>>([
      ["ground", new Set<string>()],
      ["air", new Set<string>()],
    ]);
    for (const [id, r] of robots) {
      if (busy.has(id)) continue;
      const cell = { x: Math.round(r.p.x), y: Math.round(r.p.y) };
      const layer = r.spec.layer;
      if (!r.down && targetByLayer.get(layer)!.has(cellKey(cell))) {
        const refuge = findVacateCell(opts.grid, cell, layer, targetByLayer.get(layer)!, occupied);
        if (refuge) {
          yielders.push({ id, start: cell, goal: refuge, layer });
          events.push(`robot ${id} vacates (${cell.x},${cell.y}) for an incoming task`);
          continue;
        }
      }
      staticByLayer.get(layer)!.add(cellKey(cell));
    }
    const agents: MapfAgent[] = wave.map(({ task, robotId }) => {
      const r = robots.get(robotId)!;
      return {
        id: robotId,
        start: { x: Math.round(r.p.x), y: Math.round(r.p.y) },
        goal: task.target,
        layer: r.spec.layer,
      };
    });
    // yielders plan first so their escape routes are reserved before task
    // robots claim the corridor; task robots then route around them in time.
    const mapf = planPaths(opts.grid, [...yielders, ...agents], staticByLayer);

    const active = new Map<string, { taskId: string; waypoints: Vec2[]; wpIndex: number; target: Cell }>();
    for (const { task, robotId } of wave) {
      const path = mapf.paths.get(robotId);
      if (!path) {
        fail(task.id, robotId, "MAPF: no conflict-free path to target");
        continue;
      }
      active.set(robotId, {
        taskId: task.id,
        waypoints: path.map((c) => ({ x: c.x, y: c.y })),
        wpIndex: 0,
        target: task.target,
      });
    }

    const yieldMoves = new Map<string, { waypoints: Vec2[]; wpIndex: number }>();
    for (const y of yielders) {
      const path = mapf.paths.get(y.id);
      if (!path) continue; // boxed in: stays put, task robot's MAPF already failed
      yieldMoves.set(y.id, { waypoints: path.map((c) => ({ x: c.x, y: c.y })), wpIndex: 0 });
    }

    // continuous execution of the wave under the CBF supervisory filter
    let waveTick = 0;
    while (active.size > 0 && waveTick < maxTicksPerWave) {
      // injected breakdowns
      while (pendingFailures.length > 0 && pendingFailures[0].atTick <= globalTick) {
        const f = pendingFailures.shift()!;
        const r = robots.get(f.robotId);
        if (r && !r.down) {
          r.down = true;
          events.push(`tick ${globalTick}: robot ${f.robotId} became unresponsive`);
          const job = active.get(f.robotId);
          if (job) {
            fail(job.taskId, f.robotId, `robot ${f.robotId} became unresponsive mid-task`);
            active.delete(f.robotId);
          }
        }
      }

      const bodies: CbfBody[] = [];
      for (const [id, r] of robots) {
        const job = active.get(id);
        const yieldMove = yieldMoves.get(id);
        let v: Vec2 = { x: 0, y: 0 };
        if (!r.down && job) {
          v = desiredVelocity(r, job.waypoints, job.wpIndex, dt);
        } else if (!r.down && yieldMove) {
          v = desiredVelocity(r, yieldMove.waypoints, yieldMove.wpIndex, dt);
        }
        bodies.push({ id, layer: r.spec.layer, p: r.p, v, maxSpeed: r.spec.maxSpeed, down: r.down });
      }
      const outcome = applyCbfFilter(bodies, cbfCfg);
      cbfInterventions += outcome.interventions;
      minSeparation = Math.min(minSeparation, outcome.minSeparation);

      for (const [id, mv] of [...yieldMoves]) {
        const r = robots.get(id)!;
        if (r.down) {
          yieldMoves.delete(id);
          continue;
        }
        const v = outcome.velocities.get(id)!;
        r.p = { x: r.p.x + v.x * dt, y: r.p.y + v.y * dt };
        r.distance += Math.hypot(v.x * dt, v.y * dt);
        const wp = mv.waypoints[mv.wpIndex];
        if (wp && Math.hypot(wp.x - r.p.x, wp.y - r.p.y) < WAYPOINT_EPS) {
          mv.wpIndex++;
        }
        if (mv.wpIndex >= mv.waypoints.length) yieldMoves.delete(id);
      }

      for (const [id, job] of [...active]) {
        const r = robots.get(id)!;
        const v = outcome.velocities.get(id)!;
        r.p = { x: r.p.x + v.x * dt, y: r.p.y + v.y * dt };
        r.distance += Math.hypot(v.x * dt, v.y * dt);

        const wp = job.waypoints[job.wpIndex];
        if (wp && Math.hypot(wp.x - r.p.x, wp.y - r.p.y) < WAYPOINT_EPS) {
          job.wpIndex++;
        }
        if (Math.hypot(job.target.x - r.p.x, job.target.y - r.p.y) < ARRIVAL_EPS) {
          completed.add(job.taskId);
          resolved.add(job.taskId);
          results.push({
            subtaskId: job.taskId,
            robotId: id,
            status: "completed",
            reason: "target reached",
            completedAtTick: globalTick,
          });
          events.push(`tick ${globalTick}: task ${job.taskId} completed by ${id}`);
          active.delete(id);
        }
      }

      waveTick++;
      globalTick++;
    }

    for (const [id, job] of active) {
      fail(job.taskId, id, `wave timeout after ${maxTicksPerWave} ticks (possible deadlock)`);
    }
  }

  const positions: Record<string, Cell> = {};
  for (const [id, r] of robots) {
    positions[id] = { x: Math.round(r.p.x), y: Math.round(r.p.y) };
  }
  const perRobotDistance: Record<string, number> = {};
  for (const [id, r] of robots) perRobotDistance[id] = Number(r.distance.toFixed(2));

  return {
    results,
    world: {
      positions,
      downRobots: [...robots.entries()].filter(([, r]) => r.down).map(([id]) => id),
    },
    telemetry: {
      ticks: globalTick,
      waves,
      cbfInterventions,
      minSeparation: Number((minSeparation === Infinity ? -1 : minSeparation).toFixed(3)),
      perRobotDistance,
    },
    events,
  };
}
