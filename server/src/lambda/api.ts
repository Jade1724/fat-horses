// The HTTP API behind API Gateway (SPEC.md §5).
// Environment: TABLE_NAME, STATE_MACHINE_ARN, GEOCODE_COUNTRIES, and the two
// SSM SecureStrings PASSWORD_HASH_PARAM and SESSION_SECRET_PARAM (F11.1).

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { Api, type AuthConfig } from "../app/api";
import { bundledCountries } from "../domain/countries";
import { MINUTE } from "../domain/time";
import { log } from "../log";
import { dynamoStore, env, geocoder, secureParameter, SfnStarter, toApiRequest, toResult } from "./env";
import { Cached } from "./secrets";

/** Behind CloudFront the site is always https, so the cookie is always Secure. */
const auth = new Cached<AuthConfig>(async () => {
  const [passwordHash, sessionSecret] = await Promise.all([
    secureParameter(env("PASSWORD_HASH_PARAM")),
    secureParameter(env("SESSION_SECRET_PARAM")),
  ]);
  return { passwordHash, sessionSecret, secureCookie: true };
}, 5 * MINUTE);

let parts: Omit<ConstructorParameters<typeof Api>[0], "auth"> | undefined;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  let config: AuthConfig;
  try {
    config = await auth.get(Date.now());
  } catch (e) {
    log.error("auth secrets unavailable", { error: String(e) });
    return toResult({
      status: 503,
      body: { error: "internal", message: "no password set (scripts/set-password.sh)" },
    });
  }
  parts ??= {
    geocoder: geocoder(),
    store: dynamoStore(),
    starter: new SfnStarter(env("STATE_MACHINE_ARN")),
    countries: bundledCountries(),
  };
  const r = await new Api({ ...parts, auth: config }).handle(toApiRequest(event), new Date().toISOString());
  return toResult(r);
}
