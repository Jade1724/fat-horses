import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { toApiRequest, toResult } from "./env";

function event(over: Partial<APIGatewayProxyEventV2>): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/api/history",
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    requestContext: { http: { method: "GET" } } as APIGatewayProxyEventV2["requestContext"],
    ...over,
  };
}

describe("API Gateway mapping", () => {
  it("strips /api, keeps encoding, reads the key and query", () => {
    const r = toApiRequest(
      event({
        rawPath: "/api/restaurants/osm%3Anode%2F1/visit",
        headers: { "x-api-key": "k" },
        queryStringParameters: { cursor: "c" },
        requestContext: { http: { method: "POST" } } as APIGatewayProxyEventV2["requestContext"],
        body: "{}",
      }),
    );
    expect(r).toEqual({
      method: "POST",
      path: "/restaurants/osm%3Anode%2F1/visit",
      query: { cursor: "c" },
      apiKey: "k",
      body: "{}",
    });
  });

  it("decodes base64 bodies and treats empty as none", () => {
    expect(toApiRequest(event({ body: Buffer.from('{"a":1}').toString("base64"), isBase64Encoded: true })).body).toBe(
      '{"a":1}',
    );
    expect(toApiRequest(event({ body: "" })).body).toBeUndefined();
  });

  it("returns JSON that isn't cached", () => {
    expect(toResult({ status: 422, body: { error: "x" } })).toEqual({
      statusCode: 422,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: '{"error":"x"}',
    });
  });
});
