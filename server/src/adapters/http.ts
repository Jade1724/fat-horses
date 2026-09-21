// HTTP with the app's User-Agent and a timeout (SPEC.md N4).

import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

/**
 * Node tries each address of a host ("happy eyeballs") for only 250 ms by
 * default. Where IPv6 is unreachable and IPv4 connects slowly (seen with
 * overpass-api.de), every attempt then fails with ETIMEDOUT while curl works.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2000;
setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);

export const VERSION = "0.1.0";

/** Identifies the app to the services it calls, as their usage policies ask. */
export const USER_AGENT = `fat-horses/${VERSION} (+https://github.com/Jade1724/fat-horses)`;

export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

/** Fetch text, failing on non-2xx and after `timeoutMs`. */
export async function fetchText(
  url: string,
  init: RequestInit & { timeoutMs?: number; fetchFn?: Fetch } = {},
): Promise<string> {
  const { timeoutMs = 20_000, fetchFn = fetch, headers, ...rest } = init;
  const resp = await fetchFn(url, {
    ...rest,
    headers: { "user-agent": USER_AGENT, ...(headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new HttpError(resp.status, url);
  return resp.text();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
