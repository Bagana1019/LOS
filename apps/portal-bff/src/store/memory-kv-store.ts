import type { Clock } from '../common/clock';
import type { KvStore } from './kv-store';

interface Entry {
  value: string;
  expiresAt: number;
}

/** Dev/тестийн in-memory хэрэгжүүлэлт. Нэг процесс — production-д Redis ашиглана (config шалгана). */
export class MemoryKvStore implements KvStore {
  private readonly data = new Map<string, Entry>();

  constructor(private readonly clock: Clock) {}

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.clock.now().getTime()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private expiry(ttlSec: number): number {
    return this.clock.now().getTime() + ttlSec * 1000;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.data.set(key, { value, expiresAt: this.expiry(ttlSec) });
  }

  async setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
    if (this.live(key)) return false;
    this.data.set(key, { value, expiresAt: this.expiry(ttlSec) });
    return true;
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async getAndDelete(key: string): Promise<string | null> {
    const e = this.live(key);
    if (!e) return null;
    this.data.delete(key);
    return e.value;
  }

  async incr(key: string, ttlSec: number): Promise<number> {
    const e = this.live(key);
    if (!e) {
      this.data.set(key, { value: '1', expiresAt: this.expiry(ttlSec) });
      return 1;
    }
    const next = Number(e.value) + 1;
    e.value = String(next);
    return next;
  }

  async ttl(key: string): Promise<number> {
    const e = this.live(key);
    if (!e) return 0;
    return Math.max(0, Math.ceil((e.expiresAt - this.clock.now().getTime()) / 1000));
  }
}
