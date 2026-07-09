import { describe, test, expect } from "bun:test";
import type { Vec2 } from "../fleet/types";
import { applyCbfFilter, DEFAULT_CBF } from "./cbf";
import type { CbfBody } from "./cbf";

/** Separation rate along the a->b normal: d/dt||Δp|| = (Δp·Δv)/||Δp||.
 * Negative = closing, positive = opening. */
function separationRate(pa: Vec2, pb: Vec2, va: Vec2, vb: Vec2): number {
  const dx = pa.x - pb.x;
  const dy = pa.y - pb.y;
  const d = Math.hypot(dx, dy);
  return ((va.x - vb.x) * dx + (va.y - vb.y) * dy) / d;
}

describe("applyCbfFilter head-on approach", () => {
  const bodies: CbfBody[] = [
    { id: "a", layer: "ground", p: { x: -1, y: 0 }, v: { x: 1, y: 0 }, maxSpeed: 2, down: false },
    { id: "b", layer: "ground", p: { x: 1, y: 0 }, v: { x: -1, y: 0 }, maxSpeed: 2, down: false },
  ];

  test("triggers an intervention and reduces the closing rate to the barrier bound", () => {
    const out = applyCbfFilter(bodies);
    expect(out.interventions).toBeGreaterThanOrEqual(1);
    expect(out.minSeparation).toBeCloseTo(2, 6); // measured at pre-filter positions

    const before = separationRate(bodies[0].p, bodies[1].p, bodies[0].v, bodies[1].v);
    const after = separationRate(bodies[0].p, bodies[1].p, out.velocities.get("a")!, out.velocities.get("b")!);
    // closing rate must improve (become less negative)
    expect(after).toBeGreaterThan(before);
    // and must satisfy the forward-invariance bound  d/dt h >= -alpha*h
    const h = 2 - DEFAULT_CBF.safetyDist;
    expect(after).toBeGreaterThanOrEqual(-DEFAULT_CBF.alpha * h - 1e-9);
  });

  test("splits the correction symmetrically between two mobile bodies", () => {
    const out = applyCbfFilter(bodies);
    const va = out.velocities.get("a")!;
    const vb = out.velocities.get("b")!;
    // both were slowed from unit speed; symmetric geometry -> mirror-image x components
    expect(va.x).toBeLessThan(1);
    expect(vb.x).toBeGreaterThan(-1);
    expect(va.x).toBeCloseTo(-vb.x, 6);
  });
});

describe("applyCbfFilter activation distance", () => {
  test("a pair farther than activationDist is left completely untouched", () => {
    const bodies: CbfBody[] = [
      { id: "a", layer: "ground", p: { x: -3, y: 0 }, v: { x: 1, y: 0 }, maxSpeed: 2, down: false },
      { id: "b", layer: "ground", p: { x: 3, y: 0 }, v: { x: -1, y: 0 }, maxSpeed: 2, down: false },
    ];
    const out = applyCbfFilter(bodies);
    expect(out.interventions).toBe(0);
    expect(out.velocities.get("a")).toEqual({ x: 1, y: 0 });
    expect(out.velocities.get("b")).toEqual({ x: -1, y: 0 });
    expect(out.minSeparation).toBeCloseTo(6, 6);
  });
});

describe("applyCbfFilter layer isolation", () => {
  test("a close ground/air head-on pair never interacts across layers", () => {
    const bodies: CbfBody[] = [
      { id: "g", layer: "ground", p: { x: -0.4, y: 0 }, v: { x: 1, y: 0 }, maxSpeed: 2, down: false },
      { id: "u", layer: "air", p: { x: 0.4, y: 0 }, v: { x: -1, y: 0 }, maxSpeed: 2, down: false },
    ];
    const out = applyCbfFilter(bodies);
    expect(out.interventions).toBe(0);
    expect(out.velocities.get("g")).toEqual({ x: 1, y: 0 });
    expect(out.velocities.get("u")).toEqual({ x: -1, y: 0 });
    // no same-layer pair exists, so minSeparation is untouched
    expect(out.minSeparation).toBe(Infinity);
  });
});

describe("applyCbfFilter with a downed body", () => {
  test("down body stays at zero velocity while the mobile body absorbs the full correction", () => {
    const bodies: CbfBody[] = [
      { id: "down", layer: "ground", p: { x: 0, y: 0 }, v: { x: 5, y: 5 }, maxSpeed: 2, down: true },
      { id: "mob", layer: "ground", p: { x: 1.2, y: 0 }, v: { x: -1, y: 0 }, maxSpeed: 2, down: false },
    ];
    const out = applyCbfFilter(bodies);
    expect(out.interventions).toBeGreaterThanOrEqual(1);
    // the downed body never moves regardless of its commanded velocity
    expect(out.velocities.get("down")).toEqual({ x: 0, y: 0 });

    // the mobile body must have been slowed: closing rate improved toward the bound
    const before = separationRate(bodies[0].p, bodies[1].p, { x: 0, y: 0 }, bodies[1].v);
    const after = separationRate(bodies[0].p, bodies[1].p, { x: 0, y: 0 }, out.velocities.get("mob")!);
    expect(after).toBeGreaterThan(before);
    const h = 1.2 - DEFAULT_CBF.safetyDist;
    expect(after).toBeGreaterThanOrEqual(-DEFAULT_CBF.alpha * h - 1e-9);
  });

  test("two downed bodies never intervene on each other", () => {
    const bodies: CbfBody[] = [
      { id: "d1", layer: "ground", p: { x: 0, y: 0 }, v: { x: 1, y: 0 }, maxSpeed: 2, down: true },
      { id: "d2", layer: "ground", p: { x: 1, y: 0 }, v: { x: -1, y: 0 }, maxSpeed: 2, down: true },
    ];
    const out = applyCbfFilter(bodies);
    expect(out.interventions).toBe(0);
    expect(out.velocities.get("d1")).toEqual({ x: 0, y: 0 });
    expect(out.velocities.get("d2")).toEqual({ x: 0, y: 0 });
  });
});

describe("applyCbfFilter three-body scenario", () => {
  test("only the genuinely converging pair inside activation range is corrected", () => {
    // a<->b are 1.2 apart and closing; c sits far away moving off on its own
    const bodies: CbfBody[] = [
      { id: "a", layer: "ground", p: { x: -0.6, y: 0 }, v: { x: 1, y: 0 }, maxSpeed: 2, down: false },
      { id: "b", layer: "ground", p: { x: 0.6, y: 0 }, v: { x: -1, y: 0 }, maxSpeed: 2, down: false },
      { id: "c", layer: "ground", p: { x: 10, y: 10 }, v: { x: 1, y: 1 }, maxSpeed: 2, down: false },
    ];
    const out = applyCbfFilter(bodies);
    expect(out.interventions).toBeGreaterThanOrEqual(1);
    // c is beyond activation distance from both -> its command is preserved
    expect(out.velocities.get("c")).toEqual({ x: 1, y: 1 });
    // a and b were both corrected toward separation
    expect(out.velocities.get("a")!.x).toBeLessThan(1);
    expect(out.velocities.get("b")!.x).toBeGreaterThan(-1);
  });
});
