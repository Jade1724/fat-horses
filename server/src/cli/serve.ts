// `fat-horses serve`: the HTTP API (and optionally the built web UI) on localhost
// for development. Picks run in-process; the store is the CLI's JSON file.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { nominatimFromEnv, Overpass } from "../adapters/osm";
import { identityFromEnv, TabNz } from "../adapters/tabNz";
import { Api, type WorkflowStarter } from "../app/api";
import { defaultConfig, runPick, systemClock, type Deps } from "../app/workflow";
import { FakeClassifier } from "../domain/classify";
import { bundledCountries } from "../domain/countries";
import { systemRng } from "../domain/rng";
import type { PickSession } from "../domain/session";
import type { StateStore } from "../store/state";
import { log } from "../log";

/** Runs each pick as a background task in this process. */
export class LocalStarter implements WorkflowStarter {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: Deps) {}

  async start(pickId: string): Promise<void> {
    const session = await this.deps.store.getPick(pickId);
    if (!session) throw new Error("pick not stored");
    this.run(session);
  }

  /**
   * Carry on with picks a previous server left unfinished (F13): a pick runs
   * inside the server, so stopping the server stops it mid-way.
   */
  async resume(store: StateStore): Promise<number> {
    const picks = await store.unfinishedPicks();
    for (const s of picks) {
      log.info("resuming pick", { pick_id: s.pick_id, status: s.status });
      this.run(s);
    }
    return picks.length;
  }

  private run(session: PickSession): void {
    const pickId = session.pick_id;
    if (this.running.has(pickId)) return;
    const abort = new AbortController();
    this.running.set(pickId, abort);
    void runPick(this.deps, session, systemClock, systemRng, () => {}, abort.signal)
      .then((s) => log.info("pick finished", { pick_id: pickId, status: s.status }))
      .catch((e: unknown) => log.error("pick failed", { pick_id: pickId, error: String(e) }))
      .finally(() => this.running.delete(pickId));
  }

  async cancel(pickId: string): Promise<void> {
    this.running.get(pickId)?.abort();
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(webDir: string, path: string, res: ServerResponse): void {
  const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  let file = join(webDir, safe);
  if (!file.startsWith(webDir) || !existsSync(file) || statSync(file).isDirectory()) {
    file = join(webDir, "index.html"); // SPA fallback
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export function serve(store: StateStore, port: number, apiKey: string, webDir?: string): void {
  const deps: Deps = {
    races: new TabNz(identityFromEnv()),
    places: new Overpass(),
    classifier: new FakeClassifier(),
    store,
    countries: bundledCountries(),
    config: defaultConfig(),
  };
  const starter = new LocalStarter(deps);
  void starter.resume(store).then((n) => {
    if (n > 0) console.log(`Resumed ${n} unfinished pick${n === 1 ? "" : "s"}`);
  });
  const api = new Api({
    geocoder: nominatimFromEnv(),
    store,
    starter,
    countries: deps.countries,
    apiKey,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      void (async () => {
        try {
          const header = req.headers["x-api-key"];
          const r = await api.handle(
            {
              method: req.method ?? "GET",
              // Keep percent-encoding: take the raw path from req.url, not url.pathname.
              path: ((req.url ?? "").split("?")[0] ?? "").slice(4),
              query: Object.fromEntries(url.searchParams),
              apiKey: Array.isArray(header) ? header[0] : header,
              body: (await readBody(req)) || undefined,
            },
            new Date().toISOString(),
          );
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(JSON.stringify(r.body));
        } catch (e) {
          log.error("request failed", { error: String(e) });
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal", message: "unexpected error" }));
        }
      })();
    } else if (webDir) {
      serveStatic(webDir, url.pathname, res);
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Serving the API on http://127.0.0.1:${port}/api`));
}
