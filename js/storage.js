/*
 * Archivio locale (IndexedDB), database "picspeak".
 * Versione 1: archivio "settings" (chiave-valore).
 * Versione 2: aggiunti gli archivi del modello dati (docs/FORMATO-DATI.md):
 *   profiles, pages, images, contexts, usage, audio (chiave = campo "id").
 * Se IndexedDB non è disponibile (es. alcune modalità private), si usa la memoria
 * della sessione: il tool funziona, ma i dati non restano salvati.
 */
(function () {
  'use strict';

  const DB_NAME = 'picspeak-anteprima';
  const DB_VERSION = 2;
  const SETTINGS = 'settings';
  const RECORD_STORES = ['profiles', 'pages', 'images', 'contexts', 'usage', 'audio'];

  const memory = new Map();
  const memoryStores = new Map(RECORD_STORES.map((name) => [name, new Map()]));
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB non disponibile'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
        RECORD_STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  function run(storeName, mode, action) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const result = action(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  // ---------- Impostazioni (chiave-valore) ----------

  async function get(key) {
    try {
      return await run(SETTINGS, 'readonly', (store) => store.get(key));
    } catch (error) {
      return memory.get(key);
    }
  }

  async function set(key, value) {
    memory.set(key, value);
    try {
      await run(SETTINGS, 'readwrite', (store) => { store.put(value, key); });
    } catch (error) {
      // Resta solo in memoria per questa sessione
    }
  }

  async function remove(key) {
    memory.delete(key);
    try {
      await run(SETTINGS, 'readwrite', (store) => { store.delete(key); });
    } catch (error) {
      // Nulla da fare
    }
  }

  // ---------- Archivi del modello dati (record con campo "id") ----------

  async function getRecord(storeName, id) {
    try {
      return await run(storeName, 'readonly', (store) => store.get(id));
    } catch (error) {
      return memoryStores.get(storeName).get(id);
    }
  }

  async function getAllRecords(storeName) {
    try {
      return (await run(storeName, 'readonly', (store) => store.getAll())) || [];
    } catch (error) {
      return [...memoryStores.get(storeName).values()];
    }
  }

  async function putRecord(storeName, record) {
    memoryStores.get(storeName).set(record.id, record);
    try {
      await run(storeName, 'readwrite', (store) => { store.put(record); });
    } catch (error) {
      // Resta solo in memoria per questa sessione
    }
  }

  async function putRecords(storeName, records) {
    records.forEach((record) => memoryStores.get(storeName).set(record.id, record));
    try {
      await run(storeName, 'readwrite', (store) => { records.forEach((record) => store.put(record)); });
    } catch (error) {
      // Restano solo in memoria per questa sessione
    }
  }

  async function deleteRecord(storeName, id) {
    memoryStores.get(storeName).delete(id);
    try {
      await run(storeName, 'readwrite', (store) => { store.delete(id); });
    } catch (error) {
      // Nulla da fare
    }
  }

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.storage = {
    get, set, remove, getRecord, getAllRecords, putRecord, putRecords, deleteRecord,
  };
})();
