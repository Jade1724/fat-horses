// One pick-workflow step per invocation, called by Step Functions (SPEC.md §6).
// Input: {"step": "start" | "prepare_nearby" | "check_result" | "finish" | "fail", "pick_id": "…"}.
// Output: StepOutput. Environment: TABLE_NAME.

import { z } from "zod";
import { runStep, type Deps, type StepOutput } from "../app/workflow";
import { systemRng } from "../domain/rng";
import { log } from "../log";
import type { DynamoStore } from "../store/dynamo";
import { dynamoStore, workflowDeps } from "./env";

export const stepInput = z.object({
  step: z.enum(["start", "prepare_nearby", "check_result", "finish", "fail"]),
  pick_id: z.string().min(1),
});

let shared: { deps: Omit<Deps, "store">; store: DynamoStore } | undefined;

export async function handler(event: unknown): Promise<StepOutput> {
  const { step, pick_id } = stepInput.parse(event);
  shared ??= { deps: workflowDeps(), store: dynamoStore() };
  const deps: Deps = { ...shared.deps, store: shared.store };
  const out = await runStep(deps, step, pick_id, new Date().toISOString(), systemRng);
  log.info("step done", { pick_id, step, status: out.status, decided: out.decided });
  return out;
}
