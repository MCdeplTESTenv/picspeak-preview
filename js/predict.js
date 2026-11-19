/*
 * Previsione della parola successiva (basi): tutto calcolato sul dispositivo.
 *
 * Raccolta: ogni volta che il bambino aggiunge una tessera alla frase si registra la coppia
 * «parola precedente → parola» (bigramma; "^" = inizio della frase) e la parola da sola.
 * Ogni conteggio sbiadisce nel tempo (dimezza ogni 30 giorni): le abitudini recenti pesano di più,
 * quelle vecchie si spengono da sole senza essere cancellate. Si tiene anche la fascia oraria
 * e se l'uso è avvenuto in un giorno feriale o nel fine settimana.
 *
 * Suggerimento: le parole più probabili dopo l'ultima della frase vengono EVIDENZIATE nella
 * pagina (o si evidenzia la cartella che le contiene). Le tessere non si spostano mai:
 * la posizione stabile è la base della memoria motoria.
 *
 * Privacy: nessun dato esce dal dispositivo; niente rete, niente servizi esterni.
 * Archivio IndexedDB "usage" (vedi docs/FORMATO-DATI.md).
 */
(function () {
  'use strict';

  const { storage } = window.PicSpeak;

  const START = '^'; // inizio della frase
  const HALF_LIFE_DAYS = 30;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_SCORE = 1.5; // sotto questo valore (circa due usi recenti) non si suggerisce nulla
  const SETTINGS_KEY = 'prediction';
  const DEFAULTS = { collect: true, suggest: false, count: 2, style: 'outline', width: 'medium', color: 'blue' };
  // Spessore e colore del contorno dei suggerimenti
  const WIDTHS = ['thin', 'medium', 'thick'];
  const COLORS = ['blue', 'yellow', 'green', 'orange', 'purple'];
  // Stili dei suggerimenti: contorno, contorno sfumato secondo la frequenza, trasparenza delle altre tessere,
  // solo le tessere suggerite (le altre lasciano vuoto il loro posto)
  const STYLES = ['outline', 'graded', 'fade', 'only'];
  const COUNTS = [1, 2, 3, 5, 10];
  // File CSV delle abitudini: limiti per l'importazione
  const CSV_MAX_BYTES = 2 * 1024 * 1024;
  const CSV_MAX_ROWS = 5000;
  const CSV_MAX_WEIGHT = 1000;
  const MAX_RECORDS = 20000; // tetto totale delle abitudini salvate (coppie + parole singole)

  let settings = { ...DEFAULTS };
  let profileId = null;
  const records = new Map(); // id → record
  const dirty = new Set();
  let saveTimer = null;
  let ready = null;

  // Parola normalizzata: la stessa parola in schede diverse conta come una sola
  function wordKey(label) {
    return String(label || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  }

  function recordId(prev, word) {
    return `u_${profileId}_${encodeURIComponent(prev || '')}_${encodeURIComponent(word)}`;
  }

  // Valore attuale di un conteggio che sbiadisce nel tempo
  function decayed(record, at = Date.now()) {
    const age = Math.max(0, at - Date.parse(record.lastUsed || 0)) / DAY_MS;
    return record.count * 0.5 ** (age / HALF_LIFE_DAYS);
  }

  function isHoliday(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  async function init(activeProfileId) {
    profileId = activeProfileId;
    const saved = await storage.get(SETTINGS_KEY);
    settings = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    settings.collect = settings.collect !== false;
    settings.suggest = settings.suggest === true;
    settings.count = COUNTS.includes(settings.count) ? settings.count : DEFAULTS.count;
    settings.style = STYLES.includes(settings.style) ? settings.style : DEFAULTS.style;
    settings.width = WIDTHS.includes(settings.width) ? settings.width : DEFAULTS.width;
    settings.color = COLORS.includes(settings.color) ? settings.color : DEFAULTS.color;
    applyLook();
    records.clear();
    const all = await storage.getAllRecords('usage');
    all.filter((r) => r && r.profileId === profileId && typeof r.word === 'string' && Number.isFinite(r.count))
      .forEach((r) => records.set(r.id, r));
  }

  function load(activeProfileId) {
    ready = init(activeProfileId);
    return ready;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1500);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty.size) return;
    const list = [...dirty].map((id) => records.get(id)).filter(Boolean);
    dirty.clear();
    await storage.putRecords('usage', list);
  }

  function bump(prev, word, cellId, prevCellId, when) {
    const id = recordId(prev, word);
    const nowIso = when.toISOString();
    let record = records.get(id);
    if (!record) {
      record = {
        id, profileId, contextId: null, word, prevWord: prev, cellId, prevCellId: prevCellId || null,
        count: 0, lastUsed: nowIso, byHour: new Array(24).fill(0), weekday: 0, holiday: 0,
      };
      records.set(id, record);
    }
    // Prima si fa sbiadire il valore accumulato, poi si aggiunge l'uso di adesso
    const factor = record.count ? decayed(record, when.getTime()) / record.count : 1;
    record.count = record.count * factor + 1;
    record.byHour = record.byHour.map((v, h) => v * factor + (h === when.getHours() ? 1 : 0));
    record.weekday = record.weekday * factor + (isHoliday(when) ? 0 : 1);
    record.holiday = record.holiday * factor + (isHoliday(when) ? 1 : 0);
    record.lastUsed = nowIso;
    record.cellId = cellId;
    dirty.add(id);
  }

  /*
   * Registra una tessera aggiunta alla frase. prevItem = tessera precedente nella frase (o null).
   */
  function record(item, prevItem) {
    if (!settings.collect || !profileId || !item) return;
    const word = wordKey(item.label);
    if (!word) return;
    const prev = prevItem ? wordKey(prevItem.label) : START;
    const when = new Date();
    bump(prev, word, item.cellId, prevItem ? prevItem.cellId : null, when);
    bump(null, word, item.cellId, null, when); // frequenza della parola da sola
    scheduleSave();
  }

  // Peso per l'ora e il tipo di giorno: le abitudini di questo momento contano un po' di più
  function contextWeight(rec, when) {
    const total = rec.byHour.reduce((a, b) => a + b, 0) || 1;
    const hourShare = (rec.byHour[when.getHours()] || 0) / total;
    const dayTotal = (rec.weekday + rec.holiday) || 1;
    const dayShare = (isHoliday(when) ? rec.holiday : rec.weekday) / dayTotal;
    return 1 + 0.5 * hourShare + 0.25 * dayShare;
  }

  /*
   * Parole probabili dopo la tessera indicata (null = inizio della frase), in ordine.
   * Restituisce [{ word, score }].
   */
  function candidates(prevItem) {
    const prev = prevItem ? wordKey(prevItem.label) : START;
    const now = new Date();
    const list = [];
    records.forEach((rec) => {
      if (rec.prevWord !== prev) return;
      const score = decayed(rec, now.getTime()) * contextWeight(rec, now);
      if (score >= MIN_SCORE) list.push({ word: rec.word, score });
    });
    return list.sort((a, b) => b.score - a.score);
  }

  function stats() {
    const now = Date.now();
    let uses = 0;
    let pairs = 0;
    const top = [];
    records.forEach((rec) => {
      if (rec.prevWord === null || rec.prevWord === undefined) {
        uses += Math.round(rec.count);
        return;
      }
      pairs += 1;
      if (rec.prevWord !== START) top.push({ from: rec.prevWord, to: rec.word, score: decayed(rec, now) });
    });
    top.sort((a, b) => b.score - a.score);
    return { uses, pairs, top: top.slice(0, 5) };
  }

  async function clearAll() {
    clearTimeout(saveTimer);
    dirty.clear();
    const ids = [...records.keys()];
    records.clear();
    await Promise.all(ids.map((id) => storage.deleteRecord('usage', id)));
  }

  // ---------- Esportare e importare le abitudini (CSV modificabile con un foglio di calcolo) ----------

  class CsvError extends Error {}

  // Un testo che inizia con = + - @ verrebbe letto come formula dal foglio di calcolo: si fa precedere da '
  function csvCell(value) {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function startLabel(lang) {
    return lang === 'it' ? '(inizio)' : '(start)';
  }

  /*
   * Testo CSV delle coppie «parola precedente → parola» del profilo attivo, con il peso attuale.
   * Separatore «;» (si apre direttamente in Excel, Numbers e Fogli Google anche con le impostazioni italiane).
   */
  function exportCsv(lang) {
    const now = Date.now();
    const decimal = lang === 'it' ? ',' : '.';
    const head = lang === 'it' ? ['parola precedente', 'parola', 'peso'] : ['previous word', 'word', 'weight'];
    const rows = [];
    records.forEach((rec) => {
      if (rec.prevWord === null || rec.prevWord === undefined) return;
      rows.push([rec.prevWord === START ? startLabel(lang) : rec.prevWord, rec.word, decayed(rec, now)]);
    });
    rows.sort((a, b) => b[2] - a[2]);
    const lines = [head.map(csvCell).join(';')];
    rows.forEach(([prev, word, weight]) => {
      lines.push([csvCell(prev), csvCell(word), (Math.round(weight * 10) / 10).toString().replace('.', decimal)].join(';'));
    });
    return `\ufeff${lines.join('\r\n')}\r\n`;
  }

  // Divide una riga CSV (separatore ; , o tabulazione, campi tra virgolette)
  function splitCsvLine(line, sep) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /*
   * Legge un CSV delle abitudini. Restituisce [{ prev, word, weight }] già controllate.
   * prev = START per l'inizio della frase. Le righe non valide vengono saltate e contate.
   */
  function parseCsv(text) {
    const lines = String(text).replace(/^\ufeff/, '').split(/\r\n|\n|\r/).filter((l) => l.trim());
    if (lines.length > CSV_MAX_ROWS + 1) throw new CsvError('rows');
    const first = lines[0] || '';
    const sep = [';', '\t', ','].find((c) => first.includes(c)) || ';';
    const rows = [];
    let skipped = 0;
    lines.forEach((line, index) => {
      // Niente caratteri di controllo o invisibili (es. inversione della direzione del testo)
      const cells = splitCsvLine(line, sep)
        .map((c) => c.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().replace(/^'(?=[=+\-@])/, ''));
      const weight = Number(String(cells[2] || '').replace(',', '.'));
      if (cells.length < 3 || cells[2] === '' || !Number.isFinite(weight)) {
        if (index > 0) skipped += 1; // la prima riga di solito è l'intestazione
        return;
      }
      const rawPrev = cells[0].toLowerCase();
      const prev = !rawPrev || rawPrev === '(inizio)' || rawPrev === '(start)' || rawPrev === '^' ? START : wordKey(cells[0]);
      const word = wordKey(cells[1]);
      if (!word || !prev || weight < 0) { skipped += 1; return; }
      rows.push({ prev, word, weight: Math.min(weight, CSV_MAX_WEIGHT) });
    });
    if (!rows.length) throw new CsvError('empty');
    return { rows, skipped };
  }

  async function readCsvFile(file) {
    if (!file || file.size > CSV_MAX_BYTES) throw new CsvError('size');
    return parseCsv(await file.text());
  }

  /*
   * Applica le righe importate. mode 'merge': le coppie del file sostituiscono quelle uguali, le altre restano;
   * 'replace': prima si cancellano tutte le abitudini del profilo. Peso 0 = coppia tolta.
   */
  async function importRows(rows, mode) {
    if (!profileId) return 0;
    // Con «Aggiungi» le abitudini non possono crescere senza limite (rallenterebbero i suggerimenti)
    if (mode !== 'replace' && records.size + rows.length * 2 > MAX_RECORDS) throw new CsvError('full');
    if (mode === 'replace') await clearAll();
    const nowIso = new Date().toISOString();
    const remove = [];
    rows.forEach(({ prev, word, weight }) => {
      const id = recordId(prev, word);
      if (weight === 0) {
        if (records.delete(id)) remove.push(id);
        dirty.delete(id);
        return;
      }
      const old = records.get(id);
      records.set(id, {
        id, profileId, contextId: null, word, prevWord: prev, cellId: old ? old.cellId : null,
        prevCellId: old ? old.prevCellId : null, count: weight, lastUsed: nowIso,
        byHour: new Array(24).fill(0), weekday: 0, holiday: 0,
      });
      dirty.add(id);
      // La parola da sola deve esistere per le statistiche
      const single = recordId(null, word);
      if (!records.has(single)) {
        records.set(single, {
          id: single, profileId, contextId: null, word, prevWord: null, cellId: null, prevCellId: null,
          count: weight, lastUsed: nowIso, byHour: new Array(24).fill(0), weekday: 0, holiday: 0,
        });
        dirty.add(single);
      }
    });
    await Promise.all(remove.map((id) => storage.deleteRecord('usage', id)));
    await flush();
    return rows.length;
  }

  // Spessore e colore del contorno: attributi sulla pagina, letti dal foglio di stile
  function applyLook() {
    document.documentElement.dataset.suggestWidth = settings.width;
    document.documentElement.dataset.suggestColor = settings.color;
  }

  async function setSettings(changes) {
    settings = { ...settings, ...changes };
    applyLook();
    await storage.set(SETTINGS_KEY, settings);
  }

  // Salva subito quando la pagina viene nascosta (chiusura dell'app, cambio di scheda)
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  window.PicSpeak.predict = {
    load,
    record,
    candidates,
    wordKey,
    stats,
    clearAll,
    setSettings,
    exportCsv,
    readCsvFile,
    importRows,
    CsvError,
    STYLES,
    WIDTHS,
    COLORS,
    get settings() { return { ...settings }; },
    get ready() { return ready; },
  };
})();
