/*
 * Backup automatico in una cartella del computer (File System Access API: solo Chrome ed Edge su PC e Mac; su telefoni
 * e tablet, anche Android, non si offre). L'adulto sceglie una volta la cartella (per esempio una chiavetta, un disco o una cartella sincronizzata);
 * il permesso del browser (handle) resta su questo dispositivo, per profilo, e mai nel backup.
 * Dove non si può (telefoni e tablet, Safari, Firefox) la funzione non c'è: si usa il backup online.
 *
 * File scritti nella cartella (lo stesso file .picspeak del backup locale, con la password facoltativa scelta all'inizio;
 * la password diventa una chiave non leggibile salvata sul dispositivo, così ogni copia non rifà il calcolo lento):
 *   PicSpeak-<nome>-automatico-<xxxx>.picspeak              sempre l'ultima versione (xxxx: pezzo dell'id del profilo)
 *   PicSpeak-<nome>-automatico-<xxxx>-AAAA-MM-GG.picspeak   copia del giorno (la prima del giorno), ultime 7
 * Il tool non tocca nessun altro file della cartella.
 *
 * Quando si scrive: dopo 1 minuto senza modifiche (o dopo 5 minuti di modifiche continue), al massimo ogni 2 minuti
 * (ogni 60 se sono cambiate solo le abitudini, cioè i tocchi del bambino: il file si rifà intero e non deve pesare), e subito all'uscita dalla modalità adulto o quando l'app va in secondo piano. Le modifiche si riconoscono come per
 * il backup online (cloud.changeKind). Funziona insieme a Dropbox: i due backup non dipendono l'uno dall'altro.
 * Riaprendo il browser può servire di nuovo il permesso: si chiede all'ingresso nella modalità adulto (mai davanti al
 * bambino) o con il pulsante nelle impostazioni. Scegliendo «Consenti a ogni visita» Chrome ed Edge non lo chiedono più.
 */
(function () {
  'use strict';

  const { storage, data, backup } = window.PicSpeak;

  // { [id profilo]: { handle, folder, base, lastAt, lastDaily } } (del dispositivo)
  const KEY = 'folderBackup';
  const CALM_MS = 60 * 1000;
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const MIN_GAP_MS = 2 * 60 * 1000;
  // Solo abitudini (i tocchi del bambino): il file completo si rifà al massimo ogni ora, per non pesare sull'uso
  const HABITS_GAP_MS = 60 * 60 * 1000;
  const TICK_MS = 20 * 1000;
  const KEEP_DAILY = 7;
  const PROFILE_ID = /^p_[A-Za-z0-9]{1,40}$/;

  let config = {};
  let dirty = false;
  let dirtyFull = false; // tra le modifiche da salvare ci sono schede, foto o impostazioni
  let firstDirtyAt = 0;
  let lastChangeAt = 0;
  let lastWriteAt = 0;
  let running = null;
  let status = 'off'; // off | ok | permission (serve il permesso) | error
  let asked = false; // permesso già chiesto all'ingresso nella modalità adulto, in questa apertura
  const watchers = new Set();

  // Solo sul computer (Chrome, Edge): su telefoni e tablet (Android, iPad, iPhone) non si offre
  function isMobile() {
    const ua = navigator.userAgent || '';
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    return /Android|iPhone|iPad|iPod|Mobi/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  function isSupported() {
    return typeof window.showDirectoryPicker === 'function' && window.isSecureContext !== false && !isMobile();
  }

  function profileId() {
    return data.profile && PROFILE_ID.test(data.profile.id) ? data.profile.id : null;
  }

  function entry() {
    const id = profileId();
    const e = id && config[id];
    return e && e.handle ? e : null;
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    watchers.forEach((fn) => { try { fn(status); } catch (e) { /* nulla */ } });
  }

  async function save() {
    await storage.set(KEY, config);
  }

  // Parte fissa del nome dei file, decisa alla scelta della cartella (cambiare nome al profilo non crea file nuovi)
  // Con un pezzo dell'id: due profili con lo stesso nome nella stessa cartella non si sovrascrivono
  function baseName(name, id) {
    const tag = String(id).slice(-4);
    return backup.fileName(name, new Date(), 'profilo').replace(/-\d{4}-\d{2}-\d{2}-\d{4}\.picspeak$/, `-automatico-${tag}`);
  }

  function dayStamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  async function permission(handle, ask) {
    const opts = { mode: 'readwrite' };
    if (typeof handle.queryPermission !== 'function') return 'granted';
    const now = await handle.queryPermission(opts);
    if (now === 'granted' || !ask || typeof handle.requestPermission !== 'function') return now;
    return handle.requestPermission(opts);
  }

  async function writeFile(dir, name, blob) {
    const file = await dir.getFileHandle(name, { create: true });
    // Il file nuovo prende il posto del vecchio solo a scrittura finita (close): se si interrompe, resta il vecchio
    const out = await file.createWritable();
    try {
      await out.write(blob);
      await out.close();
    } catch (error) {
      try { await out.abort(); } catch (e) { /* nulla */ }
      throw error;
    }
  }

  // Tiene le ultime copie del giorno di questo profilo; non tocca nessun altro file
  async function rotate(dir, base) {
    const daily = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}\\.picspeak$`);
    const names = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && daily.test(name)) names.push(name);
    }
    names.sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_DAILY))) await dir.removeEntry(name);
  }

  // Scrive subito la copia del profilo in uso. ask: si può chiedere il permesso (solo dopo un tocco dell'adulto)
  async function writeNow(ask = false) {
    if (running) return running;
    // Archivio del browser guasto: in memoria potrebbero esserci solo le schede di prova, mai sopra la copia buona
    if (storage.saveProblem && storage.saveProblem()) return false;
    const e = entry();
    if (!e) return false;
    running = (async () => {
      const wasDirty = dirty;
      const wasFull = dirtyFull;
      dirty = false;
      dirtyFull = false;
      try {
        if ((await permission(e.handle, ask)) !== 'granted') {
          dirty = dirty || wasDirty;
          dirtyFull = dirtyFull || wasFull;
          setStatus('permission');
          return false;
        }
        const file = await backup.create({ name: (data.profile && data.profile.name) || '', password: e.seal || '', quiet: true, device: backup.deviceLabel() });
        const now = new Date();
        await writeFile(e.handle, `${e.base}.picspeak`, file.blob);
        const today = dayStamp(now);
        if (e.lastDaily !== today) {
          await writeFile(e.handle, `${e.base}-${today}.picspeak`, file.blob);
          e.lastDaily = today;
          await rotate(e.handle, e.base);
        }
        e.lastAt = now.toISOString();
        lastWriteAt = Date.now();
        firstDirtyAt = dirty ? firstDirtyAt : 0;
        await save();
        setStatus('ok');
        return true;
      } catch (error) {
        dirty = true;
        dirtyFull = dirtyFull || wasFull;
        if (!firstDirtyAt) firstDirtyAt = Date.now();
        lastWriteAt = Date.now(); // si riprova dopo la pausa minima, non a ogni controllo
        // Cartella spostata o cancellata, disco tolto, permesso ritirato: lo si dice all'adulto
        setStatus(error && error.name === 'NotAllowedError' ? 'permission' : 'error');
        return false;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  function due(force) {
    if (!dirty || running || !entry() || status === 'permission') return false;
    if (force) return true;
    const now = Date.now();
    if (now - lastWriteAt < (dirtyFull ? MIN_GAP_MS : HABITS_GAP_MS)) return false;
    // Solo abitudini: si aspetta sempre una pausa del bambino, così la copia non cade mentre sta toccando le tessere
    return now - lastChangeAt >= CALM_MS || (dirtyFull && now - firstDirtyAt >= MAX_WAIT_MS);
  }

  // force: subito (uscita dall'adulto, app in secondo piano); se una copia è in corso, si aspetta che finisca
  function tick(force) {
    if (force && running) return running.then(() => tick(true));
    return due(force) ? writeNow(false) : Promise.resolve(false);
  }

  function onStorageChange(storeName, key, owners) {
    if (!entry()) return;
    const cloud = window.PicSpeak.cloud;
    const kind = cloud && cloud.changeKind ? cloud.changeKind(storeName, key, owners, profileId()) : null;
    if (!kind) return;
    if (kind === 'full') dirtyFull = true;
    const now = Date.now();
    lastChangeAt = now;
    if (!dirty) firstDirtyAt = now;
    dirty = true;
  }

  // Sceglie la cartella (dentro il tocco dell'adulto) e scrive subito la prima copia. false se l'adulto annulla
  // password facoltativa: si trasforma una volta in chiave (backup.makeSeal), che resta sul dispositivo e mai in chiaro
  async function choose(password = '') {
    const id = profileId();
    if (!id || !isSupported()) return false;
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'picspeak-backup', mode: 'readwrite' });
    } catch (error) {
      if (error && error.name === 'AbortError') return false;
      throw error;
    }
    const old = config[id];
    const sameFolder = old && old.handle && typeof old.handle.isSameEntry === 'function' && await old.handle.isSameEntry(handle).catch(() => false);
    const seal = password ? await backup.makeSeal(password) : null;
    config[id] = { handle, seal, folder: String(handle.name || '').slice(0, 80), base: baseName(data.profile && data.profile.name, id), lastAt: null, lastDaily: sameFolder ? old.lastDaily : null };
    await save();
    dirty = true;
    setStatus('ok');
    return writeNow(true);
  }

  // Ridà il permesso dopo la riapertura del browser (dentro il tocco dell'adulto), poi scrive se serve
  async function allow() {
    const e = entry();
    if (!e) return false;
    if ((await permission(e.handle, true).catch(() => 'denied')) !== 'granted') { setStatus('permission'); return false; }
    setStatus('ok');
    dirty = true;
    return writeNow(false);
  }

  // Il profilo smette di salvarsi nella cartella (i file già scritti restano lì)
  async function stop() {
    if (running) await running;
    const id = profileId();
    if (!id || !config[id]) return;
    delete config[id];
    dirty = false;
    await save();
    setStatus('off');
  }

  function info() {
    const e = entry();
    if (!e) return null;
    return { folder: e.folder, file: `${e.base}.picspeak`, locked: Boolean(e.seal), lastAt: e.lastAt ? new Date(e.lastAt) : null, status, pending: dirty };
  }

  async function start() {
    const saved = await storage.get(KEY);
    config = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    // Profili eliminati: si dimentica la loro cartella
    const ids = new Set((await storage.getAllRecords('profiles')).map((p) => p && p.id));
    let pruned = false;
    Object.keys(config).forEach((id) => {
      if (!PROFILE_ID.test(id) || !ids.has(id) || !config[id] || !config[id].handle) { delete config[id]; pruned = true; }
    });
    if (pruned) await save().catch(() => {});
    storage.onChange(onStorageChange);
    const e = entry();
    // Modifiche dell'ultima apertura forse non ancora salvate (pagina chiusa o ricaricata subito): una copia all'avvio
    if (e) { dirty = true; dirtyFull = true; firstDirtyAt = Date.now(); lastChangeAt = Date.now(); }
    if (e) setStatus((await permission(e.handle, false).catch(() => 'prompt')) === 'granted' ? 'ok' : 'permission');
    setInterval(() => { tick(false); }, TICK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') tick(true);
    });
    document.addEventListener('picspeak:adult-exit', () => { tick(true); });
    // Entrando nella modalità adulto (dopo un tocco) si chiede il permesso, una volta per apertura
    document.addEventListener('picspeak:adult-enter', () => {
      if (status !== 'permission' || asked || !entry()) return;
      asked = true;
      allow().catch(() => {});
    });
  }

  const app = window.PicSpeak.app;
  const whenReady = app && app.ready ? app.ready : Promise.resolve();
  const started = isSupported() ? whenReady.then(start).catch(() => {}) : Promise.resolve();

  window.PicSpeak.folderBackup = {
    started,
    isSupported,
    isActive: () => Boolean(entry()) && status === 'ok',
    info,
    choose,
    allow,
    stop,
    writeNow,
    tick,
    onStatus: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
  };
})();
