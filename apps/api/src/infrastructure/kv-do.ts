import { DurableObject } from 'cloudflare:workers';
import type { KvStore } from './kv.js';

type StoredValue = { value: string; expiresAt: number };
const VALUE_KEY = 'value';

export class KvDurableObject extends DurableObject<Env> {
  private async current(): Promise<StoredValue | null> {
    const entry = await this.ctx.storage.get<StoredValue>(VALUE_KEY);
    if (!entry) return null;
    if (entry.expiresAt > Date.now()) return entry;
    await Promise.all([this.ctx.storage.delete(VALUE_KEY), this.ctx.storage.deleteAlarm()]);
    return null;
  }

  async getValue(): Promise<string | null> {
    return (await this.current())?.value ?? null;
  }

  async setValue(value: string, ttlSeconds: number): Promise<void> {
    const entry = { value, expiresAt: Date.now() + ttlSeconds * 1000 } satisfies StoredValue;
    await Promise.all([
      this.ctx.storage.put(VALUE_KEY, entry),
      this.ctx.storage.setAlarm(entry.expiresAt),
    ]);
  }

  async setIfAbsent(value: string, ttlSeconds: number): Promise<boolean> {
    if (await this.current()) return false;
    await this.setValue(value, ttlSeconds);
    return true;
  }

  async deleteValue(): Promise<void> {
    await Promise.all([this.ctx.storage.delete(VALUE_KEY), this.ctx.storage.deleteAlarm()]);
  }

  async incrementValue(ttlSeconds: number): Promise<number> {
    const entry = await this.current();
    const next = Number(entry?.value ?? '0') + 1;
    await this.setValue(
      String(next),
      entry ? Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000)) : ttlSeconds,
    );
    return next;
  }

  async alarm(): Promise<void> {
    const entry = await this.ctx.storage.get<StoredValue>(VALUE_KEY);
    if (!entry || entry.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(VALUE_KEY);
      return;
    }
    await this.ctx.storage.setAlarm(entry.expiresAt);
  }
}

export class DurableObjectKvStore implements KvStore {
  constructor(private readonly namespace: DurableObjectNamespace<KvDurableObject>) {}
  private stub(key: string): DurableObjectStub<KvDurableObject> {
    return this.namespace.getByName(key);
  }
  async get(key: string): Promise<string | null> {
    return this.stub(key).getValue();
  }
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.stub(key).setValue(value, ttlSeconds);
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    return this.stub(key).setIfAbsent(value, ttlSeconds);
  }
  async delete(key: string): Promise<void> {
    await this.stub(key).deleteValue();
  }
  async increment(key: string, ttlSeconds: number): Promise<number> {
    return this.stub(key).incrementValue(ttlSeconds);
  }
  async close(): Promise<void> {}
}
