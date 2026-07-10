import { z } from "zod";

/**
 * Shared contract for the whole stack.
 *
 * Design rule (from the MRS literature): the LLM layer only ever sees/produces
 * these symbolic structures. All geometry (paths, velocities, separation) is
 * handled by the deterministic MAPF + CBF layers.
 */

export const CAPABILITIES = [
  "ground",
  "aerial",
  "manipulate",
  "sense",
  "transport",
] as const;

export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const cellSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});
export type Cell = z.infer<typeof cellSchema>;

export interface Vec2 {
  x: number;
  y: number;
}

export const layerSchema = z.enum(["ground", "air"]);
export type Layer = z.infer<typeof layerSchema>;

export const robotSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["ugv", "uav", "ugv-arm"]),
  layer: layerSchema,
  capabilities: z.array(capabilitySchema),
  /** m/s in continuous execution */
  maxSpeed: z.number().positive(),
  /** body radius in meters */
  radius: z.number().positive(),
  /** travel budget in grid cells; used by the executor feasibility check */
  batteryCells: z.number().positive(),
  /** dock / initial cell */
  dock: cellSchema,
});
export type RobotSpec = z.infer<typeof robotSpecSchema>;

export const subtaskSchema = z.object({
  id: z.string().describe("short unique id, e.g. 't1'"),
  description: z.string(),
  requiredCapabilities: z
    .array(capabilitySchema)
    .min(1)
    .describe("every listed capability must be present on the assigned robot"),
  target: cellSchema.describe("grid cell the robot must reach"),
  dependsOn: z
    .array(z.string())
    .describe("subtask ids that must complete first; [] if none"),
});
export type Subtask = z.infer<typeof subtaskSchema>;

export const assignmentSchema = z.object({
  subtaskId: z.string(),
  robotId: z.string(),
  rationale: z.string(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const subtaskStatusSchema = z.enum(["completed", "failed", "blocked"]);

export const subtaskResultSchema = z.object({
  subtaskId: z.string(),
  robotId: z.string().nullable(),
  status: subtaskStatusSchema,
  reason: z.string(),
  completedAtTick: z.number().nullable(),
});
export type SubtaskResult = z.infer<typeof subtaskResultSchema>;

export const worldStateSchema = z.object({
  /** robot id -> discrete cell snapshot */
  positions: z.record(z.string(), cellSchema),
  /** robots that have become unresponsive; excluded from assignment */
  downRobots: z.array(z.string()),
});
export type WorldState = z.infer<typeof worldStateSchema>;

export const telemetrySchema = z.object({
  ticks: z.number(),
  waves: z.number(),
  /** number of tick-pair events where the CBF filter altered a commanded velocity */
  cbfInterventions: z.number(),
  /** minimum center-to-center separation observed between same-layer robots (m) */
  minSeparation: z.number(),
  perRobotDistance: z.record(z.string(), z.number()),
});
export type Telemetry = z.infer<typeof telemetrySchema>;

export const robotFailureSchema = z.object({
  robotId: z.string(),
  /** global sim tick (within one execute round) at which the robot goes dark */
  atTick: z.number().int().nonnegative(),
});
export type RobotFailure = z.infer<typeof robotFailureSchema>;

export const cellKey = (c: Cell): string => `${c.x},${c.y}`;
