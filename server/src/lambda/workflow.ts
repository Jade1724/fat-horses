// One pick-workflow step per invocation, called by Step Functions (SPEC.md §6).
// Input: {"step": "start" | "prepare_nearby" | "check_result" | "finish", "pick_id": "…", "user": "…"}.
// Output: StepOutput. Environment: TABLE_NAME.

import { z } from "zod";
import { runStep, type Deps, type StepOutput } from "../app/workflow";
import { systemRng } from "../domain/rng";
import { DEFAULT_USER, isValidUser } from "../domain/users";
import { log } from "../log";
import type { DynamoStores } from "../store/dynamo";
import { dynamoStores, workflowDeps } from "./env";

export const stepInput = z.object({
  step: z.enum(["start", "prepare_nearby", "check_result", "finish"]),
  pick_id: z.string().min(1),
  user: z.string().refine(isValidUser, "bad user").default(DEFAULT_USER),
});

let shared: { deps: Omit<Deps, "store">; stores: DynamoStores } | undefined;

export async function handler(event: unknown): Promise<StepOutput> {
  const { step, pick_id, user } = stepInput.parse(event);
  shared ??= { deps: workflowDeps(), stores: dynamoStores() };
  const deps: Deps = { ...shared.deps, store: shared.stores.forUser(user) };
  const out = await runStep(deps, step, pick_id, new Date().toISOString(), systemRng);
  log.info("step done", { pick_id, user, step, status: out.status, decided: out.decided });
  return out;
}
