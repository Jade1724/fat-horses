// JSON-file stores for the CLI and local server: every user's data and the
// caches in one file, rewritten atomically after every change.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_USER } from "../domain/users";
import { emptyRoot, StateStores, upgradeRoot, UserStore, type RootData } from "./state";

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

/** Every user's data in one JSON file. Files from before users existed load as the user "me". */
export class FileStores extends StateStores {
  readonly path: string;

  constructor(path: string) {
    const root = existsSync(path)
      ? upgradeRoot(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
      : emptyRoot();
    super(root, async (d) => save(path, d));
    this.path = path;
  }
}

/** One user's view of a JSON file (default: "me"). */
export class FileStore extends UserStore {
  readonly path: string;

  constructor(path: string, user = DEFAULT_USER) {
    super(new FileStores(path), user);
    this.path = path;
  }
}
