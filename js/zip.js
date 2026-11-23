/*
 * Lettore e scrittore di archivi zip, senza librerie (usato dai pacchetti Open Board Format .obz e,
 * in futuro, dal backup .picspeak).
 *
 * - Lettura: metodi «stored» (0) e «deflate» (8); la decompressione usa DecompressionStream del browser.
 *   Zip64, archivi cifrati e su più dischi non sono ammessi.
 * - Scrittura: file «stored» oppure compressi con CompressionStream, con CRC-32.
 *
 * Sicurezza: un archivio importato è un dato non affidabile. Si controllano numero di file, nomi
 * (niente percorsi assoluti, «..» o barre rovesciate), dimensione dichiarata e dimensione reale dopo la
 * decompressione (contro gli «zip bomb»): la lettura si ferma appena si supera il limite.
 */
(function () {
  'use strict';

  class ZipError extends Error {}

  const DEFAULT_LIMITS = {
    maxEntries: 5000,
    maxEntryBytes: 10 * 1024 * 1024, // un singolo file decompresso
    maxTotalBytes: 120 * 1024 * 1024, // tutti i file letti
  };

  // ---------- CRC-32 ----------

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // Nome di file sicuro dentro l'archivio: relativo, senza «..», senza caratteri di controllo
  function safeName(name) {
    if (typeof name !== 'string' || !name || name.length > 300) return false;
    if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return false;
    return !name.split('/').some((part) => part === '..' || part === '.');
  }

  // Percorso normalizzato per i confronti (es. "./images/a.png" → "images/a.png")
  function normalizePath(path) {
    return String(path || '').replace(/^\.\//, '').replace(/^\/+/, '');
  }

  // ---------- Lettura ----------

  async function inflate(bytes, limit, onWork) {
    if (typeof DecompressionStream !== 'function') throw new ZipError('unsupported');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      // Anche il lavoro di una lettura interrotta conta nel tetto complessivo (file ripetuti oltre il limite)
      if (onWork) onWork(value.length);
      if (size > limit) {
        reader.cancel().catch(() => {});
        throw new ZipError('too-big');
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    chunks.forEach((chunk) => { out.set(chunk, offset); offset += chunk.length; });
    return out;
  }

  /*
   * Apre un archivio (Blob o File). Restituisce { names, has(name), read(name) → Uint8Array, text(name) }.
   * I file si decomprimono solo quando servono.
   */
  async function open(blob, limits = {}) {
    const lim = { ...DEFAULT_LIMITS, ...limits };
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    // Fine della directory centrale: firma 0x06054b50 negli ultimi 64 KB + 22 byte
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('format');
    const disk = view.getUint16(eocd + 4, true);
    const count = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (disk !== 0 || count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('unsupported');
    if (count > lim.maxEntries) throw new ZipError('too-many');
    if (cdOffset + cdSize > buffer.length) throw new ZipError('format');

    const entries = new Map();
    const decoder = new TextDecoder('utf-8');
    let p = cdOffset;
    for (let n = 0; n < count; n += 1) {
      if (p + 46 > buffer.length || view.getUint32(p, true) !== 0x02014b50) throw new ZipError('format');
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const crc = view.getUint32(p + 16, true);
      const compressed = view.getUint32(p + 20, true);
      const size = view.getUint32(p + 24, true);
      const nameLength = view.getUint16(p + 28, true);
      const extraLength = view.getUint16(p + 30, true);
      const commentLength = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = decoder.decode(buffer.subarray(p + 46, p + 46 + nameLength));
      p += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/')) continue; // cartella
      if (flags & 0x1) throw new ZipError('unsupported'); // cifrato
      if (compressed === 0xffffffff || size === 0xffffffff) throw new ZipError('unsupported'); // zip64
      if (!safeName(name)) throw new ZipError('format');
      if (method !== 0 && method !== 8) continue; // metodo sconosciuto: il file si ignora
      if (!entries.has(name)) entries.set(name, { method, compressed, size, localOffset, crc });
    }

    let totalRead = 0;
    // maxBytes (facoltativo): limite più stretto per questa lettura, per esempio per una singola immagine
    async function read(name, maxBytes) {
      const entry = entries.get(normalizePath(name));
      if (!entry) throw new ZipError('missing');
      const entryLimit = Number.isFinite(maxBytes) ? Math.min(lim.maxEntryBytes, maxBytes) : lim.maxEntryBytes;
      if (entry.size > entryLimit) throw new ZipError('too-big');
      const h = entry.localOffset;
      if (h + 30 > buffer.length || view.getUint32(h, true) !== 0x04034b50) throw new ZipError('format');
      const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true);
      const end = start + entry.compressed;
      if (end > buffer.length) throw new ZipError('format');
      const raw = buffer.subarray(start, end);
      const remaining = Math.max(0, lim.maxTotalBytes - totalRead);
      const limit = Math.min(entryLimit, remaining);
      let data;
      if (entry.method === 0) {
        if (raw.length > limit) throw new ZipError('too-big');
        data = raw.slice();
        totalRead += data.length;
      } else {
        data = await inflate(raw, limit, (n) => { totalRead += n; });
      }
      // Archivio danneggiato: il contenuto non corrisponde al controllo CRC-32
      if (crc32(data) !== entry.crc) throw new ZipError('format');
      return data;
    }

    return {
      names: [...entries.keys()],
      has: (name) => entries.has(normalizePath(name)),
      read,
      async text(name) {
        return decoder.decode(await read(name));
      },
    };
  }

  // Un file è uno zip? (firma «PK\3\4» all'inizio)
  async function isZip(blob) {
    const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  }

  // ---------- Scrittura ----------

  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      return null;
    }
  }

  // Data e ora nel formato DOS usato dagli zip
  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  /*
   * Crea un archivio da [{ name, data: Uint8Array | string, compress }]. Restituisce un Blob.
   * compress = true per i testi (JSON); le immagini sono già compresse e si salvano così come sono.
   */
  async function create(files) {
    const encoder = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
      if (!safeName(file.name)) throw new ZipError('format');
      const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const packed = file.compress ? await deflate(data) : null;
      const method = packed && packed.length < data.length ? 8 : 0;
      const body = method === 8 ? packed : data;
      const crc = crc32(data);
      const name = encoder.encode(file.name);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // nomi in UTF-8
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, day, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      local.set(name, 30);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, day, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, body.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      central.set(name, 46);

      locals.push(local, body);
      centrals.push(central);
      offset += local.length + body.length;
    }
    const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    return new Blob([...locals, ...centrals, end], { type: 'application/zip' });
  }

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.zip = { ZipError, open, create, isZip, normalizePath, crc32 };
})();
