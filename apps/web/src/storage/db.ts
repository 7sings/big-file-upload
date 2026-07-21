import type { UploadSession } from '../types';

const DB_NAME = 'flowdock-upload-workbench';
const SESSION_STORE = 'sessions';
const PROFILE_STORE = 'network-profiles';
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SESSION_STORE)) req.result.createObjectStore(SESSION_STORE, { keyPath: 'localId' });
      if (!req.result.objectStoreNames.contains(PROFILE_STORE)) req.result.createObjectStore(PROFILE_STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function transaction<T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = action(tx.objectStore(storeName));
    let result!: T;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? req.error); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction aborted')); };
  });
}

export interface StoredNetworkProfile { key: string; observedUploadBps: number; updatedAt: number }
export const sessionDb = {
  list: () => transaction<UploadSession[]>(SESSION_STORE, 'readonly', (store) => store.getAll()),
  put: (session: UploadSession) => transaction<IDBValidKey>(SESSION_STORE, 'readwrite', (store) => store.put(session)),
  remove: (localId: string) => transaction<undefined>(SESSION_STORE, 'readwrite', (store) => store.delete(localId)),
  clear: () => transaction<undefined>(SESSION_STORE, 'readwrite', (store) => store.clear()),
};
export const networkProfileDb = {
  get: (key: string) => transaction<StoredNetworkProfile | undefined>(PROFILE_STORE, 'readonly', (store) => store.get(key)),
  put: (profile: StoredNetworkProfile) => transaction<IDBValidKey>(PROFILE_STORE, 'readwrite', (store) => store.put(profile)),
};

export function fileIdentity(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}\0${file.size}\0${file.lastModified}`;
}
