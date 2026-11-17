/*
 * Fonti dei simboli (Tappa 3): provider intercambiabili, tutti senza chiavi né account.
 *  - "device": simboli già salvati sul dispositivo (IndexedDB, archivio images) e set incluso;
 *  - "arasaac": ricerca online con l'API pubblica di ARASAAC (CC BY-NC-SA 4.0);
 *  - "mulberry", "openmoji": pacchetti pubblicati sul nostro sito, scaricati una sola volta
 *    nella Cache Storage ("picspeak-pack-<id>") solo se l'adulto li attiva; poi funzionano offline.
 * Traduzione italiano → inglese (per i pacchetti con parole inglesi), in quest'ordine:
 *   dizionario locale (symbols/it-en.json) → ponte ARASAAC (stesso pittogramma in inglese) → MyMemory.
 * Rete: solo HTTPS verso i domini ammessi dalla CSP; verso l'esterno va solo la parola cercata.
 * Ogni simbolo scelto viene ridotto a 256 px su canvas e salvato con fonte, autore e licenza.
 */
(function () {
  'use strict';

  const { storage, data, i18n } = window.PicSpeak;

  const IMAGE_SIZE = 256;
  const MAX_DOWNLOAD_BYTES = 3 * 1024 * 1024; // un pittogramma non supera mai qualche centinaio di KB
  const MAX_TERM = 40;
  const ARASAAC_API = 'https://api.arasaac.org/api/pictograms';
  const ARASAAC_STATIC = 'https://static.arasaac.org/pictograms';
  const MYMEMORY_API = 'https://api.mymemory.translated.net/get';
  const PACK_CACHE_PREFIX = 'picspeak-pack-';
  const PACK_IDS = ['mulberry', 'openmoji'];

  // Licenze e attribuzioni di ogni fonte (usate per i record e per la pagina Crediti)
  const SOURCE_INFO = {
    arasaac: {
      name: 'ARASAAC', author: 'Sergio Palao', owner: 'Gobierno de Aragón',
      license: 'CC BY-NC-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', url: 'https://arasaac.org',
    },
    mulberry: {
      name: 'Mulberry', author: 'Steve Lee', owner: '',
      license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', url: 'https://mulberrysymbols.org',
    },
    openmoji: {
      name: 'OpenMoji', author: 'OpenMoji (HfG Schwäbisch Gmünd)', owner: '',
      license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', url: 'https://openmoji.org',
    },
  };
  const ID_PREFIX = { arasaac: 'img_ar_', mulberry: 'img_mb_', openmoji: 'img_om_' };

  // ---------- Utilità ----------

  function normalize(text) {
    return String(text || '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);
  }

  // Varianti semplici singolare/plurale italiane (mela/mele, gatto/gatti, cane/cani)
  function italianVariants(term) {
    const out = new Set([term]);
    const stem = term.slice(0, -1);
    const last = term.slice(-1);
    if (term.length > 3) {
      if (last === 'i') ['o', 'e', 'a'].forEach((v) => out.add(stem + v));
      if (last === 'e') ['a', 'i'].forEach((v) => out.add(stem + v));
      if (last === 'o' || last === 'a') { out.add(`${stem}i`); out.add(`${stem}e`); }
    }
    return [...out];
  }

  async function fetchJson(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors',
      });
      if (response.status === 404) return null; // ARASAAC: nessun risultato
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Scarica un'immagine controllando tipo e dimensione, poi la ridisegna a 256 px
  // (toglie metadati e qualsiasi contenuto attivo: si salva solo una bitmap PNG/WebP)
  async function downloadImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error('too-big');
      const blob = await response.blob();
      await checkImage(blob);
      return resizeToBlob(blob);
    } finally {
      clearTimeout(timer);
    }
  }

  // Controllo della firma reale del file (non del tipo dichiarato): solo PNG, JPEG o WebP
  const MAX_SIDE = 8192; // lato massimo dichiarato di un'immagine
  const MAX_PIXELS = 24 * 1024 * 1024; // circa 24 Mpx (le foto dei telefoni stanno sotto)

  async function checkImage(blob) {
    if (!blob || blob.size > MAX_DOWNLOAD_BYTES) throw new Error('too-big');
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const webp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    if (!png && !jpeg && !webp) throw new Error('bad-type');
    // Misura dichiarata nell'intestazione, letta prima di decodificare: un file piccolo può dichiarare
    // dimensioni enormi e bloccare il dispositivo durante la decodifica
    const size = await headerSize(blob, png ? 'png' : jpeg ? 'jpeg' : 'webp');
    if (!size || size.width < 1 || size.height < 1 || size.width > MAX_SIDE || size.height > MAX_SIDE
      || size.width * size.height > MAX_PIXELS) {
      throw new Error('too-big');
    }
  }

  // Larghezza e altezza dall'intestazione di PNG, JPEG o WebP (null se non si trovano)
  async function headerSize(blob, type) {
    const b = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const u16be = (i) => (b[i] << 8) | b[i + 1];
    const u16le = (i) => b[i] | (b[i + 1] << 8);
    const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    if (type === 'png') {
      // Il primo blocco deve essere IHDR
      if (b.length < 24 || String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
      return { width: u32be(16), height: u32be(20) };
    }
    if (type === 'webp') {
      if (b.length < 30) return null;
      const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (chunk === 'VP8X') return { width: u24le(24) + 1, height: u24le(27) + 1 };
      if (chunk === 'VP8L') {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      return null;
    }
    // JPEG: si scorrono i segmenti fino al primo SOF (inizio dell'immagine)
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: u16be(i + 7), height: u16be(i + 5) };
      i += 2 + u16be(i + 2);
    }
    return null;
  }

  async function resizeToBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    // WebP dove il browser lo sa scrivere (più leggero), altrimenti PNG (mantiene la trasparenza)
    let out = await toBlob('image/webp', 0.88);
    if (!out || out.type !== 'image/webp') out = await toBlob('image/png');
    return out;
  }

  // ---------- Fonti attive ----------

  const SOURCE_DEFAULTS = { arasaac: true, mulberry: false, openmoji: false, photo: true };

  async function activeSources() {
    const saved = (await storage.get('symbolSources')) || {};
    const out = {};
    Object.keys(SOURCE_DEFAULTS).forEach((id) => { out[id] = saved[id] ?? SOURCE_DEFAULTS[id]; });
    return out;
  }

  // ---------- Dizionario it → en (offline) ----------

  let dictionaryPromise = null;
  function dictionary() {
    if (!dictionaryPromise) {
      dictionaryPromise = fetch('symbols/it-en.json')
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return dictionaryPromise;
  }

  async function translateLocal(term) {
    const dict = await dictionary();
    const out = [];
    italianVariants(term).forEach((variant) => {
      const list = Object.prototype.hasOwnProperty.call(dict, variant) ? dict[variant] : null;
      if (Array.isArray(list)) list.forEach((en) => { if (!out.includes(en.toLowerCase())) out.push(en.toLowerCase()); });
    });
    return out;
  }

  // ---------- Pacchetti (Mulberry, OpenMoji) ----------

  const packIndexes = new Map(); // id → indice in memoria
  const packUrl = (id, file) => `symbols/packs/${id}/${file}`;

  async function packStatus() {
    return (await storage.get('symbolPacks')) || {};
  }

  async function loadPackIndex(id) {
    if (packIndexes.has(id)) return packIndexes.get(id);
    if (!('caches' in window)) return null;
    const cache = await caches.open(PACK_CACHE_PREFIX + id);
    const response = await cache.match(packUrl(id, 'index.json'));
    if (!response) return null;
    const index = validPackIndex(await response.json(), id);
    if (!index) return null;
    packIndexes.set(id, index);
    return index;
  }

  // Indice di un pacchetto: formato atteso, nomi di file sicuri, parole chiave corte
  const SAFE_FILE = /^[A-Za-z0-9_-]{1,80}\.webp$/;
  function validPackIndex(index, id) {
    if (!index || index.format !== 'picspeak-pack' || index.id !== id || !Array.isArray(index.items)) return null;
    const words = (list) => (Array.isArray(list) ? list.map(normalize).filter(Boolean).slice(0, 8) : []);
    index.items = index.items
      .filter((item) => item && SAFE_FILE.test(item.f) && /^[A-Za-z0-9_,-]{1,80}$/.test(String(item.id)))
      .map((item) => ({ f: item.f, id: String(item.id), it: words(item.it), en: words(item.en) }));
    return index;
  }

  // Scarica tutto il pacchetto una sola volta (6 file alla volta), con avanzamento
  async function downloadPack(id, onProgress) {
    if (!PACK_IDS.includes(id)) throw new Error('unknown-pack');
    if (!('caches' in window)) throw new Error('no-cache');
    const indexResponse = await fetch(packUrl(id, 'index.json'), { cache: 'no-cache' });
    if (!indexResponse.ok) throw new Error(`HTTP ${indexResponse.status}`);
    const index = validPackIndex(await indexResponse.clone().json(), id);
    if (!index) throw new Error('bad-pack');
    const cache = await caches.open(PACK_CACHE_PREFIX + id);
    const files = index.items.map((item) => item.f);
    let done = 0;
    let next = 0;
    async function worker() {
      while (next < files.length) {
        const file = files[next];
        next += 1;
        const url = packUrl(id, file);
        // eslint-disable-next-line no-await-in-loop
        if (!(await cache.match(url))) {
          // eslint-disable-next-line no-await-in-loop
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // eslint-disable-next-line no-await-in-loop
          await cache.put(url, response);
        }
        done += 1;
        if (onProgress) onProgress(done, files.length);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    // L'indice si salva per ultimo: se manca, il pacchetto non è completo
    await cache.put(packUrl(id, 'index.json'), indexResponse);
    packIndexes.set(id, index);
    const status = await packStatus();
    status[id] = { version: index.version, count: index.items.length, bytes: index.bytes, at: new Date().toISOString() };
    await storage.set('symbolPacks', status);
    return status[id];
  }

  async function removePack(id) {
    packIndexes.delete(id);
    if ('caches' in window) await caches.delete(PACK_CACHE_PREFIX + id);
    const status = await packStatus();
    delete status[id];
    await storage.set('symbolPacks', status);
  }

  // ---------- Ricerca ----------

  function matches(keywords, terms) {
    return keywords.some((k) => terms.some((term) => k === term || k.startsWith(`${term} `)));
  }

  // Simboli già sul dispositivo (set incluso, ARASAAC salvati, pacchetti già usati, foto)
  function searchDevice(terms, enTerms) {
    const results = [];
    data.allImages().forEach((image) => {
      const kw = image.keywords || {};
      const it = (kw.it || []).map(normalize);
      const en = (kw.en || []).map(normalize);
      const own = (kw[i18n.language] || []).map(normalize);
      if (matches(own, terms) || matches(it, terms) || matches(en, enTerms)) {
        results.push({
          key: image.id, source: 'device', origin: image.source, imageId: image.id,
          thumb: data.imageUrl(image.id), label: (kw[i18n.language] || kw.it || kw.en || [''])[0],
        });
      }
    });
    return results;
  }

  async function searchPack(id, terms, enTerms) {
    const index = await loadPackIndex(id);
    if (!index) return [];
    const lang = i18n.language;
    const exact = [];
    const partial = [];
    index.items.forEach((item) => {
      const own = lang === 'it' ? item.it : item.en;
      const hit = own.some((k) => terms.includes(k)) || item.en.some((k) => enTerms.includes(k));
      const near = !hit && (matches(own, terms) || matches(item.en, enTerms));
      if (!hit && !near) return;
      const result = {
        key: `${id}:${item.id}`, source: id, sourceId: item.id, imageId: ID_PREFIX[id] + item.id,
        thumb: packUrl(id, item.f), file: packUrl(id, item.f),
        label: (own[0] || item.en[0] || ''), keywords: { it: item.it, en: item.en },
      };
      (hit ? exact : partial).push(result);
    });
    return exact.concat(partial).slice(0, 30);
  }

  async function searchArasaac(term, lang) {
    const list = await fetchJson(`${ARASAAC_API}/${lang}/search/${encodeURIComponent(term)}`);
    if (!Array.isArray(list)) return [];
    return list.slice(0, 30).map((item) => {
      const id = Number(item._id);
      if (!Number.isInteger(id) || id <= 0) return null;
      const words = (item.keywords || []).map((k) => normalize(k && k.keyword)).filter(Boolean);
      // Tipo di parola indicato da ARASAAC (1 nome proprio, 2 nome, 3 verbo, 4 descrizione, 5 sociale)
      const arasaacType = item.keywords && item.keywords[0] && item.keywords[0].type;
      const wordType = { 1: 'pronoun', 2: 'noun', 3: 'verb', 4: 'adjective', 5: 'social' }[arasaacType] || null;
      return {
        wordType,
        key: `arasaac:${id}`, source: 'arasaac', sourceId: String(id), imageId: ID_PREFIX.arasaac + id,
        thumb: `${ARASAAC_STATIC}/${id}/${id}_300.png`, file: `${ARASAAC_STATIC}/${id}/${id}_300.png`,
        label: words[0] || term, keywords: { [lang]: words.slice(0, 5) },
      };
    }).filter(Boolean);
  }

  // Ponte ARASAAC: lo stesso pittogramma ha anche le parole chiave inglesi
  async function arasaacEnglish(id) {
    const item = await fetchJson(`${ARASAAC_API}/en/${encodeURIComponent(id)}`);
    if (!item || !Array.isArray(item.keywords)) return [];
    return item.keywords.map((k) => normalize(k.keyword)).filter(Boolean).slice(0, 3);
  }

  async function myMemory(term) {
    const json = await fetchJson(`${MYMEMORY_API}?q=${encodeURIComponent(term)}&langpair=it|en`);
    const text = json && json.responseData && normalize(json.responseData.translatedText);
    return text && text !== term && text.length <= MAX_TERM ? [text] : [];
  }

  /*
   * Ricerca completa. "online" dice se si può usare internet (interruttore già controllato dall'interfaccia).
   * onUpdate(groups) viene chiamata più volte: prima i risultati sul dispositivo, poi quelli online.
   * groups = { device: [], arasaac: [], mulberry: [], openmoji: [] }; stati: 'loading' | 'done' | 'error'.
   */
  async function search(rawTerm, { online, onUpdate }) {
    const term = normalize(rawTerm);
    const groups = {};
    const emit = () => onUpdate({ ...groups });
    if (!term) return groups;
    const sources = await activeSources();
    const lang = i18n.language;
    const terms = lang === 'it' ? italianVariants(term) : [term];
    let enTerms = lang === 'it' ? await translateLocal(term) : [term];

    // 1. Sul dispositivo e nei pacchetti scaricati: immediato, anche offline
    const device = searchDevice(terms, enTerms);
    groups.device = { state: 'done', items: device };
    const packs = PACK_IDS.filter((id) => sources[id]);
    await Promise.all(packs.map(async (id) => {
      groups[id] = { state: 'done', items: await searchPack(id, terms, enTerms) };
    }));
    emit();

    if (!online || !sources.arasaac) {
      if (online && lang === 'it' && !enTerms.length && packs.length) {
        // ARASAAC spento: la traduzione online serve solo ai pacchetti
        enTerms = await myMemory(term).catch(() => []);
        await Promise.all(packs.map(async (id) => { groups[id] = { state: 'done', items: await searchPack(id, terms, enTerms) }; }));
        emit();
      }
      return groups;
    }

    // 2. ARASAAC online
    groups.arasaac = { state: 'loading', items: [] };
    emit();
    try {
      const deviceIds = new Set(device.map((r) => r.imageId));
      const items = (await searchArasaac(term, lang)).filter((r) => !deviceIds.has(r.imageId));
      groups.arasaac = { state: 'done', items };
      emit();
      // 3. Traduzione per i pacchetti se il dizionario non la conosceva: ponte ARASAAC, poi MyMemory
      if (lang === 'it' && !enTerms.length && packs.length) {
        if (items.length) enTerms = await arasaacEnglish(items[0].sourceId).catch(() => []);
        if (!enTerms.length) enTerms = await myMemory(term).catch(() => []);
        if (enTerms.length) {
          await Promise.all(packs.map(async (id) => { groups[id] = { state: 'done', items: await searchPack(id, terms, enTerms) }; }));
          emit();
        }
      }
    } catch (error) {
      groups.arasaac = { state: 'error', items: [] };
      emit();
    }
    return groups;
  }

  /*
   * Prepara il simbolo scelto: se è già sul dispositivo restituisce il suo id,
   * altrimenti lo scarica una volta, lo riduce e prepara il record con fonte e licenza.
   */
  async function acquire(result) {
    if (result.source === 'device' || data.image(result.imageId)) {
      return { imageId: result.imageId, record: null, previewBlob: null };
    }
    const info = SOURCE_INFO[result.source];
    if (!info) throw new Error('unknown-source');
    let blob;
    if (result.source === 'arasaac') {
      blob = await downloadImage(result.file);
    } else {
      // Pacchetto: già nella Cache Storage (o dal sito, se il service worker non c'è)
      const cache = await caches.open(PACK_CACHE_PREFIX + result.source);
      const response = (await cache.match(result.file)) || (await fetch(result.file));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.blob();
      await checkImage(raw);
      blob = await resizeToBlob(raw);
    }
    const record = {
      id: result.imageId,
      source: result.source,
      sourceId: result.sourceId,
      author: info.author,
      owner: info.owner,
      license: info.license,
      licenseUrl: info.licenseUrl,
      mime: blob.type,
      blob,
      keywords: result.keywords || {},
    };
    return { imageId: record.id, record, previewBlob: blob };
  }

  window.PicSpeak.symbols = {
    SOURCE_INFO,
    PACK_IDS,
    activeSources,
    search,
    acquire,
    packStatus,
    downloadPack,
    removePack,
    resizeToBlob,
    checkImage,
    headerSize,
    downloadImage,
  };
})();
