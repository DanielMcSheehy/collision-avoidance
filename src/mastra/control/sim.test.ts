import { describe, test, expect } from "bun:test";
import type { Assignment, Subtask, SubtaskResult, WorldState } from "../fleet/types";
import { FLEET, initialWorld } from "../fleet/registry";
import { defaultWarehouse } from "./grid";
import { DEFAULT_CBF } from "./cbf";
import { executeAssignments } from "./sim";
import type { ExecuteOptions, ExecuteReport } from "./sim";

const grid = defaultWarehouse();

function task(id: string, target: { x: number; y: number }, deps: string[] = [], caps: Subtask["requiredCapabilities"] = ["ground"]): Subtask {
  return { id, description: id, requiredCapabilities: caps, target, dependsOn: deps };
}

function run(subtasks: Subtask[], assignments: Assignment[], extra: Partial<ExecuteOptions> = {}, world?: WorldState): ExecuteReport {
  return executeAssignments({
    grid,
    fleet: FLEET,
    world: world ?? initialWorld(),
    subtasks,
    assignments,
    alreadyCompleted: [],
    ...extra,
  });
}

function resultFor(report: ExecuteReport, id: string): SubtaskResult {
  const r = report.results.find((x) => x.subtaskId === id);
  if (!r) throw new Error(`no result for ${id}: ${JSON.stringify(report.results)}`);
  return r;
}

describe("executeAssignments crossing separation", () => {
  test("two ground robots on crossing paths never breach the CBF safety distance", () => {
    const report = run(
      [task("t1", { x: 1, y: 5 }), task("t2", { x: 5, y: 3 })],
      [
        { subtaskId: "t1", robotId: "ugv-1", rationale: "" },
        { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
      ],
    );
    expect(resultFor(report, "t1").status).toBe("completed");
    expect(resultFor(report, "t2").status).toBe("completed");
    expect(report.telemetry.minSeparation).toBeGreaterThanOrEqual(DEFAULT_CBF.safetyDist);
    // completed tasks carry a concrete tick stamp
    expect(typeof resultFor(report, "t1").completedAtTick).toBe("number");
  });
});

describe("executeAssignments dependency waves", () => {
  test("a dependent task runs only after its dependency completes", () => {
    const report = run(
      [task("a1", { x: 3, y: 1 }), task("a2", { x: 3, y: 3 }, ["a1"])],
      [
        { subtaskId: "a1", robotId: "ugv-1", rationale: "" },
        { subtaskId: "a2", robotId: "ugv-1", rationale: "" },
      ],
    );
    const a1 = resultFor(report, "a1");
    const a2 = resultFor(report, "a2");
    expect(a1.status).toBe("completed");
    expect(a2.status).toBe("completed");
    expect(report.telemetry.waves).toBe(2);
    expect(a2.completedAtTick!).toBeGreaterThan(a1.completedAtTick!);
  });

  test("a dependent of a task that never completes is blocked, not run", () => {
    // b1 has no assignment -> fails; b2 depends on it -> blocked
    const report = run(
      [task("b1", { x: 3, y: 1 }), task("b2", { x: 3, y: 3 }, ["b1"])],
      [{ subtaskId: "b2", robotId: "ugv-1", rationale: "" }],
    );
    expect(resultFor(report, "b1").status).toBe("failed");
    expect(resultFor(report, "b1").reason).toContain("no robot assigned");
    const b2 = resultFor(report, "b2");
    expect(b2.status).toBe("blocked");
    expect(b2.reason).toContain("b1");
    expect(b2.completedAtTick).toBeNull();
  });
});

describe("executeAssignments unassigned tasks", () => {
  test("a pending task with no assignment fails with 'no robot assigned'", () => {
    const report = run([task("solo", { x: 3, y: 1 })], []);
    const r = resultFor(report, "solo");
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("no robot assigned");
    expect(r.robotId).toBeNull();
  });
});

describe("executeAssignments injected failures", () => {
  test("a robot that goes down mid-task fails that task and persists as unresponsive", () => {
    const report = run(
      [task("c1", { x: 10, y: 1 })],
      [{ subtaskId: "c1", robotId: "ugv-1", rationale: "" }],
      { failures: [{ robotId: "ugv-1", atTick: 1 }] },
    );
    const r = resultFor(report, "c1");
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("unresponsive");
    expect(r.completedAtTick).toBeNull();
    expect(report.world.downRobots).toContain("ugv-1");
  });
});

describe("executeAssignments idle-robot vacating", () => {
  test("an idle robot parked on an active target vacates so the task can complete", () => {
    const world = initialWorld();
    world.positions["ugv-2"] = { x: 21, y: 8 }; // idle robot sitting on the target cell
    const report = run(
      [task("t6", { x: 21, y: 8 }, [], ["ground", "manipulate"])],
      [{ subtaskId: "t6", robotId: "arm-1", rationale: "" }],
      {},
      world,
    );
    expect(resultFor(report, "t6").status).toBe("completed");
    // the parked robot actually moved off the target
    const moved = report.world.positions["ugv-2"];
    expect(moved.x === 21 && moved.y === 8).toBe(false);
    expect(report.events.some((e) => e.includes("ugv-2 vacates"))).toBe(true);
  });

  test("a downed robot parked on a target does NOT vacate; the task fails", () => {
    const world = initialWorld();
    world.positions["ugv-2"] = { x: 21, y: 8 };
    world.downRobots = ["ugv-2"];
    const report = run(
      [task("t6", { x: 21, y: 8 }, [], ["ground", "manipulate"])],
      [{ subtaskId: "t6", robotId: "arm-1", rationale: "" }],
      {},
      world,
    );
    expect(resultFor(report, "t6").status).toBe("failed");
    // the downed robot stayed exactly where it was
    expect(report.world.positions["ugv-2"]).toEqual({ x: 21, y: 8 });
    expect(report.events.some((e) => e.includes("vacates"))).toBe(false);
  });
});
