// Lambda wiring (SPEC.md §6): configuration from the environment and AWS clients.
// Logic lives in `app`.

import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { nominatimFromEnv, type Nominatim, Overpass } from "../adapters/osm";
import { identityFromEnv, TabNz } from "../adapters/tabNz";
import type { ApiRequest, ApiResponse, WorkflowStarter } from "../app/api";
import { defaultConfig, type Deps } from "../app/workflow";
import { FakeClassifier } from "../domain/classify";
import { bundledCountries } from "../domain/countries";
import { DynamoStores } from "../store/dynamo";

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

/** Every user's store over TABLE_NAME (F14). */
export function dynamoStores(): DynamoStores {
  return new DynamoStores(env("TABLE_NAME"));
}

/** Read a SecureString parameter (the API keys, F11.1). */
export async function secureParameter(name: string): Promise<string> {
  const out = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} has no value`);
  return value;
}

/** Starts the pick state machine; the execution is named after the pick. */
export class SfnStarter implements WorkflowStarter {
  private readonly client = new SFNClient({});
  constructor(private readonly stateMachineArn: string) {}

  async start(pickId: string, user: string): Promise<void> {
    await this.client.send(
      new StartExecutionCommand({
        stateMachineArn: this.stateMachineArn,
        name: pickId,
        input: JSON.stringify({ pick_id: pickId, user }),
      }),
    );
  }

  async cancel(pickId: string): Promise<void> {
    await this.client.send(
      new StopExecutionCommand({
        executionArn: executionArn(this.stateMachineArn, pickId),
        cause: "cancelled by the user",
      }),
    );
  }
}

/** Executions are named after the pick, so their ARN follows from the state machine's. */
export function executionArn(stateMachineArn: string, pickId: string): string {
  return `${stateMachineArn.replace(":stateMachine:", ":execution:")}:${pickId}`;
}

/**
 * Workflow dependencies. The classifier guesses nothing until Bedrock is wired
 * in (T3.9), so only tagged matches (tier 1) are found.
 */
/** Workflow dependencies except the store, which is per user. */
export function workflowDeps(): Omit<Deps, "store"> {
  const config = defaultConfig();
  config.guess.model_id = process.env.BEDROCK_MODEL_ID ?? "none";
  return {
    races: new TabNz(identityFromEnv()),
    places: new Overpass(),
    classifier: new FakeClassifier(),
    countries: bundledCountries(),
    config,
  };
}

/** Countries addresses are searched in (F1.2): GEOCODE_COUNTRIES, default "nz". */
export function geocoder(): Nominatim {
  return nominatimFromEnv();
}

/** API Gateway (HTTP API, payload v2) → framework-free request. */
export function toApiRequest(event: APIGatewayProxyEventV2): ApiRequest {
  const raw = event.rawPath;
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : undefined;
  return {
    method: event.requestContext.http.method,
    path: raw.startsWith("/api") ? raw.slice(4) : raw,
    query: event.queryStringParameters ?? {},
    apiKey: event.headers["x-api-key"],
    body: body || undefined,
  };
}

export function toResult(r: ApiResponse): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: r.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(r.body),
  };
}
