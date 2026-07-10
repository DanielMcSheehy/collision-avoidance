import type { RobotSpec, WorldState } from "./types";

/**
 * Heterogeneous demo fleet (the COHERENT-style capability model).
 * Swap this module for a live fleet-manager client when wiring to hardware.
 */
export const FLEET: RobotSpec[] = [
  {
    id: "ugv-1",
    name: "Atlas",
    kind: "ugv",
    layer: "ground",
    capabilities: ["ground", "transport", "sense"],
    maxSpeed: 1.2,
    radius: 0.35,
    batteryCells: 400,
    dock: { x: 1, y: 1 },
  },
  {
    id: "ugv-2",
    name: "Bolt",
    kind: "ugv",
    layer: "ground",
    capabilities: ["ground", "transport"],
    maxSpeed: 1.5,
    radius: 0.35,
    batteryCells: 300,
    dock: { x: 1, y: 3 },
  },
  {
    id: "arm-1",
    name: "Echo",
    kind: "ugv-arm",
    layer: "ground",
    capabilities: ["ground", "manipulate", "sense"],
    maxSpeed: 0.8,
    radius: 0.4,
    batteryCells: 200,
    dock: { x: 2, y: 8 },
  },
  {
    id: "uav-1",
    name: "Comet",
    kind: "uav",
    layer: "air",
    capabilities: ["aerial", "sense"],
    maxSpeed: 2.5,
    radius: 0.25,
    batteryCells: 250,
    dock: { x: 1, y: 12 },
  },
  {
    id: "uav-2",
    name: "Dart",
    kind: "uav",
    layer: "air",
    capabilities: ["aerial", "sense"],
    maxSpeed: 2.2,
    radius: 0.25,
    batteryCells: 250,
    dock: { x: 1, y: 14 },
  },
];

export function initialWorld(): WorldState {
  const positions: WorldState["positions"] = {};
  for (const r of FLEET) positions[r.id] = { ...r.dock };
  return { positions, downRobots: [] };
}

/** Robots whose capability set covers `required` and that are not down. */
export function capableRobots(
  required: readonly string[],
  world: WorldState,
): RobotSpec[] {
  return FLEET.filter(
    (r) =>
      !world.downRobots.includes(r.id) &&
      required.every((c) => (r.capabilities as readonly string[]).includes(c)),
  );
}
