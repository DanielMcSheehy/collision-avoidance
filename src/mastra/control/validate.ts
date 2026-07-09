import type { Assignment, Subtask, WorldState } from "../fleet/types";
import { capableRobots, FLEET } from "../fleet/registry";
import type { Grid } from "./grid";
import { isBlocked } from "./grid";

/**
 * Classical validation gate between LLM structured output and dispatch.
 * Anything that fails here is sent back to the Task Manager as feedback for
 * one corrective retry (PDDL-validation pattern from the MRS literature).
 */

export function validatePlan(subtasks: Subtask[], grid: Grid, world: WorldState): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of subtasks) {
    if (ids.has(t.id)) errors.push(`duplicate subtask id '${t.id}'`);
    ids.add(t.id);
  }
  for (const t of subtasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) errors.push(`subtask '${t.id}' depends on unknown id '${d}'`);
      if (d === t.id) errors.push(`subtask '${t.id}' depends on itself`);
    }
    const wantsGround = t.requiredCapabilities.includes("ground");
    const layer = wantsGround ? "ground" : "air";
    if (isBlocked(grid, t.target, layer)) {
      errors.push(
        `subtask '${t.id}' target (${t.target.x},${t.target.y}) is out of bounds or inside a rack for a ${layer} robot`,
      );
    }
    if (t.requiredCapabilities.includes("ground") && t.requiredCapabilities.includes("aerial")) {
      errors.push(`subtask '${t.id}' requires both ground and aerial — no robot can satisfy both`);
    }
    if (capableRobots(t.requiredCapabilities, world).length === 0) {
      errors.push(
        `subtask '${t.id}' requires [${t.requiredCapabilities.join(", ")}] but no available robot has all of them`,
      );
    }
  }
  // cycle detection via Kahn's algorithm
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of subtasks) {
    indeg.set(t.id, t.dependsOn.filter((d) => ids.has(d) && d !== t.id).length);
    for (const d of t.dependsOn) {
      if (!ids.has(d)) continue;
      dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
    }
  }
  const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const dep of dependents.get(id) ?? []) {
      const n = indeg.get(dep)! - 1;
      indeg.set(dep, n);
      if (n === 0) queue.push(dep);
    }
  }
  if (visited < subtasks.length) errors.push("dependency graph contains a cycle");
  return errors;
}

export function validateAssignments(
  subtasks: Subtask[],
  assignments: Assignment[],
  world: WorldState,
  alreadyCompleted: readonly string[],
): string[] {
  const errors: string[] = [];
  const taskById = new Map(subtasks.map((t) => [t.id, t]));
  const specById = new Map(FLEET.map((r) => [r.id, r]));
  const seen = new Set<string>();

  for (const a of assignments) {
    const task = taskById.get(a.subtaskId);
    if (!task) {
      errors.push(`assignment references unknown subtask '${a.subtaskId}'`);
      continue;
    }
    if (seen.has(a.subtaskId)) {
      errors.push(`subtask '${a.subtaskId}' assigned more than once`);
      continue;
    }
    seen.add(a.subtaskId);
    const robot = specById.get(a.robotId);
    if (!robot) {
      errors.push(`assignment for '${a.subtaskId}' references unknown robot '${a.robotId}'`);
      continue;
    }
    if (world.downRobots.includes(a.robotId)) {
      errors.push(`robot '${a.robotId}' is unresponsive and cannot take '${a.subtaskId}'`);
    }
    const missing = task.requiredCapabilities.filter(
      (c) => !(robot.capabilities as readonly string[]).includes(c),
    );
    if (missing.length > 0) {
      errors.push(
        `robot '${a.robotId}' lacks [${missing.join(", ")}] required by '${a.subtaskId}'`,
      );
    }
  }
  for (const t of subtasks) {
    if (alreadyCompleted.includes(t.id)) continue;
    if (!seen.has(t.id)) errors.push(`pending subtask '${t.id}' has no assignment`);
  }
  return errors;
}
