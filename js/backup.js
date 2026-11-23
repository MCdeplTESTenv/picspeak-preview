/*
 * Backup completo di PicSpeak (Tappa 5, primo passo: backup locale in un file).
 *
 * Il file «.picspeak» è un archivio zip (scritto e letto da zip.js, senza librerie):
 *   manifest.json   { format: 'picspeak', kind: 'backup', formatVersion: 1, app, createdAt,
 *                     profile: { id, name }, device, parts: [...], encryption: null | {…} }
 *   boards.json     schede del profilo nel formato dei modelli; ogni immagine indica il suo file in images/
 *   images/N.ext    immagini e foto (PNG, JPEG o WebP), ognuna salvata una volta sola anche se la usano schede e modelli
 *   habits.json     abitudini d'uso, pesi di partenza e contesti (stesso formato di «Esporta storico e contesti»)
 *   templates.json  i modelli salvati dall'adulto («I miei modelli»), immagini come in boards.json
 *   appearance.json aspetto: stile, colori, sfondo, zoom
 *   settings.json   altre impostazioni: voce, lingua, tocco e frase, previsione, stampa, simboli, schermo
 * Con la password facoltativa gli ultimi cinque file stanno in un secondo zip, cifrato con AES-GCM
 * (chiave ricavata dalla password con PBKDF2-SHA-256, tutto con la crittografia già presente nel browser):
 * nel file resta in chiaro solo manifest.json (formato, nome e id del profilo, data e ora, tipo di dispositivo,
 * elenco delle parti): l'adulto ne è avvisato quando sceglie la password.
 *
 * Fuori dal backup, di proposito: PIN e codice di recupero, la scelta sull'uso di Internet, i pacchetti di simboli
 * scaricati (si riscaricano), la copia delle schede di prima e la data dell'ultimo backup di questo dispositivo.
 *
 * Sicurezza: un file da ripristinare è un dato non affidabile. Ogni parte passa dai controlli già usati per i
 * modelli (templates.validate) e per lo storico (predict.readHistoryFile); le impostazioni si accettano solo per
 * chiavi conosciute, come dati JSON semplici e di dimensione limitata. Nessun testo diventa HTML.
 */
(function () {
  'use strict';

  const { storage, data, templates, predict, zip, symbols } = window.PicSpeak;

  const FORMAT = 'picspeak';
  const KIND = 'backup';
  const FORMAT_VERSION = 1;
  const MB = 1024 * 1024;
  const MAX_FILE_BYTES = 100 * MB;
  // Un solo tetto per tutto ciò che si decomprime, archivio esterno e interno (cifrato) insieme
  const MAX_TOTAL_BYTES = 150 * MB;
  const ZIP_LIMITS = { maxEntries: 8000, maxEntryBytes: 80 * MB, maxTotalBytes: MAX_TOTAL_BYTES };
  // Dimensione massima di ogni parte, controllata prima di leggerla come JSON
  const PART_MAX_BYTES = {
    'manifest.json': 64 * 1024,
    'boards.json': 60 * MB,
    'habits.json': 40 * MB,
    'templates.json': 40 * MB,
    'appearance.json': MB,
    'settings.json': MB,
  };
  const ITERATIONS = 310000; // PBKDF2: lento abbastanza contro i tentativi, veloce su un tablet
  const MIN_ITERATIONS = 100000;
  const MAX_ITERATIONS = 2000000; // un file non può chiedere un calcolo che blocca il dispositivo
  const NAME_MAX = 40;
  const MAX_TEMPLATES = 20; // come «I miei modelli»
  const MAX_SETTING_CHARS = 200 * 1024;
  const LAST_KEY = 'lastBackup';
  const PARTS = ['boards', 'habits', 'templates', 'appearance', 'settings'];
  // Chiavi dell'archivio «settings» che entrano nel backup, divise tra aspetto e altre impostazioni
  const GROUP_KEYS = {
    appearance: ['colorMode', 'pageBackground', 'appearance', 'preset', 'labelCase'],
    settings: ['language', 'voice', 'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources',
      'keepScreenOn', 'autoFullscreen', 'openSections', 'sectionState'],
  };
  const PACK_NAMES = { mulberry: 'Mulberry', openmoji: 'OpenMoji' };
  const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

  class BackupError extends Error {}

  const encoder = new TextEncoder();

  // ---------- Testi e nomi ----------

  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // Niente caratteri di controllo né di direzione del testo
    return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function cleanName(value) {
    return cleanText(value, NAME_MAX);
  }

  // Nome del file: PicSpeak-<nome>-AAAA-MM-GG-HHMM.picspeak (data e ora locali)
  function fileName(name, date, fallback) {
    const slug = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || fallback;
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
    return `PicSpeak-${slug}-${stamp}.picspeak`;
  }

  // Tipo di dispositivo e browser (es. «iPad, Safari»): solo per riconoscere il backup, niente di identificativo
  function deviceLabel() {
    const ua = navigator.userAgent || '';
    const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
    let device = '';
    if (/iPad/.test(ua) || touchMac) device = 'iPad';
    else if (/iPhone/.test(ua)) device = 'iPhone';
    else if (/Android/.test(ua)) device = 'Android';
    else if (/CrOS/.test(ua)) device = 'Chromebook';
    else if (/Windows/.test(ua)) device = 'Windows';
    else if (/Macintosh/.test(ua)) device = 'Mac';
    else if (/Linux/.test(ua)) device = 'Linux';
    let browser = '';
    if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
    else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
    else if (/Chrome|CriOS/.test(ua)) browser = 'Chrome';
    else if (/Safari/.test(ua)) browser = 'Safari';
    return [device, browser].filter(Boolean).join(', ');
  }

  // ---------- Base64 ----------

  function bytesToBase64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ---------- Cifratura facoltativa ----------

  function cryptoAvailable() {
    return Boolean(window.crypto && crypto.subtle && typeof crypto.subtle.deriveKey === 'function');
  }

  async function deriveKey(password, salt, iterations) {
    // Forma unica dei caratteri accentati (NFC): la stessa password scritta su iPad o su PC dà la stessa chiave
    const base = await crypto.subtle.importKey('raw', encoder.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  // ---------- Impostazioni come dati semplici ----------

  // Copia pulita di un valore JSON: solo testo, numeri, sì/no, elenchi e oggetti, con profondità limitata
  function plainValue(value, depth = 0) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (depth > 6) return undefined;
    if (Array.isArray(value)) {
      return value.slice(0, 500).map((item) => plainValue(item, depth + 1)).filter((item) => item !== undefined);
    }
    if (typeof value === 'object') {
      const out = {};
      Object.keys(value).slice(0, 200).forEach((key) => {
        if (RESERVED_KEYS.includes(key) || key.length > 80) return;
        const clean = plainValue(value[key], depth + 1);
        if (clean !== undefined) out[key] = clean;
      });
      return out;
    }
    return undefined;
  }

  function cleanGroup(raw, group) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    GROUP_KEYS[group].forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
      const value = plainValue(raw[key]);
      if (value === undefined || value === null) return;
      if (JSON.stringify(value).length > MAX_SETTING_CHARS) return;
      out[key] = value;
    });
    return out;
  }

  async function readGroup(group) {
    const out = {};
    for (const key of GROUP_KEYS[group]) {
      const value = await storage.get(key);
      if (value !== undefined && value !== null) out[key] = value;
    }
    return out;
  }

  // ---------- Salvare un backup ----------

  async function lastBackup() {
    const saved = await storage.get(LAST_KEY);
    if (!saved || typeof saved.at !== 'string' || Number.isNaN(Date.parse(saved.at))) return null;
    return { at: new Date(saved.at), name: cleanName(saved.name) };
  }

  async function setProfileName(name) {
    const profile = data.profile;
    if (!profile) return;
    profile.name = cleanName(name);
    profile.updatedAt = new Date().toISOString();
    await storage.putRecord('profiles', profile);
  }

  /*
   * Crea il file del backup e lo restituisce come { blob, name }.
   * options: { name (nome del profilo), password (facoltativa, '' = nessuna), fallbackName }
   */
  async function create({ name, password, fallbackName }) {
    const profileName = cleanName(name);
    if (password && !cryptoAvailable()) throw new BackupError('unsupported');
    await setProfileName(profileName);
    if (predict && typeof predict.flush === 'function') await predict.flush();

    const now = new Date();
    const files = [];
    const parts = [];
    // Immagini in comune: ogni immagine diversa diventa un file images/N.ext, schede e modelli lo richiamano
    const imagePaths = new Map(); // contenuto in base64 → percorso nel file
    const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const shareImages = (template) => {
      Object.values(template.images).forEach((entry) => {
        if (!entry.data) return;
        let path = imagePaths.get(entry.data);
        if (!path) {
          path = `images/${imagePaths.size + 1}.${EXT[entry.mime] || 'png'}`;
          imagePaths.set(entry.data, path);
          files.push({ name: path, data: base64ToBytes(entry.data), compress: false });
        }
        entry.file = path;
        delete entry.data;
      });
      return template;
    };
    const addPart = (part, value) => {
      parts.push(part);
      files.push({ name: `${part}.json`, data: JSON.stringify(value), compress: true });
    };

    // Schede: stesso formato dei modelli, immagini e foto dentro il file
    if (data.profilePages().length) {
      const boards = await templates.fromCurrentPages(profileName || 'PicSpeak', { embed: true });
      addPart('boards', shareImages(boards));
    }
    if (predict && typeof predict.exportData === 'function') addPart('habits', predict.exportData());
    const userTemplates = await templates.userTemplates();
    const templateList = [];
    for (const entry of userTemplates) {
      if (!entry || !entry.template) continue;
      try {
        templateList.push({ id: entry.id, savedAt: entry.savedAt, template: shareImages(await templates.embedImages(entry.template)) });
      } catch (error) {
        // Modello illeggibile: si salta
      }
    }
    addPart('templates', templateList);
    addPart('appearance', await readGroup('appearance'));
    addPart('settings', await readGroup('settings'));

    const manifest = {
      format: FORMAT,
      kind: KIND,
      formatVersion: FORMAT_VERSION,
      app: 'PicSpeak',
      createdAt: now.toISOString(),
      profile: { id: data.profile ? data.profile.id : null, name: profileName },
      device: deviceLabel(),
      parts,
      encryption: null,
    };

    let archiveFiles;
    if (password) {
      const inner = new Uint8Array(await (await zip.create(files)).arrayBuffer());
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt, ITERATIONS);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, inner));
      manifest.encryption = {
        cipher: 'AES-GCM', kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: bytesToBase64(salt), iv: bytesToBase64(iv),
      };
      archiveFiles = [{ name: 'data.bin', data: sealed, compress: false }];
    } else {
      archiveFiles = files;
    }
    archiveFiles.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2), compress: true });
    const zipped = await zip.create(archiveFiles);
    const blob = new Blob([zipped], { type: 'application/octet-stream' });
    await storage.set(LAST_KEY, { at: manifest.createdAt, name: profileName });
    return { blob, name: fileName(profileName, now, fallbackName || 'backup') };
  }

  // Salva il file (cartella Download, o app File su iPad e iPhone)
  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- Aprire un backup ----------

  function zipProblem(error) {
    if (error instanceof BackupError) return error;
    const code = error && error.message;
    if (code === 'unsupported') return new BackupError('unsupported');
    if (code === 'too-big' || code === 'too-many') return new BackupError('size');
    return new BackupError('damaged');
  }

  function cleanManifest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BackupError('format');
    if (raw.format !== FORMAT || raw.kind !== KIND) throw new BackupError('format');
    if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) throw new BackupError('format');
    if (raw.formatVersion > FORMAT_VERSION) throw new BackupError('version');
    const created = typeof raw.createdAt === 'string' && raw.createdAt.length <= 40 ? new Date(raw.createdAt) : null;
    const profile = raw.profile && typeof raw.profile === 'object' ? raw.profile : {};
    const info = {
      createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
      profileId: typeof profile.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(profile.id) ? profile.id : null,
      name: cleanName(profile.name),
      device: cleanText(raw.device, 60),
      encryption: null,
    };
    if (raw.encryption) {
      const enc = raw.encryption;
      let salt;
      let iv;
      try {
        salt = base64ToBytes(String(enc.salt));
        iv = base64ToBytes(String(enc.iv));
      } catch (error) {
        throw new BackupError('damaged');
      }
      if (enc.cipher !== 'AES-GCM' || enc.kdf !== 'PBKDF2-SHA-256' || !Number.isInteger(enc.iterations)
        || enc.iterations < MIN_ITERATIONS || enc.iterations > MAX_ITERATIONS || salt.length !== 16 || iv.length !== 12) {
        throw new BackupError('damaged');
      }
      info.encryption = { iterations: enc.iterations, salt, iv };
    }
    return info;
  }

  /*
   * Apre il file e ne legge solo la descrizione (manifest). Restituisce { info, archive }.
   * Le parti si leggono dopo, con read() (e la password, se il backup è protetto).
   */
  async function open(file) {
    if (!file || file.size > MAX_FILE_BYTES) throw new BackupError('size');
    let archive;
    try {
      if (!(await zip.isZip(file))) throw new BackupError('format');
      archive = await zip.open(file, ZIP_LIMITS);
    } catch (error) {
      throw zipProblem(error);
    }
    if (!archive.has('manifest.json')) throw new BackupError('format');
    let raw;
    try {
      raw = JSON.parse(new TextDecoder().decode(await readPart(archive, 'manifest.json')));
    } catch (error) {
      throw error instanceof SyntaxError ? new BackupError('format') : zipProblem(error);
    }
    return { info: cleanManifest(raw), archive };
  }

  // Byte di una parte, con il suo limite di dimensione
  async function readPart(archive, name) {
    let bytes;
    try {
      bytes = await archive.read(name);
    } catch (error) {
      throw zipProblem(error);
    }
    const max = PART_MAX_BYTES[name] || (name.startsWith('images/') ? 3 * MB : MB);
    if (bytes.length > max) throw new BackupError('size');
    return bytes;
  }

  // Archivio con le parti: quello del file o, con la password, quello interno decifrato
  async function unlock(opened, password) {
    const { info, archive } = opened;
    if (!info.encryption) return archive;
    if (!cryptoAvailable()) throw new BackupError('unsupported');
    if (!archive.has('data.bin')) throw new BackupError('damaged');
    let sealed;
    try {
      sealed = await archive.read('data.bin');
    } catch (error) {
      throw zipProblem(error);
    }
    let plain;
    try {
      const key = await deriveKey(String(password || ''), info.encryption.salt, info.encryption.iterations);
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: info.encryption.iv }, key, sealed);
    } catch (error) {
      // AES-GCM controlla anche l'integrità: password sbagliata o file modificato
      throw new BackupError('password');
    }
    try {
      // L'archivio interno può decomprimere solo quanto resta del tetto complessivo
      const left = Math.max(0, MAX_TOTAL_BYTES - sealed.length);
      return await zip.open(new Blob([plain]), { ...ZIP_LIMITS, maxTotalBytes: left });
    } catch (error) {
      throw zipProblem(error);
    }
  }

  async function readJson(archive, name) {
    if (!archive.has(name)) return undefined;
    const bytes = await readPart(archive, name);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      return undefined;
    }
  }

  /*
   * Rimette dentro un modello letto dal file le immagini salvate a parte (images/N.ext), nella forma che
   * templates.validate conosce (base64). Un riferimento sbagliato o mancante lascia la tessera con la sola parola.
   */
  async function attachImages(archive, raw, cache) {
    if (!raw || typeof raw !== 'object' || !raw.images || typeof raw.images !== 'object') return raw;
    for (const entry of Object.values(raw.images)) {
      if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') continue;
      const path = entry.file;
      delete entry.file;
      if (!/^images\/\d{1,6}\.(png|jpg|webp)$/.test(path) || !archive.has(path)) continue;
      if (!cache.has(path)) cache.set(path, bytesToBase64(await readPart(archive, path)));
      entry.data = cache.get(path);
    }
    return raw;
  }

  // Immagini dentro un modello: si tengono solo quelle con la firma reale di PNG, JPEG o WebP
  async function checkTemplateImages(template) {
    for (const entry of Object.values(template.images)) {
      if (!entry.data) continue;
      try {
        const binary = atob(entry.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        await symbols.checkImage(new Blob([bytes], { type: entry.mime }));
      } catch (error) {
        delete entry.data;
        delete entry.mime;
      }
    }
    return template;
  }

  /*
   * Legge e controlla le parti presenti nel backup. Una parte non valida viene lasciata fuori (non blocca le altre).
   * Restituisce { boards, habits, templates, appearance, settings, summary }.
   */
  async function read(opened, password) {
    const archive = await unlock(opened, password);
    const parts = {};
    const summary = {};
    const imageCache = new Map(); // percorso → base64, per leggere una sola volta le immagini in comune

    const boardsRaw = await attachImages(archive, await readJson(archive, 'boards.json'), imageCache);
    if (boardsRaw !== undefined) {
      try {
        parts.boards = templates.validate(boardsRaw, { fromFile: true });
        summary.boards = { pages: parts.boards.pages.length };
      } catch (error) {
        // Schede non valide: la parte non si offre
      }
    }

    const habitsRaw = archive.has('habits.json') ? await readPart(archive, 'habits.json') : null;
    if (habitsRaw && predict && typeof predict.readHistoryFile === 'function') {
      try {
        const { parsed, summary: s } = await predict.readHistoryFile(new Blob([habitsRaw]));
        if (parsed.kind === 'habits') {
          parts.habits = parsed;
          summary.habits = { days: s.days, contexts: s.contexts };
        }
      } catch (error) {
        // Storico non valido: la parte non si offre
      }
    }

    const templatesRaw = await readJson(archive, 'templates.json');
    if (Array.isArray(templatesRaw)) {
      const list = [];
      for (const entry of templatesRaw.slice(0, MAX_TEMPLATES * 2)) {
        if (!entry || typeof entry !== 'object') continue;
        try {
          await attachImages(archive, entry.template, imageCache);
          const template = await checkTemplateImages(templates.validate(entry.template, { fromFile: true }));
          const id = typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(entry.id) ? entry.id : data.newId('tpl');
          const savedAt = typeof entry.savedAt === 'string' && !Number.isNaN(Date.parse(entry.savedAt))
            ? new Date(entry.savedAt).toISOString() : new Date().toISOString();
          if (!list.some((item) => item.id === id)) list.push({ id, savedAt, template });
        } catch (error) {
          // Modello non valido: si salta
        }
      }
      parts.templates = list;
      summary.templates = { n: list.length };
    }

    for (const group of ['appearance', 'settings']) {
      const clean = cleanGroup(await readJson(archive, `${group}.json`), group);
      if (clean) {
        parts[group] = clean;
        summary[group] = { keys: Object.keys(clean).length };
      }
    }
    parts.summary = summary;
    return parts;
  }

  // ---------- Ripristinare ----------

  /*
   * choice: { boards: 'replace' | 'add' | null, habits: 'merge' | 'replace' | null, templates: 'add' | 'replace' | null,
   *           appearance: 'replace' | null, settings: 'replace' | null }
   * info: descrizione del backup (nome del profilo, data); all = true per «Ripristina tutto».
   * Restituisce un resoconto per l'adulto.
   */
  async function restore(parts, choice, info, { folderName, all = false } = {}) {
    const report = { missing: 0, packs: [], templatesFull: false };

    if (choice.boards && parts.boards) {
      if (choice.boards === 'add' && folderName) parts.boards.name = folderName;
      const result = await templates.apply(parts.boards, { mode: choice.boards === 'add' ? 'add' : 'replace', online: false });
      report.missing = result.missing || 0;
    }

    if (choice.habits && parts.habits) {
      await predict.importData(parts.habits, choice.habits === 'replace' ? 'replace' : 'merge');
      if (typeof predict.flush === 'function') await predict.flush();
    }

    if (choice.templates && parts.templates) {
      const list = choice.templates === 'replace' ? [] : await templates.userTemplates();
      parts.templates.forEach((entry) => {
        if (list.some((item) => item.id === entry.id)) return;
        if (list.length >= MAX_TEMPLATES) { report.templatesFull = true; return; }
        list.push(entry);
      });
      await storage.set('userTemplates', list);
    }

    for (const group of ['appearance', 'settings']) {
      if (choice[group] !== 'replace' || !parts[group]) continue;
      // «Sostituisci»: le impostazioni diventano identiche a quelle del backup (le chiavi assenti tornano iniziali)
      for (const key of GROUP_KEYS[group]) {
        if (Object.prototype.hasOwnProperty.call(parts[group], key)) await storage.set(key, parts[group][key]);
        else await storage.remove(key);
      }
    }

    // Nome del profilo: con «Ripristina tutto» si prende quello del backup, altrimenti solo se qui manca
    if (info.name && data.profile && (all || !data.profile.name)) await setProfileName(info.name);

    // Pacchetti di simboli attivi nel backup ma non scaricati su questo dispositivo
    const sources = choice.settings === 'replace' && parts.settings ? parts.settings.symbolSources : null;
    if (sources && typeof sources === 'object') {
      const status = await symbols.packStatus();
      report.packs = Object.keys(PACK_NAMES).filter((id) => sources[id] === true && !status[id]).map((id) => PACK_NAMES[id]);
    }
    return report;
  }

  window.PicSpeak.backup = {
    BackupError,
    PARTS,
    MAX_TEMPLATES,
    cryptoAvailable,
    lastBackup,
    setProfileName,
    create,
    save,
    open,
    read,
    restore,
  };
})();
