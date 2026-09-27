// Reading menu photos with Claude on Amazon Bedrock (SPEC.md F15, §3). The
// model only transcribes the dishes on the photo; the race chooses among them.
// Uses Bedrock's standard InvokeModel endpoint, which serves Claude Haiku 4.5
// and needs only `bedrock:InvokeModel`.

import { AnthropicBedrock, type ClientOptions as BedrockClientOptions } from "@anthropic-ai/bedrock-sdk";
import { z } from "zod";
import {
  FakeMenuReader,
  MenuReadingNotSetUp,
  MenuUnreadable,
  type MenuImage,
  type MenuReader,
  type MenuReading,
} from "../domain/menu";
import { log } from "../log";

/** Credentials come from the default AWS chain (the Lambda role, or a local profile), never static keys. */
type ClientOptions = Omit<BedrockClientOptions, "awsAccessKey" | "awsSecretKey" | "awsSessionToken">;

const PROMPT = `This is a photo of a restaurant menu. A group of friends will let a horse race choose which dishes they order, so list what they could order to eat.

- dishes: every food item someone could order, named as the menu names it (keep its language and spelling). Leave out drinks, prices, section headings, descriptions, and add-ons or extras. List each dish once.
- restaurant_name: the restaurant's name if the menu shows it, otherwise null.

If the photo is not a menu or can't be read, return an empty dishes list.`;

const TOOL = {
  name: "record_menu",
  description: "Record the dishes read from the menu photo.",
  input_schema: {
    type: "object" as const,
    properties: {
      restaurant_name: { type: ["string", "null"], description: "The restaurant's name, if shown." },
      dishes: { type: "array", items: { type: "string" }, description: "Orderable food items, as written." },
    },
    required: ["restaurant_name", "dishes"],
    additionalProperties: false,
  },
};

const reading = z.object({ restaurant_name: z.string().nullable(), dishes: z.array(z.string()) });

export class BedrockMenuReader implements MenuReader {
  private readonly client: AnthropicBedrock;

  constructor(
    private readonly model: string,
    options: ClientOptions = {},
  ) {
    // The api Lambda has 28 s; one retry of a 12 s call fits.
    this.client = new AnthropicBedrock({ timeout: 12_000, maxRetries: 1, ...options });
  }

  async read(image: MenuImage): Promise<MenuReading> {
    let res;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      });
    } catch (e) {
      throw new MenuUnreadable(`bedrock call failed: ${String(e)}`);
    }
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
      throw new MenuUnreadable(`model stopped: ${res.stop_reason}`);
    }
    const call = res.content.find((b) => b.type === "tool_use" && b.name === TOOL.name);
    const parsed = reading.safeParse(call?.type === "tool_use" ? call.input : undefined);
    if (!parsed.success) throw new MenuUnreadable("the model's reading was malformed");
    log.info("menu model call", {
      model: this.model,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    });
    return parsed.data;
  }
}

class UnconfiguredMenuReader implements MenuReader {
  async read(): Promise<MenuReading> {
    throw new MenuReadingNotSetUp("menu reading isn't set up: MENU_MODEL_ID is empty");
  }
}

/**
 * The reader for this environment: `MENU_READER=fake` for local runs without
 * Bedrock; otherwise Claude on Bedrock with MENU_MODEL_ID, if one is set.
 */
export function menuReaderFromEnv(env: NodeJS.ProcessEnv = process.env): MenuReader {
  if (env.MENU_READER === "fake") return new FakeMenuReader();
  const model = env.MENU_MODEL_ID?.trim();
  if (!model) return new UnconfiguredMenuReader();
  return new BedrockMenuReader(model, { awsRegion: env.AWS_REGION ?? "ap-southeast-2" });
}
