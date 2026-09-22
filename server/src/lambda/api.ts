// The HTTP API behind API Gateway (SPEC.md §5).
// Environment: TABLE_NAME, STATE_MACHINE_ARN, API_KEYS_PARAM (SSM SecureString
// holding {"<user>": "<key>", …}, F11.1 and F14), GEOCODE_COUNTRIES.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Api } from "../app/api";
import { bundledCountries } from "../domain/countries";
import { MINUTE } from "../domain/time";
import { parseApiKeysJson, type ApiKeys } from "../domain/users";
import { log } from "../log";
import { dynamoStores, env, geocoder, secureParameter, SfnStarter, toApiRequest, toResult } from "./env";
import { KeyCache } from "./keys";

const keys = new KeyCache(
  async () => parseApiKeysJson(await secureParameter(env("API_KEYS_PARAM"))),
  5 * MINUTE,
);
let parts: Omit<ConstructorParameters<typeof Api>[0], "apiKeys"> | undefined;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let apiKeys: ApiKeys;
  try {
    apiKeys = await keys.get(Date.now());
  } catch (e) {
    log.error("API keys unavailable", { error: String(e) });
    return toResult({
      status: 503,
      body: { error: "internal", message: "API keys not configured (scripts/set-api-keys.sh)" },
    });
  }
  parts ??= {
    geocoder: geocoder(),
    stores: dynamoStores(),
    starter: new SfnStarter(env("STATE_MACHINE_ARN")),
    countries: bundledCountries(),
  };
  const r = await new Api({ ...parts, apiKeys }).handle(toApiRequest(event), new Date().toISOString());
  return toResult(r);
}
