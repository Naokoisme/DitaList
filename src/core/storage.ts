import type { AppData, StorageInfo } from "../model";
import { createEmptyData, validateData } from "./domain";

const DATABASE = "dida-local-v1";
const STORE = "documents";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          `无法打开本地数据库：${request.error?.message || "未知错误"}`,
        ),
      );
    request.onblocked = () =>
      reject(
        new Error("本地数据库正被旧版本页面占用，请关闭其他 DitaList 窗口后重试"),
      );
  });
}

async function readBrowserState(): Promise<unknown> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .get("main");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error(`读取本地数据失败：${request.error?.message}`));
    });
  } finally {
    database.close();
  }
}

export async function loadData(): Promise<{
  data: AppData;
  info: StorageInfo;
}> {
  if (window.didaLocal) {
    const result = await window.didaLocal.load();
    return {
      data:
        result.data === null ? createEmptyData() : validateData(result.data),
      info: result.info,
    };
  }
  const saved = await readBrowserState();
  return {
    data: saved == null ? createEmptyData() : validateData(saved),
    info: { kind: "browser", path: "此浏览器的本地数据库（IndexedDB）" },
  };
}

export async function saveData(data: AppData): Promise<void> {
  const validated = validateData(data);
  if (window.didaLocal) return window.didaLocal.save(validated);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite", {
        durability: "strict",
      });
      const store = transaction.objectStore(STORE);
      const previous = store.get("main");
      previous.onsuccess = () => {
        if (previous.result != null) store.put(previous.result, "backup");
        store.put(validated, "main");
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          new Error(
            `保存失败，原数据保持不变：${transaction.error?.message || "事务取消"}`,
          ),
        );
      transaction.onerror = () =>
        reject(
          new Error(`保存失败：${transaction.error?.message || "数据库错误"}`),
        );
    });
  } finally {
    database.close();
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (window.didaLocal) return true;
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}

export async function exportData(data: AppData): Promise<boolean> {
  const validated = validateData(data);
  if (window.didaLocal) return window.didaLocal.exportBackup(validated);
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: "dida-local-backup",
          exportedAt: new Date().toISOString(),
          data: validated,
        },
        null,
        2,
      ),
    ],
    { type: "application/json;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `DitaList-备份-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
