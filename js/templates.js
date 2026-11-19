/*
 * Schede pronte e modelli (vedi docs/FORMATO-DATI.md, «Modello»).
 *
 * - Schede pronte incluse nel tool (cartella templates/): insiemi di schede costruiti secondo le
 *   buone pratiche della CAA (vocabolario di base, colori per tipo di parola, posizioni fisse).
 * - I miei modelli: schede salvate sul dispositivo o importate da un file, da riusare per altri bambini.
 * - Esportazione e importazione in un file JSON (formato «picspeak», tipo «template», versione 1).
 *
 * Le immagini dei modelli sono riferimenti alle fonti (es. pittogramma ARASAAC n. 2462): usando il
 * modello si scaricano una sola volta sul dispositivo. Un file esportato contiene anche le immagini
 * (foto comprese), così funziona anche senza internet.
 *
 * Sicurezza: un file importato è un dato non affidabile. Viene validato campo per campo (formato,
 * versione, tipi, lunghezze, colori, firma reale delle immagini) prima di scrivere qualsiasi cosa;
 * nessun campo diventa HTML. Le immagini vengono ridisegnate su canvas (nessun SVG, nessun metadato).
 */
(function () {
  'use strict';

  const { storage, data, i18n, symbols, sampleData } = window.PicSpeak;

  const FORMAT = 'picspeak';
  const FORMAT_VERSION = 1;
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  const MAX_PAGES = 300;
  const MAX_CELLS = 400;
  const MAX_IMAGES = 3000;
  const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // immagine in base64 (le nostre sono ~10–40 KB)
  const MAX_COLS = 12;
  const MAX_ROWS = 200;
  const USER_TEMPLATES_KEY = 'userTemplates';
  const ARASAAC_STATIC = 'https://static.arasaac.org/pictograms';
  const SOURCES = ['arasaac', 'mulberry', 'openmoji', 'twemoji', 'photo', 'other'];
  const ID_PREFIX = { arasaac: 'img_ar_', mulberry: 'img_mb_', openmoji: 'img_om_', twemoji: 'img_tw_' };
  const KINDS = ['symbol', 'folder', 'empty'];
  const SAFE_KEY = /^[A-Za-z0-9_-]{1,80}$/;
  const SAFE_SOURCE_ID = /^[A-Za-z0-9_-]{1,80}$/;
  const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
  const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
  const MAX_USER_TEMPLATES = 20;

  // Chiave sicura per pagine e immagini (mai nomi che toccano il prototipo degli oggetti)
  function safeKey(key) {
    return typeof key === 'string' && SAFE_KEY.test(key) && !RESERVED_KEYS.includes(key);
  }

  // Pittogrammi ARASAAC già inclusi nel tool (funzionano subito, anche offline)
  const BUNDLED = new Set([...Object.values(sampleData.symbols), ...Object.values(sampleData.folders)]
    .map((item) => String(item.arasaac)).filter(Boolean));

  class TemplateError extends Error {}

  // ---------- Testi multilingua ----------

  // Un testo può essere una stringa o { it, en, … }: si sceglie la lingua attuale
  function localized(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      return value[i18n.language] || value.it || value.en || Object.values(value).find((v) => typeof v === 'string') || '';
    }
    return '';
  }

  // Testo pulito: niente caratteri di controllo, lunghezza massima
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
  }

  function cleanLocalized(value, max) {
    if (typeof value === 'string') return cleanText(value, max);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const out = {};
    Object.entries(value).slice(0, 10).forEach(([lang, text]) => {
      if (/^[a-z]{2}$/.test(lang) && typeof text === 'string') out[lang] = cleanText(text, max);
    });
    return Object.keys(out).length ? out : '';
  }

  // ---------- Validazione di un modello (file importato o scheda pronta) ----------

  function isInt(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
  }

  function validateImage(raw) {
    if (!raw || typeof raw !== 'object') throw new TemplateError('image');
    const source = SOURCES.includes(raw.source) ? raw.source : 'other';
    const image = { source };
    if (raw.sourceId !== undefined && raw.sourceId !== null) {
      const sourceId = String(raw.sourceId);
      if (!SAFE_SOURCE_ID.test(sourceId)) throw new TemplateError('image');
      if (source === 'arasaac' && !/^\d{1,7}$/.test(sourceId)) throw new TemplateError('image');
      image.sourceId = sourceId;
    }
    ['author', 'owner', 'license'].forEach((key) => {
      if (typeof raw[key] === 'string') image[key] = cleanText(raw[key], 160);
    });
    // Solo indirizzi https per la licenza (mostrati come testo o link nei crediti)
    if (typeof raw.licenseUrl === 'string' && /^https:\/\/[A-Za-z0-9.-]+\/[\w\-./#?=&%~]*$/.test(raw.licenseUrl)
      && raw.licenseUrl.length <= 200) {
      image.licenseUrl = raw.licenseUrl;
    }
    if (raw.keywords && typeof raw.keywords === 'object' && !Array.isArray(raw.keywords)) {
      image.keywords = {};
      Object.entries(raw.keywords).slice(0, 10).forEach(([lang, list]) => {
        if (/^[a-z]{2}$/.test(lang) && Array.isArray(list)) {
          image.keywords[lang] = list.filter((w) => typeof w === 'string').slice(0, 10).map((w) => cleanText(w, 60));
        }
      });
    }
    if (raw.data !== undefined) {
      if (typeof raw.data !== 'string' || raw.data.length > MAX_IMAGE_CHARS || !/^[A-Za-z0-9+/=]+$/.test(raw.data)) {
        throw new TemplateError('image');
      }
      if (!MIMES.includes(raw.mime)) throw new TemplateError('image');
      image.data = raw.data;
      image.mime = raw.mime;
    }
    // Riferimento a un'immagine già sul dispositivo: solo per i modelli salvati qui (mai da file)
    if (typeof raw.localId === 'string' && SAFE_KEY.test(raw.localId)) image.localId = raw.localId;
    return image;
  }

  /*
   * Controlla un modello e restituisce una copia pulita (solo i campi conosciuti).
   * fromFile = true per i file importati: i riferimenti a immagini locali vengono ignorati.
   */
  function validate(raw, { fromFile = false } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateError('format');
    if (raw.format !== FORMAT || raw.kind !== 'template') throw new TemplateError('format');
    if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1) throw new TemplateError('format');
    if (raw.formatVersion > FORMAT_VERSION) throw new TemplateError('version');
    if (!Array.isArray(raw.pages) || !raw.pages.length || raw.pages.length > MAX_PAGES) throw new TemplateError('pages');

    const images = Object.create(null);
    const rawImages = raw.images && typeof raw.images === 'object' && !Array.isArray(raw.images) ? raw.images : {};
    const imageKeys = Object.keys(rawImages);
    if (imageKeys.length > MAX_IMAGES) throw new TemplateError('images');
    imageKeys.forEach((key) => {
      if (!safeKey(key)) throw new TemplateError('images');
      const image = validateImage(rawImages[key]);
      if (fromFile) delete image.localId;
      images[key] = image;
    });

    const pageKeys = new Set();
    raw.pages.forEach((p) => {
      if (!p || typeof p !== 'object' || !safeKey(p.key) || pageKeys.has(p.key)) throw new TemplateError('pages');
      pageKeys.add(p.key);
    });

    const pages = raw.pages.map((p) => {
      const grid = p.grid && typeof p.grid === 'object' ? p.grid : {};
      const cols = isInt(grid.cols, 1, MAX_COLS) ? grid.cols : data.DEFAULT_COLS;
      const fixed = grid.fixed === true;
      if (!Array.isArray(p.cells) || p.cells.length > MAX_CELLS) throw new TemplateError('cells');
      const used = new Set();
      const cells = p.cells.map((c, index) => {
        if (!c || typeof c !== 'object') throw new TemplateError('cells');
        const kind = KINDS.includes(c.kind) ? c.kind : 'symbol';
        let row = isInt(c.row, 0, MAX_ROWS) ? c.row : Math.floor(index / cols);
        let col = isInt(c.col, 0, cols - 1) ? c.col : index % cols;
        // Due tessere nella stessa casella: la seconda va nella prima casella libera
        if (used.has(`${row}:${col}`)) {
          let i = 0;
          while (used.has(`${Math.floor(i / cols)}:${i % cols}`)) i += 1;
          row = Math.floor(i / cols);
          col = i % cols;
        }
        used.add(`${row}:${col}`);
        const cell = {
          row,
          col,
          kind,
          label: cleanLocalized(c.label, 40),
          speak: c.speak ? cleanLocalized(c.speak, 80) : null,
          wordType: kind === 'symbol' && data.WORD_TYPES.includes(c.wordType) ? c.wordType : (kind === 'symbol' ? 'noun' : null),
          color: typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.toLowerCase() : null,
          hidden: c.hidden === true,
          locked: c.locked === true,
          silent: kind === 'folder' && c.silent === true,
          image: null,
          target: null,
        };
        if (c.image !== null && c.image !== undefined) {
          const key = String(c.image);
          if (key in images) cell.image = key; // images non ha prototipo: solo chiavi proprie
        }
        if (kind === 'folder') {
          if (!pageKeys.has(c.target)) throw new TemplateError('cells');
          cell.target = c.target;
        }
        return cell;
      });
      const maxRow = cells.reduce((m, c) => Math.max(m, c.row), -1);
      return {
        key: p.key,
        title: cleanLocalized(p.title, 60),
        grid: { cols, rows: Math.max(1, maxRow + 1, isInt(grid.rows, 1, MAX_ROWS) ? grid.rows : 1), fixed },
        cells,
      };
    });

    // Si tengono solo le immagini usate da qualche tessera (niente immagini orfane nel dispositivo)
    const used = new Set();
    pages.forEach((p) => p.cells.forEach((c) => { if (c.image) used.add(c.image); }));
    Object.keys(images).forEach((key) => { if (!used.has(key)) delete images[key]; });

    const homePage = pageKeys.has(raw.homePage) ? raw.homePage : pages[0].key;
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      kind: 'template',
      id: SAFE_KEY.test(String(raw.id)) ? raw.id : null,
      name: cleanLocalized(raw.name, 80) || 'PicSpeak',
      description: cleanLocalized(raw.description, 300),
      basis: cleanLocalized(raw.basis, 400),
      createdAt: typeof raw.createdAt === 'string' ? cleanText(raw.createdAt, 40) : null,
      homePage,
      pages,
      images,
    };
  }

  function summary(template) {
    const cells = template.pages.reduce((n, p) => n + p.cells.length, 0);
    const home = template.pages.find((p) => p.key === template.homePage) || template.pages[0];
    return {
      pages: template.pages.length,
      cells,
      homeCells: home.cells.length,
      cols: home.grid.cols,
      rows: home.grid.rows,
      images: Object.keys(template.images).length,
    };
  }

  // ---------- Schede pronte incluse nel tool ----------

  let builtInIndex = null;

  async function builtIns() {
    if (builtInIndex) return builtInIndex;
    const response = await fetch('templates/index.json');
    if (!response.ok) throw new TemplateError('network');
    const index = await response.json();
    builtInIndex = (index && Array.isArray(index.templates) ? index.templates : [])
      .filter((item) => item && SAFE_KEY.test(String(item.id)) && /^templates\/[a-z0-9-]+\.json$/.test(item.file));
    return builtInIndex;
  }

  async function loadBuiltIn(id) {
    const item = (await builtIns()).find((entry) => entry.id === id);
    if (!item) throw new TemplateError('format');
    const response = await fetch(item.file);
    if (!response.ok) throw new TemplateError('network');
    return validate(await response.json());
  }

  // ---------- I miei modelli (salvati sul dispositivo) ----------

  async function userTemplates() {
    const list = await storage.get(USER_TEMPLATES_KEY);
    return Array.isArray(list) ? list : [];
  }

  async function saveUserTemplate(template) {
    const list = await userTemplates();
    if (list.length >= MAX_USER_TEMPLATES) throw new TemplateError('full');
    const entry = { id: data.newId('tpl'), savedAt: new Date().toISOString(), template };
    list.unshift(entry);
    await storage.set(USER_TEMPLATES_KEY, list);
    return entry;
  }

  async function deleteUserTemplate(id) {
    const list = (await userTemplates()).filter((entry) => entry.id !== id);
    await storage.set(USER_TEMPLATES_KEY, list);
  }

  async function loadUserTemplate(id) {
    const entry = (await userTemplates()).find((item) => item.id === id);
    if (!entry) throw new TemplateError('format');
    return validate(entry.template);
  }

  // ---------- Immagini ----------

  function base64ToBlob(text, mime) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function arasaacRecord(sourceId, entry) {
    return {
      id: ID_PREFIX.arasaac + sourceId,
      source: 'arasaac',
      sourceId,
      author: 'Sergio Palao',
      owner: 'Gobierno de Aragón',
      license: 'CC BY-NC-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      keywords: (entry && entry.keywords) || {},
    };
  }

  // Scarica un pittogramma ARASAAC e lo salva sul dispositivo (una sola volta)
  async function downloadArasaac(sourceId, entry) {
    const blob = await symbols.downloadImage(`${ARASAAC_STATIC}/${sourceId}/${sourceId}_300.png`);
    const record = { ...arasaacRecord(sourceId, entry), mime: blob.type, blob };
    await data.saveImage(record);
    return record.id;
  }

  /*
   * Rende disponibili sul dispositivo le immagini del modello.
   * Restituisce Map(chiave immagine → id immagine) e il numero di pittogrammi da scaricare più tardi.
   */
  async function resolveImages(template, { online, onProgress }) {
    const map = new Map();
    const toDownload = [];
    let missing = 0;
    for (const [key, entry] of Object.entries(template.images)) {
      // 1. Già sul dispositivo
      if (entry.localId && data.image(entry.localId)) { map.set(key, entry.localId); continue; }
      const stableId = entry.sourceId && ID_PREFIX[entry.source] ? ID_PREFIX[entry.source] + entry.sourceId : null;
      if (stableId && data.image(stableId)) { map.set(key, stableId); continue; }
      // 2. Immagine contenuta nel file: controllata e ridisegnata
      if (entry.data) {
        try {
          const raw = base64ToBlob(entry.data, entry.mime);
          await symbols.checkImage(raw);
          const blob = await symbols.resizeToBlob(raw);
          const fields = {
            source: entry.source,
            sourceId: entry.sourceId || null,
            author: entry.author || '',
            owner: entry.owner || '',
            license: entry.license || '',
            licenseUrl: entry.licenseUrl || '',
            mime: blob.type,
            blob,
            keywords: entry.keywords || {},
          };
          // Sempre un id nuovo: un'immagine contenuta in un file non deve mai prendere il posto
          // del pittogramma vero con lo stesso numero (che la ricerca riuserebbe in altre tessere)
          const saved = await data.addImage(fields);
          map.set(key, saved.id);
        } catch (error) {
          // Immagine non valida: la tessera resta con la sola parola
        }
        continue;
      }
      // 3. Pittogramma ARASAAC incluso nel tool
      if (entry.source === 'arasaac' && entry.sourceId) {
        if (BUNDLED.has(entry.sourceId)) {
          await data.saveImage({
            ...arasaacRecord(entry.sourceId, entry), mime: 'image/png', path: `symbols/arasaac/${entry.sourceId}.png`,
          });
          map.set(key, stableId);
          continue;
        }
        // 4. Da scaricare: la tessera tiene già l'id, l'immagine arriva appena scaricata
        map.set(key, stableId);
        toDownload.push([entry.sourceId, entry]);
      }
    }
    if (toDownload.length && online) {
      let done = 0;
      const queue = [...toDownload];
      const worker = async () => {
        while (queue.length) {
          const [sourceId, entry] = queue.shift();
          try {
            await downloadArasaac(sourceId, entry);
          } catch (error) {
            missing += 1;
          }
          done += 1;
          if (onProgress) onProgress(done, toDownload.length);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } else {
      missing = toDownload.length;
    }
    return { map, missing };
  }

  // Pittogrammi ARASAAC usati nelle schede ma non ancora sul dispositivo (es. modello usato offline)
  function missingImages() {
    const ids = new Set();
    data.profilePages().forEach((p) => p.cells.forEach((c) => {
      if (c.imageId && c.imageId.startsWith(ID_PREFIX.arasaac) && !data.image(c.imageId)) ids.add(c.imageId);
    }));
    return [...ids];
  }

  async function downloadMissing(onProgress) {
    const ids = missingImages();
    let done = 0;
    let failed = 0;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const sourceId = queue.shift().slice(ID_PREFIX.arasaac.length);
        if (!/^\d{1,7}$/.test(sourceId)) { failed += 1; continue; }
        try {
          if (BUNDLED.has(sourceId)) {
            await data.saveImage({ ...arasaacRecord(sourceId), mime: 'image/png', path: `symbols/arasaac/${sourceId}.png` });
          } else {
            await downloadArasaac(sourceId);
          }
        } catch (error) {
          failed += 1;
        }
        done += 1;
        if (onProgress) onProgress(done, ids.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return { total: ids.length, failed };
  }

  // ---------- Usare un modello ----------

  /*
   * mode: 'replace' = diventano le schede del bambino (le precedenti restano recuperabili);
   *       'add' = si aggiungono come cartella nella Home attuale.
   */
  async function apply(template, { mode, online, onProgress }) {
    const { map, missing } = await resolveImages(template, { online, onProgress });
    const pageIds = new Map(template.pages.map((p) => [p.key, data.newId('pg')]));
    const name = localized(template.name);
    const pages = template.pages.map((p) => ({
      id: pageIds.get(p.key),
      profileId: data.profile.id,
      title: (mode === 'add' && p.key === template.homePage ? name : localized(p.title)) || name,
      grid: { ...p.grid },
      contextIds: [],
      cells: p.cells.map((c) => ({
        id: data.newId('c'),
        row: c.row,
        col: c.col,
        kind: c.kind,
        label: localized(c.label),
        speak: c.speak ? localized(c.speak) || null : null,
        imageId: c.image ? map.get(c.image) || null : null,
        wordType: c.wordType,
        color: c.color,
        targetPageId: c.target ? pageIds.get(c.target) : null,
        hidden: c.hidden,
        locked: c.locked,
        silent: c.silent === true,
        audioId: null,
      })),
      updatedAt: new Date().toISOString(),
    }));
    const homeId = pageIds.get(template.homePage);
    if (mode === 'replace') {
      await data.snapshotPages();
      await data.replacePages(pages, homeId);
    } else {
      await data.addPages(pages);
      const homeTemplate = template.pages.find((p) => p.key === template.homePage);
      const firstImage = homeTemplate && homeTemplate.cells.find((c) => c.image && map.get(c.image));
      await data.addCell(data.homePageId, {
        kind: 'folder', label: name.slice(0, 40), wordType: null, targetPageId: homeId,
        imageId: firstImage ? map.get(firstImage.image) : null,
        // Il nome della scheda pronta (es. «Parole di base · 60 tessere…») non si legge: si cambia nella cartella
        silent: true,
      });
    }
    return { missing, homeId };
  }

  // ---------- Esportare ----------

  /*
   * Modello dalle schede attuali. embed = true: le immagini sono dentro il file (per esportare);
   * false: riferimenti alle immagini già sul dispositivo (per «I miei modelli»).
   */
  async function fromCurrentPages(name, { embed }) {
    const pages = data.profilePages();
    const images = {};
    const imageKeys = new Map();
    for (const p of pages) {
      for (const c of p.cells) {
        if (c.imageId && !imageKeys.has(c.imageId)) {
          const image = data.image(c.imageId);
          const key = `i${imageKeys.size + 1}`;
          if (image) {
            const entry = {
              source: SOURCES.includes(image.source) ? image.source : 'other',
              author: image.author || '',
              owner: image.owner || '',
              license: image.license || '',
              licenseUrl: image.licenseUrl || '',
              keywords: image.keywords || {},
            };
            if (image.sourceId) entry.sourceId = String(image.sourceId);
            if (embed && image.blob) {
              entry.mime = MIMES.includes(image.blob.type) ? image.blob.type : 'image/png';
              entry.data = await blobToBase64(image.blob);
            } else if (!embed) {
              entry.localId = image.id;
            }
            images[key] = entry;
            imageKeys.set(c.imageId, key);
          } else if (c.imageId.startsWith(ID_PREFIX.arasaac)) {
            // Pittogramma non ancora scaricato: resta il riferimento
            const { id, ...reference } = arasaacRecord(c.imageId.slice(ID_PREFIX.arasaac.length));
            images[key] = reference;
            imageKeys.set(c.imageId, key);
          }
        }
      }
    }
    const pageKey = (id) => id.replace(/[^A-Za-z0-9_-]/g, '_');
    return validate({
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      kind: 'template',
      app: 'PicSpeak',
      createdAt: new Date().toISOString(),
      name,
      homePage: pageKey(data.homePageId),
      pages: pages.map((p) => ({
        key: pageKey(p.id),
        title: p.title,
        grid: { cols: p.grid.cols, rows: p.grid.rows, fixed: data.isFixed(p) },
        cells: data.orderedCells(p, { includeHidden: true }).map((c) => ({
          row: c.row,
          col: c.col,
          kind: c.kind,
          label: c.label,
          speak: c.speak,
          wordType: c.wordType,
          color: c.color,
          hidden: c.hidden,
          locked: c.locked,
          silent: c.silent === true ? true : undefined,
          image: c.imageId ? imageKeys.get(c.imageId) || null : null,
          target: c.targetPageId ? pageKey(c.targetPageId) : undefined,
        })).map((c) => (c.kind === 'folder' && !pages.some((p2) => pageKey(p2.id) === c.target)
          ? { ...c, kind: 'symbol', target: undefined } : c)),
      })),
      images,
    });
  }

  // Prepara un modello salvato sul dispositivo per l'esportazione: inserisce le immagini nel file
  async function embedImages(template) {
    const copy = JSON.parse(JSON.stringify(template));
    for (const entry of Object.values(copy.images)) {
      if (entry.localId) {
        const image = data.image(entry.localId);
        if (image && image.blob) {
          entry.mime = MIMES.includes(image.blob.type) ? image.blob.type : 'image/png';
          entry.data = await blobToBase64(image.blob);
        }
        delete entry.localId;
      }
    }
    copy.app = 'PicSpeak';
    return copy;
  }

  function fileName(name) {
    const slug = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'schede';
    const date = new Date().toISOString().slice(0, 10);
    return `picspeak-modello-${slug}-${date}.json`;
  }

  // Salva il file sul dispositivo (cartella Download o pannello di condivisione)
  function download(template) {
    const blob = new Blob([JSON.stringify(template)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(localized(template.name));
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------- Importare ----------

  async function readFile(file) {
    if (!file) throw new TemplateError('format');
    if (file.size > MAX_FILE_BYTES) throw new TemplateError('size');
    const text = await file.text();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new TemplateError('format');
    }
    return validate(raw, { fromFile: true });
  }

  window.PicSpeak.templates = {
    TemplateError,
    localized,
    validate,
    summary,
    builtIns,
    loadBuiltIn,
    userTemplates,
    saveUserTemplate,
    deleteUserTemplate,
    loadUserTemplate,
    apply,
    missingImages,
    downloadMissing,
    fromCurrentPages,
    embedImages,
    download,
    readFile,
  };
})();
