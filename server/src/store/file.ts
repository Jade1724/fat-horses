// The JSON-file store for the CLI and local server: the shared data and the
// caches in one file, rewritten atomically after every change.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emptyRoot, StateStore, upgradeRoot, type RootData } from "./state";

/** `$XDG_DATA_HOME/fat-horses/store.json`, else `~/.local/share/fat-horses/store.json`. */
export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(env.HOME ?? homedir(), ".local", "share");
  return join(base, "fat-horses", "store.json");
}

function save(path: string, data: RootData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, path);
}

/** One JSON file. Older per-user files load as the data that was stored for "me". */
export class FileStore extends StateStore {
  readonly path: string;

  constructor(path: string) {
    const root = existsSync(path)
      ? upgradeRoot(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
      : emptyRoot();
    super(root, async (d) => save(path, d));
    this.path = path;
  }
}
