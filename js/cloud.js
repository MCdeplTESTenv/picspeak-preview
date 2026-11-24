/*
 * Backup online su Dropbox (Tappa 5).
 *
 * Collegamento: OAuth 2 con PKCE direttamente dal browser, senza server e senza segreti nel codice (serve solo la
 * chiave pubblica dell'app). L'app Dropbox è di tipo «App folder»: è Dropbox stesso a impedire a PicSpeak di vedere
 * o toccare qualsiasi file fuori dalla cartella «Applicazioni/PicSpeak». Il codice che Dropbox mostra dopo «Consenti»
 * si incolla nel tool (nessun ritorno automatico alla pagina): così funziona anche con l'app aggiunta alla schermata
 * Home di iPad e iPhone, che ha un archivio separato da Safari.
 * Il permesso duraturo (refresh token) resta solo su questo dispositivo, mai nel backup; l'accesso breve solo in memoria.
 *
 * Cartella di ogni profilo: /<id del profilo>/
 *   attuale-completo.picspeak   tutto il profilo (schede, foto, abitudini, modelli, impostazioni)
 *   attuale-abitudini.picspeak  solo abitudini e contesti, aggiornato più spesso
 *   giorno-AAAA-MM-GG.picspeak  copia del giorno (la prima sincronizzazione del giorno), si tengono le ultime 10
 *   prima-AAAA-MM-GG-HHMMSS.picspeak  copia automatica prima di un ripristino o di «Cancella tutto», ultime 5
 *   foto-AAAA-MM-GG-HHMMSS[-nome].picspeak  fotografie salvate a mano dall'adulto, mai cancellate dal tool
 *   profilo.json                nome del profilo, data dell'ultima copia e dispositivo (per l'elenco del ripristino)
 * Ogni percorso si controlla prima di scrivere o cancellare (solo questi nomi); il tool cancella solo le sue copie
 * automatiche più vecchie.
 *
 * Sincronizzazione a gruppi: ogni modifica segna il profilo da aggiornare; si invia dopo 2 minuti di calma (o dopo
 * 5 minuti di modifiche continue), al massimo una volta ogni 5 minuti, e subito all'uscita dalla modalità adulto o
 * quando l'app va in secondo piano. Senza rete si aspetta. Le modifiche alle sole abitudini mandano il file piccolo;
 * schede, foto e impostazioni mandano il file completo.
 */
(function () {
  'use strict';

  const { storage, data, backup, predict } = window.PicSpeak;

  // Chiave pubblica dell'app registrata su Dropbox (App key): non è un segreto
  const APP_KEY = '6zf88jq7xuhph7m';
  const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const API = 'https://api.dropboxapi.com/2/';
  const CONTENT = 'https://content.dropboxapi.com/2/';

  const SCOPES = 'account_info.read files.metadata.read files.content.read files.content.write';
  // { refreshToken, name, connectedAt, profileIds } (del dispositivo). profileIds: i soli profili per cui l'adulto ha
  // attivato il backup online; gli altri profili dello stesso dispositivo (es. altri bambini) non vanno mai su Dropbox
  const LINK_KEY = 'cloudDropbox';
  const STATE_KEY = 'cloudState'; // { [id profilo]: { dirtyFull, dirtyHabits, firstDirtyAt, lastFullAt, lastHabitsAt, lastDaily, lastError } }

  const CALM_MS = 2 * 60 * 1000;
  const MAX_WAIT_MS = 5 * 60 * 1000;
  const MIN_GAP_MS = 5 * 60 * 1000;
  const TICK_MS = 30 * 1000;
  const KEEP_DAILY = 10;
  const KEEP_BEFORE = 5;
  const TIMEOUT_MS = 60 * 1000;
  const MAX_DOWNLOAD = 100 * 1024 * 1024;

  const PROFILE_ID = /^p_[A-Za-z0-9]{1,40}$/;
  const FILE_NAMES = {
    full: /^attuale-completo\.picspeak$/,
    habits: /^attuale-abitudini\.picspeak$/,
    daily: /^giorno-\d{4}-\d{2}-\d{2}\.picspeak$/,
    before: /^prima-\d{4}-\d{2}-\d{2}-\d{6}\.picspeak$/,
    photo: /^foto-\d{4}-\d{2}-\d{2}-\d{6}(-[a-z0-9-]{1,30})?\.picspeak$/,
    profile: /^profilo\.json$/,
  };

  // Cosa cambia nell'archivio e quale file online va aggiornato
  const HABIT_STORES = new Set(['usage', 'contexts']);
  const FULL_STORES = new Set(['pages', 'images', 'profiles', 'audio']);
  const FULL_KEYS = new Set(['colorMode', 'pageBackground', 'appearance', 'preset', 'labelCase', 'language', 'voice',
    'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources', 'keepScreenOn', 'autoFullscreen',
    'openSections', 'sectionState', 'userTemplates']);

  class CloudError extends Error {}

  let link = null; // permesso salvato
  let access = null; // { token, until } solo in memoria
  let state = {};
  let status = 'off'; // off | idle | syncing | waiting (senza rete) | error | reconnect
  let lastChangeAt = 0;
  let lastSyncAt = 0;
  let running = null;
  let suppress = 0; // > 0 mentre il tool stesso prepara una copia (le sue scritture non contano come modifiche)
  let ready = false;
  const watchers = new Set();

  function isConfigured() {
    return Boolean(APP_KEY);
  }

  function setStatus(next) {
    status = next;
    watchers.forEach((fn) => { try { fn(status); } catch (error) { /* niente */ } });
  }

  function onStatus(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  }

  // ---------- Percorsi controllati ----------

  function checkPath(profileId, name) {
    if (!PROFILE_ID.test(profileId)) throw new CloudError('path');
    if (!Object.values(FILE_NAMES).some((re) => re.test(name))) throw new CloudError('path');
    return `/${profileId}/${name}`;
  }

  function pad(n, len = 2) {
    return String(n).padStart(len, '0');
  }

  function dayStamp(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function timeStamp(date) {
    return `${dayStamp(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  // Nome facoltativo di una fotografia: solo lettere e numeri senza accenti, trattini
  function slug(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  }

  // ---------- Rete ----------

  // Chiamata di rete con un tempo massimo; read(res) legge la risposta dentro lo stesso tempo massimo
  async function request(url, options, read, timeoutMs = TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      return read ? await read(res) : res;
    } catch (error) {
      throw error instanceof CloudError ? error : new CloudError('network');
    } finally {
      clearTimeout(timer);
    }
  }

  // Corpo della risposta letto a pezzi: ci si ferma appena supera il limite, senza riempire la memoria
  async function readLimited(res, max) {
    const declared = Number(res.headers.get('Content-Length'));
    if (declared > max) throw new CloudError('size');
    if (!res.body || typeof res.body.getReader !== 'function') {
      const blob = await res.blob();
      if (blob.size > max) throw new CloudError('size');
      return blob;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        reader.cancel().catch(() => {});
        throw new CloudError('size');
      }
      chunks.push(value);
    }
    return new Blob(chunks);
  }

  function base64Url(bytes) {
    let text = '';
    bytes.forEach((b) => { text += String.fromCharCode(b); });
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Coppia PKCE: verificatore casuale (resta qui) e la sua impronta (va a Dropbox)
  async function newPkce() {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return { verifier, challenge: base64Url(digest) };
  }

  function authorizeUrl(pkce) {
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: 'code',
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      // Solo i permessi che servono, anche se sulla console di Dropbox ne venissero aggiunti altri
      scope: SCOPES,
    });
    return `${AUTH_URL}?${params}`;
  }

  async function tokenRequest(params) {
    return request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: APP_KEY }).toString(),
    }, async (res) => {
      let body = null;
      try { body = JSON.parse(await (await readLimited(res, 64 * 1024)).text()); } catch (error) { body = null; }
      if (res.status === 400 || res.status === 401) throw new CloudError('auth');
      if (!res.ok || !body || typeof body.access_token !== 'string') throw new CloudError('server');
      return body;
    });
  }

  function keepAccess(body) {
    const seconds = Number.isFinite(body.expires_in) ? body.expires_in : 3600;
    access = { token: body.access_token, until: Date.now() + Math.max(60, seconds - 120) * 1000 };
  }

  async function accessToken() {
    if (access && access.until > Date.now()) return access.token;
    if (!link || !link.refreshToken) throw new CloudError('auth');
    keepAccess(await tokenRequest({ grant_type: 'refresh_token', refresh_token: link.refreshToken }));
    return access.token;
  }

  /*
   * Chiamata alle API, con un nuovo accesso breve se quello vecchio è scaduto. read(res) legge la risposta riuscita;
   * il tempo massimo cresce con la dimensione del file inviato (reti lente).
   */
  async function call(url, makeOptions, read, timeoutMs, retried = false) {
    const token = await accessToken();
    const options = makeOptions();
    options.headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
    const outcome = await request(url, options, async (res) => {
      if (res.status === 401) return { retry: true };
      if (res.status === 409) throw new CloudError('not-found');
      if (res.status === 429 || res.status >= 500) throw new CloudError('busy');
      if (!res.ok) throw new CloudError('server');
      return { value: await read(res) };
    }, timeoutMs);
    if (outcome.retry && !retried) {
      access = null;
      return call(url, makeOptions, read, timeoutMs, true);
    }
    if (outcome.retry) throw new CloudError('auth');
    return outcome.value;
  }

  async function rpc(endpoint, body) {
    return call(API + endpoint, () => ({
      method: 'POST',
      headers: body === null ? {} : { 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
    }), async (res) => {
      try { return JSON.parse(await (await readLimited(res, 4 * 1024 * 1024)).text()); } catch (error) { return null; }
    });
  }

  async function upload(path, blob) {
    // Un minuto più un minuto ogni 2 MB: una copia con molte foto ha il tempo di partire anche su una rete lenta
    const timeoutMs = TIMEOUT_MS + Math.ceil(blob.size / (2 * 1024 * 1024)) * TIMEOUT_MS;
    await call(`${CONTENT}files/upload`, () => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }),
      },
      body: blob,
    }), async () => null, timeoutMs);
  }

  async function download(path, max = MAX_DOWNLOAD) {
    return call(`${CONTENT}files/download`, () => ({
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path }) },
    }), (res) => readLimited(res, max), TIMEOUT_MS * 10);
  }

  async function listFolder(path) {
    const entries = [];
    let page = await rpc('files/list_folder', { path, recursive: false, limit: 500 });
    for (let guard = 0; page && guard < 20; guard += 1) {
      if (Array.isArray(page.entries)) entries.push(...page.entries);
      if (!page.has_more || typeof page.cursor !== 'string') break;
      page = await rpc('files/list_folder/continue', { cursor: page.cursor });
    }
    return entries.filter((e) => e && typeof e.name === 'string' && typeof e['.tag'] === 'string');
  }

  async function remove(profileId, name) {
    await rpc('files/delete_v2', { path: checkPath(profileId, name) });
  }

  // ---------- Stato salvato ----------

  async function loadState() {
    const saved = await storage.get(STATE_KEY);
    state = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }

  async function saveState() {
    await storage.set(STATE_KEY, state);
  }

  function profileState(profileId) {
    if (!state[profileId] || typeof state[profileId] !== 'object') state[profileId] = {};
    return state[profileId];
  }

  function currentProfileId() {
    return data.profile && PROFILE_ID.test(data.profile.id) ? data.profile.id : null;
  }

  // Il backup online è attivo per il profilo in uso?
  function enabledHere() {
    const id = currentProfileId();
    return Boolean(id && link && Array.isArray(link.profileIds) && link.profileIds.includes(id));
  }

  // Attiva il backup online anche per il profilo in uso (scelta dell'adulto, nelle impostazioni con PIN)
  async function enableHere() {
    const id = currentProfileId();
    if (!id || !link) throw new CloudError('auth');
    if (!Array.isArray(link.profileIds)) link.profileIds = [];
    if (!link.profileIds.includes(id)) link.profileIds.push(id);
    await storage.set(LINK_KEY, link);
    tick(true);
  }

  // «Solo Wi-Fi» scelto per internet e il browser dice che la rete non è Wi-Fi: gli invii automatici aspettano
  function cellularOnly() {
    const network = window.PicSpeak.network;
    if (!network || typeof network.onlineSearchMode !== 'function' || network.onlineSearchMode() !== 'wifi') return false;
    const type = navigator.connection && navigator.connection.type;
    return Boolean(type) && type !== 'wifi' && type !== 'ethernet';
  }

  // ---------- Modifiche ----------

  function classify(storeName, key) {
    if (storeName !== 'settings') {
      if (HABIT_STORES.has(storeName)) return 'habits';
      if (FULL_STORES.has(storeName)) return 'full';
      return null;
    }
    const plain = String(key).replace(/^p:[^:]+:/, '');
    return FULL_KEYS.has(plain) ? 'full' : null;
  }

  function markDirty(kind) {
    const id = currentProfileId();
    if (!id || !enabledHere()) return;
    const st = profileState(id);
    const now = Date.now();
    lastChangeAt = now;
    const flag = kind === 'full' ? 'dirtyFull' : 'dirtyHabits';
    if (st[flag]) return;
    st[flag] = true;
    if (!st.firstDirtyAt) st.firstDirtyAt = now;
    // Si salva solo quando il segno cambia: le modifiche restano da inviare anche dopo una ricarica della pagina
    suppress += 1;
    saveState().finally(() => { suppress -= 1; });
  }

  function onStorageChange(storeName, key) {
    if (suppress > 0 || !ready) return;
    const kind = classify(storeName, key);
    if (kind) markDirty(kind);
  }

  function hasNetwork() {
    return navigator.onLine !== false;
  }

  function due(force) {
    const id = currentProfileId();
    if (!id || !enabledHere() || running) return false;
    const st = profileState(id);
    const needFirst = !st.lastFullAt;
    if (!st.dirtyFull && !st.dirtyHabits && !needFirst) return false;
    if (!hasNetwork() || cellularOnly()) { setStatus('waiting'); return false; }
    if (status === 'reconnect') return false;
    if (force || needFirst) return true;
    const now = Date.now();
    if (now - lastSyncAt < MIN_GAP_MS) return false;
    return now - lastChangeAt >= CALM_MS || now - (st.firstDirtyAt || now) >= MAX_WAIT_MS;
  }

  // ---------- Copie ----------

  async function buildFile(only) {
    suppress += 1;
    try {
      return await backup.create({ name: (data.profile && data.profile.name) || '', password: '', only, quiet: true });
    } finally {
      suppress -= 1;
    }
  }

  async function uploadProfileInfo(profileId, at) {
    const info = {
      format: 'picspeak', kind: 'cloud-profile', id: profileId,
      name: (data.profile && data.profile.name) || '', updatedAt: at.toISOString(), device: backup.deviceLabel(),
    };
    await upload(checkPath(profileId, 'profilo.json'), new Blob([JSON.stringify(info)], { type: 'application/json' }));
  }

  // Tiene le ultime N copie automatiche di un tipo; non tocca nessun altro file
  async function rotate(profileId, kind, keep) {
    const names = (await listFolder(`/${profileId}`))
      .filter((e) => e['.tag'] === 'file' && FILE_NAMES[kind].test(e.name))
      .map((e) => e.name).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await remove(profileId, name);
  }

  async function syncNow() {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere()) return;
    const st = profileState(profileId);
    const full = Boolean(st.dirtyFull || !st.lastFullAt);
    const habits = Boolean(st.dirtyHabits);
    // Si tolgono i segni prima di preparare la copia: una modifica fatta nel frattempo li rimette
    st.dirtyFull = false;
    st.dirtyHabits = false;
    st.firstDirtyAt = 0;
    setStatus('syncing');
    try {
      const now = new Date();
      const today = dayStamp(now);
      const needDaily = st.lastDaily !== today;
      if (full || needDaily) {
        const file = await buildFile(null);
        await upload(checkPath(profileId, 'attuale-completo.picspeak'), file.blob);
        if (needDaily) {
          await upload(checkPath(profileId, `giorno-${today}.picspeak`), file.blob);
          st.lastDaily = today;
          await rotate(profileId, 'daily', KEEP_DAILY);
        }
        st.lastFullAt = now.toISOString();
        st.lastHabitsAt = now.toISOString();
        await uploadProfileInfo(profileId, now);
      } else if (habits) {
        const file = await buildFile(['habits']);
        await upload(checkPath(profileId, 'attuale-abitudini.picspeak'), file.blob);
        st.lastHabitsAt = now.toISOString();
      }
      st.lastError = null;
      setStatus('idle');
    } catch (error) {
      // Si riprova più tardi: i segni tornano com'erano
      if (full) st.dirtyFull = true;
      if (habits) st.dirtyHabits = true;
      if (!st.firstDirtyAt) st.firstDirtyAt = Date.now();
      const code = error instanceof CloudError ? error.message : 'server';
      st.lastError = code;
      setStatus(code === 'auth' ? 'reconnect' : (code === 'network' ? 'waiting' : 'error'));
    } finally {
      lastSyncAt = Date.now();
      suppress += 1;
      try { await saveState(); } finally { suppress -= 1; }
    }
  }

  function runSync() {
    if (!running) running = syncNow().finally(() => { running = null; });
    return running;
  }

  async function tick(force) {
    if (!ready) return;
    if (due(force)) await runSync();
  }

  // Ultima copia inviata (per la pagina delle impostazioni)
  function lastCopy() {
    const id = currentProfileId();
    if (!id || !state[id]) return null;
    const st = state[id];
    const times = [st.lastFullAt, st.lastHabitsAt].filter((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)));
    if (!times.length) return null;
    return new Date(Math.max(...times.map((v) => Date.parse(v))));
  }

  function pending() {
    const id = currentProfileId();
    const st = id && state[id];
    return Boolean(st && (st.dirtyFull || st.dirtyHabits));
  }

  // Copia completa con un nome proprio: fotografia dell'adulto ('photo') o copia prima di un'operazione grande ('before')
  async function saveSnapshot(kind, label) {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere()) throw new CloudError('auth');
    if (running) await running.catch(() => {});
    const now = new Date();
    const extra = kind === 'photo' && slug(label) ? `-${slug(label)}` : '';
    const name = `${kind === 'photo' ? 'foto' : 'prima'}-${timeStamp(now)}${extra}.picspeak`;
    const file = await buildFile(null);
    await upload(checkPath(profileId, name), file.blob);
    if (kind === 'before') await rotate(profileId, 'before', KEEP_BEFORE);
    return name;
  }

  // ---------- Collegare e scollegare ----------

  async function connect(code, pkce) {
    const clean = String(code || '').trim();
    if (!clean || clean.length > 400 || !/^[A-Za-z0-9_\-.~]+$/.test(clean) || !pkce) throw new CloudError('code');
    let body;
    try {
      body = await tokenRequest({ grant_type: 'authorization_code', code: clean, code_verifier: pkce.verifier });
    } catch (error) {
      throw new CloudError(error.message === 'network' ? 'network' : 'code');
    }
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new CloudError('code');
    // Il backup online parte solo per il profilo in uso: gli altri si attivano uno per uno
    link = { refreshToken: body.refresh_token, name: '', connectedAt: new Date().toISOString(), profileIds: [currentProfileId()].filter(Boolean) };
    keepAccess(body);
    try {
      const account = await rpc('users/get_current_account', null);
      const display = account && account.name && account.name.display_name;
      if (typeof display === 'string') link.name = display.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 60);
    } catch (error) {
      // Il nome dell'account serve solo da promemoria
    }
    await storage.set(LINK_KEY, link);
    setStatus('idle');
    tick(true);
  }

  async function disconnect() {
    const had = link;
    if (had) {
      try {
        // Dropbox ritira il permesso: anche chi avesse una copia del dispositivo non potrebbe più usarlo
        await rpc('auth/token/revoke', null);
      } catch (error) {
        // Senza rete il permesso resta valido su Dropbox ma si cancella comunque da qui
      }
    }
    link = null;
    access = null;
    await storage.remove(LINK_KEY);
    setStatus('off');
  }

  // ---------- Ripristino da Dropbox ----------

  function cleanText(value, max) {
    return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  // Profili salvati su Dropbox: [{ id, name, updatedAt, device }]
  async function listProfiles() {
    const folders = (await listFolder('')).filter((e) => e['.tag'] === 'folder' && PROFILE_ID.test(e.name));
    const out = [];
    for (const folder of folders.slice(0, 50)) {
      let info = {};
      try {
        const blob = await download(checkPath(folder.name, 'profilo.json'), 4096);
        info = JSON.parse(await blob.text()) || {};
        if (!info || typeof info !== 'object') info = {};
      } catch (error) {
        info = {};
      }
      const at = typeof info.updatedAt === 'string' ? new Date(info.updatedAt) : null;
      out.push({
        id: folder.name,
        name: cleanText(info.name, 40),
        updatedAt: at && !Number.isNaN(at.getTime()) ? at : null,
        device: cleanText(info.device, 60),
      });
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function parseStamp(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/.exec(text);
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Copie di un profilo: [{ kind: latest|daily|before|photo, name, date, label }], dalla più recente
  async function listCopies(profileId) {
    if (!PROFILE_ID.test(profileId)) throw new CloudError('path');
    const files = (await listFolder(`/${profileId}`)).filter((e) => e['.tag'] === 'file');
    const copies = [];
    const fullEntry = files.find((e) => FILE_NAMES.full.test(e.name));
    if (fullEntry) {
      const habitsEntry = files.find((e) => FILE_NAMES.habits.test(e.name));
      const times = [fullEntry, habitsEntry].filter(Boolean).map((e) => Date.parse(e.server_modified)).filter(Number.isFinite);
      copies.push({ kind: 'latest', name: fullEntry.name, date: times.length ? new Date(Math.max(...times)) : null, label: '' });
    }
    const groups = [['photo', 'foto-'], ['daily', 'giorno-'], ['before', 'prima-']];
    groups.forEach(([kind, prefix]) => {
      files.filter((e) => FILE_NAMES[kind].test(e.name)).forEach((e) => {
        const rest = e.name.slice(prefix.length).replace(/\.picspeak$/, '');
        const label = kind === 'photo' ? rest.slice(18).replace(/-/g, ' ').trim() : '';
        copies.push({ kind, name: e.name, date: parseStamp(rest), label });
      });
    });
    const order = { latest: 0, photo: 1, daily: 2, before: 3 };
    return copies.sort((a, b) => (order[a.kind] - order[b.kind]) || ((b.date || 0) - (a.date || 0)));
  }

  /*
   * Scarica una copia e la apre come un file di backup. Per la copia più recente unisce il backup completo e il file
   * delle abitudini, se è più nuovo. Restituisce { opened, parts } (parts null se il file è protetto da password).
   */
  async function openCopy(profileId, copy) {
    const opened = await backup.open(await download(checkPath(profileId, copy.name)));
    if (opened.info.encryption) return { opened, parts: null };
    let parts = await backup.read(opened);
    let info = opened.info;
    if (copy.kind === 'latest') {
      try {
        const habitsOpened = await backup.open(await download(checkPath(profileId, 'attuale-abitudini.picspeak')));
        if (!habitsOpened.info.encryption) {
          const habitsParts = await backup.read(habitsOpened);
          ({ parts, info } = backup.combineLatest(parts, info, habitsParts, habitsOpened.info));
        }
      } catch (error) {
        // Nessun file delle abitudini (o illeggibile): vale il backup completo
      }
    }
    return { opened: { ...opened, info }, parts };
  }

  // ---------- Avvio ----------

  let started = false;

  async function start() {
    if (started) return;
    started = true;
    link = await storage.get(LINK_KEY);
    if (!link || typeof link.refreshToken !== 'string') link = null;
    await loadState();
    storage.onChange(onStorageChange);
    ready = true;
    setStatus(link ? 'idle' : 'off');
    setInterval(() => tick(false), TICK_MS);
    window.addEventListener('online', () => tick(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && pending()) tick(true);
    });
    document.addEventListener('picspeak:adult-exit', () => { if (pending()) tick(true); });
    setTimeout(() => tick(false), 5000);
  }

  const app = window.PicSpeak.app;
  const whenReady = app && app.ready ? app.ready : Promise.resolve();
  if (isConfigured()) whenReady.then(start).catch(() => {});

  window.PicSpeak.cloud = {
    CloudError,
    isConfigured,
    isConnected: () => Boolean(link),
    isEnabledHere: enabledHere,
    enableHere,
    accountName: () => (link && link.name) || '',
    status: () => status,
    onStatus,
    newPkce,
    authorizeUrl,
    connect,
    disconnect,
    syncNow: () => (enabledHere() ? runSync() : Promise.resolve()),
    lastCopy,
    pending,
    saveSnapshot,
    listProfiles,
    listCopies,
    openCopy,
    // Per i test
    _test: { classify, checkPath, slug, parseStamp, rotate, markDirty, due, start, setLink: (value) => { link = value; access = null; }, state: () => state, FILE_NAMES },
  };
})();
