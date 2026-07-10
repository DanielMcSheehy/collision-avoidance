import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { defaultWarehouse, manhattan, renderGrid } from "../control/grid";
import { executeAssignments } from "../control/sim";
import { validateAssignments, validatePlan } from "../control/validate";
import { capableRobots, FLEET, initialWorld } from "../fleet/registry";
import {
  type Assignment,
  assignmentSchema,
  robotFailureSchema,
  type Subtask,
  subtaskResultSchema,
  subtaskSchema,
  telemetrySchema,
  type WorldState,
  worldStateSchema,
} from "../fleet/types";

/**
 * COHERENT-style PEFA loop (Proposal -> Execution -> Feedback -> Adjustment)
 * as a Mastra workflow:
 *
 *   propose (LLM, validated)                          <- Proposal
 *     -> dountil round workflow:
 *          assign (LLM + executor review, validated)  <- Proposal cont.
 *          execute (MAPF + CBF sim, no LLM)           <- Execution
 *          feedback/adjust (LLM only on failure)      <- Feedback + Adjustment
 *        until no pending failures or maxRounds
 *     -> report
 */

const GRID = defaultWarehouse();

const roundIOSchema = z.object({
  mission: z.string(),
  subtasks: z.array(subtaskSchema),
  assignments: z.array(assignmentSchema),
  world: worldStateSchema,
  completed: z.array(z.string()),
  results: z.array(subtaskResultSchema),
  telemetry: z.array(telemetrySchema),
  events: z.array(z.string()),
  round: z.number(),
  maxRounds: z.number(),
  robotFailures: z.array(robotFailureSchema),
  done: z.boolean(),
});
type RoundIO = z.infer<typeof roundIOSchema>;

const planSchema = z.object({ subtasks: z.array(subtaskSchema) });
const assignmentsSchema = z.object({ assignments: z.array(assignmentSchema) });
const reviewSchema = z.object({
  reviews: z.array(
    z.object({
      subtaskId: z.string(),
      feasible: z.boolean(),
      reason: z.string(),
    }),
  ),
});

function fleetBrief(world: WorldState): string {
  return FLEET.map((r) => {
    const pos = world.positions[r.id] ?? r.dock;
    const status = world.downRobots.includes(r.id) ? "UNRESPONSIVE" : "ok";
    return `- ${r.id} "${r.name}" (${r.kind}, ${r.layer}) caps=[${r.capabilities.join(",")}] speed=${r.maxSpeed}m/s battery=${r.batteryCells} cells at (${pos.x},${pos.y}) [${status}]`;
  }).join("\n");
}

/** Deterministic fallback: nearest capable robot, balancing task counts. */
function greedyAssign(
  subtasks: Subtask[],
  world: WorldState,
  completed: readonly string[],
): Assignment[] {
  const load = new Map<string, number>();
  const out: Assignment[] = [];
  for (const t of subtasks) {
    if (completed.includes(t.id)) continue;
    const candidates = capableRobots(t.requiredCapabilities, world);
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) => {
      const la = load.get(a.id) ?? 0;
      const lb = load.get(b.id) ?? 0;
      if (la !== lb) return la < lb ? a : b;
      const da = manhattan(world.positions[a.id] ?? a.dock, t.target);
      const db = manhattan(world.positions[b.id] ?? b.dock, t.target);
      return da <= db ? a : b;
    });
    load.set(best.id, (load.get(best.id) ?? 0) + 1);
    out.push({
      subtaskId: t.id,
      robotId: best.id,
      rationale: "deterministic fallback: nearest capable robot with lowest load",
    });
  }
  return out;
}

// ---------------------------------------------------------------- Proposal

const proposeStep = createStep({
  id: "propose",
  inputSchema: z.object({
    mission: z.string(),
    robotFailures: z.array(robotFailureSchema).default([]),
    maxRounds: z.number().int().min(1).default(3),
  }),
  outputSchema: roundIOSchema,
  execute: async ({ inputData, mastra }) => {
    const world = initialWorld();
    const agent = mastra.getAgent("taskManagerAgent");
    const basePrompt = `MISSION: ${inputData.mission}

WAREHOUSE MAP (24x16, '#' racks block ground robots only):
${renderGrid(GRID)}

FLEET:
${fleetBrief(world)}

Decompose this mission into subtasks per your rules. Return only the plan.`;

    let response = await agent.generate(basePrompt, {
      structuredOutput: { schema: planSchema },
    });
    let subtasks = response.object.subtasks;
    let errors = validatePlan(subtasks, GRID, world);
    if (errors.length > 0) {
      response = await agent.generate(
        `${basePrompt}

Your previous plan was REJECTED by the validator:
${errors.map((e) => `- ${e}`).join("\n")}

Previous plan: ${JSON.stringify(subtasks)}

Fix every violation and return the corrected plan.`,
        { structuredOutput: { schema: planSchema } },
      );
      subtasks = response.object.subtasks;
      errors = validatePlan(subtasks, GRID, world);
      if (errors.length > 0) {
        throw new Error(`Task Manager produced an invalid plan twice: ${errors.join("; ")}`);
      }
    }

    return {
      mission: inputData.mission,
      subtasks,
      assignments: [],
      world,
      completed: [],
      results: [],
      telemetry: [],
      events: [`proposed ${subtasks.length} subtasks`],
      round: 1,
      maxRounds: inputData.maxRounds,
      robotFailures: inputData.robotFailures,
      done: false,
    };
  },
});

// -------------------------------------------------------------- Assignment

const assignStep = createStep({
  id: "assign",
  inputSchema: roundIOSchema,
  outputSchema: roundIOSchema,
  execute: async ({ inputData, mastra }) => {
    const { subtasks, world, completed } = inputData;
    const pending = subtasks.filter((t) => !completed.includes(t.id));
    const events = [...inputData.events];

    // adjustment from the previous round already covers all pending tasks
    const covered = new Set(inputData.assignments.map((a) => a.subtaskId));
    let assignments = inputData.assignments;
    if (!pending.every((t) => covered.has(t.id))) {
      const agent = mastra.getAgent("taskManagerAgent");
      const prompt = `Assign one robot to each pending subtask.

FLEET:
${fleetBrief(world)}

PENDING SUBTASKS:
${JSON.stringify(pending, null, 2)}

Rules: the robot must have every required capability, must be responsive, and
independent subtasks should go to different robots for parallelism.`;
      let response = await agent.generate(prompt, {
        structuredOutput: { schema: assignmentsSchema },
      });
      assignments = response.object.assignments;
      let errors = validateAssignments(subtasks, assignments, world, completed);
      if (errors.length > 0) {
        response = await agent.generate(
          `${prompt}

Your previous assignment was REJECTED:
${errors.map((e) => `- ${e}`).join("\n")}
Previous: ${JSON.stringify(assignments)}
Fix every violation.`,
          { structuredOutput: { schema: assignmentsSchema } },
        );
        assignments = response.object.assignments;
        errors = validateAssignments(subtasks, assignments, world, completed);
        if (errors.length > 0) {
          events.push(`assignment invalid twice (${errors.join("; ")}); using deterministic fallback`);
          assignments = greedyAssign(subtasks, world, completed);
        }
      }
    }

    // PEFA feasibility check: robot-local executor reviews the batch (HMAS-2)
    const executor = mastra.getAgent("robotExecutorAgent");
    const review = await executor.generate(
      `Review these assignments for feasibility.

FLEET:
${fleetBrief(world)}

SUBTASKS: ${JSON.stringify(subtasks.filter((t) => !completed.includes(t.id)))}
ASSIGNMENTS: ${JSON.stringify(assignments)}`,
      { structuredOutput: { schema: reviewSchema } },
    );
    for (const r of review.object.reviews) {
      if (r.feasible) continue;
      const current = assignments.find((a) => a.subtaskId === r.subtaskId);
      const task = subtasks.find((t) => t.id === r.subtaskId);
      if (!current || !task) continue;
      const alternative = capableRobots(task.requiredCapabilities, world).find(
        (c) => c.id !== current.robotId,
      );
      if (alternative) {
        events.push(
          `executor flagged ${r.subtaskId} on ${current.robotId} (${r.reason}); reassigned to ${alternative.id}`,
        );
        current.robotId = alternative.id;
        current.rationale = `reassigned after executor feasibility check: ${r.reason}`;
      } else {
        events.push(`executor flagged ${r.subtaskId} (${r.reason}); no alternative robot, dispatching anyway`);
      }
    }

    return { ...inputData, assignments, events };
  },
});

// --------------------------------------------------------------- Execution

const executeStep = createStep({
  id: "execute",
  inputSchema: roundIOSchema,
  outputSchema: roundIOSchema,
  execute: async ({ inputData }) => {
    const report = executeAssignments({
      grid: GRID,
      fleet: FLEET,
      world: inputData.world,
      subtasks: inputData.subtasks,
      assignments: inputData.assignments,
      alreadyCompleted: inputData.completed,
      failures: inputData.robotFailures,
    });
    const completed = [
      ...inputData.completed,
      ...report.results.filter((r) => r.status === "completed").map((r) => r.subtaskId),
    ];
    return {
      ...inputData,
      world: report.world,
      completed,
      results: report.results,
      telemetry: [...inputData.telemetry, report.telemetry],
      events: [...inputData.events, ...report.events.map((e) => `[round ${inputData.round}] ${e}`)],
      robotFailures: [], // injected breakdowns fire once
    };
  },
});

// ----------------------------------------------------- Feedback + Adjustment

const feedbackStep = createStep({
  id: "feedback-adjust",
  inputSchema: roundIOSchema,
  outputSchema: roundIOSchema,
  execute: async ({ inputData, mastra }) => {
    const failed = inputData.results.filter((r) => r.status !== "completed");
    const events = [...inputData.events];

    if (failed.length === 0) {
      events.push(`round ${inputData.round}: all subtasks complete`);
      return { ...inputData, events, done: true };
    }
    if (inputData.round >= inputData.maxRounds) {
      events.push(
        `round ${inputData.round}: ${failed.length} subtasks unresolved, max rounds reached`,
      );
      return { ...inputData, events, done: true };
    }

    // Adjustment: Task Manager reallocates the failures for the next round
    const agent = mastra.getAgent("taskManagerAgent");
    const pending = inputData.subtasks.filter((t) => !inputData.completed.includes(t.id));
    const prompt = `Execution round ${inputData.round} feedback — some subtasks did not complete.

FLEET (note unresponsive robots):
${fleetBrief(inputData.world)}

FAILED/BLOCKED RESULTS:
${JSON.stringify(failed, null, 2)}

STILL-PENDING SUBTASKS:
${JSON.stringify(pending, null, 2)}

Reassign every pending subtask for the next round. Never assign to an
unresponsive robot. Change robots where the failure reason demands it.`;
    let response = await agent.generate(prompt, {
      structuredOutput: { schema: assignmentsSchema },
    });
    let assignments = response.object.assignments;
    const errors = validateAssignments(
      inputData.subtasks,
      assignments,
      inputData.world,
      inputData.completed,
    );
    if (errors.length > 0) {
      events.push(`adjustment invalid (${errors.join("; ")}); using deterministic fallback`);
      assignments = greedyAssign(inputData.subtasks, inputData.world, inputData.completed);
    }
    events.push(
      `round ${inputData.round}: adjusting ${failed.length} unresolved subtasks, replanning`,
    );
    return {
      ...inputData,
      assignments,
      events,
      round: inputData.round + 1,
      done: false,
    };
  },
});

const pefaRound = createWorkflow({
  id: "pefa-round",
  inputSchema: roundIOSchema,
  outputSchema: roundIOSchema,
})
  .then(assignStep)
  .then(executeStep)
  .then(feedbackStep)
  .commit();

// ------------------------------------------------------------------ Report

const reportStep = createStep({
  id: "report",
  inputSchema: roundIOSchema,
  outputSchema: z.object({
    mission: z.string(),
    success: z.boolean(),
    rounds: z.number(),
    subtasks: z.array(subtaskSchema),
    finalStatus: z.array(subtaskResultSchema),
    telemetry: z.array(telemetrySchema),
    events: z.array(z.string()),
    map: z.string(),
  }),
  execute: async ({ inputData }) => {
    // last recorded status per subtask across rounds
    const finalStatus = inputData.subtasks.map((t) => {
      if (inputData.completed.includes(t.id)) {
        const r = inputData.results.find(
          (x) => x.subtaskId === t.id && x.status === "completed",
        );
        return (
          r ?? {
            subtaskId: t.id,
            robotId: null,
            status: "completed" as const,
            reason: "completed in an earlier round",
            completedAtTick: null,
          }
        );
      }
      const r = [...inputData.results].reverse().find((x) => x.subtaskId === t.id);
      return (
        r ?? {
          subtaskId: t.id,
          robotId: null,
          status: "failed" as const,
          reason: "never executed",
          completedAtTick: null,
        }
      );
    });
    const marks: Record<string, { x: number; y: number }> = {};
    for (const [id, pos] of Object.entries(inputData.world.positions)) marks[id] = pos;
    return {
      mission: inputData.mission,
      success: finalStatus.every((r) => r.status === "completed"),
      rounds: inputData.round,
      subtasks: inputData.subtasks,
      finalStatus,
      telemetry: inputData.telemetry,
      events: inputData.events,
      map: renderGrid(GRID, marks),
    };
  },
});

export const pefaWorkflow = createWorkflow({
  id: "pefa-mission",
  description:
    "Multi-robot mission orchestration: LLM proposal/assignment with classical validation, MAPF+CBF safe execution, and a feedback-adjustment loop.",
  inputSchema: z.object({
    mission: z.string().describe("natural-language mission for the fleet"),
    robotFailures: z
      .array(robotFailureSchema)
      .default([])
      .describe("optional injected breakdowns for failure drills"),
    maxRounds: z.number().int().min(1).default(3),
  }),
  outputSchema: reportStep.outputSchema,
})
  .then(proposeStep)
  .dountil(pefaRound, async ({ inputData }) => inputData.done)
  .then(reportStep)
  .commit();
