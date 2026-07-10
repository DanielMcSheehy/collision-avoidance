import type { Layer, Vec2 } from "../fleet/types";

/**
 * Control Barrier Function safety filter (CBF-QP-lite).
 *
 * Barrier per same-layer pair (i, j): h(x) = ||Δp|| - Ds  with Δp = p_i - p_j.
 * Forward-invariance condition:  d/dt h(x) >= -α·h(x)
 * where d/dt h = (Δp · Δv) / ||Δp||  and Δv = v_i - v_j.
 *
 * Instead of a full QP over all constraints we run a few Gauss-Seidel passes
 * of pairwise analytic projections: when a pair violates the condition, the
 * minimal correction along the separation normal is split between the two
 * bodies (or applied wholly to the mobile one when its partner is down).
 * This is the standard decentralized approximation; it never touches a
 * velocity unless the barrier condition is violated, so the upstream planner
 * (LLM -> MAPF) stays completely decoupled from safety enforcement.
 */

export interface CbfBody {
  id: string;
  layer: Layer;
  p: Vec2;
  /** commanded velocity from the path follower; filtered in place-copy */
  v: Vec2;
  maxSpeed: number;
  /** down robots are immobile hazards: they constrain others but never move */
  down: boolean;
}

export interface CbfConfig {
  /** hard safety distance Ds between body centers (m) */
  safetyDist: number;
  /** pairs farther apart than this are ignored (m) */
  activationDist: number;
  /** class-K gain α: higher = more aggressive braking near the boundary */
  alpha: number;
  /** Gauss-Seidel passes over all pairs */
  iterations: number;
  /** evasive headroom: corrected speed may exceed maxSpeed by this factor */
  overspeed: number;
}

export const DEFAULT_CBF: CbfConfig = {
  safetyDist: 0.9,
  activationDist: 3.0,
  alpha: 1.2,
  iterations: 3,
  overspeed: 1.25,
};

export interface CbfOutcome {
  /** id -> safe velocity */
  velocities: Map<string, Vec2>;
  /** count of pairwise corrections applied this tick */
  interventions: number;
  /** min same-layer center distance observed this tick (Infinity if no pair) */
  minSeparation: number;
}

export function applyCbfFilter(bodies: CbfBody[], cfg: CbfConfig = DEFAULT_CBF): CbfOutcome {
  const v = new Map<string, Vec2>();
  for (const b of bodies) v.set(b.id, b.down ? { x: 0, y: 0 } : { ...b.v });

  let interventions = 0;
  let minSeparation = Infinity;

  for (let pass = 0; pass < cfg.iterations; pass++) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (a.layer !== b.layer) continue;
        if (a.down && b.down) continue;

        const dx = a.p.x - b.p.x;
        const dy = a.p.y - b.p.y;
        const d = Math.hypot(dx, dy);
        if (pass === 0) minSeparation = Math.min(minSeparation, d);
        if (d > cfg.activationDist || d < 1e-9) continue;

        const nx = dx / d;
        const ny = dy / d;
        const va = v.get(a.id)!;
        const vb = v.get(b.id)!;
        // d/dt ||Δp|| along the separation normal
        const hDot = (va.x - vb.x) * nx + (va.y - vb.y) * ny;
        const h = d - cfg.safetyDist;
        const bound = -cfg.alpha * h;
        if (hDot >= bound) continue; // constraint satisfied, leave commands alone

        interventions++;
        const deficit = bound - hDot; // total separation-rate we must add
        const aShare = a.down ? 0 : b.down ? 1 : 0.5;
        const bShare = 1 - aShare;
        va.x += nx * deficit * aShare;
        va.y += ny * deficit * aShare;
        vb.x -= nx * deficit * bShare;
        vb.y -= ny * deficit * bShare;
        // near-antiparallel approach: add a small tangential nudge so two
        // robots in a symmetric head-on do not stall on the barrier boundary
        if (h < cfg.safetyDist * 0.5) {
          const tx = -ny;
          const ty = nx;
          const nudge = deficit * 0.2;
          if (!a.down) {
            va.x += tx * nudge;
            va.y += ty * nudge;
          }
          if (!b.down) {
            vb.x -= tx * nudge;
            vb.y -= ty * nudge;
          }
        }
      }
    }
  }

  // clamp to evasive speed envelope
  for (const b of bodies) {
    if (b.down) continue;
    const vel = v.get(b.id)!;
    const speed = Math.hypot(vel.x, vel.y);
    const cap = b.maxSpeed * cfg.overspeed;
    if (speed > cap) {
      vel.x = (vel.x / speed) * cap;
      vel.y = (vel.y / speed) * cap;
    }
  }

  return { velocities: v, interventions, minSeparation };
}
