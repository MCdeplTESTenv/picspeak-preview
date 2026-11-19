/*
 * Open Board Format (OBF): scambio di schede con altre app di CAA.
 *
 * - .obf: un file JSON con una scheda (griglia di pulsanti, immagini, collegamenti).
 * - .obz: un archivio zip con più schede collegate, le immagini e manifest.json.
 * Campi verificati sul codice di riferimento di OpenAAC (libreria «obf», licenza MIT: validatore e
 * conversioni). Formato scritto: "open-board-0.1".
 *
 * Importazione: il file diventa un modello PicSpeak (vedi templates.js) e passa dalla stessa validazione
 * dei modelli; poi si salva tra «I miei modelli» o si usa subito. Le informazioni che OBF non ha
 * (tipo di parola, tessere bloccate, griglia fissa) viaggiano in campi «ext_picspeak_…», ammessi dal formato.
 *
 * Sicurezza: limiti di dimensione e numero, nomi dei file dello zip controllati, immagini solo PNG/JPEG/WebP
 * (firma reale) ridisegnate su canvas; un SVG viene solo disegnato come immagine (nessuno script) e
 * convertito in PNG, mai salvato così com'è. Le immagini indicate con un indirizzo esterno non si
 * scaricano (tranne i pittogrammi ARASAAC, con le regole della ricerca online). Nessun testo diventa HTML.
 */
(function () {
  'use strict';

  const { data, i18n, symbols, templates, zip, lexicon } = window.PicSpeak;

  const OBF_FORMAT = 'open-board-0.1';
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  const MAX_BOARDS = 300;
  const MAX_BOARD_BYTES = 5 * 1024 * 1024;
  const MAX_BUTTONS = 400;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_SVG_BYTES = 1024 * 1024;
  const MAX_IMAGES = 3000; // come i modelli JSON
  const MAX_TOTAL_IMAGE_CHARS = 40 * 1024 * 1024; // immagini del modello prodotto (base64), come il limite dei file
  const SVG_TIMEOUT_MS = 10000;
  const MAX_GRID = 60; // righe o colonne dichiarate
  const MAX_COLS = 12; // colonne di PicSpeak
  const SOURCES = ['arasaac', 'mulberry', 'openmoji', 'twemoji', 'photo', 'other'];
  const ARASAAC_URL = /^https:\/\/(?:static|api)\.arasaac\.org\/(?:api\/)?pictograms\/(\d{1,7})(?:[/?_.]|$)/;
  // Comandi della striscia frase che PicSpeak ha già nei suoi pulsanti: le tessere che fanno solo questo
  // non si importano (resterebbe una tessera che pronuncia «cancella» invece di cancellare)
  const CONTROL_ACTIONS = [':clear', ':backspace', ':home', ':speak', ':back', ':space', ':hide',
    ':suggestions', ':shift', ':alert', ':sticky'];

  // Colori automatici per tipo di parola (gli stessi della modalità «colore pieno»)
  const TYPE_COLORS = {
    pronoun: ['#e0ac00', '#fff3c4'],
    verb: ['#2e9a47', '#daf2df'],
    noun: ['#e57a12', '#ffe4cc'],
    adjective: ['#2a6fd6', '#dbe8fc'],
    social: ['#d0468f', '#fbdcec'],
    negation: ['#cf3439', '#fbd9da'],
    question: ['#7a4fc9', '#ece3fa'],
    connector: ['#8a8f98', '#f6f7f9'],
    folder: ['#3b4252', '#e7e9ef'],
  };

  class ObfError extends templates.TemplateError {}

  // ---------- Utilità ----------

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // Codice lingua a due lettere ("it-IT", "en_US" → "it", "en")
  function shortLang(locale) {
    const m = /^([a-z]{2})(?:[-_].*)?$/i.exec(String(locale || ''));
    return m ? m[1].toLowerCase() : null;
  }

  // Testo semplice da description_html: si tolgono i tag, il risultato si mostra solo come testo
  function plainText(html, max) {
    if (typeof html !== 'string') return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // "rgb(255, 200, 0)" o "rgba(…)" → "#ffc800" (null se il formato non è valido)
  function rgbToHex(value) {
    const m = /^\s*rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)\s*$/.exec(String(value || ''));
    if (!m) return null;
    const parts = m.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255)) return null;
    return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }

  // Un colore «vero» (non bianco, non grigio): vale la pena tenerlo come colore della tessera
  function isColorful(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max - min > 40 && max > 60;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ObfError('obfFormat');
    }
  }

  // ---------- Immagini importate ----------

  // È un SVG? (dichiarato o riconosciuto dal contenuto)
  function looksLikeSvg(bytes, contentType) {
    if (/svg/i.test(contentType || '')) return true;
    const head = new TextDecoder().decode(bytes.subarray(0, 300)).trimStart().toLowerCase();
    return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
  }

  /*
   * SVG → PNG: l'SVG viene caricato come immagine (in questo modo il browser non esegue script né carica
   * risorse esterne) e disegnato su un canvas di 256 px. Il file SVG non viene mai salvato.
   */
  function rasterizeSvg(bytes) {
    return new Promise((resolve, reject) => {
      if (bytes.length > MAX_SVG_BYTES) { reject(new Error('too-big')); return; }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
      const img = new Image();
      let timer = null;
      const done = () => { clearTimeout(timer); URL.revokeObjectURL(url); };
      img.onload = () => {
        try {
          const w = img.naturalWidth || 256;
          const h = img.naturalHeight || 256;
          const scale = 256 / Math.max(w, h);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => { done(); if (blob) resolve(blob); else reject(new Error('svg')); }, 'image/png');
        } catch (error) {
          done();
          reject(error);
        }
      };
      img.onerror = () => { done(); reject(new Error('svg')); };
      // Un SVG molto pesante da disegnare non deve bloccare l'importazione
      // (allo scadere si interrompe anche il caricamento, così il browser smette di lavorarci)
      timer = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        img.removeAttribute('src');
        done();
        reject(new Error('svg-timeout'));
      }, SVG_TIMEOUT_MS);
      img.src = url;
    });
  }

  // Byte di un'immagine (PNG, JPEG, WebP o SVG) → { data: base64, mime } già controllata e ridotta
  async function prepareImage(bytes, contentType) {
    if (!bytes || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('too-big');
    let blob;
    if (looksLikeSvg(bytes, contentType)) {
      blob = await rasterizeSvg(bytes);
    } else {
      const raw = new Blob([bytes]);
      await symbols.checkImage(raw);
      blob = await symbols.resizeToBlob(raw);
    }
    await symbols.checkImage(blob);
    const out = new Uint8Array(await blob.arrayBuffer());
    return { data: bytesToBase64(out), mime: blob.type };
  }

  // Licenza OBF → campi delle immagini di PicSpeak (fonte, autore, licenza, indirizzo della licenza)
  function licenseFields(image) {
    const lic = isObject(image.license) ? image.license : null;
    const fields = {};
    const ext = typeof image.ext_picspeak_source === 'string' && SOURCES.includes(image.ext_picspeak_source)
      ? image.ext_picspeak_source : null;
    const text = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
    if (lic) {
      if (text(lic.author_name)) fields.author = text(lic.author_name);
      if (text(lic.type) && lic.type !== 'private') fields.license = text(lic.type);
      const url = [lic.copyright_notice_url, lic.copyright_notice_link].find((u) => typeof u === 'string' && /^https?:\/\//.test(u));
      if (url) fields.licenseUrl = url.replace(/^http:\/\//, 'https://');
    }
    if (typeof image.ext_picspeak_owner === 'string') fields.owner = text(image.ext_picspeak_owner);
    const hint = `${lic ? `${text(lic.source_url)} ${text(lic.author_name)} ${text(lic.author_url)}` : ''}`.toLowerCase();
    if (ext) fields.source = ext;
    else if (hint.includes('arasaac') || hint.includes('sergio palao')) fields.source = 'arasaac';
    else if (hint.includes('mulberry')) fields.source = 'mulberry';
    else if (hint.includes('openmoji')) fields.source = 'openmoji';
    else if (hint.includes('jdecked/twemoji')) fields.source = 'twemoji';
    else fields.source = 'other'; // senza licenza: fonte esterna sconosciuta (l'adulto riceve un avviso)
    if (fields.source === 'arasaac') {
      fields.author = fields.author || 'Sergio Palao';
      fields.owner = fields.owner || 'Gobierno de Aragón';
      fields.license = fields.license || 'CC BY-NC-SA 4.0';
      fields.licenseUrl = fields.licenseUrl || 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
    }
    return fields;
  }

  // ---------- Importazione ----------

  /*
   * Legge un file .obf o .obz e lo trasforma in un modello PicSpeak (già validato).
   * Restituisce { template, report } dove report conta ciò che non si è potuto importare.
   */
  async function readFile(file) {
    if (!file) throw new ObfError('obfFormat');
    if (file.size > MAX_FILE_BYTES) throw new ObfError('size');
    const report = { boards: 0, skippedActions: 0, externalImages: 0, badImages: 0, brokenLinks: 0, noLicense: 0, reflowed: 0 };
    let boards; // [{ board, path }]
    let archive = null;
    let rootIndex = 0;

    if (await zip.isZip(file)) {
      try {
        archive = await zip.open(file, { maxEntryBytes: MAX_BOARD_BYTES, maxTotalBytes: 60 * 1024 * 1024 });
      } catch (error) {
        throw new ObfError('obfZip');
      }
      let manifest = null;
      if (archive.has('manifest.json')) manifest = parseJson(await readText(archive, 'manifest.json'));
      let paths = [];
      if (isObject(manifest) && isObject(manifest.paths) && isObject(manifest.paths.boards)) {
        paths = Object.values(manifest.paths.boards).filter((p) => typeof p === 'string').map(zip.normalizePath);
      }
      if (!paths.length) paths = archive.names.filter((name) => /\.obf$/i.test(name));
      paths = [...new Set(paths)].filter((p) => archive.has(p));
      if (!paths.length) throw new ObfError('obfFormat');
      if (paths.length > MAX_BOARDS) throw new ObfError('pages');
      boards = [];
      for (const path of paths) {
        boards.push({ board: parseJson(await readText(archive, path)), path });
      }
      const root = isObject(manifest) && typeof manifest.root === 'string' ? zip.normalizePath(manifest.root) : null;
      rootIndex = Math.max(0, boards.findIndex((b) => b.path === root));
    } else {
      if (file.size > MAX_BOARD_BYTES * 4) throw new ObfError('size');
      boards = [{ board: parseJson(await file.text()), path: null }];
    }
    boards.forEach(({ board }) => {
      if (!isObject(board) || !Array.isArray(board.buttons)) throw new ObfError('obfFormat');
      if (typeof board.format === 'string' && !/^open-board-/.test(board.format)) throw new ObfError('obfFormat');
    });
    report.boards = boards.length;

    // Chiavi sicure per le schede (gli id OBF possono contenere qualsiasi carattere)
    const keyById = new Map();
    const keyByPath = new Map();
    boards.forEach(({ board, path }, index) => {
      const key = `b${index + 1}`;
      if (board.id !== undefined && board.id !== null && !keyById.has(String(board.id))) keyById.set(String(board.id), key);
      if (path) keyByPath.set(path, key);
    });

    const images = {};
    const imageJobs = []; // immagini da leggere dopo aver costruito le tessere
    const imageKeyBySource = new Map();

    const pages = boards.map(({ board }, index) => {
      const key = `b${index + 1}`;
      const lang = shortLang(board.locale) || i18n.language;
      const boardImages = new Map((Array.isArray(board.images) ? board.images : [])
        .filter(isObject).map((img) => [String(img.id), img]));
      const buttons = new Map(board.buttons.filter(isObject).map((b) => [String(b.id), b]));

      // Disposizione: grid.order è una matrice di id (null = casella vuota)
      const grid = isObject(board.grid) ? board.grid : {};
      let cols = Number.isInteger(grid.columns) && grid.columns > 0 ? Math.min(grid.columns, MAX_GRID) : 4;
      let order = Array.isArray(grid.order) ? grid.order.slice(0, MAX_GRID) : null;
      const placed = [];
      if (order) {
        order.forEach((row, r) => {
          if (!Array.isArray(row)) return;
          row.slice(0, MAX_GRID).forEach((id, c) => {
            if (id === null || id === undefined) return;
            const button = buttons.get(String(id));
            if (button) placed.push({ button, row: r, col: c });
          });
        });
      } else {
        board.buttons.filter(isObject).forEach((button, i) => placed.push({ button, row: Math.floor(i / cols), col: i % cols }));
      }
      let fixed = board.ext_picspeak_fixed !== false;
      if (cols > MAX_COLS) {
        // Troppe colonne per PicSpeak: si tiene l'ordine di lettura su 12 colonne, disposizione automatica
        placed.sort((a, b) => (a.row - b.row) || (a.col - b.col));
        placed.forEach((p, i) => { p.row = Math.floor(i / MAX_COLS); p.col = i % MAX_COLS; });
        cols = MAX_COLS;
        fixed = false;
        report.reflowed += 1;
      }
      if (placed.length > MAX_BUTTONS) throw new ObfError('cells');

      const cells = [];
      placed.forEach(({ button, row, col }) => {
        const actions = [button.action, ...(Array.isArray(button.actions) ? button.actions : [])]
          .filter((a) => typeof a === 'string');
        const isControl = actions.some((a) => CONTROL_ACTIONS.includes(a) || /^:ext_/.test(a));
        if (isControl && !button.load_board && !button.vocalization) {
          report.skippedActions += 1;
          return;
        }
        // Etichetta nella lingua della scheda, più le traduzioni presenti nel file
        const label = {};
        const speak = {};
        if (typeof button.label === 'string') label[lang] = button.label;
        if (typeof button.vocalization === 'string' && button.vocalization !== button.label) speak[lang] = button.vocalization;
        if (isObject(button.translations)) {
          Object.entries(button.translations).slice(0, 10).forEach(([loc, tr]) => {
            const l = shortLang(loc);
            if (!l || !isObject(tr)) return;
            if (typeof tr.label === 'string' && !label[l]) label[l] = tr.label;
            if (typeof tr.vocalization === 'string' && tr.vocalization !== tr.label && !speak[l]) speak[l] = tr.vocalization;
          });
        }
        // Collegamento a un'altra scheda del pacchetto
        let target = null;
        if (isObject(button.load_board)) {
          const lb = button.load_board;
          if (lb.path && keyByPath.has(zip.normalizePath(lb.path))) target = keyByPath.get(zip.normalizePath(lb.path));
          else if (lb.id !== undefined && keyById.has(String(lb.id))) target = keyById.get(String(lb.id));
          if (!target) report.brokenLinks += 1;
        }
        const kind = target ? 'folder' : 'symbol';
        const mainLabel = label[lang] || Object.values(label)[0] || '';
        let wordType = null;
        if (kind === 'symbol') {
          wordType = data.WORD_TYPES.includes(button.ext_picspeak_word_type) ? button.ext_picspeak_word_type
            : (lexicon.guess(label.it || mainLabel) || 'noun');
        }
        let color = null;
        if (typeof button.ext_picspeak_color === 'string' && /^#[0-9a-f]{6}$/i.test(button.ext_picspeak_color)) {
          color = button.ext_picspeak_color.toLowerCase();
        } else if (!button.ext_picspeak_word_type && kind === 'symbol') {
          // Colore scelto da chi ha creato la scheda nell'altra app: si conserva se è un colore vero
          const bg = rgbToHex(button.background_color);
          const border = rgbToHex(button.border_color);
          if (bg && isColorful(bg)) color = bg;
          else if (border && isColorful(border)) color = border;
        }
        // Immagine: si registra ora, si legge dopo
        let image = null;
        if (button.image_id !== undefined && button.image_id !== null && boardImages.has(String(button.image_id))) {
          const img = boardImages.get(String(button.image_id));
          const sourceKey = typeof img.path === 'string' && archive ? `path:${zip.normalizePath(img.path)}`
            : `board:${index}:${String(img.id)}`;
          if (!imageKeyBySource.has(sourceKey)) {
            // Il limite si controlla subito, prima di leggere e ridisegnare le immagini
            if (imageKeyBySource.size >= MAX_IMAGES) throw new ObfError('images');
            const imageKey = `i${imageKeyBySource.size + 1}`;
            imageKeyBySource.set(sourceKey, imageKey);
            imageJobs.push({ key: imageKey, img });
          }
          image = imageKeyBySource.get(sourceKey);
        }
        cells.push({
          row,
          col,
          kind,
          label,
          speak: Object.keys(speak).length ? speak : null,
          wordType,
          color,
          hidden: button.hidden === true,
          locked: button.ext_picspeak_locked === true,
          silent: kind === 'folder' && button.ext_picspeak_silent === true,
          image,
          target: target || undefined,
        });
      });
      const maxRow = cells.reduce((m, c) => Math.max(m, c.row), -1);
      const rows = Number.isInteger(grid.rows) && grid.rows > 0 && cols === grid.columns ? Math.min(grid.rows, MAX_GRID) : maxRow + 1;
      const title = {};
      if (typeof board.name === 'string') title[lang] = board.name;
      if (isObject(board.ext_picspeak_title)) {
        Object.entries(board.ext_picspeak_title).forEach(([l, v]) => { if (/^[a-z]{2}$/.test(l) && typeof v === 'string') title[l] = v; });
      }
      return { key, title, grid: { cols, rows: Math.max(1, rows), fixed }, cells };
    });

    // Lettura delle immagini (una alla volta: poca memoria anche con pacchetti grandi)
    let totalChars = 0;
    for (const { key, img } of imageJobs) {
      const arasaacUrl = typeof img.url === 'string' && ARASAAC_URL.test(img.url);
      // Un pittogramma indicato con l'indirizzo di ARASAAC ha la licenza di ARASAAC anche se il file non la scrive
      const fields = licenseFields(arasaacUrl && !img.ext_picspeak_source ? { ...img, ext_picspeak_source: 'arasaac' } : img);
      if (!isObject(img.license) && !arasaacUrl && !img.ext_picspeak_source) report.noLicense += 1;
      const sourceId = typeof img.ext_picspeak_source_id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(img.ext_picspeak_source_id)
        ? img.ext_picspeak_source_id : null;
      let bytes = null;
      let contentType = typeof img.content_type === 'string' ? img.content_type : '';
      try {
        if (typeof img.data === 'string') {
          const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(img.data.slice(0, MAX_IMAGE_BYTES * 1.4));
          if (m) { contentType = m[1]; bytes = base64ToBytes(m[2].replace(/\s/g, '')); }
        }
        if (!bytes && typeof img.path === 'string' && archive && archive.has(img.path)) {
          bytes = await archive.read(img.path);
        }
      } catch (error) {
        bytes = null;
      }
      const arasaacId = typeof img.url === 'string' ? (ARASAAC_URL.exec(img.url) || [])[1] : null;
      if (bytes) {
        try {
          const prepared = await prepareImage(bytes, contentType);
          totalChars += prepared.data.length;
          if (totalChars > MAX_TOTAL_IMAGE_CHARS) throw new ObfError('size');
          images[key] = { ...fields, ...prepared };
          if (fields.source === 'arasaac' && (sourceId || arasaacId) && /^\d{1,7}$/.test(sourceId || arasaacId)) {
            images[key].sourceId = sourceId || arasaacId;
          } else if (sourceId && fields.source !== 'arasaac') {
            images[key].sourceId = sourceId;
          }
          continue;
        } catch (error) {
          if (error instanceof ObfError) throw error;
          report.badImages += 1;
        }
      }
      if (arasaacId || (fields.source === 'arasaac' && sourceId && /^\d{1,7}$/.test(sourceId))) {
        // Pittogramma ARASAAC indicato solo con l'indirizzo: si scarica con le regole della ricerca online
        images[key] = { ...fields, source: 'arasaac', sourceId: arasaacId || sourceId };
      } else if (!bytes) {
        report.externalImages += 1;
      }
    }

    // Le tessere con immagini non disponibili restano con la sola parola
    pages.forEach((p) => p.cells.forEach((c) => { if (c.image && !images[c.image]) c.image = null; }));

    const root = boards[rootIndex].board;
    const name = typeof root.name === 'string' && root.name.trim() ? root.name
      : (file.name || 'OBF').replace(/\.(obf|obz)$/i, '');
    const raw = {
      format: 'picspeak',
      formatVersion: 1,
      kind: 'template',
      name,
      description: plainText(root.description_html, 300),
      homePage: pages[rootIndex].key,
      pages,
      images,
    };
    let template;
    try {
      template = templates.validate(raw, { fromFile: true });
    } catch (error) {
      if (error instanceof templates.TemplateError) throw error;
      throw new ObfError('obfFormat');
    }
    return { template, report };
  }

  async function readText(archive, path) {
    try {
      const bytes = await archive.read(path);
      if (bytes.length > MAX_BOARD_BYTES) throw new ObfError('size');
      return new TextDecoder('utf-8').decode(bytes);
    } catch (error) {
      if (error instanceof ObfError) throw error;
      throw new ObfError('obfZip');
    }
  }

  // ---------- Esportazione ----------

  const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

  // Byte e misure di un'immagine del dispositivo (blob salvato o file incluso nel tool)
  async function imageBytes(image) {
    let blob = image.blob || null;
    if (!blob && image.path && /^symbols\/[\w/-]+\.(png|jpe?g|webp)$/.test(image.path)) {
      const response = await fetch(image.path);
      if (response.ok) blob = await response.blob();
    }
    if (!blob) return null;
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    let mime = null;
    if (head[0] === 0x89 && head[1] === 0x50) mime = 'image/png';
    else if (head[0] === 0xff && head[1] === 0xd8) mime = 'image/jpeg';
    else if (head[0] === 0x52 && head[8] === 0x57) mime = 'image/webp';
    if (!mime) return null;
    const size = await symbols.headerSize(blob, EXT_BY_MIME[mime] === 'jpg' ? 'jpeg' : EXT_BY_MIME[mime]);
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mime,
      width: size ? size.width : 256,
      height: size ? size.height : 256,
    };
  }

  // Licenza di un'immagine nel formato OBF, più i campi di PicSpeak in ext_
  function obfLicense(image) {
    const license = { type: image.license || 'private' };
    if (image.licenseUrl) license.copyright_notice_url = image.licenseUrl;
    if (image.author) license.author_name = image.author;
    if (image.source === 'arasaac') {
      license.author_url = 'https://arasaac.org';
      license.source_url = image.sourceId ? `https://arasaac.org/pictograms/es/${image.sourceId}` : 'https://arasaac.org';
    } else if (image.source === 'mulberry') {
      license.source_url = 'https://mulberrysymbols.org';
    } else if (image.source === 'openmoji') {
      license.source_url = 'https://openmoji.org';
    } else if (image.source === 'twemoji') {
      license.source_url = 'https://github.com/jdecked/twemoji';
    }
    return license;
  }

  function cellColors(cell) {
    if (cell.color && /^#[0-9a-f]{6}$/i.test(cell.color)) {
      return { background: hexToRgb(mixWithWhite(cell.color, 0.25)), border: hexToRgb(cell.color) };
    }
    const [line, fill] = TYPE_COLORS[cell.kind === 'folder' ? 'folder' : (cell.wordType || 'noun')] || TYPE_COLORS.noun;
    return { background: hexToRgb(fill), border: hexToRgb(line) };
  }

  function mixWithWhite(hex, amount) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (v) => Math.round(v * amount + 255 * (1 - amount));
    return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => mix(v).toString(16).padStart(2, '0')).join('')}`;
  }

  /*
   * Schede del dispositivo → schede OBF.
   * pages: le schede da esportare; embedData = true scrive le immagini dentro la scheda (file .obf singolo),
   * altrimenti in images/ dello zip. Restituisce { boards, imageFiles, rootId }.
   */
  async function buildBoards(pages, { embedData, onProgress }) {
    const lang = i18n.language;
    const boardId = new Map(pages.map((p, i) => [p.id, `picspeak_${i + 1}`]));
    const imageEntries = new Map(); // imageId → { obf, file }
    const imageFiles = [];
    let done = 0;
    const total = new Set(pages.flatMap((p) => p.cells.map((c) => c.imageId).filter(Boolean))).size;

    async function imageFor(imageId) {
      if (imageEntries.has(imageId)) return imageEntries.get(imageId);
      const image = data.image(imageId);
      let entry = null;
      const id = `img_${imageEntries.size + 1}`;
      if (image) {
        const info = await imageBytes(image).catch(() => null);
        if (info) {
          const obfImage = { id, width: info.width, height: info.height, content_type: info.mime, license: obfLicense(image) };
          if (embedData) {
            obfImage.data = `data:${info.mime};base64,${bytesToBase64(info.bytes)}`;
          } else {
            obfImage.path = `images/${id}.${EXT_BY_MIME[info.mime]}`;
            imageFiles.push({ name: obfImage.path, data: info.bytes });
          }
          obfImage.ext_picspeak_source = SOURCES.includes(image.source) ? image.source : 'other';
          if (image.sourceId) obfImage.ext_picspeak_source_id = String(image.sourceId);
          if (image.owner) obfImage.ext_picspeak_owner = image.owner;
          entry = obfImage;
        }
      }
      if (!entry && imageId.startsWith('img_ar_')) {
        // Pittogramma ARASAAC non ancora scaricato su questo dispositivo: resta l'indirizzo ufficiale
        const sourceId = imageId.slice('img_ar_'.length);
        if (/^\d{1,7}$/.test(sourceId)) {
          entry = {
            id,
            width: 300,
            height: 300,
            content_type: 'image/png',
            url: `https://static.arasaac.org/pictograms/${sourceId}/${sourceId}_300.png`,
            license: obfLicense({ source: 'arasaac', sourceId, author: 'Sergio Palao', license: 'CC BY-NC-SA 4.0',
              licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' }),
            ext_picspeak_source: 'arasaac',
            ext_picspeak_source_id: sourceId,
            ext_picspeak_owner: 'Gobierno de Aragón',
          };
        }
      }
      imageEntries.set(imageId, entry);
      done += 1;
      if (onProgress) onProgress(done, total);
      return entry;
    }

    const boards = [];
    for (const p of pages) {
      const cells = data.orderedCells(p, { includeHidden: true });
      const cols = Math.max(1, p.grid.cols || data.DEFAULT_COLS);
      const rows = Math.max(1, p.grid.rows || 1, ...cells.map((c) => c.row + 1));
      const order = Array.from({ length: rows }, () => Array(cols).fill(null));
      const buttons = [];
      const usedImages = [];
      for (const cell of cells) {
        if (cell.kind === 'empty' || cell.col >= cols) continue;
        const id = String(buttons.length + 1);
        const colors = cellColors(cell);
        const button = {
          id,
          label: cell.label || '',
          background_color: colors.background,
          border_color: colors.border,
        };
        if (cell.speak && cell.speak !== cell.label) button.vocalization = cell.speak;
        if (cell.hidden) button.hidden = true;
        if (cell.imageId) {
          const image = await imageFor(cell.imageId);
          if (image) {
            button.image_id = image.id;
            if (!usedImages.includes(image)) usedImages.push(image);
          }
        }
        if (cell.kind === 'folder' && boardId.has(cell.targetPageId)) {
          const target = boardId.get(cell.targetPageId);
          button.load_board = embedData ? { id: target } : { id: target, path: `boards/${target}.obf` };
        }
        if (cell.kind === 'symbol' && cell.wordType) button.ext_picspeak_word_type = cell.wordType;
        if (cell.color) button.ext_picspeak_color = cell.color;
        if (cell.locked) button.ext_picspeak_locked = true;
        if (cell.kind === 'folder' && cell.silent) button.ext_picspeak_silent = true;
        order[cell.row][cell.col] = id;
        buttons.push(button);
      }
      boards.push({
        format: OBF_FORMAT,
        id: boardId.get(p.id),
        locale: lang,
        name: p.title || '',
        description_html: '',
        grid: { rows, columns: cols, order },
        buttons,
        images: usedImages,
        sounds: [],
        ext_picspeak_fixed: data.isFixed(p),
      });
    }
    return { boards, imageFiles, rootId: boardId.get(data.homePageId) || boards[0].id };
  }

  // Tutte le schede del bambino in un pacchetto .obz
  async function exportObz(name, { onProgress } = {}) {
    const pages = data.profilePages();
    if (!pages.length) throw new ObfError('pages');
    const { boards, imageFiles, rootId } = await buildBoards(pages, { embedData: false, onProgress });
    const manifest = {
      format: OBF_FORMAT,
      root: `boards/${rootId}.obf`,
      paths: { boards: {}, images: {}, sounds: {} },
      ext_picspeak_name: name,
    };
    const files = [];
    boards.forEach((board) => {
      const path = `boards/${board.id}.obf`;
      manifest.paths.boards[board.id] = path;
      if (board.id === rootId) board.name = board.name || name;
      files.push({ name: path, data: JSON.stringify(board), compress: true });
    });
    imageFiles.forEach((file) => {
      manifest.paths.images[file.name.replace(/^images\/|\.\w+$/g, '')] = file.name;
    });
    files.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2), compress: true });
    files.push(...imageFiles);
    const blob = await zip.create(files);
    saveBlob(blob, fileName(name, 'obz'));
  }

  // Una sola scheda in un file .obf (immagini dentro il file; le cartelle restano collegamenti per id)
  async function exportObf(pageId, { onProgress } = {}) {
    const p = data.page(pageId);
    if (!p) throw new ObfError('pages');
    const { boards } = await buildBoards([p], { embedData: true, onProgress });
    const board = boards[0];
    const blob = new Blob([JSON.stringify(board)], { type: 'application/json' });
    saveBlob(blob, fileName(p.title || 'scheda', 'obf'));
  }

  function fileName(name, ext) {
    const slug = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'schede';
    return `picspeak-${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
  }

  // Salva il file (cartella Download, o app File su iPad e iPhone)
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Il file scelto è in formato Open Board? (dall'estensione o dalla firma zip)
  function isObfFile(file) {
    return Boolean(file) && /\.(obf|obz)$/i.test(file.name || '');
  }

  window.PicSpeak.obf = { ObfError, readFile, exportObz, exportObf, isObfFile, rgbToHex, OBF_FORMAT };
})();
