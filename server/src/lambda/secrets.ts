// The auth secrets, re-read every few minutes (F11.1), so rotating the password
// or the session secret applies without a redeploy. A failed read isn't cached,
// so a momentary SSM failure doesn't lock everyone out until the TTL passes.

export class Cached<T> {
  private value: T | null = null;
  private readAt = 0;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
  ) {}

  async get(nowMs: number): Promise<T> {
    if (this.value !== null && nowMs - this.readAt < this.ttlMs) return this.value;
    this.value = await this.load();
    this.readAt = nowMs;
    return this.value;
  }
}
