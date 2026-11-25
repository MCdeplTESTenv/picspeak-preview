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
 *   fotografie.json             nomi delle fotografie esattamente come li ha scritti l'adulto (nome del file → nome)
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

  // account_info.read lo include sempre Dropbox (non si può togliere); il tool però non lo usa mai
  const SCOPES = 'account_info.read files.metadata.read files.content.read files.content.write';
  // { refreshToken, connectedAt, profileIds } (del dispositivo). profileIds: i soli profili per cui l'adulto ha
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
    names: /^fotografie\.json$/,
    // Abitudini di un solo dispositivo (sincronizzazione): ognuno scrive solo le sue
    device: /^abitudini-d[0-9a-f]{12}\.picspeak$/,
    // Dispositivi esclusi dall'adulto (persi, rubati, non più usati): gli altri ignorano i loro file
    excluded: /^esclusi\.json$/,
  };
  const DEVICE_CODE = /^d[0-9a-f]{12}$/;
  const LAYERS_PREFIX = 'syncLayers:'; // + id del profilo: abitudini degli altri dispositivi, per l'uso senza rete
  const MAX_DEVICES = 10;
  const MAX_HABITS_DOWNLOAD = 20 * 1024 * 1024; // file delle abitudini di un altro dispositivo
  const PULL_MS = 3 * 60 * 1000; // ogni quanto si guarda se altri dispositivi hanno inviato qualcosa
  const APPLY_AT_START_MS = 20 * 1000; // schede arrivate da un altro dispositivo: si applicano solo appena aperta l'app

  // Cosa cambia nell'archivio e quale file online va aggiornato
  // Conteggi dei tocchi → file delle abitudini; contesti e pesi di partenza (scelte dell'adulto) → file completo
  const HABIT_STORES = new Set(['usage']);
  const FULL_STORES = new Set(['pages', 'images', 'profiles', 'audio', 'contexts']);
  // Scelte che restano di ogni dispositivo anche quando un profilo è sincronizzato
  const DEVICE_ONLY_KEYS = ['keepScreenOn', 'autoFullscreen', 'openSections', 'sectionState'];
  const FULL_KEYS = new Set(['colorMode', 'pageBackground', 'appearance', 'preset', 'labelCase', 'language', 'voice',
    'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources', 'keepScreenOn', 'autoFullscreen',
    'openSections', 'sectionState', 'userTemplates']);

  class CloudError extends Error {}

  /*
   * Collegamenti salvati sul dispositivo (chiave cloudDropbox, formato 2):
   *   { format: 2, accounts: { a…: { refreshToken, connectedAt, name } },
   *     profiles: { id profilo: { account, folder?, device?, deviceName? } }, excludedProfiles: [] }
   * Ogni profilo usa il suo account Dropbox (anche lo stesso di un altro profilo). name è il nome dato dall'adulto
   * all'account: PicSpeak non chiede a Dropbox né nome né email. Il formato 1 (un solo permesso per il dispositivo)
   * si converte da solo (normalizeLink).
   */
  let link = null;
  const accessByAccount = new Map(); // account → { token, until }, solo in memoria
  let accountOverride = null; // account da usare per le chiamate fuori dal profilo (ripristino, scelta del profilo)
  let state = {};
  let status = 'off'; // off | idle | syncing | waiting (senza rete) | error | reconnect
  let lastChangeAt = 0;
  let lastSyncAt = 0;
  let running = null;
  let suppress = 0; // > 0 mentre si applicano le schede arrivate da un altro dispositivo (non sono modifiche da rimandare)
  let ready = false;
  // Profilo appena collegato che aspetta la risposta dell'adulto («continuare con un profilo già su Dropbox?»):
  // finché aspetta non si invia nulla, così su Dropbox non nasce una cartella che poi non serve. Solo in memoria:
  // se l'app si chiude prima della risposta, alla riapertura il profilo si salva come gli altri.
  let holding = null;
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

  /*
   * Cartelle dei profili su Dropbox: si chiamano come il profilo («Luca B»; «Luca B (2)» se il nome è già usato).
   * Il riferimento vero è l'id del profilo, scritto in profilo.json dentro la cartella: i dispositivi ritrovano la
   * cartella da lì, anche se è stata rinominata. Le cartelle create prima si chiamano «p_…» (id nel nome) e prendono
   * il nome del profilo alla copia completa successiva.
   */
  const FOLDER_NAME = /^[^\\/:*?"<>|\p{Cc}\p{Cf}]{1,48}$/u;
  const MAX_FOLDERS = 200;
  const folderNames = new Map(); // id del profilo → nome della cartella su Dropbox (com'è ora)
  // Cartella su Dropbox (il suo codice interno, che non cambia se la cartella si rinomina) → id letto in profilo.json
  const folderIds = new Map();

  function validFolder(name) {
    return typeof name === 'string' && FOLDER_NAME.test(name) && name.trim() === name && !/[.]$/.test(name);
  }

  // Nome del profilo ripulito per Dropbox: caratteri non accettati tolti, al massimo 40 caratteri interi
  function baseName(profileName) {
    const clean = Array.from(String(profileName || '').replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim())
      .slice(0, 40).join('').replace(/[. ]+$/, '');
    // Un nome che sembra un id («p_…») o vuoto non si usa: si mette un nome generico
    return clean && !PROFILE_ID.test(clean) ? clean : 'Profilo';
  }

  function dirOf(profileId) {
    if (!PROFILE_ID.test(profileId)) throw new CloudError('path');
    const name = folderNames.get(profileId) || profileId;
    if (!validFolder(name)) throw new CloudError('path');
    return `/${name}`;
  }

  function checkPath(profileId, name) {
    if (!Object.values(FILE_NAMES).some((re) => re.test(name))) throw new CloudError('path');
    return `${dirOf(profileId)}/${name}`;
  }

  // Id del profilo di una cartella: dal nome per le cartelle vecchie, altrimenti da profilo.json (dato non affidabile).
  // Si ricorda per il codice della cartella su Dropbox, non per il nome: un nome può passare a un altro profilo.
  async function folderId(entry) {
    if (PROFILE_ID.test(entry.name)) return entry.name;
    const key = typeof entry.id === 'string' && entry.id ? entry.id : null;
    if (key && folderIds.has(key)) return folderIds.get(key);
    let id = null;
    try {
      const info = JSON.parse(await (await download(`/${entry.name}/profilo.json`, 4096)).text());
      if (info && typeof info.id === 'string' && PROFILE_ID.test(info.id)) id = info.id;
    } catch (error) {
      // Rete, accesso, tempo: si ferma tutto (meglio che creare una cartella doppia). File assente o non valido: niente id
      if (error instanceof CloudError && error.message !== 'not-found') throw error;
      if (!(error instanceof CloudError) && !(error instanceof SyntaxError)) throw error;
      id = null;
    }
    if (key) folderIds.set(key, id);
    return id;
  }

  // Ordine con cui si sceglie tra due cartelle dello stesso profilo (caso raro): prima quella con il nome
  function preferFolder(x, y) {
    return (PROFILE_ID.test(x) - PROFILE_ID.test(y)) || (x < y ? -1 : 1);
  }

  // Cartelle dei profili sulla radice: { list: [{ name, id }], complete } (complete false se sono troppe)
  async function scanFolders() {
    const entries = (await listFolder('')).filter((e) => e['.tag'] === 'folder' && validFolder(e.name))
      .sort((x, y) => (x.name < y.name ? -1 : 1));
    const list = [];
    for (const entry of entries.slice(0, MAX_FOLDERS)) {
      const id = await folderId(entry);
      if (id) list.push({ name: entry.name, id });
    }
    return { list, complete: entries.length <= MAX_FOLDERS };
  }

  /*
   * Cerca su Dropbox la cartella del profilo (dall'id). fresh: rilegge l'elenco anche se è già nota (un altro
   * dispositivo potrebbe averla rinominata). Con due cartelle dello stesso id (caso raro) vale quella con il nome.
   */
  async function findFolder(profileId, fresh = false) {
    if (!PROFILE_ID.test(profileId)) throw new CloudError('path');
    if (!fresh && folderNames.has(profileId)) return folderNames.get(profileId);
    const { list, complete } = await scanFolders();
    const found = list.filter((f) => f.id === profileId).map((f) => f.name).sort(preferFolder);
    if (found.length) folderNames.set(profileId, found[0]);
    else if (!complete) throw new CloudError('path'); // troppe cartelle: non se ne crea una nuova alla cieca
    else folderNames.delete(profileId);
    return found[0] || null;
  }

  // Primo nome libero: «Luca», poi «Luca (2)», «Luca (3)»… (Dropbox non distingue maiuscole e minuscole)
  async function freeName(base, except) {
    const taken = new Set((await listFolder('')).map((e) => e.name.toLowerCase()));
    taken.delete(String(except || '').toLowerCase());
    for (let n = 1; n < 100; n += 1) {
      const name = n === 1 ? base : `${base} (${n})`;
      if (!taken.has(name.toLowerCase())) return name;
    }
    throw new CloudError('path');
  }

  // La cartella va bene per questo nome di profilo? («Luca» e «Luca (2)» vanno bene per «Luca»)
  function fitsName(folder, base) {
    if (folder.toLowerCase() === base.toLowerCase()) return true;
    const m = /^(.*) \((\d{1,2})\)$/.exec(folder);
    return Boolean(m && m[1].toLowerCase() === base.toLowerCase());
  }

  // Dà alla cartella il nome del profilo: alla prima copia la crea già così, dopo la rinomina se il nome è cambiato
  async function nameFolder(profileId, profileName) {
    const base = baseName(profileName);
    const current = await findFolder(profileId, true);
    if (current && fitsName(current, base)) return false;
    const wanted = await freeName(base, current);
    if (!current) { folderNames.set(profileId, wanted); return true; }
    try {
      await rpc('files/move_v2', { from_path: dirOf(profileId), to_path: `/${wanted}`, autorename: false });
      folderNames.set(profileId, wanted);
    } catch (error) {
      // Rinominata nel frattempo altrove (o nome appena preso): si resta sul nome che c'è
      await findFolder(profileId, true);
    }
    return false;
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
    // Con un account già collegato si chiede sempre di rientrare: il browser potrebbe essere ancora aperto sul
    // Dropbox di un'altra famiglia (tablet condiviso)
    if (link && Object.keys(link.accounts).length) params.set('force_reauthentication', 'true');
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

  function keepAccess(body, key) {
    const seconds = Number.isFinite(body.expires_in) ? body.expires_in : 3600;
    accessByAccount.set(key, { token: body.access_token, until: Date.now() + Math.max(60, seconds - 120) * 1000 });
  }

  // Account delle chiamate: quello scelto per un'operazione fuori dal profilo, altrimenti quello del profilo in uso
  function activeAccount() {
    if (accountOverride && link && link.accounts[accountOverride]) return accountOverride;
    const own = profileLink(currentProfileId());
    return own ? own.account : null;
  }

  // Account per un profilo che non usa ancora Dropbox: quello scelto, oppure l'unico collegato sul dispositivo
  function accountForNewUse() {
    const key = activeAccount();
    if (key) return key;
    const keys = link ? Object.keys(link.accounts) : [];
    return keys.length === 1 ? keys[0] : null;
  }

  async function accessToken() {
    const key = activeAccount();
    const account = key && link ? link.accounts[key] : null;
    if (!account || !account.refreshToken) throw new CloudError('auth');
    const cached = accessByAccount.get(key);
    if (cached && cached.until > Date.now()) return cached.token;
    keepAccess(await tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken }), key);
    return accessByAccount.get(key).token;
  }

  /*
   * Esegue fn (per esempio il passaggio a un altro profilo) senza copie automatiche in corso o in partenza: una copia
   * del profilo di prima non deve leggere le schede del profilo nuovo.
   */
  let paused = 0;
  async function pauseDuring(fn) {
    paused += 1;
    try {
      if (running) await running.catch(() => {});
      if (pulling) await pulling.catch(() => {});
      return await fn();
    } finally {
      paused -= 1;
    }
  }

  // Esegue fn con un account scelto (es. per guardare i profili di un altro Dropbox già collegato)
  async function withAccount(key, fn) {
    if (!link || !link.accounts[key]) throw new CloudError('auth');
    // Le copie automatiche del profilo in uso aspettano: non devono mai partire con l'account sbagliato
    if (running) await running.catch(() => {});
    if (pulling) await pulling.catch(() => {});
    const before = accountOverride;
    accountOverride = key;
    try {
      return await fn();
    } finally {
      accountOverride = before;
      // Nomi delle cartelle visti con l'altro account: non valgono per questo
      folderNames.clear();
      folderIds.clear();
    }
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
      if (res.status === 409) {
        let text = '';
        try { text = await (await readLimited(res, 64 * 1024)).text(); } catch (error) { text = ''; }
        throw new CloudError(/conflict/.test(text) ? 'conflict' : 'not-found');
      }
      if (res.status === 429 || res.status >= 500) throw new CloudError('busy');
      if (!res.ok) throw new CloudError('server');
      return { value: await read(res) };
    }, timeoutMs);
    if (outcome.retry && !retried) {
      accessByAccount.delete(activeAccount());
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

  /*
   * Invia un file. mode: 'overwrite' (predefinito), 'add' (solo se non c'è ancora) oppure { '.tag': 'update', update: rev }
   * (solo se su Dropbox c'è ancora la versione rev: altrimenti errore 'conflict'). Restituisce la descrizione del file
   * su Dropbox (con rev).
   */
  async function upload(path, blob, mode = 'overwrite') {
    // Un minuto più un minuto ogni 2 MB: una copia con molte foto ha il tempo di partire anche su una rete lenta
    const timeoutMs = TIMEOUT_MS + Math.ceil(blob.size / (2 * 1024 * 1024)) * TIMEOUT_MS;
    return call(`${CONTENT}files/upload`, () => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg({ path, mode, mute: true }),
      },
      body: blob,
    }), async (res) => {
      try { return JSON.parse(await (await readLimited(res, 64 * 1024)).text()); } catch (error) { return null; }
    }, timeoutMs);
  }

  /*
   * Intestazione Dropbox-API-Arg: Dropbox vuole solo caratteri ASCII (gli altri come \uXXXX). Servono per i nomi
   * delle cartelle con lettere accentate, emoji o alfabeti diversi.
   */
  function apiArg(value) {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }

  async function download(path, max = MAX_DOWNLOAD) {
    return call(`${CONTENT}files/download`, () => ({
      method: 'POST',
      headers: { 'Dropbox-API-Arg': apiArg({ path }) },
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

  const ACCOUNT_KEY = /^a[0-9a-f]{8}$/;

  function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Collegamenti salvati → formato 2 controllato (dato del dispositivo, ma letto con prudenza)
  function normalizeLink(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = { format: 2, accounts: {}, profiles: {}, excludedProfiles: [] };
    const okDevice = (v) => (typeof v === 'string' && DEVICE_CODE.test(v) ? v : undefined);
    const okFolder = (v) => (typeof v === 'string' && PROFILE_ID.test(v) ? v : undefined);
    if (raw.format === 2) {
      Object.entries(raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {}).forEach(([key, a]) => {
        if (!ACCOUNT_KEY.test(key) || !a || typeof a.refreshToken !== 'string' || !a.refreshToken) return;
        out.accounts[key] = {
          refreshToken: a.refreshToken, connectedAt: String(a.connectedAt || ''), name: cleanText(a.name, 40),
          print: typeof a.print === 'string' && /^[0-9a-f]{64}$/.test(a.print) ? a.print : undefined,
        };
      });
      Object.entries(raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}).forEach(([id, p]) => {
        if (!PROFILE_ID.test(id) || !p || !out.accounts[p.account]) return;
        out.profiles[id] = { account: p.account, folder: okFolder(p.folder), device: okDevice(p.device), deviceName: cleanText(p.deviceName, 30) || undefined, auto: p.auto === true ? true : undefined };
      });
    } else if (typeof raw.refreshToken === 'string' && raw.refreshToken) {
      // Formato 1 (fino al 25/11/2026): un solo permesso per tutto il dispositivo
      const key = `a${randomHex(4)}`;
      out.accounts[key] = { refreshToken: raw.refreshToken, connectedAt: String(raw.connectedAt || ''), name: 'Dropbox' };
      const ids = new Set([...(Array.isArray(raw.profileIds) ? raw.profileIds : [])].filter((id) => PROFILE_ID.test(String(id))));
      ids.forEach((id) => {
        out.profiles[id] = {
          account: key,
          folder: okFolder(raw.folders && raw.folders[id]),
          device: okDevice(raw.devices && raw.devices[id]),
        };
      });
    } else {
      return null;
    }
    out.excludedProfiles = (Array.isArray(raw.excludedProfiles) ? raw.excludedProfiles : []).filter((id) => PROFILE_ID.test(String(id))).slice(-20);
    return Object.keys(out.accounts).length ? out : null;
  }

  async function saveLink() {
    if (link && Object.keys(link.accounts).length) await storage.set(LINK_KEY, link);
    else { link = null; await storage.remove(LINK_KEY); }
  }

  function profileLink(id) {
    const p = id && link ? link.profiles[id] : null;
    return p && link.accounts[p.account] ? p : null;
  }

  // Cartella su Dropbox del profilo: la sua, oppure quella del profilo seguito da un altro dispositivo
  // Un profilo di questo dispositivo è già collegato a quella cartella di Dropbox (come suo o seguendola)?
  function linkedHere(folder) {
    if (!link) return false;
    return Object.entries(link.profiles).some(([id, p]) => id === folder || p.folder === folder);
  }

  function folderOf(localId) {
    const p = profileLink(localId);
    return p && typeof p.folder === 'string' && PROFILE_ID.test(p.folder) ? p.folder : localId;
  }

  /*
   * Codice casuale di questo dispositivo per il profilo in uso (solo per dare un nome al file delle sue abitudini).
   * Uno per profilo: due profili dello stesso dispositivo che seguono la stessa cartella non si sovrascrivono.
   */
  function deviceId() {
    const p = profileLink(currentProfileId());
    if (!p) return null;
    if (typeof p.device !== 'string' || !DEVICE_CODE.test(p.device)) {
      p.device = `d${randomHex(6)}`;
      saveLink().catch(() => {});
    }
    return p.device;
  }

  // Nome di questo dispositivo scelto dall'adulto (es. «Tablet di scuola»), altrimenti il tipo («iPad, Safari»)
  function deviceName() {
    const p = profileLink(currentProfileId());
    return (p && p.deviceName) || backup.deviceLabel();
  }

  async function setDeviceName(name) {
    const p = profileLink(currentProfileId());
    if (!p) throw new CloudError('auth');
    p.deviceName = cleanText(name, 30) || undefined;
    await saveLink();
    // Il nome viaggia con il file delle parole usate e con profilo.json: si rimandano alla prossima copia
    markDirty('habits');
  }

  // Il profilo in uso segue la cartella di un altro dispositivo, o un altro dispositivo segue la sua?
  function isSynced() {
    const id = currentProfileId();
    return Boolean(id && enabledHere() && (folderOf(id) !== id || (predict && predict.remoteDevices().length)));
  }

  // Il backup online è attivo per il profilo in uso?
  function enabledHere() {
    return Boolean(profileLink(currentProfileId()));
  }

  function attachProfile(id, account, extra = {}) {
    const old = link.profiles[id];
    link.profiles[id] = { account, ...(old && old.account === account ? { device: old.device, deviceName: old.deviceName } : {}), ...extra };
    link.excludedProfiles = link.excludedProfiles.filter((x) => x !== id);
  }

  /*
   * Aggiornamento automatico (scelta dell'adulto, per profilo e per dispositivo). Spento, che è la partenza: si invia
   * e si riceve solo con «Aggiorna adesso», una fotografia o un'altra azione dell'adulto. Il primo invio dopo il
   * collegamento parte comunque, perché l'adulto ha appena chiesto il backup.
   */
  function isAuto(id = currentProfileId()) {
    const p = profileLink(id);
    return Boolean(p && p.auto);
  }

  async function setAuto(on) {
    const p = profileLink(currentProfileId());
    if (!p) throw new CloudError('auth');
    p.auto = on ? true : undefined;
    await saveLink();
    if (on) {
      await tick(true);
      pullAndApply(false);
    }
  }

  // Attiva il backup online per il profilo in uso con un account già collegato (scelta dell'adulto, con PIN)
  async function enableHere(account) {
    const id = currentProfileId();
    const key = account || (link && Object.keys(link.accounts).length === 1 ? Object.keys(link.accounts)[0] : null);
    if (!id || !link || !link.accounts[key]) throw new CloudError('auth');
    attachProfile(id, key);
    await saveLink();
    tick(true);
  }

  // Account collegati su questo dispositivo: [{ key, name, profiles (quanti profili lo usano), here }]
  function listAccounts() {
    if (!link) return [];
    const here = profileLink(currentProfileId());
    return Object.entries(link.accounts).map(([key, a]) => ({
      key,
      name: a.name || 'Dropbox',
      profiles: Object.values(link.profiles).filter((p) => p.account === key).length,
      here: Boolean(here && here.account === key),
    }));
  }

  // Nome libero per un account nuovo: «Dropbox», «Dropbox 2»…
  function freeAccountName(name) {
    const base = cleanText(name, 40) || 'Dropbox';
    const used = new Set(listAccounts().map((a) => a.name.toLowerCase()));
    if (!used.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n += 1) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
    return base;
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
      if (storeName === 'usage' && String(key).startsWith('ub_')) return 'full';
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
    // (lo stato stesso non conta come modifica: classify lo ignora)
    saveState().catch(() => {});
  }

  function onStorageChange(storeName, key, owners) {
    if (suppress > 0 || !ready) return;
    // Scritture che riguardano solo altri profili (per esempio un profilo nuovo creato qui) non sono modifiche di questo
    // Immagini: sono in comune tra i profili; una foto nuova del profilo in uso arriva sempre con la sua tessera (pagina)
    if (storeName === 'images') return;
    const id = currentProfileId();
    if (Array.isArray(owners) && owners.length && owners.every((o) => typeof o === 'string' && o !== id)) return;
    const prefixed = /^p:([^:]+):/.exec(String(key));
    if (storeName === 'settings' && prefixed && prefixed[1] !== id) return;
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
    const needFirst = (!st.lastFullAt && !st.conflictRev) || !st.legacyClean;
    if (!st.dirtyFull && !st.dirtyHabits && !needFirst) return false;
    if (!hasNetwork() || cellularOnly()) { setStatus('waiting'); return false; }
    if (status === 'reconnect') return false;
    if (st.conflictRev && !st.dirtyHabits) return false;
    if (force || needFirst) return true;
    const now = Date.now();
    if (now - lastSyncAt < MIN_GAP_MS) return false;
    return now - lastChangeAt >= CALM_MS || now - (st.firstDirtyAt || now) >= MAX_WAIT_MS;
  }

  // ---------- Copie ----------

  // Prepara la copia senza scrivere nulla (quiet). Le modifiche fatte intanto dall'adulto restano segnate da inviare
  async function buildFile(only) {
    return backup.create({ name: (data.profile && data.profile.name) || '', password: '', only, quiet: true, device: deviceName() });
  }

  async function uploadProfileInfo(profileId, at) {
    const info = {
      format: 'picspeak', kind: 'cloud-profile', id: profileId,
      name: (data.profile && data.profile.name) || '', updatedAt: at.toISOString(), device: deviceName(),
    };
    await upload(checkPath(profileId, 'profilo.json'), new Blob([JSON.stringify(info)], { type: 'application/json' }));
  }

  // Tiene le ultime N copie automatiche di un tipo; non tocca nessun altro file
  async function rotate(profileId, kind, keep) {
    const names = (await listFolder(dirOf(profileId)))
      .filter((e) => e['.tag'] === 'file' && FILE_NAMES[kind].test(e.name))
      .map((e) => e.name).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await remove(profileId, name);
  }

  // File completo del profilo: si invia solo se su Dropbox c'è ancora la versione vista l'ultima volta
  async function uploadFull(profileId, folder, st, blob) {
    const mode = st.fullRev ? { '.tag': 'update', update: st.fullRev } : 'add';
    const meta = await upload(checkPath(folder, 'attuale-completo.picspeak'), blob, mode);
    if (meta && typeof meta.rev === 'string') st.fullRev = meta.rev;
  }

  async function syncNow() {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere() || profileId === holding) return;
    const folder = folderOf(profileId);
    const st = profileState(profileId);
    // In attesa che l'adulto scelga tra le due versioni delle schede: si inviano solo le abitudini
    const blocked = Boolean(st.conflictRev);
    const full = Boolean(!blocked && (st.dirtyFull || !st.lastFullAt));
    // Anche al primo invio dopo l'aggiornamento (legacyClean): gli altri dispositivi leggono solo i file per dispositivo
    const habits = Boolean(st.dirtyHabits || !st.lastHabitsAt || !st.legacyClean);
    // Si tolgono i segni prima di preparare la copia: una modifica fatta nel frattempo li rimette
    if (full) st.dirtyFull = false;
    st.dirtyHabits = false;
    st.firstDirtyAt = 0;
    setStatus('syncing');
    let habitsSent = false;
    try {
      // Cartella con il nome del profilo (rinominata se il nome è cambiato, ritrovata se l'ha rinominata un altro)
      const now = new Date();
      const exists = await findFolder(folder, true);
      // Profilo che ne segue un altro: la cartella c'è già, non se ne crea mai una
      if (!exists && folder !== profileId) throw new CloudError('not-found');
      // Escluso da un altro dispositivo? Allora non si tocca più nulla (neanche il nome della cartella)
      if (exists && await excludedNow(profileId, folder, st)) return;
      let created = false;
      if (full || !exists) created = await nameFolder(folder, (data.profile && data.profile.name) || '');
      // Cartella nuova: profilo.json per primo, è il file da cui gli altri dispositivi la riconoscono
      if (created) await uploadProfileInfo(folder, now);
      const today = dayStamp(now);
      // Anche mentre si aspetta la scelta dell'adulto: la copia del giorno è di questo dispositivo, non sovrascrive nulla
      const needDaily = st.lastDaily !== today;
      // Prima le parole usate: non aspettano mai le schede (anche se l'invio delle schede trova un conflitto)
      if (habits) {
        // Solo i tocchi fatti su questo dispositivo, nel suo file: gli altri dispositivi li sommano una volta sola
        const file = await buildFile(['habits']);
        await upload(checkPath(folder, `abitudini-${deviceId()}.picspeak`), file.blob);
        st.lastHabitsAt = now.toISOString();
        habitsSent = true;
        if (!st.legacyClean) {
          // Vecchio file unico delle abitudini (prima della sincronizzazione), scritto da questo profilo: ora c'è il suo
          try { await remove(folder, 'attuale-abitudini.picspeak'); } catch (error) { /* non c'era */ }
          st.legacyClean = true;
        }
      }
      if (full || needDaily) {
        const file = await buildFile(null);
        if (full) await uploadFull(profileId, folder, st, file.blob);
        if (needDaily) {
          await upload(checkPath(folder, `giorno-${today}.picspeak`), file.blob);
          st.lastDaily = today;
          await rotate(folder, 'daily', KEEP_DAILY);
        }
        if (full) {
          st.lastFullAt = now.toISOString();
          // Dopo l'invio riuscito: data e dispositivo dell'ultima versione delle schede
          await uploadProfileInfo(folder, now);
        }
      }
      st.lastError = null;
      setStatus(st.conflictRev ? 'conflict' : 'idle');
    } catch (error) {
      // Si riprova più tardi: i segni tornano com'erano
      if (full) st.dirtyFull = true;
      if (habits && !habitsSent) st.dirtyHabits = true;
      if (!st.firstDirtyAt) st.firstDirtyAt = Date.now();
      const code = error instanceof CloudError ? error.message : 'server';
      if (code === 'conflict') {
        // Un altro dispositivo ha cambiato le schede nel frattempo: lo si scopre leggendo la cartella
        st.lastError = null;
        lastSyncAt = Date.now();
        await saveStateQuiet();
        try {
          await pullNow({ apply: false });
          if (status === 'syncing') setStatus('idle');
        } catch (pullError) {
          const pullCode = pullError instanceof CloudError ? pullError.message : 'server';
          setStatus(pullCode === 'auth' ? 'reconnect' : (pullCode === 'network' ? 'waiting' : 'error'));
        }
        return;
      }
      st.lastError = code;
      setStatus(code === 'auth' ? 'reconnect' : (code === 'network' ? 'waiting' : 'error'));
    } finally {
      lastSyncAt = Date.now();
      await saveStateQuiet();
    }
  }

  // Stato e livelli sono chiavi che classify ignora: salvarli non segna modifiche (e non ne nasconde altre)
  async function saveStateQuiet() {
    await saveState();
  }

  // ---------- Sincronizzazione: cosa arriva dagli altri dispositivi ----------

  async function loadLayers(profileId) {
    const saved = await storage.get(LAYERS_PREFIX + profileId);
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }

  // Abitudini degli altri dispositivi salvate qui (per l'uso senza rete), passate alla previsione
  async function restoreLayers() {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere() || !predict || typeof predict.setRemoteLayer !== 'function') return;
    const layers = await loadLayers(profileId);
    const mine = deviceId();
    Object.keys(layers).slice(0, MAX_DEVICES).forEach((dev) => {
      if (dev !== mine && layers[dev] && layers[dev].parsed) predict.setRemoteLayer(dev, layers[dev].parsed);
    });
  }

  // Scarica un file dello stesso profilo e lo apre come backup (dati non affidabili: stesse verifiche dei file)
  async function openRemote(folder, name, max = MAX_DOWNLOAD) {
    const opened = await backup.open(await download(checkPath(folder, name), max));
    if (opened.info.encryption) throw new CloudError('server');
    return { opened, parts: await backup.read(opened) };
  }

  /*
   * Schede, foto, impostazioni del profilo e definizioni dei contesti arrivate da un altro dispositivo: prendono il
   * posto di quelle di qui. Restano di questo dispositivo i conteggi dei tocchi e le scelte dello schermo.
   */
  async function applyRemoteFull(parts, info) {
    suppress += 1;
    try {
      const keep = {};
      for (const key of DEVICE_ONLY_KEYS) keep[key] = await storage.get(key);
      const choice = { boards: parts.boards ? 'replace' : null, appearance: parts.appearance ? 'replace' : null, settings: parts.settings ? 'replace' : null };
      await backup.restore(parts, choice, info, {});
      for (const key of DEVICE_ONLY_KEYS) {
        if (keep[key] === undefined) await storage.remove(key); else await storage.set(key, keep[key]);
      }
      if (parts.habits && predict && typeof predict.replaceDefinitions === 'function') await predict.replaceDefinitions(parts.habits);
      if (info && info.name && data.profile && data.profile.name !== info.name) await backup.setProfileName(info.name);
    } finally {
      suppress -= 1;
    }
  }

  const startedAt = Date.now();
  let reloadNeeded = false;

  /*
   * Guarda la cartella del profilo su Dropbox: abitudini nuove degli altri dispositivi (subito, cambiano solo i
   * suggerimenti) e schede cambiate altrove (solo con apply: all'apertura o all'uscita dalla modalità adulto).
   */
  // Elenco dei dispositivi esclusi (esclusi.json, dato non affidabile): si rilegge solo quando cambia
  async function readExcluded(folder, entries, st) {
    const entry = entries.find((e) => FILE_NAMES.excluded.test(e.name));
    if (!entry) { st.excluded = []; st.excludedRev = null; return []; }
    if (entry.rev && entry.rev === st.excludedRev && Array.isArray(st.excluded)) return st.excluded;
    // File troppo grande o illeggibile: vale l'ultima lista valida (gli esclusi non rientrano)
    const previous = Array.isArray(st.excluded) ? st.excluded : [];
    let list = previous;
    if (typeof entry.size !== 'number' || entry.size <= 64 * 1024) {
      try {
        const raw = JSON.parse(await (await download(checkPath(folder, 'esclusi.json'), 64 * 1024)).text());
        if (raw && Array.isArray(raw.devices)) {
          list = [...new Set([...previous, ...raw.devices.filter((d) => typeof d === 'string' && DEVICE_CODE.test(d))])].slice(-100);
        }
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof CloudError && error.message === 'size')) throw error;
      }
    }
    st.excluded = list;
    st.excludedRev = entry.rev || null;
    return list;
  }

  /*
   * Questo dispositivo è stato escluso: il profilo resta qui com'è, ma non si sincronizza più (né invia né riceve).
   * Si tolgono le parole degli altri dispositivi scaricate e il codice del dispositivo. L'adulto può ricollegarlo
   * (con il PIN), e il dispositivo riparte con un codice nuovo.
   */
  async function leaveSync(profileId) {
    await storage.remove(LAYERS_PREFIX + profileId);
    if (predict && typeof predict.clearRemoteLayers === 'function') predict.clearRemoteLayers();
    delete state[profileId];
    await saveState();
    if (link) {
      // L'account resta collegato sul dispositivo (si può riusare); il profilo non lo usa più
      delete link.profiles[profileId];
      link.excludedProfiles = [...new Set([...link.excludedProfiles, profileId])].slice(-20);
      await saveLink();
    }
    setStatus('idle');
  }

  // Controllo prima di ogni invio: se questo dispositivo è stato escluso, smette di sincronizzarsi (true)
  async function excludedNow(profileId, folder, st) {
    const files = (await listFolder(dirOf(folder))).filter((e) => e['.tag'] === 'file');
    if (!(await readExcluded(folder, files, st)).includes(deviceId())) return false;
    await leaveSync(profileId);
    return true;
  }

  function wasExcluded() {
    const id = currentProfileId();
    return Boolean(id && link && link.excludedProfiles.includes(id));
  }

  // Dispositivi che usano il profilo in uso: [{ id, label, at, here }] (questo dispositivo per primo)
  async function listDevices() {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere()) throw new CloudError('auth');
    const folder = folderOf(profileId);
    if (!(await findFolder(folder, true))) return [];
    const entries = (await listFolder(dirOf(folder))).filter((e) => e['.tag'] === 'file');
    const st = profileState(profileId);
    const excluded = await readExcluded(folder, entries, st);
    const layers = await loadLayers(profileId);
    const mine = deviceId();
    const out = entries.filter((e) => FILE_NAMES.device.test(e.name)).map((e) => {
      const id = e.name.slice('abitudini-'.length, -'.picspeak'.length);
      const at = Date.parse(e.server_modified || '');
      return {
        id,
        here: id === mine,
        label: id === mine ? deviceName() : ((layers[id] && layers[id].device) || ''),
        at: Number.isNaN(at) ? null : new Date(at),
      };
    }).filter((d) => !excluded.includes(d.id));
    if (!out.some((d) => d.here)) out.push({ id: mine, here: true, label: deviceName(), at: null });
    return out.sort((x, y) => (y.here - x.here) || ((y.at || 0) - (x.at || 0))).slice(0, MAX_DEVICES + 1);
  }

  // Esclude un altro dispositivo dal profilo: gli altri ignorano le sue parole, il suo file si cancella da Dropbox
  async function excludeDevice(id) {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere()) throw new CloudError('auth');
    if (!DEVICE_CODE.test(String(id)) || id === deviceId()) throw new CloudError('path');
    const folder = folderOf(profileId);
    if (!(await findFolder(folder, true))) throw new CloudError('not-found');
    const st = profileState(profileId);
    st.excludedRev = null; // si rilegge sempre prima di aggiungere
    let meta = null;
    let list = [];
    for (let attempt = 0; attempt < 3 && !meta; attempt += 1) {
      st.excludedRev = null; // si rilegge sempre prima di aggiungere
      const entries = (await listFolder(dirOf(folder))).filter((e) => e['.tag'] === 'file');
      const current = await readExcluded(folder, entries, st);
      // Questo dispositivo è già stato escluso da un altro: non può escludere nessuno
      if (current.includes(deviceId())) { await leaveSync(profileId); throw new CloudError('excluded'); }
      list = [...new Set([...current, id])].slice(-100);
      const entry = entries.find((e) => FILE_NAMES.excluded.test(e.name));
      // Solo se nessuno l'ha cambiata nel frattempo: due esclusioni quasi insieme non si cancellano a vicenda
      const mode = entry && entry.rev ? { '.tag': 'update', update: entry.rev } : 'add';
      try {
        meta = await upload(checkPath(folder, 'esclusi.json'),
          new Blob([JSON.stringify({ format: 'picspeak', kind: 'cloud-excluded', devices: list })], { type: 'application/json' }), mode);
      } catch (error) {
        if (!(error instanceof CloudError && error.message === 'conflict')) throw error;
      }
    }
    if (!meta) throw new CloudError('busy');
    st.excluded = list;
    st.excludedRev = meta.rev || null;
    try { await remove(folder, `abitudini-${id}.picspeak`); } catch (error) { /* già tolto */ }
    const layers = await loadLayers(profileId);
    if (layers[id]) { delete layers[id]; await storage.set(LAYERS_PREFIX + profileId, layers); }
    predict.setRemoteLayer(id, null);
    await saveStateQuiet();
  }

  async function pullNow({ apply }) {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere()) return;
    const folder = folderOf(profileId);
    const st = profileState(profileId);
    let entries;
    try {
      if (!(await findFolder(folder, true))) return;
      entries = (await listFolder(dirOf(folder))).filter((e) => e['.tag'] === 'file');
    } catch (error) {
      if (error instanceof CloudError && error.message === 'not-found') return;
      throw error;
    }
    const mine = deviceId();
    // 0. Questo dispositivo è stato escluso da un altro? Allora smette di sincronizzarsi
    const excluded = await readExcluded(folder, entries, st);
    if (excluded.includes(mine)) { await leaveSync(profileId); return; }
    // 1. Abitudini degli altri dispositivi: ogni file sostituisce il livello di quel dispositivo
    const layers = await loadLayers(profileId);
    let layersChanged = false;
    const present = new Set();
    const deviceEntries = entries.filter((x) => FILE_NAMES.device.test(x.name)
      && !excluded.includes(x.name.slice('abitudini-'.length, -'.picspeak'.length))).sort((x, y) => (x.name < y.name ? -1 : 1));
    deviceEntries.forEach((e) => present.add(e.name.slice('abitudini-'.length, -'.picspeak'.length)));
    for (const e of deviceEntries.slice(0, MAX_DEVICES + 1)) {
      const dev = e.name.slice('abitudini-'.length, -'.picspeak'.length);
      if (dev === mine) continue;
      present.add(dev);
      if (layers[dev] && layers[dev].rev === e.rev) continue;
      try {
        if (typeof e.size === 'number' && e.size > MAX_HABITS_DOWNLOAD) continue;
        const { opened, parts } = await openRemote(folder, e.name, MAX_HABITS_DOWNLOAD);
        if (!parts.habits) continue;
        const parsed = { pairs: parts.habits.pairs, days: parts.habits.days, months: parts.habits.months };
        // Tipo di dispositivo (es. «iPad, Safari»), per l'elenco dei dispositivi nelle impostazioni
        layers[dev] = { rev: e.rev, parsed, device: cleanText(opened.info.device, 60) };
        predict.setRemoteLayer(dev, parsed);
        layersChanged = true;
      } catch (error) {
        // File illeggibile: resta il livello di prima
      }
    }
    Object.keys(layers).forEach((dev) => {
      if (!present.has(dev)) { delete layers[dev]; predict.setRemoteLayer(dev, null); layersChanged = true; }
    });
    if (layersChanged) {
      await storage.set(LAYERS_PREFIX + profileId, layers);
    }
    // 2. Schede e impostazioni cambiate su un altro dispositivo
    const fullEntry = entries.find((e) => FILE_NAMES.full.test(e.name));
    if (fullEntry && typeof fullEntry.rev === 'string' && fullEntry.rev !== st.fullRev) {
      const remoteAt = Date.parse(fullEntry.server_modified || '');
      const ownCopy = !st.fullRev && st.lastFullAt && folder === profileId
        && !(remoteAt > Date.parse(st.lastFullAt) + 60 * 1000);
      if (ownCopy) {
        // Copia scritta da questo profilo prima della sincronizzazione: è già la sua
        st.fullRev = fullEntry.rev;
      } else if (st.dirtyFull || st.conflictRev) {
        // Cambiate qui e là: decide l'adulto (nessuna delle due si perde)
        st.conflictRev = fullEntry.rev;
        setStatus('conflict');
      } else if (apply) {
        const { opened, parts } = await openRemote(folder, fullEntry.name);
        await applyRemoteFull(parts, opened.info);
        st.fullRev = fullEntry.rev;
        st.lastFullAt = new Date().toISOString();
        st.pendingApply = false;
        reloadNeeded = true;
      } else {
        st.pendingApply = true;
      }
      await saveStateQuiet();
    }
  }

  /*
   * «Aggiorna adesso» (scelta dell'adulto, dalle impostazioni): prende subito anche le schede arrivate da altri
   * dispositivi. Risolve con true se sono cambiate (la pagina va ricaricata).
   */
  async function applyNow() {
    if (!enabledHere() || status === 'reconnect' || accountOverride) return false;
    if (running) await running.catch(() => {});
    if (pulling) await pulling.catch(() => {});
    pulling = pullNow({ apply: true });
    try {
      await pulling;
    } finally {
      pulling = null;
    }
    const changed = reloadNeeded;
    reloadNeeded = false;
    return changed;
  }

  // Ricontrolla e, se sono arrivate schede nuove, ricarica la pagina (mai mentre il bambino le sta usando)
  let pulling = null; // lettura degli arrivi in corso (withAccount la aspetta)

  async function pullAndApply(apply) {
    if (!enabledHere() || !hasNetwork() || cellularOnly() || status === 'reconnect' || accountOverride || pulling || paused) return;
    if (running) await running.catch(() => {});
    if (accountOverride) return;
    pulling = pullNow({ apply: apply && !isAdult() });
    try {
      await pulling;
    } catch (error) {
      return;
    } finally {
      pulling = null;
    }
    if (reloadNeeded && typeof window.PicSpeak.onCloudReload === 'function') window.PicSpeak.onCloudReload();
    else if (reloadNeeded) location.reload();
  }

  /*
   * Due versioni delle schede (qui e su un altro dispositivo). 'mine': si tengono quelle di qui; 'theirs': quelle
   * dell'altro dispositivo. In tutti e due i casi l'altra versione resta come copia «prima-…» su Dropbox.
   */
  async function resolveConflict(which) {
    const profileId = currentProfileId();
    if (!profileId || !enabledHere()) throw new CloudError('auth');
    const folder = folderOf(profileId);
    const st = profileState(profileId);
    if (!st.conflictRev) return;
    if (!(await findFolder(folder, true))) throw new CloudError('not-found');
    if (await excludedNow(profileId, folder, st)) throw new CloudError('excluded');
    const now = new Date();
    const beforeName = `prima-${timeStamp(now)}.picspeak`;
    if (which === 'mine') {
      // Si conserva la versione dell'altro dispositivo, poi si invia la propria
      await rpc('files/copy_v2', { from_path: checkPath(folder, 'attuale-completo.picspeak'), to_path: checkPath(folder, beforeName), autorename: true });
      const file = await buildFile(null);
      // Solo se su Dropbox c'è ancora la versione vista: se un terzo dispositivo ha inviato nel frattempo, si richiede
      let meta;
      try {
        meta = await upload(checkPath(folder, 'attuale-completo.picspeak'), file.blob, { '.tag': 'update', update: st.conflictRev });
      } catch (error) {
        if (error instanceof CloudError && error.message === 'conflict') {
          // Un'altra versione ancora, arrivata proprio ora: la domanda si ripete su quella
          const latest = (await listFolder(dirOf(folder))).find((e) => FILE_NAMES.full.test(e.name));
          if (latest && latest.rev) st.conflictRev = latest.rev;
          await saveStateQuiet();
        }
        throw error;
      }
      if (meta && typeof meta.rev === 'string') st.fullRev = meta.rev;
      st.dirtyFull = false;
      st.lastFullAt = now.toISOString();
    } else {
      // Si conserva la propria versione, poi si prendono le schede dell'altro dispositivo
      const file = await buildFile(null);
      await upload(checkPath(folder, beforeName), file.blob);
      const entries = await listFolder(dirOf(folder));
      const fullEntry = entries.find((e) => FILE_NAMES.full.test(e.name));
      const { opened, parts } = await openRemote(folder, 'attuale-completo.picspeak');
      await applyRemoteFull(parts, opened.info);
      st.fullRev = fullEntry && fullEntry.rev ? fullEntry.rev : st.conflictRev;
      st.dirtyFull = false;
      st.lastFullAt = now.toISOString();
      reloadNeeded = true;
    }
    st.conflictRev = null;
    await rotate(folder, 'before', KEEP_BEFORE);
    await saveStateQuiet();
    setStatus('idle');
    return which === 'theirs';
  }

  // Da dove viene l'altra versione (per la domanda all'adulto): quando e da che tipo di dispositivo
  async function conflictInfo() {
    const profileId = currentProfileId();
    const out = { here: deviceName(), there: null, thereAt: null };
    if (!profileId) return out;
    try {
      await findFolder(folderOf(profileId));
      const blob = await download(checkPath(folderOf(profileId), 'profilo.json'), 4 * 1024);
      const info = JSON.parse(await blob.text());
      if (info && typeof info === 'object') {
        out.there = cleanText(info.device, 60) || null;
        if (typeof info.updatedAt === 'string' && !Number.isNaN(Date.parse(info.updatedAt))) out.thereAt = new Date(info.updatedAt);
      }
    } catch (error) {
      // Senza queste informazioni la domanda resta valida
    }
    return out;
  }

  function hasConflict() {
    const id = currentProfileId();
    return Boolean(id && state[id] && state[id].conflictRev && enabledHere());
  }

  /*
   * Il profilo in uso (appena creato vuoto) segue la cartella di un altro profilo su Dropbox: schede, foto,
   * impostazioni e contesti arrivano da lì; i conteggi degli altri dispositivi restano a parte (livelli).
   * safety: false quando l'adulto ha appena collegato Dropbox per riprendere un profilo (dispositivo nuovo): non si
   * carica nulla di questo dispositivo, si scarica soltanto.
   */
  async function follow(folder, { safety = true } = {}) {
    const profileId = currentProfileId();
    const account = accountForNewUse();
    if (!profileId || !link || !account || !PROFILE_ID.test(folder)) throw new CloudError('path');
    // Le chiamate di follow usano questo account anche prima che il profilo sia collegato
    if (!accountOverride || accountOverride !== account) return withAccount(account, () => follow(folder, { safety }));
    if (!(await findFolder(folder, true))) throw new CloudError('not-found');
    const entries = await listFolder(dirOf(folder));
    const fullEntry = entries.find((e) => FILE_NAMES.full.test(e.name));
    if (!fullEntry) throw new CloudError('not-found');
    // Copia di sicurezza di com'era questo profilo, nella cartella scelta: se non riesce, non si cambia nulla
    if (safety) {
      const before = await buildFile(null);
      await upload(checkPath(folder, `prima-${timeStamp(new Date())}.picspeak`), before.blob, 'add');
    }
    // Prima si scarica e si legge la copia: se non riesce, il profilo resta com'era e non si collega a quella cartella
    const { opened, parts } = await openRemote(folder, fullEntry.name);
    // Stato «già allineato» salvato prima del collegamento: se l'app si chiude o le schede non si salvano a metà,
    // alla riapertura non parte nessun invio verso la cartella scelta (le schede si riscaricano al prossimo arrivo)
    const st = profileState(profileId);
    Object.assign(st, {
      dirtyFull: false, dirtyHabits: false, firstDirtyAt: 0, conflictRev: null, legacyClean: true,
      fullRev: null, lastFullAt: new Date().toISOString(), lastDaily: dayStamp(new Date()),
    });
    await saveStateQuiet();
    attachProfile(profileId, account, { folder: folder === profileId ? undefined : folder });
    deviceId();
    await saveLink();
    await applyRemoteFull(parts, opened.info);
    st.fullRev = fullEntry.rev;
    await saveStateQuiet();
    // Solo ora, con le schede scaricate e la copia segnata come già inviata, il profilo può sincronizzarsi
    if (holding === profileId) holding = null;
    reloadNeeded = false;
    await pullNow({ apply: false });
  }

  function runSync() {
    if (!running) running = syncNow().finally(() => { running = null; });
    return running;
  }

  async function tick(force) {
    if (!ready || accountOverride || paused) return;
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
    // In attesa della scelta «continuare con un profilo già su Dropbox?»: nessuna cartella prima della risposta
    if (profileId === holding) throw new CloudError('held');
    if (running) await running.catch(() => {});
    const folder = folderOf(profileId);
    if (!(await findFolder(folder, true))) {
      // Nessuna cartella ancora: la si crea con il nome del profilo (mai per un profilo che ne segue un altro)
      if (folder !== profileId) throw new CloudError('not-found');
      await nameFolder(folder, data.profile && data.profile.name);
      await uploadProfileInfo(folder, new Date());
    } else if (await excludedNow(profileId, folder, profileState(profileId))) throw new CloudError('excluded');
    const now = new Date();
    const extra = kind === 'photo' && slug(label) ? `-${slug(label)}` : '';
    const name = `${kind === 'photo' ? 'foto' : 'prima'}-${timeStamp(now)}${extra}.picspeak`;
    const file = await buildFile(null);
    await upload(checkPath(folder, name), file.blob);
    if (kind === 'before') await rotate(folder, 'before', KEEP_BEFORE);
    const typed = kind === 'photo' ? cleanText(label, 40) : '';
    if (typed) {
      // Il nome scritto dall'adulto, con maiuscole e accenti, si ritrova uguale nell'elenco del ripristino
      try {
        const names = await readPhotoNames(folder);
        names[name] = typed;
        await upload(checkPath(folder, 'fotografie.json'), new Blob([JSON.stringify(names)], { type: 'application/json' }));
      } catch (error) {
        // Resta il nome semplificato nel nome del file
      }
    }
    return name;
  }

  // Nomi delle fotografie salvati su Dropbox (dato non affidabile: solo nomi di file validi e testo ripulito)
  async function readPhotoNames(profileId) {
    let raw = null;
    try {
      raw = JSON.parse(await (await download(checkPath(profileId, 'fotografie.json'), 64 * 1024)).text());
    } catch (error) {
      if (error instanceof CloudError && error.message !== 'not-found') throw error;
      raw = null;
    }
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      Object.keys(raw).slice(0, 500).forEach((key) => {
        const text = cleanText(raw[key], 40);
        if (FILE_NAMES.photo.test(key) && text) out[key] = text;
      });
    }
    return out;
  }

  // ---------- Collegare e scollegare ----------

  /*
   * Collega un account Dropbox con il codice incollato dall'adulto e lo usa per il profilo in uso.
   * name: nome dato dall'adulto all'account (per riconoscerlo tra gli altri); account: chiave di un account già
   * collegato da ricollegare (permesso scaduto), altrimenti se ne aggiunge uno nuovo.
   */
  // Impronta dell'account Dropbox (SHA-256 del suo codice, che Dropbox manda con il permesso): serve solo a capire
  // se due collegamenti sono lo stesso Dropbox. Non è un dato leggibile e non lascia mai il dispositivo.
  async function accountPrint(body) {
    if (!body || typeof body.account_id !== 'string' || !body.account_id) return '';
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`picspeak:${body.account_id}`));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /*
   * hold: se il profilo in uso si collega ora per la prima volta, non si invia nulla finché non si chiama release()
   * (l'adulto sceglie prima se continuare con un profilo già su Dropbox). Risponde con held: true in quel caso.
   */
  async function connect(code, pkce, { name, account, hold } = {}) {
    const clean = String(code || '').trim();
    if (!clean || clean.length > 400 || !/^[A-Za-z0-9_\-.~]+$/.test(clean) || !pkce) throw new CloudError('code');
    let body;
    try {
      body = await tokenRequest({ grant_type: 'authorization_code', code: clean, code_verifier: pkce.verifier });
    } catch (error) {
      throw new CloudError(error.message === 'network' ? 'network' : 'code');
    }
    if (typeof body.refresh_token !== 'string' || !body.refresh_token) throw new CloudError('code');
    if (!link) link = { format: 2, accounts: {}, profiles: {}, excludedProfiles: [] };
    const now = new Date().toISOString();
    const print = await accountPrint(body);
    let key = account && link.accounts[account] ? account : null;
    let sameAs = null;
    if (key) {
      // Ricollegamento: deve essere lo stesso Dropbox, altrimenti tutti i profili dell'account cambierebbero Dropbox
      const old = link.accounts[key].print;
      if (old && print && old !== print) {
        // Il permesso appena dato dall'altro Dropbox non serve: lo si ritira subito
        try {
          await request(`${API}auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${body.access_token}` } }, () => null);
        } catch (error) { /* senza rete resta valido su Dropbox, ma non si salva qui */ }
        throw new CloudError('other-account');
      }
      link.accounts[key].refreshToken = body.refresh_token;
      link.accounts[key].connectedAt = now;
      if (print) link.accounts[key].print = print;
    } else {
      // Lo stesso Dropbox di un account già collegato: si usa quello (e lo si dice all'adulto)
      const same = print ? Object.entries(link.accounts).find(([, a]) => a.print === print) : null;
      if (same) {
        [key] = same;
        sameAs = same[1].name || 'Dropbox';
        link.accounts[key].refreshToken = body.refresh_token;
        link.accounts[key].connectedAt = now;
      } else {
        key = `a${randomHex(4)}`;
        link.accounts[key] = { refreshToken: body.refresh_token, connectedAt: now, name: freeAccountName(name), print: print || undefined };
      }
    }
    // Il backup online parte solo per il profilo in uso: gli altri si attivano uno per uno
    const id = currentProfileId();
    // Un altro profilo di qui usa già questo Dropbox (sameAs): è un profilo in più, non serve chiedere
    const held = Boolean(hold && id && !profileLink(id) && !sameAs);
    if (id && (!profileLink(id) || !account)) attachProfile(id, key);
    if (held) holding = id;
    keepAccess(body, key);
    // Di proposito non si chiede nulla dell'account Dropbox (nome, email): al tool serve solo la sua cartella
    await saveLink();
    deviceId();
    setStatus('idle');
    if (!held) tick(true);
    return { sameAs, held };
  }

  // Fine dell'attesa dopo connect({ hold }): il profilo si salva su Dropbox come gli altri
  function release() {
    if (!holding) return;
    holding = null;
    tick(true);
  }

  // Ritira su Dropbox il permesso di un account e lo toglie dal dispositivo
  async function revokeAccount(key) {
    if (!link || !link.accounts[key]) return;
    try {
      // Dropbox ritira il permesso: anche chi avesse una copia del dispositivo non potrebbe più usarlo
      await withAccount(key, () => rpc('auth/token/revoke', null));
    } catch (error) {
      // Senza rete il permesso resta valido su Dropbox ma si cancella comunque da qui
    }
    delete link.accounts[key];
    accessByAccount.delete(key);
    Object.keys(link.profiles).forEach((id) => { if (link.profiles[id].account === key) delete link.profiles[id]; });
  }

  // Account che nessun profilo usa più: si ritira il permesso
  async function dropUnusedAccounts() {
    if (!link) return;
    const used = new Set(Object.values(link.profiles).map((p) => p.account));
    for (const key of Object.keys(link.accounts)) if (!used.has(key)) await revokeAccount(key);
  }

  // «Scollega» nel profilo in uso: il profilo smette di usare Dropbox; l'account si ritira se non serve ad altri
  async function disconnect() {
    const id = currentProfileId();
    if (!link || !id) return;
    await storage.remove(LAYERS_PREFIX + id);
    if (predict && typeof predict.clearRemoteLayers === 'function') predict.clearRemoteLayers();
    delete link.profiles[id];
    delete state[id];
    await saveState();
    await dropUnusedAccounts();
    await saveLink();
    setStatus(link ? 'idle' : 'off');
  }

  // «Cancella tutto»: tutti gli account ritirati e tolti dal dispositivo
  async function disconnectAll() {
    if (link) {
      for (const id of Object.keys(link.profiles)) if (PROFILE_ID.test(id)) await storage.remove(LAYERS_PREFIX + id);
      for (const key of Object.keys(link.accounts)) await revokeAccount(key);
    }
    if (predict && typeof predict.clearRemoteLayers === 'function') predict.clearRemoteLayers();
    link = null;
    accessByAccount.clear();
    await storage.remove(LINK_KEY);
    setStatus('off');
  }

  // Profilo eliminato da questo dispositivo: si dimenticano il suo collegamento, il suo stato e i dati scaricati
  async function forgetProfile(profileId) {
    if (!PROFILE_ID.test(String(profileId))) return;
    await storage.remove(LAYERS_PREFIX + profileId);
    if (state[profileId]) { delete state[profileId]; await saveState(); }
    if (!link) return;
    delete link.profiles[profileId];
    link.excludedProfiles = link.excludedProfiles.filter((x) => x !== profileId);
    await dropUnusedAccounts();
    await saveLink();
  }

  // ---------- Ripristino da Dropbox ----------

  function cleanText(value, max) {
    return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  // Profili salvati su Dropbox: [{ id, name, updatedAt, device }]
  async function listProfiles() {
    const { list } = await scanFolders();
    const folders = list.slice().sort((x, y) => preferFolder(x.name, y.name));
    const out = [];
    for (const folder of folders) {
      const { id } = folder;
      if (out.some((p) => p.id === id)) continue;
      folderNames.set(id, folder.name);
      let info = {};
      try {
        const blob = await download(checkPath(id, 'profilo.json'), 4096);
        info = JSON.parse(await blob.text()) || {};
        if (!info || typeof info !== 'object') info = {};
      } catch (error) {
        info = {};
      }
      const at = typeof info.updatedAt === 'string' ? new Date(info.updatedAt) : null;
      out.push({
        id,
        folder: folder.name,
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
    if (!(await findFolder(profileId, true))) return [];
    const files = (await listFolder(dirOf(profileId))).filter((e) => e['.tag'] === 'file');
    const copies = [];
    const fullEntry = files.find((e) => FILE_NAMES.full.test(e.name));
    if (fullEntry) {
      const habitsEntries = files.filter((e) => FILE_NAMES.habits.test(e.name) || FILE_NAMES.device.test(e.name));
      const times = [fullEntry, ...habitsEntries].map((e) => Date.parse(e.server_modified)).filter(Number.isFinite);
      copies.push({ kind: 'latest', name: fullEntry.name, date: times.length ? new Date(Math.max(...times)) : null, label: '' });
    }
    let typedNames = {};
    if (files.some((e) => FILE_NAMES.names.test(e.name))) {
      try { typedNames = await readPhotoNames(profileId); } catch (error) { typedNames = {}; }
    }
    const groups = [['photo', 'foto-'], ['daily', 'giorno-'], ['before', 'prima-']];
    groups.forEach(([kind, prefix]) => {
      files.filter((e) => FILE_NAMES[kind].test(e.name)).forEach((e) => {
        const rest = e.name.slice(prefix.length).replace(/\.picspeak$/, '');
        const label = kind === 'photo' ? (typedNames[e.name] || rest.slice(18).replace(/-/g, ' ').trim()) : '';
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
  // File delle abitudini dei dispositivi per il ripristino, senza quelli esclusi
  async function deviceFilesForRestore(profileId) {
    const files = (await listFolder(dirOf(profileId))).filter((e) => e['.tag'] === 'file');
    const excluded = await readExcluded(profileId, files, {});
    return files.filter((e) => FILE_NAMES.device.test(e.name)
      && !excluded.includes(e.name.slice('abitudini-'.length, -'.picspeak'.length))).slice(0, MAX_DEVICES);
  }

  async function openCopy(profileId, copy) {
    await findFolder(profileId);
    const opened = await backup.open(await download(checkPath(profileId, copy.name)));
    if (opened.info.encryption) return { opened, parts: null };
    let parts = await backup.read(opened);
    let info = opened.info;
    const deviceFiles = copy.kind === 'latest'
      ? await deviceFilesForRestore(profileId)
      : [];
    if (deviceFiles.length && parts.habits) {
      /*
       * Profilo usato su più dispositivi: i contesti vengono dal file completo, i conteggi dai file dei dispositivi,
       * ognuno una volta sola (quelli del file completo sono già nel file del dispositivo che l'ha scritto)
       */
      parts.habits = { ...parts.habits, days: [], months: [] };
      parts.habitsExtra = [];
      parts.habitsFolder = profileId;
      for (const e of deviceFiles) {
        try {
          const { opened: devOpened, parts: devParts } = await openRemote(profileId, e.name);
          if (!devParts.habits) continue;
          parts.habitsExtra.push({ ...devParts.habits, contexts: [], base: [], deviceId: e.name.slice('abitudini-'.length, -'.picspeak'.length) });
          if (devOpened.info.createdAt && (!info.createdAt || devOpened.info.createdAt > info.createdAt)) info = { ...info, createdAt: devOpened.info.createdAt };
        } catch (error) {
          // File di un dispositivo illeggibile: si salta
        }
      }
      parts.summary.habits = { ...parts.summary.habits, days: new Set(parts.habitsExtra.flatMap((h) => h.days.map((d) => d[0]))).size };
    } else if (copy.kind === 'latest') {
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

  // Collegamenti di profili che non esistono più (eliminati da una versione vecchia): via, e via gli account inutili
  async function pruneLink() {
    if (!link) return;
    const existing = new Set((await storage.getAllRecords('profiles')).map((p) => p && p.id));
    let changed = false;
    Object.keys(link.profiles).forEach((id) => { if (!existing.has(id)) { delete link.profiles[id]; changed = true; } });
    if (changed) { await dropUnusedAccounts(); await saveLink(); }
  }

  async function loadLink() {
    const raw = await storage.get(LINK_KEY);
    link = normalizeLink(raw);
    accessByAccount.clear();
    // Formato vecchio: si salva subito convertito (la conversione dà un codice nuovo all'account)
    if (link && raw.format !== 2) await saveLink();
  }

  async function start() {
    if (started) return;
    started = true;
    await loadLink();
    await pruneLink().catch(() => {});
    await loadState();
    storage.onChange(onStorageChange);
    ready = true;
    setStatus(link ? 'idle' : 'off');
    // Invii e arrivi da soli solo con l'aggiornamento automatico (isAuto); in manuale nulla parte da solo:
    // «Aggiorna adesso» invia e applica subito gli arrivi (applyNow)
    setInterval(() => { if (isAuto()) tick(false); }, TICK_MS);
    window.addEventListener('online', () => { if (isAuto()) tick(true); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && isAuto() && pending()) tick(true);
    });
    document.addEventListener('picspeak:adult-exit', async () => {
      if (!isAuto()) return;
      // Prima si inviano le modifiche dell'adulto, poi si prendono quelle arrivate dagli altri dispositivi
      if (pending()) await tick(true);
      pullAndApply(true);
    });
    setTimeout(() => { if (isAuto()) tick(false); }, 5000);
    // Abitudini degli altri dispositivi già scaricate: valgono subito, anche senza rete
    await restoreLayers().catch(() => {});
    // Appena aperta l'app si possono applicare le schede arrivate da altri dispositivi (poi solo all'uscita dall'adulto)
    setTimeout(() => {
      if (isAuto()) pullAndApply(Date.now() - startedAt < APPLY_AT_START_MS && !isAdult());
    }, 2000);
    setInterval(() => {
      if (isAuto() && document.visibilityState === 'visible' && !running) pullAndApply(false);
    }, PULL_MS);
    document.addEventListener('visibilitychange', () => {
      // Il bambino riapre l'app dopo una pausa: è come un'apertura
      if (document.visibilityState === 'visible' && isAuto()) pullAndApply(!isAdult() && hasPendingApply());
    });
  }

  function isAdult() {
    const app = window.PicSpeak.app;
    return Boolean(app && app.mode === 'adult');
  }

  function hasPendingApply() {
    const id = currentProfileId();
    return Boolean(id && state[id] && state[id].pendingApply);
  }

  const app = window.PicSpeak.app;
  const whenReady = app && app.ready ? app.ready : Promise.resolve();
  if (isConfigured()) whenReady.then(start).catch(() => {});

  window.PicSpeak.cloud = {
    CloudError,
    isConfigured,
    isConnected: () => Boolean(link),
    listAccounts,
    withAccount,
    disconnectAll,
    deviceName,
    setDeviceName,
    isEnabledHere: enabledHere,
    enableHere,
    status: () => status,
    onStatus,
    newPkce,
    authorizeUrl,
    connect,
    disconnect,
    syncNow: () => (enabledHere() ? runSync() : Promise.resolve()),
    pullNow: () => pullAndApply(false),
    hasConflict,
    resolveConflict,
    conflictInfo,
    follow,
    release,
    isAuto,
    setAuto,
    applyNow,
    linkedHere,
    pauseDuring,
    isSynced,
    forgetProfile,
    listDevices,
    excludeDevice,
    // Modifica fatta senza toccare le schede (es. pittogrammi recuperati): va nella prossima copia completa
    markChanged: () => { if (ready) markDirty('full'); },
    wasExcluded,
    folder: () => (currentProfileId() ? folderOf(currentProfileId()) : null),
    deviceId: () => (enabledHere() ? deviceId() : null),
    lastCopy,
    pending,
    saveSnapshot,
    listProfiles,
    listCopies,
    openCopy,
    // Per i test
    _test: { classify, checkPath, slug, parseStamp, rotate, markDirty, due, start, setLink: (value) => { link = normalizeLink(value); accessByAccount.clear(); }, normalizeLink, state: () => state, link: () => link, FILE_NAMES, pullNow, pullAndApply, restoreLayers, loadLink },
  };
})();
