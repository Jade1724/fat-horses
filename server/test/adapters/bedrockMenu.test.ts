// Reading menu photos with Claude on Bedrock (F15), against a recorded reply (no network).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BedrockMenuReader, menuReaderFromEnv } from "../../src/adapters/bedrockMenu";
import { FakeMenuReader, MenuReadingNotSetUp, MenuUnreadable } from "../../src/domain/menu";

const MODEL = "au.anthropic.claude-haiku-4-5-test";
const IMAGE = {
  media_type: "image/jpeg" as const,
  data: Buffer.from([0xff, 0xd8, 0xff, 0]).toString("base64"),
};
const reply = JSON.parse(
  readFileSync(new URL("../fixtures/bedrock/menu_read.json", import.meta.url), "utf8"),
);

/** A fetch that records each request and answers with `body`. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fn: fn as typeof fetch, calls };
}

const reader = (f: typeof fetch) =>
  new BedrockMenuReader(MODEL, { awsRegion: "ap-southeast-2", skipAuth: true, fetch: f, maxRetries: 0 });

describe("BedrockMenuReader", () => {
  it("sends the photo with a forced record_menu call and returns what it read", async () => {
    const f = fakeFetch(reply);
    const reading = await reader(f.fn).read(IMAGE);
    expect(reading).toEqual({
      restaurant_name: "Siam House",
      dishes: ["Pad Thai", "Green Curry", "Chicken Satay", "Tom Yum Goong"],
    });
    const [call] = f.calls;
    expect(call?.url).toContain(`/model/${encodeURIComponent(MODEL)}/invoke`);
    const messages = call?.body.messages as { content: { type: string; source?: unknown }[] }[];
    expect(messages[0]?.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: IMAGE.data },
    });
    expect(call?.body.tool_choice).toEqual({ type: "tool", name: "record_menu" });
  });

  it("treats a refusal, a cut-off answer or a malformed reading as unreadable", async () => {
    for (const bad of [
      { ...reply, stop_reason: "refusal", content: [] },
      { ...reply, stop_reason: "max_tokens" },
      { ...reply, content: [{ ...reply.content[0], input: { dishes: "Pad Thai" } }] },
      { ...reply, content: [{ type: "text", text: "Sorry, I can't read that." }], stop_reason: "end_turn" },
    ]) {
      await expect(reader(fakeFetch(bad).fn).read(IMAGE)).rejects.toBeInstanceOf(MenuUnreadable);
    }
  });

  it("turns an error from Bedrock into MenuUnreadable", async () => {
    const f = fakeFetch({ message: "throttled" }, 429);
    await expect(reader(f.fn).read(IMAGE)).rejects.toBeInstanceOf(MenuUnreadable);
  });
});

describe("menuReaderFromEnv", () => {
  it("uses the fake reader for local runs that ask for it", () => {
    expect(menuReaderFromEnv({ MENU_READER: "fake" })).toBeInstanceOf(FakeMenuReader);
  });

  it("reads with Bedrock once a model is configured", () => {
    expect(menuReaderFromEnv({ MENU_MODEL_ID: MODEL, AWS_REGION: "ap-southeast-2" })).toBeInstanceOf(
      BedrockMenuReader,
    );
  });

  it("says menu reading isn't set up when no model is configured", async () => {
    await expect(menuReaderFromEnv({ MENU_MODEL_ID: " " }).read(IMAGE)).rejects.toBeInstanceOf(
      MenuReadingNotSetUp,
    );
  });
});
