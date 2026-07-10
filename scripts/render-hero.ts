// Renders assets/hero.svg from the real warehouse grid and real MAPF output.
// Reproduce with: bun scripts/render-hero.ts
import { defaultWarehouse } from "../src/mastra/control/grid";
import { planPaths } from "../src/mastra/control/mapf";
import type { Cell, Layer } from "../src/mastra/fleet/types";
import { cellKey } from "../src/mastra/fleet/types";
import { mkdirSync, writeFileSync } from "node:fs";

const grid = defaultWarehouse();

interface Actor {
  id: string;
  label: string;
  start: Cell;
  goal: Cell;
  layer: Layer;
  color: string;
}

const ACTORS: Actor[] = [
  { id: "ugv-1", label: "UGV Atlas", start: { x: 1, y: 1 }, goal: { x: 21, y: 8 }, layer: "ground", color: "#31d0ff" },
  { id: "ugv-2", label: "UGV Bolt", start: { x: 1, y: 3 }, goal: { x: 21, y: 1 }, layer: "ground", color: "#7bff9e" },
  { id: "arm-1", label: "Arm Echo", start: { x: 2, y: 8 }, goal: { x: 11, y: 14 }, layer: "ground", color: "#ffd24a" },
  { id: "uav-1", label: "UAV Comet", start: { x: 1, y: 12 }, goal: { x: 14, y: 4 }, layer: "air", color: "#ff7ac8" },
  { id: "uav-2", label: "UAV Dart", start: { x: 1, y: 14 }, goal: { x: 14, y: 11 }, layer: "air", color: "#b78bff" },
];

const mapf = planPaths(
  grid,
  ACTORS.map(({ id, start, goal, layer }) => ({ id, start, goal, layer })),
  new Map([
    ["ground", new Set<string>()],
    ["air", new Set<string>()],
  ]),
);
if (mapf.failed.length > 0) throw new Error(`hero scenario must plan cleanly, failed: ${mapf.failed.join(",")}`);

const CELL = 46;
const PAD = 40;
const W = grid.width * CELL + PAD * 2;
const H = grid.height * CELL + PAD * 2 + 60;
const px = (c: Cell): { x: number; y: number } => ({
  x: PAD + c.x * CELL + CELL / 2,
  y: PAD + 60 + (grid.height - 1 - c.y) * CELL + CELL / 2,
});

const svg: string[] = [];
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'JetBrains Mono','Fira Code',monospace">`);
svg.push(`<defs>
  <radialGradient id="bg" cx="50%" cy="35%" r="90%">
    <stop offset="0%" stop-color="#101d33"/>
    <stop offset="100%" stop-color="#060a14"/>
  </radialGradient>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="4.5" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="softglow" x="-80%" y="-80%" width="260%" height="260%">
    <feGaussianBlur stdDeviation="9" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>`);
svg.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);

// title block
svg.push(`<text x="${W / 2}" y="52" text-anchor="middle" fill="#e8f4ff" font-size="30" font-weight="bold" letter-spacing="6">COLLISION AVOIDANCE</text>`);
svg.push(`<text x="${W / 2}" y="78" text-anchor="middle" fill="#5f7ea6" font-size="14" letter-spacing="3">LLM MISSION PLANNING · MAPF CONFLICT-FREE PATHS · CBF SAFETY BARRIER</text>`);

// grid lines
for (let x = 0; x <= grid.width; x++) {
  svg.push(`<line x1="${PAD + x * CELL}" y1="${PAD + 60}" x2="${PAD + x * CELL}" y2="${PAD + 60 + grid.height * CELL}" stroke="#16283f" stroke-width="1"/>`);
}
for (let y = 0; y <= grid.height; y++) {
  svg.push(`<line x1="${PAD}" y1="${PAD + 60 + y * CELL}" x2="${PAD + grid.width * CELL}" y2="${PAD + 60 + y * CELL}" stroke="#16283f" stroke-width="1"/>`);
}

// racks
for (let x = 0; x < grid.width; x++) {
  for (let y = 0; y < grid.height; y++) {
    if (!grid.obstacles.has(cellKey({ x, y }))) continue;
    const c = px({ x, y });
    svg.push(`<rect x="${c.x - CELL / 2 + 3}" y="${c.y - CELL / 2 + 3}" width="${CELL - 6}" height="${CELL - 6}" rx="4" fill="#1d2f49" stroke="#2f4a70" stroke-width="1.5"/>`);
    svg.push(`<line x1="${c.x - CELL / 2 + 9}" y1="${c.y}" x2="${c.x + CELL / 2 - 9}" y2="${c.y}" stroke="#2f4a70" stroke-width="1.5"/>`);
  }
}

// paths (air dashed above, ground solid); tiny per-robot offset so shared
// corridors show every path instead of the last-drawn one
ACTORS.forEach((a, i) => {
  const off = (i - (ACTORS.length - 1) / 2) * 4;
  const path = mapf.paths.get(a.id)!;
  const pts = path.map((c) => px(c)).map((p) => `${p.x + off},${p.y + off}`).join(" ");
  const dash = a.layer === "air" ? ` stroke-dasharray="2 9"` : "";
  svg.push(`<polyline points="${pts}" fill="none" stroke="${a.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" filter="url(#glow)"${dash}/>`);
  // goal marker
  const g = px(a.goal);
  svg.push(`<circle cx="${g.x}" cy="${g.y}" r="9" fill="none" stroke="${a.color}" stroke-width="2.5" opacity="0.9"/>`);
  svg.push(`<circle cx="${g.x}" cy="${g.y}" r="2.5" fill="${a.color}"/>`);
});

// robots at start (safety bubble + body)
for (const a of ACTORS) {
  const s = px(a.start);
  svg.push(`<circle cx="${s.x}" cy="${s.y}" r="${CELL * 0.62}" fill="${a.color}" opacity="0.10"/>`);
  svg.push(`<circle cx="${s.x}" cy="${s.y}" r="${CELL * 0.62}" fill="none" stroke="${a.color}" stroke-width="1.2" opacity="0.55" stroke-dasharray="4 5"/>`);
  if (a.layer === "air") {
    const r = 8;
    svg.push(`<g filter="url(#softglow)"><line x1="${s.x - r}" y1="${s.y - r}" x2="${s.x + r}" y2="${s.y + r}" stroke="${a.color}" stroke-width="4" stroke-linecap="round"/><line x1="${s.x - r}" y1="${s.y + r}" x2="${s.x + r}" y2="${s.y - r}" stroke="${a.color}" stroke-width="4" stroke-linecap="round"/><circle cx="${s.x}" cy="${s.y}" r="3.4" fill="#0b1322" stroke="${a.color}" stroke-width="2"/></g>`);
  } else {
    svg.push(`<g filter="url(#softglow)"><rect x="${s.x - 9}" y="${s.y - 9}" width="18" height="18" rx="5" fill="#0b1322" stroke="${a.color}" stroke-width="3"/><circle cx="${s.x}" cy="${s.y}" r="3" fill="${a.color}"/></g>`);
  }
}

// legend (top-right corner of the map, empty in this scenario)
const LX = W - PAD - 218;
let ly = PAD + 60 + 24 + (ACTORS.length - 1) * 22;
svg.push(`<rect x="${LX - 12}" y="${PAD + 60 + 8}" width="230" height="${ACTORS.length * 22 + 18}" rx="8" fill="#0a1424" opacity="0.85" stroke="#1f3450"/>`);
for (let i = ACTORS.length - 1; i >= 0; i--) {
  const a = ACTORS[i];
  svg.push(`<line x1="${LX}" y1="${ly - 4}" x2="${LX + 26}" y2="${ly - 4}" stroke="${a.color}" stroke-width="4" stroke-linecap="round"${a.layer === "air" ? ` stroke-dasharray="2 7"` : ""}/>`);
  svg.push(`<text x="${LX + 36}" y="${ly}" fill="#c8ddf2" font-size="13">${a.label} · ${a.layer}</text>`);
  ly -= 22;
}

svg.push(`</svg>`);

mkdirSync("assets", { recursive: true });
writeFileSync("assets/hero.svg", svg.join("\n"));
console.log(`wrote assets/hero.svg (${ACTORS.length} planned paths, 0 conflicts)`);
