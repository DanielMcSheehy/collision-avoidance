import { Mastra } from "@mastra/core";
import { robotExecutorAgent } from "./agents/robot-executor";
import { taskManagerAgent } from "./agents/task-manager";
import { pefaWorkflow } from "./workflows/pefa";

export const mastra = new Mastra({
  agents: { taskManagerAgent, robotExecutorAgent },
  workflows: { pefaWorkflow },
});
