// Users (SPEC.md F14): each API key belongs to one user, whose picks, passport
// and history are separate from everyone else's.

/** The user for single-key setups and data stored before users existed. */
export const DEFAULT_USER = "me";

/** User names are short and safe to put in storage keys. */
export function isValidUser(user: string): boolean {
  return /^[a-z0-9_-]{1,32}$/.test(user);
}

/** user → API key. */
export type ApiKeys = Record<string, string>;

/**
 * Local configuration: `FAT_HORSES_API_KEYS="haruka:key1,friend:key2"`, or the
 * single `FAT_HORSES_API_KEY` for the user "me". Throws on a malformed entry.
 */
export function apiKeysFromEnv(env: NodeJS.ProcessEnv = process.env): ApiKeys {
  const many = env.FAT_HORSES_API_KEYS?.trim();
  if (many) return parseApiKeyList(many);
  const one = env.FAT_HORSES_API_KEY?.trim();
  return one ? { [DEFAULT_USER]: one } : {};
}

export function parseApiKeyList(list: string): ApiKeys {
  const keys: ApiKeys = {};
  for (const entry of list
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)) {
    const at = entry.indexOf(":");
    const user = entry.slice(0, at).trim();
    const key = entry.slice(at + 1).trim();
    if (at < 1 || !isValidUser(user) || !key) {
      throw new Error(`bad API key entry "${entry.slice(0, 40)}": expected user:key with user [a-z0-9_-]`);
    }
    keys[user] = key;
  }
  return keys;
}

/** The SSM parameter's JSON: {"haruka": "<key>", "friend": "<key>"}. */
export function parseApiKeysJson(json: string): ApiKeys {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("API keys must be a JSON object of user → key");
  }
  const keys: ApiKeys = {};
  for (const [user, key] of Object.entries(value)) {
    if (!isValidUser(user) || typeof key !== "string" || !key)
      throw new Error(`bad API key entry for "${user}"`);
    keys[user] = key;
  }
  return keys;
}
