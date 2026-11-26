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
 *   appearance.json aspetto: stile, colori (anche quelli scelti per i tipi di parola), sfondo, zoom
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
    appearance: ['colorMode', 'pageBackground', 'appearance', 'preset', 'labelCase', 'typeColors'],
    settings: ['language', 'voice', 'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources',
      'keepScreenOn', 'autoFullscreen', 'openSections', 'sectionState'],
  };
  const PACK_NAMES = { mulberry: 'Mulberry', openmoji: 'OpenMoji' };
  const ONLINE_SOURCES = { twemoji: 'Twemoji' };
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

  // ---------- Promemoria del backup (solo per chi non ha il backup online) ----------

  // Primo promemoria dopo una settimana di uso, poi un mese dopo l'ultimo backup; «Più tardi» rimanda di una settimana
  const REMINDER_KEY = 'backupReminder';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const REMINDER_FIRST_DAYS = 7;
  const REMINDER_EVERY_DAYS = 30;
  const REMINDER_SNOOZE_DAYS = 7;

  function validDate(value) {
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isNaN(ms) ? null : ms;
  }

  /*
   * Decide se mostrare il promemoria (funzione pura, per i test). Date in millisecondi o null:
   * now, last (ultimo backup da questo dispositivo), since (creazione del profilo), until (rimandato fino a).
   * online: il profilo ha il backup online attivo su questo dispositivo, e allora non serve.
   */
  function reminderDue({ now, last: savedLast, since, until, online }) {
    if (online) return false;
    // Date nel futuro (orologio spostato avanti e poi corretto, valore rovinato): un rinvio non dura più di 7 giorni,
    // un backup «nel futuro» vale come fatto adesso
    if (until && now < until && until - now <= REMINDER_SNOOZE_DAYS * DAY_MS) return false;
    const last = savedLast ? Math.min(savedLast, now) : savedLast;
    if (last) return now - last >= REMINDER_EVERY_DAYS * DAY_MS;
    // Mai salvato: si aspetta una settimana dalla nascita del profilo (data sconosciuta: si mostra)
    return !since || now - since >= REMINDER_FIRST_DAYS * DAY_MS;
  }

  // Stato per il profilo in uso: { due, days } (days = giorni dall'ultimo backup, null se mai salvato)
  async function reminderState(online) {
    const now = Date.now();
    const lastInfo = await lastBackup();
    const last = lastInfo ? lastInfo.at.getTime() : null;
    const saved = await storage.get(REMINDER_KEY);
    const until = saved && typeof saved === 'object' ? validDate(saved.until) : null;
    const since = data.profile ? validDate(data.profile.createdAt) : null;
    return {
      due: reminderDue({ now, last, since, until, online: Boolean(online) }),
      days: last ? Math.max(0, Math.floor((now - last) / DAY_MS)) : null,
    };
  }

  async function snoozeReminder() {
    await storage.set(REMINDER_KEY, { until: new Date(Date.now() + REMINDER_SNOOZE_DAYS * DAY_MS).toISOString() });
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
   * options: { name (nome del profilo), password (facoltativa, '' = nessuna), fallbackName,
   *            only (facoltativo: elenco delle parti da mettere, es. ['habits'] per la copia online delle abitudini),
   *            quiet (true per le copie online automatiche: non cambia il nome del profilo né la data dell'ultimo
   *            backup salvato da questo dispositivo) }
   */
  async function create(options) {
    // Se la prova del file appena creato non riesce, lo si rifà da capo una volta, senza disturbare l'adulto
    try {
      return await build(options);
    } catch (error) {
      if (!(error instanceof BackupError) || error.message !== 'verify') throw error;
      return build(options);
    }
  }

  async function build({ name, password, fallbackName, only, quiet, device }) {
    const profileName = cleanName(name);
    if (password && !cryptoAvailable()) throw new BackupError('unsupported');
    const want = (part) => !Array.isArray(only) || only.includes(part);
    if (!quiet) await setProfileName(profileName);
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
    if (want('boards') && data.profilePages().length) {
      const boards = await templates.fromCurrentPages(profileName || 'PicSpeak', { embed: true });
      addPart('boards', shareImages(boards));
    }
    if (want('habits') && predict && typeof predict.exportData === 'function') addPart('habits', predict.exportData());
    const userTemplates = want('templates') ? await templates.userTemplates() : [];
    const templateList = [];
    for (const entry of userTemplates) {
      if (!entry || !entry.template) continue;
      try {
        templateList.push({ id: entry.id, savedAt: entry.savedAt, template: shareImages(await templates.embedImages(entry.template)) });
      } catch (error) {
        // Modello illeggibile: si salta
      }
    }
    if (want('templates')) addPart('templates', templateList);
    if (want('appearance')) addPart('appearance', await readGroup('appearance'));
    if (want('settings')) addPart('settings', await readGroup('settings'));

    const manifest = {
      format: FORMAT,
      kind: KIND,
      formatVersion: FORMAT_VERSION,
      app: 'PicSpeak',
      createdAt: now.toISOString(),
      profile: { id: data.profile ? data.profile.id : null, name: profileName },
      // Nome del dispositivo scelto dall'adulto per il backup online (es. «Tablet di scuola»), altrimenti il tipo
      device: (typeof device === 'string' && device.trim() ? device.trim().slice(0, 60) : deviceLabel()),
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
    const pages = want('boards') ? data.profilePages().length : 0;
    await verify(blob, password, { pages, templates: templateList.length, images: imagePaths.size });
    if (!quiet) await storage.set(LAST_KEY, { at: manifest.createdAt, name: profileName });
    return { blob, name: fileName(profileName, now, fallbackName || 'backup'), createdAt: now };
  }

  /*
   * Prova del file appena creato, prima di consegnarlo: lo si riapre esattamente come al ripristino (password
   * compresa) e si controlla che ci siano tutte le schede, tutti i modelli e tutte le immagini, leggibili.
   */
  async function verify(blob, password, expected) {
    let parts;
    try {
      parts = await read(await open(blob), password);
    } catch (error) {
      throw new BackupError('verify');
    }
    const pages = parts.boards ? parts.boards.pages.length : 0;
    const templateCount = parts.templates ? parts.templates.length : 0;
    if (parts.issues.images || parts.issues.parts.length || pages !== expected.pages
      || templateCount !== expected.templates || parts.imageCount !== expected.images) {
      throw new BackupError('verify');
    }
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
  /*
   * Vecchio file «Storico e contesti» (.json, kind «habits», dalla sezione tolta il 23/11/2026): si apre come un
   * backup che contiene solo abitudini e contesti, così i file salvati prima non vanno persi.
   */
  async function openHistoryFile(file) {
    if (file.size > PART_MAX_BYTES['habits.json']) throw new BackupError('size');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let raw;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new BackupError('format');
    }
    if (!raw || raw.format !== FORMAT || raw.kind !== 'habits') throw new BackupError('format');
    // Storico salvato da una versione più recente: si chiede di aggiornare l'app, come per il backup
    if (predict && Number(raw.formatVersion) > predict.HISTORY_FORMAT_VERSION) throw new BackupError('version');
    const created = typeof raw.createdAt === 'string' && raw.createdAt.length <= 40 ? new Date(raw.createdAt) : null;
    const archive = {
      names: ['habits.json'],
      has: (name) => name === 'habits.json',
      async read(name, max) {
        if (name !== 'habits.json') throw new BackupError('damaged');
        if (max && bytes.length > max) throw new BackupError('size');
        return bytes;
      },
    };
    return {
      info: {
        createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
        profileId: null, name: '', device: '', encryption: null, legacy: true,
      },
      archive,
    };
  }

  async function open(file) {
    if (!file || file.size > MAX_FILE_BYTES) throw new BackupError('size');
    let archive;
    try {
      if (!(await zip.isZip(file))) return await openHistoryFile(file);
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
    // Il limite della parte vale già durante la decompressione: niente lavoro inutile oltre quella misura
    const max = PART_MAX_BYTES[name] || (name.startsWith('images/') ? 3 * MB : MB);
    let bytes;
    try {
      bytes = await archive.read(name, max);
    } catch (error) {
      throw zipProblem(error);
    }
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

  // Parte JSON: undefined se non c'è, null se c'è ma non si riesce a leggere
  async function readJson(archive, name) {
    if (!archive.has(name)) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(await readPart(archive, name)));
    } catch (error) {
      return null;
    }
  }

  /*
   * Rimette dentro un modello letto dal file le immagini salvate a parte (images/N.ext), nella forma che
   * templates.validate conosce (base64). Il ripristino non si blocca mai: un'immagine che manca o non si legge
   * si conta in issues e la tessera resta con la parola.
   */
  async function attachImages(archive, raw, cache, issues) {
    if (!raw || typeof raw !== 'object' || !raw.images || typeof raw.images !== 'object') return raw;
    for (const entry of Object.values(raw.images)) {
      if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') continue;
      const path = entry.file;
      delete entry.file;
      if (!cache.has(path)) {
        let value = null;
        if (/^images\/\d{1,6}\.(png|jpg|webp)$/.test(path) && archive.has(path)) {
          try {
            value = bytesToBase64(await readPart(archive, path));
          } catch (error) {
            value = null;
          }
        }
        if (!value) issues.images += 1;
        cache.set(path, value);
      }
      if (cache.get(path)) entry.data = cache.get(path);
      else delete entry.mime;
    }
    return raw;
  }

  /*
   * Controlla che ogni immagine contenuta in un modello si possa davvero usare: firma reale PNG, JPEG o WebP,
   * misure ammesse e decodifica riuscita. Un'immagine rovinata si toglie (la tessera resta con la parola) e si conta.
   */
  async function checkTemplateImages(template, checked, issues) {
    for (const entry of Object.values(template.images)) {
      if (!entry.data) continue;
      if (!checked.has(entry.data)) {
        let ok = true;
        try {
          const blob = new Blob([base64ToBytes(entry.data)], { type: entry.mime });
          await symbols.checkImage(blob);
          const bitmap = await createImageBitmap(blob);
          if (bitmap.close) bitmap.close();
        } catch (error) {
          ok = false;
          issues.images += 1;
        }
        checked.set(entry.data, ok);
      }
      if (!checked.get(entry.data)) {
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
    // Il ripristino recupera sempre tutto quello che può: le parti o le immagini rovinate si contano e si dicono
    // all'adulto alla fine, senza fermare il resto
    const issues = { images: 0, parts: [] };
    const imageCache = new Map(); // percorso → base64 (null se illeggibile), per leggere una volta le immagini in comune
    const checked = new Map(); // immagine → true se usabile

    if (archive.has('boards.json')) {
      try {
        const raw = await attachImages(archive, await readJson(archive, 'boards.json'), imageCache, issues);
        parts.boards = await checkTemplateImages(templates.validate(raw, { fromFile: true }), checked, issues);
        summary.boards = { pages: parts.boards.pages.length };
      } catch (error) {
        delete parts.boards;
        issues.parts.push('boards');
      }
    }

    if (archive.has('habits.json') && predict && typeof predict.readHistoryFile === 'function') {
      try {
        const result = await predict.readHistoryFile(new Blob([await readPart(archive, 'habits.json')]));
        if (result.parsed.kind !== 'habits') throw new BackupError('damaged');
        parts.habits = result.parsed;
        summary.habits = { days: result.summary.days, contexts: result.summary.contexts };
      } catch (error) {
        issues.parts.push('habits');
      }
    }

    if (archive.has('templates.json')) {
      const raw = await readJson(archive, 'templates.json');
      const list = [];
      let lost = !Array.isArray(raw);
      for (const entry of (Array.isArray(raw) ? raw.slice(0, MAX_TEMPLATES * 2) : [])) {
        try {
          if (!entry || typeof entry !== 'object') throw new BackupError('damaged');
          await attachImages(archive, entry.template, imageCache, issues);
          const template = await checkTemplateImages(templates.validate(entry.template, { fromFile: true }), checked, issues);
          const id = typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(entry.id) ? entry.id : data.newId('tpl');
          const savedAt = typeof entry.savedAt === 'string' && !Number.isNaN(Date.parse(entry.savedAt))
            ? new Date(entry.savedAt).toISOString() : new Date().toISOString();
          if (!list.some((item) => item.id === id)) list.push({ id, savedAt, template });
        } catch (error) {
          lost = true;
        }
      }
      if (lost) issues.parts.push('templates');
      parts.templates = list;
      summary.templates = { n: list.length };
    }

    for (const group of ['appearance', 'settings']) {
      if (!archive.has(`${group}.json`)) continue;
      const clean = cleanGroup(await readJson(archive, `${group}.json`), group);
      if (!clean) { issues.parts.push(group); continue; }
      parts[group] = clean;
      summary[group] = { keys: Object.keys(clean).length };
    }
    parts.summary = summary;
    parts.issues = issues;
    parts.imageCount = [...imageCache.values()].filter(Boolean).length;
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
    const issues = parts.issues || { images: 0, parts: [] };
    const report = { missing: 0, packs: [], templatesFull: false, lostImages: issues.images, lostParts: issues.parts };

    if (choice.boards && parts.boards) {
      if (choice.boards === 'add' && folderName) parts.boards.name = folderName;
      const result = await templates.apply(parts.boards, { mode: choice.boards === 'add' ? 'add' : 'replace', online: false });
      report.missing = result.missing || 0;
    }

    if (choice.habits && parts.habits) {
      const extra = Array.isArray(parts.habitsExtra) ? parts.habitsExtra : null;
      const cloud = window.PicSpeak.cloud;
      const sameFolder = Boolean(extra && cloud && cloud.isEnabledHere() && cloud.folder() === parts.habitsFolder);
      if (sameFolder) {
        /*
         * Copia online della cartella che questo profilo usa già (anche da altri dispositivi): i tocchi degli altri
         * dispositivi arrivano a parte e non si copiano qui, altrimenti si conterebbero due volte. Si prendono
         * contesti e pesi di partenza; con «sostituisci» lo storico di qui torna quello del suo file.
         */
        await predict.replaceDefinitions(parts.habits);
        const own = extra.find((h) => h.deviceId === cloud.deviceId());
        if (choice.habits === 'replace') await predict.importData({ ...(own || { pairs: [], days: [], months: [] }), contexts: [], base: [] }, 'replace-counts');
      } else {
        await predict.importData(parts.habits, choice.habits === 'replace' ? 'replace' : 'merge');
        // Conteggi di ogni dispositivo, ognuno sommato una volta sola
        if (extra) for (const habits of extra) await predict.importData(habits, 'merge');
      }
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

    // Fonti online (Twemoji, scaricata da un sito esterno): un backup non le accende da solo su questo dispositivo;
    // restano come sono qui e l'adulto è avvisato, così decide lui se attivarle
    report.online = [];
    if (choice.settings === 'replace' && parts.settings && parts.settings.symbolSources
      && typeof parts.settings.symbolSources === 'object') {
      const here = (await storage.get('symbolSources')) || {};
      const incoming = { ...parts.settings.symbolSources };
      Object.keys(ONLINE_SOURCES).forEach((id) => {
        if (incoming[id] === true && here[id] !== true) report.online.push(ONLINE_SOURCES[id]);
        if (typeof here[id] === 'boolean') incoming[id] = here[id];
        else delete incoming[id];
      });
      parts.settings.symbolSources = incoming;
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
    // (mai un nome già usato da un altro profilo di questo dispositivo: i profili si riconoscono dal nome)
    if (info.name && data.profile && (all || !data.profile.name)) {
      const key = info.name.toLocaleLowerCase();
      const others = await storage.getAllRecords('profiles');
      const taken = others.some((p) => p && p.id !== data.profile.id && cleanName(p.name).toLocaleLowerCase() === key);
      if (!taken) await setProfileName(info.name);
    }

    // Pacchetti di simboli attivi nel backup ma non scaricati su questo dispositivo
    const sources = choice.settings === 'replace' && parts.settings ? parts.settings.symbolSources : null;
    if (sources && typeof sources === 'object') {
      const status = await symbols.packStatus();
      report.packs = Object.keys(PACK_NAMES).filter((id) => sources[id] === true && !status[id]).map((id) => PACK_NAMES[id]);
    }
    return report;
  }

  /*
   * Copia online «più recente»: il backup completo e, se è più nuovo, il file con le sole abitudini (che si aggiorna
   * più spesso). Le abitudini più nuove prendono il posto di quelle del backup completo. Modifica e restituisce
   * fullParts; info è la descrizione del backup completo (la data diventa quella del file più nuovo).
   */
  function combineLatest(fullParts, fullInfo, habitsParts, habitsInfo) {
    if (!habitsParts || !habitsInfo || !habitsInfo.createdAt || !habitsParts.habits) return { parts: fullParts, info: fullInfo };
    if (fullInfo.createdAt && habitsInfo.createdAt <= fullInfo.createdAt) return { parts: fullParts, info: fullInfo };
    fullParts.habits = habitsParts.habits;
    fullParts.summary.habits = habitsParts.summary.habits;
    fullParts.issues.parts = fullParts.issues.parts.filter((part) => part !== 'habits');
    return { parts: fullParts, info: { ...fullInfo, createdAt: habitsInfo.createdAt } };
  }

  window.PicSpeak.backup = {
    combineLatest,
    fileName,
    deviceLabel,
    BackupError,
    PARTS,
    MAX_TEMPLATES,
    cryptoAvailable,
    lastBackup,
    reminderDue,
    reminderState,
    snoozeReminder,
    setProfileName,
    create,
    save,
    open,
    read,
    restore,
  };
})();
