/*
 * Archivio locale (IndexedDB), database "picspeak".
 * Versione 1: archivio "settings" (chiave-valore).
 * Versione 2: aggiunti gli archivi del modello dati (docs/FORMATO-DATI.md):
 *   profiles, pages, images, contexts, usage, audio (chiave = campo "id").
 * Se IndexedDB non è disponibile (es. alcune modalità private) o non risponde, si usa la memoria
 * della sessione: il tool funziona, ma i dati non restano salvati e la modalità adulto lo dice (saveProblem).
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

  /*
   * Archivio che non risponde. Un errore del browser nel leggere o scrivere (archivio occupato, collegamento
   * all'archivio perso dopo lo stop del computer, disco pieno o lento) non deve mai essere scambiato per «archivio
   * vuoto»: altrimenti il tool ripartirebbe con le schede di prova e le salverebbe sopra il lavoro fatto.
   * Per questo ogni operazione si riprova (riaprendo l'archivio, per circa 5 secondi); se non riesce ancora, non si
   * scrive più nulla sul dispositivo (i dati salvati restano com'erano), si lavora in memoria e la modalità adulto
   * mostra un avviso (saveProblem / onSaveProblem).
   *
   * Recupero automatico, senza domande a nessuno: ogni 15 secondi (e quando l'app torna in primo piano) si prova a
   * riaprire l'archivio. Se riapre:
   *  - le modifiche fatte nel frattempo si salvano tutte insieme (tutte o nessuna), ma solo se sono sicure: il guasto
   *    è arrivato dopo il caricamento completo delle schede, nel frattempo non si è letto nulla che non fosse già in
   *    memoria (nessuna decisione presa su dati mancanti) e nell'archivio nessun altro ha scritto (un'altra scheda o
   *    finestra aperta: lo dice il «timbro» scritto con ogni salvataggio). Così non si porta mai dentro una copia non
   *    allineata all'ultimo stato;
   *  - se non sono sicure, le modifiche in attesa non si salvano e l'avviso resta: chiudere e riaprire;
   *  - senza modifiche in attesa si torna alla normalità, oppure (se quello in memoria non è affidabile) si chiede alla
   *    pagina di ricaricarsi da sola appena il bambino non la sta usando (onReloadSuggested).
   * Su Safari a volte l'archivio si riapre solo ricaricando la pagina: se dopo un minuto non riapre e non c'è nulla
   * in attesa, si chiede la stessa ricarica automatica.
   */
  const RETRY_DELAYS_MS = [150, 500, 1500, 3000];
  const RECOVER_EVERY_MS = 15000;
  const RELOAD_AFTER_MS = 60000;
  const MAX_PENDING = 5000;
  // Timbro dell'ultimo salvataggio (chiave del dispositivo, mai nel backup): sessione + numero progressivo
  const STAMP_KEY = 'writeStamp';
  const SESSION_ID = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
  let writeCount = 0;
  let lastStamp; // timbro dell'ultimo salvataggio riuscito di questa sessione
  let loaded = false; // schede caricate dall'archivio prima di qualsiasi guasto (markLoaded)
  let profilesComplete = false; // l'elenco completo dei profili è in memoria
  let replayable = false; // le modifiche in attesa si possono salvare al ritorno dell'archivio
  let pending = []; // modifiche fatte durante il guasto, nell'ordine
  let brokenAt = 0;
  let recoverTimer = null;
  let recovering = false;
  const reloadListeners = new Set();
  const OPEN_TIMEOUT_MS = 10000;
  // Errori che dipendono da un singolo record (dato non salvabile, chiave sbagliata), non dall'archivio: non si
  // riprovano e non fermano gli altri salvataggi
  const RECORD_ERRORS = new Set(['DataCloneError', 'DataError', 'ConstraintError']);
  let broken = false;
  // Chiavi delle impostazioni lette o scritte davvero in questa sessione (vedi isKnown)
  const known = new Set();
  const problemListeners = new Set();

  function saveProblem() {
    return broken;
  }

  // Il listener riceve ogni cambio: guasto e ritorno alla normalità (si legge saveProblem)
  function onSaveProblem(listener) {
    problemListeners.add(listener);
    return () => problemListeners.delete(listener);
  }

  function onReloadSuggested(listener) {
    reloadListeners.add(listener);
    return () => reloadListeners.delete(listener);
  }

  function emit(listeners) {
    listeners.forEach((listener) => {
      try { listener(); } catch (error) { /* un ascoltatore non blocca gli altri */ }
    });
  }

  /*
   * Le schede del profilo sono state lette dall'archivio (data.load): da qui in poi la memoria è affidabile.
   * Punto di partenza: il timbro letto da data.load prima di leggere le schede (currentStamp), così una scrittura di
   * un'altra scheda durante il caricamento fa fallire il confronto (lato prudente). Se questa sessione ha già scritto,
   * vale il suo timbro; un archivio senza timbro (versione precedente o appena svuotato) ne riceve uno subito.
   */
  async function currentStamp() {
    try {
      return await run(SETTINGS, 'readonly', (store) => store.get(STAMP_KEY));
    } catch (error) {
      return undefined;
    }
  }

  async function markLoaded(startStamp) {
    if (broken) return;
    try {
      if (lastStamp === undefined) {
        if (startStamp === undefined) await run(SETTINGS, 'readwrite', () => {});
        else lastStamp = startStamp;
      }
      if (!broken) loaded = true;
    } catch (error) {
      // Archivio guasto proprio adesso: le modifiche non si potranno recuperare (loaded resta false)
    }
  }

  // Durante il guasto si è letto qualcosa che non c'era in memoria: le modifiche in attesa potrebbero basarsi su dati
  // mancanti, quindi non si salveranno
  function taint() {
    replayable = false;
    pending = [];
  }

  function queue(op) {
    if (!broken || !replayable) return;
    if (pending.length >= MAX_PENDING) { taint(); return; }
    pending.push(op);
  }

  function markBroken() {
    if (broken) return;
    broken = true;
    brokenAt = Date.now();
    replayable = loaded;
    pending = [];
    dbPromise = null;
    if (!recoverTimer) recoverTimer = setInterval(tryRecover, RECOVER_EVERY_MS);
    emit(problemListeners);
  }

  function openDb() {
    if (broken) return Promise.reject(new Error('archivio non disponibile'));
    if (dbPromise) return dbPromise;
    let timedOut = false;
    const opening = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        // Il browser non ha l'archivio: inutile riprovare
        const error = new Error('IndexedDB non disponibile');
        error.name = 'IdbMissing';
        reject(error);
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
      request.onsuccess = () => {
        const db = request.result;
        // Aperto quando ormai si era smesso di aspettare: il collegamento non serve più
        if (timedOut) { db.close(); return; }
        // Collegamento chiuso dal browser (o da un'altra scheda con una versione nuova): la prossima volta si riapre
        db.onclose = () => { if (dbPromise === opening) dbPromise = null; };
        db.onversionchange = () => { db.close(); if (dbPromise === opening) dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      // Il browser non risponde: si smette di aspettare (il tentativo successivo riapre)
      setTimeout(() => { timedOut = true; reject(new Error('archivio lento')); }, OPEN_TIMEOUT_MS);
    });
    dbPromise = opening;
    // Apertura non riuscita: il prossimo tentativo riapre invece di riusare l'errore
    opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
    return opening;
  }

  // Esegue un'operazione sull'archivio riprovando; se non riesce mai, l'archivio è segnato come guasto
  async function withRetry(operation) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (error && RECORD_ERRORS.has(error.name)) throw error;
        if (broken || attempt >= RETRY_DELAYS_MS.length || (error && error.name === 'IdbMissing')) {
          markBroken();
          throw error;
        }
        dbPromise = null; // il collegamento potrebbe essere perso: si riapre
        await new Promise((resolve) => { setTimeout(resolve, RETRY_DELAYS_MS[attempt]); });
      }
    }
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

  function nextStamp() {
    writeCount += 1;
    return `${SESSION_ID}:${writeCount}`;
  }

  // Ogni scrittura lascia nella stessa operazione il timbro di questa sessione (vedi il recupero automatico)
  function run(storeName, mode, action) {
    return withRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
      const writing = mode === 'readwrite';
      const tx = db.transaction(writing && storeName !== SETTINGS ? [storeName, SETTINGS] : storeName, mode);
      const result = action(tx.objectStore(storeName));
      const stamp = writing ? nextStamp() : null;
      if (writing) tx.objectStore(SETTINGS).put(stamp, STAMP_KEY);
      tx.oncomplete = () => {
        if (writing) lastStamp = stamp;
        resolve(result && 'result' in result ? result.result : undefined);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    })));
  }

  // ---------- Impostazioni (chiave-valore) ----------

  // Ogni lettura riuscita resta anche in memoria: se poi l'archivio si guasta, la sessione continua con i valori veri
  // (per esempio il PIN) invece che con valori vuoti
  async function rawGet(key) {
    try {
      const value = await run(SETTINGS, 'readonly', (store) => store.get(key));
      known.add(key);
      if (value === undefined) memory.delete(key);
      else memory.set(key, value);
      return value;
    } catch (error) {
      if (!known.has(key)) taint();
      return memory.get(key);
    }
  }

  async function rawSet(key, value) {
    memory.set(key, value);
    known.add(key);
    try {
      await run(SETTINGS, 'readwrite', (store) => { store.put(value, key); });
    } catch (error) {
      // Resta in memoria, in attesa del recupero automatico
      queue({ store: SETTINGS, put: value, key });
    }
    notify(SETTINGS, key);
  }

  async function rawRemove(key) {
    memory.delete(key);
    known.add(key);
    try {
      await run(SETTINGS, 'readwrite', (store) => { store.delete(key); });
    } catch (error) {
      queue({ store: SETTINGS, del: [key] });
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

  /*
   * Con l'archivio guasto: false se il valore di questa chiave non si è mai potuto leggere in questa sessione
   * (quello che restituisce get è vuoto per errore, non perché manca). Serve per il PIN: un PIN illeggibile non vale
   * come «nessun PIN». Con l'archivio a posto è sempre true.
   */
  async function isKnown(key) {
    if (!broken) return true;
    return known.has(await resolveKey(key));
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
    await withRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
      const names = [SETTINGS, ...RECORD_STORES].filter((name) => db.objectStoreNames.contains(name));
      const tx = db.transaction(names, 'readwrite');
      names.forEach((name) => tx.objectStore(name).clear());
      // Timbro nuovo: chi aveva modifiche in attesa sa che l'archivio è cambiato
      const stamp = nextStamp();
      tx.objectStore(SETTINGS).put(stamp, STAMP_KEY);
      tx.oncomplete = () => { lastStamp = stamp; resolve(); };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    })));
  }

  // ---------- Archivi del modello dati (record con campo "id") ----------

  async function getRecord(storeName, id) {
    try {
      const record = await run(storeName, 'readonly', (store) => store.get(id));
      if (record !== undefined && storeName === 'profiles') memoryStores.get(storeName).set(id, record);
      return record;
    } catch (error) {
      if (!memoryStores.get(storeName).has(id)) taint();
      return memoryStores.get(storeName).get(id);
    }
  }

  async function getAllRecords(storeName) {
    try {
      const records = (await run(storeName, 'readonly', (store) => store.getAll())) || [];
      // In memoria si tengono solo i profili (pochi e piccoli): schede e immagini le ha già il modello in uso
      if (storeName === 'profiles') {
        const cache = memoryStores.get(storeName);
        records.forEach((record) => { if (record && record.id !== undefined) cache.set(record.id, record); });
        profilesComplete = true;
      }
      return records;
    } catch (error) {
      if (storeName !== 'profiles' || !profilesComplete) taint();
      return [...memoryStores.get(storeName).values()];
    }
  }

  async function putRecord(storeName, record) {
    memoryStores.get(storeName).set(record.id, record);
    try {
      await run(storeName, 'readwrite', (store) => { store.put(record); });
    } catch (error) {
      if (!(error && RECORD_ERRORS.has(error.name))) queue({ store: storeName, records: [record] });
    }
    notify(storeName, record.id, [storeName === 'profiles' ? record.id : record.profileId]);
  }

  async function putRecords(storeName, records) {
    records.forEach((record) => memoryStores.get(storeName).set(record.id, record));
    try {
      await run(storeName, 'readwrite', (store) => { records.forEach((record) => store.put(record)); });
    } catch (error) {
      if (!(error && RECORD_ERRORS.has(error.name))) queue({ store: storeName, records: [...records] });
    }
    if (records.length) notify(storeName, records[0].id, records.map((r) => (storeName === 'profiles' ? r.id : r.profileId)));
  }

  /*
   * Record il cui id inizia con uno dei prefissi indicati (es. «ud_<profilo>_»): legge solo quelli,
   * senza scorrere i dati degli altri profili.
   */
  async function getRecordsByPrefix(storeName, prefixes) {
    try {
      const records = await withRetry(() => openDb().then((db) => new Promise((resolve, reject) => {
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
      })));
      return records;
    } catch (error) {
      taint();
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
      queue({ store: storeName, del: [...ids] });
    }
    notify(storeName, ids[0]);
  }

  async function deleteRecord(storeName, id) {
    memoryStores.get(storeName).delete(id);
    try {
      await run(storeName, 'readwrite', (store) => { store.delete(id); });
    } catch (error) {
      queue({ store: storeName, del: [id] });
    }
    notify(storeName, id);
  }

  // ---------- Recupero automatico (vedi in cima) ----------

  // Apre un collegamento nuovo, anche con l'archivio segnato come guasto
  function openFresh() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB non disponibile')); return; }
      let timedOut = false;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => { request.transaction.abort(); };
      request.onsuccess = () => {
        if (timedOut) { request.result.close(); return; }
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      setTimeout(() => { timedOut = true; reject(new Error('archivio lento')); }, OPEN_TIMEOUT_MS);
    });
  }

  // Salva tutte le modifiche in attesa in una sola operazione: o tutte o nessuna. Il timbro si controlla nella stessa
  // operazione, così nessun'altra scheda può scrivere in mezzo. Risolve con false se il timbro non è quello atteso.
  function replay(db, ops) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([SETTINGS, ...RECORD_STORES], 'readwrite');
      let aligned = false;
      const stamp = nextStamp();
      const check = tx.objectStore(SETTINGS).get(STAMP_KEY);
      check.onsuccess = () => {
        if (check.result !== lastStamp) { tx.abort(); return; }
        aligned = true;
        ops.forEach((op) => {
          const store = tx.objectStore(op.store);
          if (op.store === SETTINGS && 'put' in op) store.put(op.put, op.key);
          if (op.records) op.records.forEach((record) => store.put(record));
          if (op.del) op.del.forEach((key) => store.delete(key));
        });
        tx.objectStore(SETTINGS).put(stamp, STAMP_KEY);
      };
      tx.oncomplete = () => {
        // Chiusa senza aver controllato il timbro (lettura non riuscita): nulla è stato salvato, si resta in attesa
        if (!aligned) { reject(new Error('timbro non letto')); return; }
        lastStamp = stamp;
        resolve(true);
      };
      tx.onerror = (event) => { if (aligned) reject(tx.error); else event.preventDefault(); };
      tx.onabort = () => { if (aligned) reject(tx.error); else resolve(false); };
    });
  }

  function suggestReload() {
    emit(reloadListeners);
  }

  function backToNormal(db) {
    broken = false;
    pending = [];
    clearInterval(recoverTimer);
    recoverTimer = null;
    const ready = Promise.resolve(db);
    db.onclose = () => { if (dbPromise === ready) dbPromise = null; };
    db.onversionchange = () => { db.close(); if (dbPromise === ready) dbPromise = null; };
    dbPromise = ready;
    emit(problemListeners);
  }

  async function tryRecover() {
    if (!broken || recovering) return;
    recovering = true;
    let db = null;
    try {
      db = await openFresh();
      if (!replayable) {
        // L'archivio c'è di nuovo, ma quello in memoria non è affidabile: si ricarica la pagina (solo se non c'è
        // nulla in attesa, ed è sempre così quando non si può recuperare)
        db.close();
        suggestReload();
        return;
      }
      if (!(await replay(db, pending))) {
        // Qualcun altro ha scritto nell'archivio: le modifiche in attesa non sono più allineate e non si salvano
        db.close();
        taint();
        return;
      }
      backToNormal(db);
    } catch (error) {
      if (db && broken) db.close();
      // Ancora guasto: su Safari spesso serve ricaricare la pagina; lo si fa solo se non si perde nulla
      if (Date.now() - brokenAt > RELOAD_AFTER_MS && !pending.length) suggestReload();
    } finally {
      recovering = false;
    }
  }

  // Quando l'app torna in primo piano (per esempio dopo lo stop del computer) si prova subito
  document.addEventListener('visibilitychange', () => {
    if (broken && document.visibilityState === 'visible') tryRecover();
  });

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.storage = {
    name: DB_NAME, get, set, remove, clearAll, requestPersistence, persistenceStatus, keepData, getRecord, getAllRecords, putRecord, putRecords, deleteRecord,
    getRecordsByPrefix, deleteRecords, onChange, saveProblem, onSaveProblem, isKnown, markLoaded, currentStamp, onReloadSuggested, tryRecover,
    PROFILE_KEYS, activeProfileId, setActiveProfileId, newProfileId,
    getProfileSettings, setProfileSettings, removeProfileSettings,
  };
})();
