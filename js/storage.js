/*
 * Archivio locale (IndexedDB), database "picspeak".
 * Versione 1: archivio "settings" (chiave-valore).
 * Versione 2: aggiunti gli archivi del modello dati (docs/FORMATO-DATI.md):
 *   profiles, pages, images, contexts, usage, audio (chiave = campo "id").
 * Se IndexedDB non è disponibile (es. alcune modalità private), si usa la memoria
 * della sessione: il tool funziona, ma i dati non restano salvati.
 *
 * Profili multipli: le scelte che riguardano il bambino (aspetto, voce, lingua, tocco e frase, previsione…,
 * elenco PROFILE_KEYS) si salvano per profilo, con la chiave «p:<id profilo>:<nome>». Chi usa get/set/remove
 * non se ne accorge: vale sempre il profilo in uso (activeProfileId). Le altre chiavi (PIN, uso di internet,
 * fonti dei simboli, modelli salvati, schermo…) restano del dispositivo.
 * La prima volta le scelte già salvate senza profilo passano al profilo in uso (migrazione automatica).
 */
(function () {
  'use strict';

  const DB_NAME = 'picspeak-anteprima';
  const DB_VERSION = 2;
  const SETTINGS = 'settings';
  const RECORD_STORES = ['profiles', 'pages', 'images', 'contexts', 'usage', 'audio'];

  // Scelte salvate per profilo (vedi sopra e docs/FORMATO-DATI.md)
  const PROFILE_KEYS = [
    'language', 'voice', 'colorMode', 'pageBackground', 'appearance', 'preset', 'labelCase',
    'communication', 'prediction', 'printOptions', 'lockPositions', 'gridDefault', 'lastBackup', 'backupReminder', 'typeColors',
  ];
  const PROFILE_KEY_SET = new Set(PROFILE_KEYS);
  const ACTIVE_KEY = 'activeProfileId';
  const MIGRATED_KEY = 'profileSettings'; // 1 = scelte già spostate nel profilo
  const PROFILE_ID = /^p_[A-Za-z0-9]{1,40}$/;

  const memory = new Map();
  // Chi vuole sapere quando cambia qualcosa nell'archivio (backup online): riceve (archivio, chiave o id)
  const listeners = new Set();

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // owners: profili a cui appartengono i record scritti (se si sanno), per chi deve sapere quale profilo è cambiato
  function notify(storeName, key, owners) {
    listeners.forEach((listener) => {
      try { listener(storeName, key, owners); } catch (error) { /* un ascoltatore non blocca il salvataggio */ }
    });
  }
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

  /*
   * Archiviazione «persistente»: il browser non cancella da solo i dati di PicSpeak quando lo spazio scarseggia.
   * Scelta fissa: si chiede sempre (Impostazioni › Sicurezza mostra solo lo stato). Se il browser non ha la funzione
   * o dice no non succede nulla: i dati restano salvati come sempre, solo senza la protezione in più.
   * Safari e Chrome decidono da soli senza finestre (la concedono più facilmente all'app aggiunta alla schermata Home);
   * Firefox mostra una richiesta di permesso: per questo si chiede solo nella modalità adulto, mai davanti al bambino.
   * Una volta concessa, nessuna funzione del browser permette al sito di ritirarla: si toglie dalle impostazioni del
   * browser (dati o permessi del sito).
   * Stato: 'granted' (protetti), 'not' (non ancora), 'unsupported' (il browser non permette di chiederlo).
   */
  function storageManager() {
    try {
      const sm = navigator.storage;
      return sm && typeof sm.persist === 'function' && typeof sm.persisted === 'function' ? sm : null;
    } catch (error) {
      return null;
    }
  }

  async function persistenceStatus() {
    const sm = storageManager();
    if (!sm) return 'unsupported';
    try {
      return (await sm.persisted()) ? 'granted' : 'not';
    } catch (error) {
      return 'not';
    }
  }

  // Chiede la protezione (se non c'è già) e restituisce lo stato che ne risulta; non lancia mai errori
  async function requestPersistence() {
    const sm = storageManager();
    if (!sm) return 'unsupported';
    try {
      if (await sm.persisted()) return 'granted';
      return (await sm.persist()) ? 'granted' : 'not';
    } catch (error) {
      return 'not';
    }
  }

  // All'ingresso nella modalità adulto: se non è già concessa la si chiede, ma al massimo una volta ogni 7 giorni
  // per dispositivo (Firefox mostra una domanda: non va ripetuta a ogni sblocco). Non lancia mai errori.
  const KEEP_ASKED_KEY = 'keepDataAsked';
  const KEEP_ASK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

  async function keepData() {
    try {
      const status = await persistenceStatus();
      if (status !== 'not') return status;
      const asked = Date.parse(await get(KEEP_ASKED_KEY));
      if (!Number.isNaN(asked) && Date.now() - asked >= 0 && Date.now() - asked < KEEP_ASK_EVERY_MS) return status;
      await set(KEEP_ASKED_KEY, new Date().toISOString());
      return await requestPersistence();
    } catch (error) {
      return 'not';
    }
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

  async function rawGet(key) {
    try {
      return await run(SETTINGS, 'readonly', (store) => store.get(key));
    } catch (error) {
      return memory.get(key);
    }
  }

  async function rawSet(key, value) {
    memory.set(key, value);
    try {
      await run(SETTINGS, 'readwrite', (store) => { store.put(value, key); });
    } catch (error) {
      // Resta solo in memoria per questa sessione
    }
    notify(SETTINGS, key);
  }

  async function rawRemove(key) {
    memory.delete(key);
    try {
      await run(SETTINGS, 'readwrite', (store) => { store.delete(key); });
    } catch (error) {
      // Nulla da fare
    }
    notify(SETTINGS, key);
  }

  // ---------- Profilo in uso e scelte per profilo ----------

  let activePromise = null;

  function newProfileId() {
    // Stesso formato degli altri id (data.newId): p_ + 16 cifre esadecimali
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `p_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  function profileKey(profileId, key) {
    return `p:${profileId}:${key}`;
  }

  /*
   * Id del profilo in uso. Se manca (primissima apertura) se ne prepara uno: data.js crea poi il profilo con
   * questo id. La prima volta sposta nel profilo le scelte salvate quando i profili non esistevano.
   */
  function activeProfileId() {
    if (activePromise) return activePromise;
    activePromise = (async () => {
      let id = await rawGet(ACTIVE_KEY);
      if (typeof id !== 'string' || !PROFILE_ID.test(id)) {
        id = newProfileId();
        await rawSet(ACTIVE_KEY, id);
      }
      if ((await rawGet(MIGRATED_KEY)) !== 1) {
        for (const key of PROFILE_KEYS) {
          const value = await rawGet(key);
          if (value === undefined) continue;
          if ((await rawGet(profileKey(id, key))) === undefined) await rawSet(profileKey(id, key), value);
          await rawRemove(key);
        }
        await rawSet(MIGRATED_KEY, 1);
      }
      return id;
    })();
    return activePromise;
  }

  async function resolveKey(key) {
    return PROFILE_KEY_SET.has(key) ? profileKey(await activeProfileId(), key) : key;
  }

  async function get(key) {
    return rawGet(await resolveKey(key));
  }

  async function set(key, value) {
    await rawSet(await resolveKey(key), value);
  }

  async function remove(key) {
    await rawRemove(await resolveKey(key));
  }

  // Scelte di un profilo qualsiasi (per duplicare o eliminare un profilo che non è in uso)
  async function getProfileSettings(profileId) {
    const out = {};
    for (const key of PROFILE_KEYS) {
      const value = await rawGet(profileKey(profileId, key));
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  async function setProfileSettings(profileId, values) {
    for (const key of PROFILE_KEYS) {
      if (values[key] !== undefined) await rawSet(profileKey(profileId, key), values[key]);
    }
  }

  async function removeProfileSettings(profileId) {
    for (const key of PROFILE_KEYS) await rawRemove(profileKey(profileId, key));
  }

  // Il profilo da usare alla prossima apertura (la pagina poi si ricarica)
  async function setActiveProfileId(profileId) {
    if (!PROFILE_ID.test(profileId)) throw new Error('profile-id');
    await rawSet(ACTIVE_KEY, profileId);
    activePromise = Promise.resolve(profileId);
  }

  // Cancella tutto il contenuto di tutti gli archivi (impostazioni, PIN, schede, immagini, abitudini…).
  // Si svuotano gli archivi invece di eliminare il database: funziona anche con l'app aperta in un'altra scheda.
  async function clearAll() {
    activePromise = null;
    memory.clear();
    memoryStores.forEach((store) => store.clear());
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const names = [SETTINGS, ...RECORD_STORES].filter((name) => db.objectStoreNames.contains(name));
      const tx = db.transaction(names, 'readwrite');
      names.forEach((name) => tx.objectStore(name).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
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
    notify(storeName, record.id, [storeName === 'profiles' ? record.id : record.profileId]);
  }

  async function putRecords(storeName, records) {
    records.forEach((record) => memoryStores.get(storeName).set(record.id, record));
    try {
      await run(storeName, 'readwrite', (store) => { records.forEach((record) => store.put(record)); });
    } catch (error) {
      // Restano solo in memoria per questa sessione
    }
    if (records.length) notify(storeName, records[0].id, records.map((r) => (storeName === 'profiles' ? r.id : r.profileId)));
  }

  /*
   * Record il cui id inizia con uno dei prefissi indicati (es. «ud_<profilo>_»): legge solo quelli,
   * senza scorrere i dati degli altri profili.
   */
  async function getRecordsByPrefix(storeName, prefixes) {
    try {
      return await openDb().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const out = [];
        prefixes.forEach((prefix) => {
          const request = store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
          request.onsuccess = () => { out.push(...request.result); };
        });
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }));
    } catch (error) {
      return [...memoryStores.get(storeName).values()]
        .filter((r) => r && typeof r.id === 'string' && prefixes.some((prefix) => r.id.startsWith(prefix)));
    }
  }

  async function deleteRecords(storeName, ids) {
    ids.forEach((id) => memoryStores.get(storeName).delete(id));
    if (!ids.length) return;
    try {
      await run(storeName, 'readwrite', (store) => { ids.forEach((id) => store.delete(id)); });
    } catch (error) {
      // Nulla da fare
    }
    notify(storeName, ids[0]);
  }

  async function deleteRecord(storeName, id) {
    memoryStores.get(storeName).delete(id);
    try {
      await run(storeName, 'readwrite', (store) => { store.delete(id); });
    } catch (error) {
      // Nulla da fare
    }
    notify(storeName, id);
  }

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.storage = {
    name: DB_NAME, get, set, remove, clearAll, requestPersistence, persistenceStatus, keepData, getRecord, getAllRecords, putRecord, putRecords, deleteRecord,
    getRecordsByPrefix, deleteRecords, onChange,
    PROFILE_KEYS, activeProfileId, setActiveProfileId, newProfileId,
    getProfileSettings, setProfileSettings, removeProfileSettings,
  };
})();
