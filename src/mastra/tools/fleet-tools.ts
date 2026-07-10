import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { capableRobots, FLEET } from "../fleet/registry";
import { capabilitySchema, robotSpecSchema, worldStateSchema } from "../fleet/types";
import { defaultWarehouse, renderGrid } from "../control/grid";

/**
 * COHERENT-style heterogeneous capability model, exposed as a tool so the
 * Task Manager agent can ground its decomposition in what the fleet can
 * actually do instead of hallucinating robot abilities.
 */
export const capabilityTool = createTool({
  id: "lookup-capable-robots",
  description:
    "Look up which robots in the fleet possess ALL of the given capabilities and are currently responsive. Use before assigning any subtask.",
  inputSchema: z.object({
    requiredCapabilities: z.array(capabilitySchema).min(1),
    world: worldStateSchema
      .optional()
      .describe("current world state; omit to assume all robots available"),
  }),
  outputSchema: z.object({
    candidates: z.array(robotSpecSchema),
  }),
  execute: async ({ requiredCapabilities, world }) => ({
    candidates: capableRobots(
      requiredCapabilities,
      world ?? { positions: {}, downRobots: [] },
    ),
  }),
});

export const worldTool = createTool({
  id: "get-world-snapshot",
  description:
    "Get the warehouse map (ASCII: '#' racks block ground robots only, UAVs overfly), grid dimensions, and the full fleet roster with capabilities and docks.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    map: z.string(),
    width: z.number(),
    height: z.number(),
    fleet: z.array(robotSpecSchema),
  }),
  execute: async () => {
    const grid = defaultWarehouse();
    return {
      map: renderGrid(grid),
      width: grid.width,
      height: grid.height,
      fleet: FLEET,
    };
  },
});
