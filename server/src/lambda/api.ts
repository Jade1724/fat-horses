// The HTTP API behind API Gateway (SPEC.md §5).
// Environment: TABLE_NAME, STATE_MACHINE_ARN, API_KEYS_PARAM (SSM SecureString
// holding {"<user>": "<key>", …}, read at cold start, F11.1 and F14).

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Api } from "../app/api";
import { bundledCountries } from "../domain/countries";
import { parseApiKeysJson } from "../domain/users";
import { dynamoStores, env, geocoder, secureParameter, SfnStarter, toApiRequest, toResult } from "./env";

let api: Promise<Api> | undefined;

async function build(): Promise<Api> {
  const apiKeys = parseApiKeysJson(await secureParameter(env("API_KEYS_PARAM")));
  return new Api({
    geocoder: geocoder(),
    stores: dynamoStores(),
    starter: new SfnStarter(env("STATE_MACHINE_ARN")),
    countries: bundledCountries(),
    apiKeys,
  });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  api ??= build().catch((e: unknown) => {
    api = undefined; // retry the cold-start setup on the next call
    throw e;
  });
  const r = await (await api).handle(toApiRequest(event), new Date().toISOString());
  return toResult(r);
}
