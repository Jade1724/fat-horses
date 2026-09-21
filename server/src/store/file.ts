// JSON-file store for the CLI: the whole state in one file, rewritten atomically.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emptyState, StateStore, type StateData } from "./state";

/** `$XDG_DATA_HOME/fat-horses/store.json`, else `~/.local/share/fat-horses/store.json`. */
export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(env.HOME ?? homedir(), ".local", "share");
  return join(base, "fat-horses", "store.json");
}

function save(path: string, data: StateData): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, path);
}

export class FileStore extends StateStore {
  readonly path: string;

  constructor(path: string) {
    const data = existsSync(path)
      ? { ...emptyState(), ...(JSON.parse(readFileSync(path, "utf8")) as Partial<StateData>) }
      : emptyState();
    super(data, async (d) => save(path, d));
    this.path = path;
  }
}
