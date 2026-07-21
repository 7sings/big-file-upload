import { createClient, type RedisClientType } from 'redis';

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  close(): Promise<void>;
}

type Entry = { value: string; expiresAt: number };
export class MemoryKvStore implements KvStore {
  private readonly values = new Map<string, Entry>();
  async get(key: string): Promise<string | null> { const entry=this.values.get(key); if (!entry) return null; if (entry.expiresAt <= Date.now()) { this.values.delete(key); return null; } return entry.value; }
  async set(key: string,value: string,ttlSeconds: number): Promise<void> { this.values.set(key,{value,expiresAt:Date.now()+ttlSeconds*1000}); }
  async setIfAbsent(key:string,value:string,ttlSeconds:number):Promise<boolean>{if(await this.get(key)!==null)return false;await this.set(key,value,ttlSeconds);return true;}
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async increment(key: string,ttlSeconds: number): Promise<number> { const existing=await this.get(key); const current=Number(existing ?? '0')+1; if(existing===null)await this.set(key,String(current),ttlSeconds);else { const entry=this.values.get(key); if(entry)entry.value=String(current); } return current; }
  async close(): Promise<void> { this.values.clear(); }
}
export class RedisKvStore implements KvStore {
  private constructor(private readonly client: RedisClientType) {}
  static async connect(url: string): Promise<RedisKvStore> { const client=createClient({url}); await client.connect(); return new RedisKvStore(client as RedisClientType); }
  async get(key:string):Promise<string|null>{return this.client.get(key)}
  async set(key:string,value:string,ttlSeconds:number):Promise<void>{await this.client.set(key,value,{EX:ttlSeconds})}
  async setIfAbsent(key:string,value:string,ttlSeconds:number):Promise<boolean>{return (await this.client.set(key,value,{EX:ttlSeconds,NX:true}))==='OK'}
  async delete(key:string):Promise<void>{await this.client.del(key)}
  async increment(key:string,ttlSeconds:number):Promise<number>{const value=await this.client.incr(key); if(value===1) await this.client.expire(key,ttlSeconds); return value}
  async close():Promise<void>{await this.client.quit()}
}
