// API keys, re-read every few minutes (F11.1), so new or changed keys apply
// without a redeploy. A failed read isn't cached.

import type { ApiKeys } from "../domain/users";

export class KeyCache {
  private value: ApiKeys | null = null;
  private readAt = 0;

  constructor(
    private readonly load: () => Promise<ApiKeys>,
    private readonly ttlMs: number,
  ) {}

  async get(nowMs: number): Promise<ApiKeys> {
    if (this.value && nowMs - this.readAt < this.ttlMs) return this.value;
    this.value = await this.load();
    this.readAt = nowMs;
    return this.value;
  }
}
