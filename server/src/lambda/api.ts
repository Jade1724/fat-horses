// The HTTP API behind API Gateway (SPEC.md §5).
// Environment: TABLE_NAME, API_KEY_PARAM (SSM SecureString name, read at cold start), STATE_MACHINE_ARN.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Api } from "../app/api";
import { bundledCountries } from "../domain/countries";
import { dynamoStore, env, geocoder, secureParameter, SfnStarter, toApiRequest, toResult } from "./env";

let api: Promise<Api> | undefined;

function build(): Promise<Api> {
  return secureParameter(env("API_KEY_PARAM")).then(
    (apiKey) =>
      new Api({
        geocoder: geocoder(),
        store: dynamoStore(),
        starter: new SfnStarter(env("STATE_MACHINE_ARN")),
        countries: bundledCountries(),
        apiKey,
      }),
  );
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  api ??= build().catch((e: unknown) => {
    api = undefined; // retry the cold-start setup on the next call
    throw e;
  });
  const r = await (await api).handle(toApiRequest(event), new Date().toISOString());
  return toResult(r);
}
