import { describe, test, expect } from "bun:test";
import type { Assignment, Subtask, WorldState } from "../fleet/types";
import { initialWorld } from "../fleet/registry";
import { defaultWarehouse } from "./grid";
import { validateAssignments, validatePlan } from "./validate";

const grid = defaultWarehouse();

function task(over: Partial<Subtask> & Pick<Subtask, "id">): Subtask {
  return {
    description: over.id,
    requiredCapabilities: ["ground"],
    target: { x: 3, y: 1 },
    dependsOn: [],
    ...over,
  };
}

describe("validatePlan", () => {
  test("accepts a well-formed plan with no errors", () => {
    const errors = validatePlan([task({ id: "t1" }), task({ id: "t2", dependsOn: ["t1"] })], grid, initialWorld());
    expect(errors).toEqual([]);
  });

  test("flags duplicate subtask ids", () => {
    const errors = validatePlan([task({ id: "dup" }), task({ id: "dup" })], grid, initialWorld());
    expect(errors.some((e) => e.includes("duplicate subtask id 'dup'"))).toBe(true);
  });

  test("flags a dependency on an unknown id", () => {
    const errors = validatePlan([task({ id: "t1", dependsOn: ["ghost"] })], grid, initialWorld());
    expect(errors.some((e) => e.includes("unknown id 'ghost'"))).toBe(true);
  });

  test("flags a self-dependency", () => {
    const errors = validatePlan([task({ id: "t1", dependsOn: ["t1"] })], grid, initialWorld());
    expect(errors.some((e) => e.includes("depends on itself"))).toBe(true);
  });

  test("detects a dependency cycle", () => {
    const errors = validatePlan(
      [task({ id: "t1", dependsOn: ["t2"] }), task({ id: "t2", dependsOn: ["t1"] })],
      grid,
      initialWorld(),
    );
    expect(errors).toContain("dependency graph contains a cycle");
  });

  test("flags an out-of-bounds target", () => {
    const errors = validatePlan([task({ id: "t1", target: { x: -1, y: 0 } })], grid, initialWorld());
    expect(errors.some((e) => e.includes("out of bounds or inside a rack"))).toBe(true);
  });

  test("flags a ground target inside a rack", () => {
    // (6,2) is a rack cell in the default warehouse
    const errors = validatePlan([task({ id: "t1", target: { x: 6, y: 2 } })], grid, initialWorld());
    expect(errors.some((e) => e.includes("out of bounds or inside a rack"))).toBe(true);
  });

  test("flags the impossible ground+aerial combo", () => {
    const errors = validatePlan(
      [task({ id: "t1", requiredCapabilities: ["ground", "aerial"] })],
      grid,
      initialWorld(),
    );
    expect(errors.some((e) => e.includes("requires both ground and aerial"))).toBe(true);
  });

  test("flags an unsatisfiable capability set that no single robot covers", () => {
    // no robot has both aerial and manipulate
    const errors = validatePlan(
      [task({ id: "t1", requiredCapabilities: ["aerial", "manipulate"], target: { x: 6, y: 2 } })],
      grid,
      initialWorld(),
    );
    expect(errors.some((e) => e.includes("no available robot has all of them"))).toBe(true);
  });
});

describe("validateAssignments", () => {
  const subtasks = [task({ id: "t1" }), task({ id: "t2" })];
  const world = (): WorldState => initialWorld();

  test("accepts a fully valid assignment set", () => {
    const assignments: Assignment[] = [
      { subtaskId: "t1", robotId: "ugv-1", rationale: "" },
      { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
    ];
    expect(validateAssignments(subtasks, assignments, world(), [])).toEqual([]);
  });

  test("flags an assignment to a robot lacking a required capability", () => {
    const errors = validateAssignments(
      subtasks,
      [
        { subtaskId: "t1", robotId: "uav-1", rationale: "" }, // air robot, no 'ground'
        { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
      ],
      world(),
      [],
    );
    expect(errors.some((e) => e.includes("lacks [ground]") && e.includes("uav-1"))).toBe(true);
  });

  test("flags assigning a task to a downed robot", () => {
    const w = world();
    w.downRobots = ["ugv-1"];
    const errors = validateAssignments(
      subtasks,
      [
        { subtaskId: "t1", robotId: "ugv-1", rationale: "" },
        { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
      ],
      w,
      [],
    );
    expect(errors.some((e) => e.includes("ugv-1") && e.includes("unresponsive"))).toBe(true);
  });

  test("flags a pending task with no assignment", () => {
    const errors = validateAssignments(
      subtasks,
      [{ subtaskId: "t1", robotId: "ugv-1", rationale: "" }],
      world(),
      [],
    );
    expect(errors.some((e) => e.includes("pending subtask 't2' has no assignment"))).toBe(true);
  });

  test("does not require assignments for already-completed tasks", () => {
    const errors = validateAssignments(
      subtasks,
      [{ subtaskId: "t1", robotId: "ugv-1", rationale: "" }],
      world(),
      ["t2"],
    );
    expect(errors).toEqual([]);
  });

  test("flags an assignment referencing an unknown subtask", () => {
    const errors = validateAssignments(
      subtasks,
      [
        { subtaskId: "t1", robotId: "ugv-1", rationale: "" },
        { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
        { subtaskId: "nope", robotId: "ugv-1", rationale: "" },
      ],
      world(),
      [],
    );
    expect(errors.some((e) => e.includes("unknown subtask 'nope'"))).toBe(true);
  });

  test("flags an assignment referencing an unknown robot", () => {
    const errors = validateAssignments(
      subtasks,
      [
        { subtaskId: "t1", robotId: "ghost-9", rationale: "" },
        { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
      ],
      world(),
      [],
    );
    expect(errors.some((e) => e.includes("unknown robot 'ghost-9'"))).toBe(true);
  });

  test("flags a subtask assigned more than once", () => {
    const errors = validateAssignments(
      subtasks,
      [
        { subtaskId: "t1", robotId: "ugv-1", rationale: "" },
        { subtaskId: "t1", robotId: "ugv-2", rationale: "" },
        { subtaskId: "t2", robotId: "ugv-2", rationale: "" },
      ],
      world(),
      [],
    );
    expect(errors.some((e) => e.includes("'t1' assigned more than once"))).toBe(true);
  });
});
