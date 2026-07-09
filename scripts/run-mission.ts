import { mastra } from "../src/mastra/index";

/**
 * End-to-end PEFA demo with a mid-mission robot breakdown, forcing the
 * feedback -> adjustment branch to reassign work.
 *
 *   bun scripts/run-mission.ts [mission text]
 */

const mission =
  process.argv[2] ??
  "Survey the tops of all four shelf racks for damaged stock, then deliver a replacement pallet from the loading dock area at (2,2) to the staging cell at (21,8). Finally have the arm robot inspect and adjust the pallet at the staging cell.";

const workflow = mastra.getWorkflow("pefaWorkflow");
const run = await workflow.createRun();

console.log(`MISSION: ${mission}\n`);
console.log("Injecting breakdown: ugv-2 goes dark at tick 30 of round 1.\n");

const result = await run.start({
  inputData: {
    mission,
    robotFailures: [{ robotId: "ugv-2", atTick: 30 }],
    maxRounds: 3,
  },
});

if (result.status !== "success") {
  console.error(`Workflow ended with status '${result.status}'`);
  if (result.status === "failed") console.error(result.error);
  process.exit(1);
}

const report = result.result;
console.log("=".repeat(70));
console.log(`SUCCESS: ${report.success}  (rounds used: ${report.rounds})`);
console.log("=".repeat(70));

console.log("\nSUBTASK OUTCOMES");
for (const r of report.finalStatus) {
  const task = report.subtasks.find((t) => t.id === r.subtaskId);
  console.log(
    `  [${r.status.toUpperCase().padEnd(9)}] ${r.subtaskId} -> ${r.robotId ?? "-"} | ${task?.description ?? ""} | ${r.reason}`,
  );
}

console.log("\nTELEMETRY (per round)");
for (const [i, t] of report.telemetry.entries()) {
  console.log(
    `  round ${i + 1}: ${t.ticks} ticks, ${t.waves} waves, ${t.cbfInterventions} CBF interventions, min separation ${t.minSeparation}m`,
  );
}

console.log("\nEVENT LOG");
for (const e of report.events) console.log(`  - ${e}`);

console.log("\nFINAL POSITIONS");
console.log(report.map);
