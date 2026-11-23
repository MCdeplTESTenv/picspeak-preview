/*
 * Previsione della parola successiva: tutto calcolato sul dispositivo.
 *
 * Raccolta (dal 22/11/2026): invece di registrare ogni tocco si tiene un RIEPILOGO PER GIORNO.
 * Per ogni giorno d'uso e per ogni combinazione «parola precedente → parola» usata quel giorno si conta
 * quante volte è stata usata in ciascuna fascia di un'ora. Ore e combinazioni non usate non occupano spazio.
 * Ogni voce occupa 4 byte (vedi pack). "^" = inizio della frase.
 *
 * Punteggio: le abitudini recenti pesano di più (dimezzano ogni 30 giorni) e quelle della stessa ora
 * e dello stesso tipo di giorno (feriale/fine settimana) un po' di più.
 *
 * Contesti (Scuola, Logopedia, Mare…): una regola (giorni della settimana e orari, oppure un periodo
 * dell'anno) che filtra lo storico. Quando il contesto è attivo, le sue combinazioni ricevono una
 * prevalenza regolabile (×2, ×4, ×8) senza escludere le altre. Nel contesto le abitudini sbiadiscono
 * lentamente (dimezzano in un anno), così «Mare» dell'estate scorsa conta ancora l'estate dopo.
 * L'adulto vede le combinazioni del contesto e può cambiarne il peso, toglierle o aggiungerne.
 *
 * Pesi di partenza: valori senza data e ora (dal file CSV o dalle abitudini del vecchio formato),
 * che si sommano allo storico e sbiadiscono dal giorno in cui sono stati inseriti.
 *
 * I punteggi si preparano all'avvio, a ogni cambio d'ora e a ogni modifica dei contesti:
 * a ogni tocco si legge solo la tabella già pronta.
 *
 * Suggerimento: le parole più probabili vengono EVIDENZIATE (le tessere non si spostano mai).
 * Privacy: nessun dato esce dal dispositivo. Archivi IndexedDB "usage" e "contexts" (docs/FORMATO-DATI.md).
 */
(function () {
  'use strict';

  const { storage } = window.PicSpeak;

  const START = '^'; // inizio della frase
  const STARTER = 'starter'; // segno dei pesi di partenza messi dalla base di PicSpeak
  const HALF_LIFE_DAYS = 30;
  const CONTEXT_HALF_LIFE_DAYS = 365;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN_SCORE = 1.5; // sotto questo valore (circa due usi recenti) non si suggerisce nulla
  const SETTINGS_KEY = 'prediction';
  const DEFAULTS = { collect: true, suggest: false, count: 2, style: 'outline', dim: false, dimLevel: 50, width: 'medium', color: 'blue', showContext: false };
  const DIM_LEVEL = { min: 10, max: 90, step: 10 };
  const WIDTHS = ['thin', 'medium', 'thick'];
  const COLORS = ['blue', 'yellow', 'green', 'orange', 'purple'];
  const STYLES = ['outline', 'graded', 'only'];
  const COUNTS = [1, 2, 3, 5, 10];
  // File CSV delle abitudini: limiti per l'importazione
  const CSV_MAX_BYTES = 2 * 1024 * 1024;
  const CSV_MAX_ROWS = 20000;
  const CSV_MAX_WEIGHT = 1000;
  // Storico: limiti
  const MAX_COMBOS = 60000; // combinazioni diverse (oltre, le nuove non si registrano più)
  const MAX_BASE = 20000; // pesi di partenza
  const COMBO_PAGE = 1024; // combinazioni per record salvato (si riscrive solo la pagina cambiata)
  const MAX_COUNT = 255; // usi della stessa combinazione nella stessa ora dello stesso giorno
  const COMPACT_THRESHOLD = 300000; // voci totali oltre le quali i giorni vecchi si accorpano per mese
  const COMPACT_AFTER_DAYS = 400; // circa 13 mesi
  // Contesti: limiti
  const BOOSTS = [2, 4, 8];
  const MODES = ['auto', 'on', 'off'];
  const MAX_CONTEXTS = 30;
  const MAX_EDITS = 2000;
  const MAX_SLOTS = 6; // fasce orarie per contesto
  const NAME_MAX = 40;
  // File dello storico (esportazione a parte e, in futuro, parte del backup completo)
  const HISTORY_FORMAT_VERSION = 2; // 2: regole settimanali con più fasce (i file della versione 1 restano validi)
  const HISTORY_MAX_BYTES = 40 * 1024 * 1024;
  const HISTORY_MAX_DAYS = 20000;
  const HISTORY_MAX_ENTRIES_PER_DAY = 100000;
  const HISTORY_MAX_TOTAL_ENTRIES = 2000000;

  let settings = { ...DEFAULTS };
  let profileId = null;
  let ready = null;

  // ---------- Stato in memoria del profilo attivo ----------
  let combos = []; // indice → [prev, word]
  let comboIndex = new Map(); // "prev\u0001word" → indice
  let days = new Map(); // giorno → Uint32Array (giorni passati e di oggi già salvati)
  let months = new Map(); // primo giorno del mese → Uint32Array (giorni vecchi accorpati)
  let today = { day: -1, counts: new Map() }; // oggi: (combinazione * 32 + ora) → conteggio
  let base = []; // pesi di partenza: { prev, word, weight, day, ctx }
  let contexts = []; // contesti del profilo
  // Cose da salvare
  const dirtyPages = new Set();
  const dirtyDays = new Set();
  const deletedIds = new Set();
  let dirtyBase = false;
  let saveTimer = null;
  // Tabella dei punteggi pronta: prev → Map(word → punteggio)
  let table = new Map();
  let tableHour = -1; // ora (giorno * 24 + ora) per cui è stata preparata
  let hourTimer = null;

  // ---------- Piccoli aiuti ----------

  // Parola normalizzata: la stessa parola in schede diverse conta come una sola
  function wordKey(label) {
    return String(label || '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  }

  const pairKey = (prev, word) => `${prev}\u0001${word}`;

  // Voce di 4 byte: conteggio (bit 0-7), ora (8-12), fine settimana (13, solo nei mesi accorpati), combinazione (14-31)
  function pack(combo, hour, count, weekend) {
    return ((combo << 14) | ((weekend ? 1 : 0) << 13) | (hour << 8) | Math.min(MAX_COUNT, count)) >>> 0;
  }

  // Giorno locale come numero intero (giorni dal 1/1/1970): non dipende dal fuso orario
  function localDay(date) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
  }

  // 0 = domenica … 6 = sabato
  const dayOfWeek = (day) => (day + 4) % 7;
  const isWeekendDay = (day) => { const d = dayOfWeek(day); return d === 0 || d === 6; };
  // Giorno ISO: 1 = lunedì … 7 = domenica
  const isoDay = (day) => dayOfWeek(day) || 7;

  // "MM-GG" di un giorno
  function monthDay(day) {
    const date = new Date(day * DAY_MS);
    return `${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function monthStart(day) {
    const date = new Date(day * DAY_MS);
    return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / DAY_MS);
  }

  function daysInMonth(start) {
    const date = new Date(start * DAY_MS);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  }

  const decay = (ageDays, halfLife) => 0.5 ** (Math.max(0, ageDays) / halfLife);

  const dayId = (day) => `ud_${profileId}_${day}`;
  const monthId = (start) => `um_${profileId}_${start}`;
  const pageId = (page) => `uc_${profileId}_${page}`;
  const baseId = () => `ub_${profileId}`;

  /*
   * Abitudini salvate di un profilo: si leggono solo i suoi record (gli id iniziano con il codice del profilo),
   * così con più profili sullo stesso dispositivo l'avvio non legge le abitudini degli altri.
   * «u_» è il formato più vecchio, recuperato da migrateOld.
   */
  async function usageRecordsOf(id) {
    if (!id) return [];
    const prefixes = ['uc_', 'ud_', 'um_', 'u_'].map((kind) => `${kind}${id}_`).concat(`ub_${id}`);
    const records = await storage.getRecordsByPrefix('usage', prefixes);
    return records.filter((r) => r && r.profileId === id);
  }

  // ---------- Regole dei contesti ----------

  // Una fascia settimanale valida o null: giorni ISO 1-7, ore intere da/a (a escluso)
  function cleanSlot(slot) {
    if (!slot || typeof slot !== 'object') return null;
    const list = Array.isArray(slot.days) ? [...new Set(slot.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort() : [];
    const from = Number.isInteger(slot.from) && slot.from >= 0 && slot.from <= 23 ? slot.from : null;
    const to = Number.isInteger(slot.to) && slot.to >= 1 && slot.to <= 24 ? slot.to : null;
    // «to» minore di «from» = fascia che passa la mezzanotte (es. 18 → 6): finisce il mattino dopo
    if (!list.length || from === null || to === null || to === from) return null;
    return { days: list, from, to };
  }

  /*
   * Regola valida o null. weekly: una o più fasce (slots), ognuna con giorni e orari; dates: "MM-GG" da/a, ogni anno.
   * Migrazione: la regola settimanale del formato precedente ({ days, from, to }, una sola fascia) diventa
   * { slots: [ { days, from, to } ] } senza perdere nulla.
   */
  function cleanRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    if (rule.type === 'weekly') {
      const raw = Array.isArray(rule.slots) ? rule.slots.slice(0, MAX_SLOTS) : [rule];
      const seen = new Set();
      const slots = [];
      raw.forEach((item) => {
        const slot = cleanSlot(item);
        const key = slot && `${slot.days.join(',')}|${slot.from}|${slot.to}`;
        if (slot && !seen.has(key)) { seen.add(key); slots.push(slot); }
      });
      return slots.length ? { type: 'weekly', slots } : null;
    }
    if (rule.type === 'dates') {
      const ok = (v) => typeof v === 'string' && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)
        && Number(v.slice(3)) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(v.slice(0, 2)) - 1];
      if (!ok(rule.from) || !ok(rule.to)) return null;
      return { type: 'dates', from: rule.from, to: rule.to };
    }
    return null;
  }

  // Periodo preciso dello storico da cui prendere le combinazioni: "AAAA-MM-GG" da/a (null = come la regola)
  function cleanSource(source) {
    if (!source || typeof source !== 'object') return null;
    const toDay = (v) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      const t = Date.parse(`${v}T00:00:00Z`);
      return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? Math.floor(t / DAY_MS) : null;
    };
    const from = toDay(source.from);
    const to = toDay(source.to);
    if (from === null || to === null || to < from || to - from > 3660) return null;
    return { from: source.from, to: source.to };
  }

  // Filtro sullo storico di un contesto: la regola stessa oppure il periodo preciso scelto
  function filterOf(ctx) {
    const source = cleanSource(ctx.source);
    if (source) return { type: 'range', from: Math.floor(Date.parse(`${source.from}T00:00:00Z`) / DAY_MS), to: Math.floor(Date.parse(`${source.to}T00:00:00Z`) / DAY_MS) };
    return cleanRule(ctx.rule);
  }

  function inDates(rule, md) {
    return rule.from <= rule.to ? md >= rule.from && md <= rule.to : md >= rule.from || md <= rule.to;
  }

  // La regola comprende questo giorno e questa ora?
  /*
   * Fascia oraria settimanale. dayIn = il giorno è tra quelli scelti; prevIn = lo è il giorno prima.
   * Una fascia che passa la mezzanotte (es. venerdì 18 → 6) appartiene al giorno in cui comincia:
   * le ore dopo mezzanotte contano se il giorno PRIMA è tra quelli scelti (sabato 0-6 per «venerdì»).
   */
  function weeklyHour(slot, hour, dayIn, prevIn) {
    if (slot.from < slot.to) return dayIn && hour >= slot.from && hour < slot.to;
    return (dayIn && hour >= slot.from) || (prevIn && hour < slot.to);
  }

  /*
   * Ore di accensione di una regola settimanale per ogni giorno della settimana: masks[iso] ha il bit h a 1 se in quel
   * giorno all'ora h almeno una fascia è attiva (un'ora presa da due fasce conta una volta sola). Calcolato una volta.
   */
  const weekMaskCache = new WeakMap();
  function weekMask(rule) {
    let masks = weekMaskCache.get(rule);
    if (masks) return masks;
    masks = new Int32Array(8);
    for (let iso = 1; iso <= 7; iso += 1) {
      const prevIso = iso === 1 ? 7 : iso - 1;
      let m = 0;
      rule.slots.forEach((slot) => {
        const dayIn = slot.days.includes(iso);
        const prevIn = slot.days.includes(prevIso);
        for (let h = 0; h < 24; h += 1) if (weeklyHour(slot, h, dayIn, prevIn)) m |= 1 << h;
      });
      masks[iso] = m;
    }
    weekMaskCache.set(rule, masks);
    return masks;
  }

  function ruleMatches(rule, day, hour) {
    if (rule.type === 'weekly') return ((weekMask(rule)[isoDay(day)] >>> hour) & 1) === 1;
    return inDates(rule, monthDay(day));
  }

  // Per i mesi accorpati: quale parte del mese (o dei giorni di quel tipo) cade nella regola, da 0 a 1
  function monthFraction(rule, start, hour, weekend) {
    if (rule.type === 'range') {
      const n = daysInMonth(start);
      const inside = Math.max(0, Math.min(rule.to, start + n - 1) - Math.max(rule.from, start) + 1);
      return inside / n;
    }
    if (rule.type === 'weekly') {
      // Parte dei giorni dello stesso tipo (feriali o fine settimana) in cui la regola è accesa a quest'ora
      const masks = weekMask(rule);
      const isos = weekend ? [6, 7] : [1, 2, 3, 4, 5];
      return isos.filter((iso) => (masks[iso] >>> hour) & 1).length / isos.length;
    }
    // Periodo dell'anno: dipende solo dal mese, si calcola una volta per mese e regola
    const key = `${rule.from}|${rule.to}|${start}`;
    if (!datesFractionCache.has(key)) {
      const n = daysInMonth(start);
      let inside = 0;
      for (let d = 0; d < n; d += 1) if (inDates(rule, monthDay(start + d))) inside += 1;
      datesFractionCache.set(key, inside / n);
    }
    return datesFractionCache.get(key);
  }
  const datesFractionCache = new Map();

  function isActive(ctx, day, hour) {
    if (ctx.mode === 'on') return true;
    if (ctx.mode === 'off') return false;
    return ruleMatches(ctx.rule, day, hour);
  }

  // Contesti accesi adesso, dal più forte (prevalenza più alta) e poi per nome
  function activeContexts(when = new Date()) {
    const day = localDay(when);
    return contexts.filter((ctx) => isActive(ctx, day, when.getHours()))
      .sort((a, b) => (b.boost - a.boost) || a.name.localeCompare(b.name));
  }

  // ---------- Caricamento e conversione dal formato precedente ----------

  function resetState() {
    combos = [];
    comboIndex = new Map();
    days = new Map();
    months = new Map();
    today = { day: -1, counts: new Map() };
    base = [];
    contexts = [];
    dirtyPages.clear();
    dirtyDays.clear();
    deletedIds.clear();
    dirtyBase = false;
    table = new Map();
    tableHour = -1;
  }

  function comboFor(prev, word, create) {
    const key = pairKey(prev, word);
    let index = comboIndex.get(key);
    if (index === undefined && create) {
      if (combos.length >= MAX_COMBOS) return -1;
      index = combos.length;
      combos.push([prev, word]);
      comboIndex.set(key, index);
      dirtyPages.add(Math.floor(index / COMBO_PAGE));
    }
    return index === undefined ? -1 : index;
  }

  function cleanContext(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // Nomi sempre in MAIUSCOLO (anche quelli salvati prima o importati da file)
    const name = String(raw.name || '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().toUpperCase().slice(0, NAME_MAX);
    const rule = cleanRule(raw.rule);
    if (!name || !rule) return null;
    const edits = [];
    const seen = new Set();
    (Array.isArray(raw.edits) ? raw.edits : []).slice(0, MAX_EDITS).forEach((e) => {
      if (!e || typeof e !== 'object') return;
      const prev = e.prev === START ? START : wordKey(e.prev);
      const word = wordKey(e.word);
      const weight = Number(e.weight);
      if (!prev || !word || !Number.isFinite(weight) || weight < 0) return;
      const key = pairKey(prev, word);
      if (seen.has(key)) return;
      seen.add(key);
      edits.push({ prev, word, weight: Math.min(CSV_MAX_WEIGHT, Math.round(weight * 10) / 10) });
    });
    return {
      id: typeof raw.id === 'string' && /^ctx_[\w-]{1,40}$/.test(raw.id) ? raw.id : `ctx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      profileId,
      kind: 'prediction',
      name,
      rule,
      mode: MODES.includes(raw.mode) ? raw.mode : 'auto',
      boost: BOOSTS.includes(raw.boost) ? raw.boost : 4,
      source: cleanSource(raw.source),
      edits,
      // Contesto pronto (dalla base di PicSpeak): quale e in che lingua. Mai da un file importato
      ...(typeof raw.builtin === 'string' && builtinDef(raw.builtin)
        ? { builtin: raw.builtin, lang: raw.lang === 'it' ? 'it' : 'en' } : {}),
    };
  }

  /*
   * Abitudini salvate con il formato precedente (un record per coppia, conteggio che sbiadisce, senza date):
   * diventano pesi di partenza con la data dell'ultimo uso. Si scrive prima il nuovo e poi si cancella il vecchio.
   */
  async function migrateOld(oldRecords) {
    const existing = new Set(base.map((b) => pairKey(b.prev, b.word)));
    oldRecords.forEach((r) => {
      if (r.prevWord === null || r.prevWord === undefined) return; // la parola da sola ora si ricava dalle coppie
      const prev = r.prevWord === START ? START : wordKey(r.prevWord);
      const word = wordKey(r.word);
      const at = Date.parse(r.lastUsed);
      if (!prev || !word || !(r.count > 0) || existing.has(pairKey(prev, word)) || base.length >= MAX_BASE) return;
      existing.add(pairKey(prev, word));
      base.push({ prev, word, weight: Math.round(r.count * 100) / 100, day: Number.isFinite(at) ? localDay(new Date(at)) : localDay(new Date()), ctx: null });
    });
    dirtyBase = true;
    await flush();
    await Promise.all(oldRecords.map((r) => storage.deleteRecord('usage', r.id)));
  }

  async function init(activeProfileId) {
    profileId = activeProfileId;
    const saved = await storage.get(SETTINGS_KEY);
    settings = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    settings.collect = settings.collect !== false;
    settings.suggest = settings.suggest === true;
    settings.count = COUNTS.includes(settings.count) ? settings.count : DEFAULTS.count;
    // Vecchio stile «fade» (trasparenza da sola): ora è contorno + interruttore «altre tessere trasparenti»
    if (settings.style === 'fade') { settings.style = 'outline'; settings.dim = true; }
    settings.style = STYLES.includes(settings.style) ? settings.style : DEFAULTS.style;
    settings.dim = settings.dim === true;
    settings.dimLevel = Number.isInteger(settings.dimLevel) && settings.dimLevel >= DIM_LEVEL.min
      && settings.dimLevel <= DIM_LEVEL.max && settings.dimLevel % DIM_LEVEL.step === 0
      ? settings.dimLevel : DEFAULTS.dimLevel;
    settings.width = WIDTHS.includes(settings.width) ? settings.width : DEFAULTS.width;
    settings.color = COLORS.includes(settings.color) ? settings.color : DEFAULTS.color;
    settings.showContext = settings.showContext === true;
    applyLook();

    resetState();
    const all = await usageRecordsOf(profileId);
    const pages = [];
    const old = [];
    all.forEach((r) => {
      if (r.kind === 'combos' && Number.isInteger(r.page) && Array.isArray(r.list)) pages.push(r);
      else if (r.kind === 'day' && Number.isInteger(r.day) && r.entries instanceof Uint32Array) days.set(r.day, r.entries);
      else if (r.kind === 'month' && Number.isInteger(r.day) && r.entries instanceof Uint32Array) months.set(r.day, r.entries);
      else if (r.kind === 'base' && Array.isArray(r.list)) base = r.list.filter((b) => b && typeof b.word === 'string' && Number.isFinite(b.weight));
      else if (!r.kind && typeof r.word === 'string' && Number.isFinite(r.count)) old.push(r);
    });
    pages.sort((a, b) => a.page - b.page).forEach((p) => {
      p.list.forEach((pair, i) => {
        const index = p.page * COMBO_PAGE + i;
        combos[index] = pair;
        if (Array.isArray(pair)) comboIndex.set(pairKey(pair[0], pair[1]), index);
      });
    });
    const allContexts = await storage.getAllRecords('contexts');
    contexts = allContexts.filter((c) => c && c.profileId === profileId && c.kind === 'prediction').map(cleanContext).filter(Boolean);
    if (old.length) await migrateOld(old);
    // Il riepilogo di oggi si riprende per continuare a contarlo
    const now = new Date();
    const todayDay = localDay(now);
    startDay(todayDay);
    await compactIfNeeded(todayDay);
    rebuild(now);
    scheduleHourly();
  }

  function startDay(day) {
    today = { day, counts: new Map() };
    const saved = days.get(day);
    if (saved) {
      saved.forEach((v) => {
        const key = (v >>> 14) * 32 + ((v >>> 8) & 31);
        today.counts.set(key, (today.counts.get(key) || 0) + (v & 255));
      });
    }
  }

  function todayEntries() {
    const out = new Uint32Array(today.counts.size);
    let i = 0;
    today.counts.forEach((n, key) => { out[i] = pack(Math.floor(key / 32), key % 32, n, false); i += 1; });
    return out;
  }

  function load(activeProfileId) {
    ready = init(activeProfileId);
    return ready;
  }

  // ---------- Accorpamento dei giorni molto vecchi (solo se lo storico diventa grande) ----------

  async function compactIfNeeded(todayDay) {
    let total = 0;
    days.forEach((e) => { total += e.length; });
    months.forEach((e) => { total += e.length; });
    if (total <= COMPACT_THRESHOLD) return;
    const limit = todayDay - COMPACT_AFTER_DAYS;
    const merged = new Map(); // mese → Map(chiave → conteggio)
    [...days.keys()].filter((d) => d < limit).forEach((d) => {
      const start = monthStart(d);
      if (!merged.has(start)) {
        const m = new Map();
        (months.get(start) || []).forEach((v) => { m.set(v & ~255, (m.get(v & ~255) || 0) + (v & 255)); });
        merged.set(start, m);
      }
      const m = merged.get(start);
      const weekend = isWeekendDay(d);
      days.get(d).forEach((v) => {
        const key = pack(v >>> 14, (v >>> 8) & 31, 0, weekend);
        m.set(key, (m.get(key) || 0) + (v & 255));
      });
      days.delete(d);
      deletedIds.add(dayId(d));
    });
    const records = [];
    merged.forEach((m, start) => {
      const entries = new Uint32Array(m.size);
      let i = 0;
      m.forEach((n, key) => { entries[i] = (key | Math.min(MAX_COUNT, n)) >>> 0; i += 1; });
      months.set(start, entries);
      records.push({ id: monthId(start), profileId, kind: 'month', day: start, entries });
    });
    await storage.putRecords('usage', records);
    await Promise.all([...deletedIds].map((id) => storage.deleteRecord('usage', id)));
    deletedIds.clear();
  }

  // ---------- Salvataggio ----------

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1500);
  }

  // true dopo freeze(): un'altra scheda sta ripristinando un backup, questa non deve più scrivere nell'archivio
  let frozen = false;

  function freeze() {
    frozen = true;
    clearTimeout(saveTimer);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!profileId || frozen) return;
    const records = [];
    dirtyPages.forEach((page) => {
      records.push({ id: pageId(page), profileId, kind: 'combos', page, list: combos.slice(page * COMBO_PAGE, (page + 1) * COMBO_PAGE) });
    });
    dirtyPages.clear();
    dirtyDays.forEach((day) => {
      const entries = day === today.day ? todayEntries() : days.get(day);
      if (!entries) return;
      days.set(day, entries);
      if (entries.length) records.push({ id: dayId(day), profileId, kind: 'day', day, entries });
      else deletedIds.add(dayId(day));
    });
    dirtyDays.clear();
    if (dirtyBase) {
      records.push({ id: baseId(), profileId, kind: 'base', list: base });
      dirtyBase = false;
    }
    if (records.length) await storage.putRecords('usage', records);
    if (deletedIds.size) {
      const ids = [...deletedIds];
      deletedIds.clear();
      await Promise.all(ids.map((id) => storage.deleteRecord('usage', id)));
    }
  }

  // ---------- Punteggi ----------

  // Aggiunge un contributo alla tabella
  function addScore(map, prev, word, value) {
    let row = map.get(prev);
    if (!row) { row = new Map(); map.set(prev, row); }
    row.set(word, (row.get(word) || 0) + value);
  }

  /*
   * Peso di ogni combinazione nello storico filtrato da una regola (null = tutto), con il tempo di dimezzamento
   * indicato. Restituisce Map(pairKey → { prev, word, weight, uses }).
   */
  function filteredWeights(rule, halfLife, nowDay, timeOf) {
    const out = new Map();
    const add = (c, value, uses) => {
      const pair = combos[c];
      if (!pair) return;
      const key = pairKey(pair[0], pair[1]);
      const item = out.get(key);
      if (item) { item.weight += value; item.uses += uses; } else out.set(key, { prev: pair[0], word: pair[1], weight: value, uses });
    };
    const visitDay = (day, entries) => {
      const dec = decay(nowDay - day, halfLife);
      if (!rule && dec < 1e-4) return;
      const weekend = isWeekendDay(day);
      let datesOk = true;
      if (rule && rule.type === 'dates') datesOk = inDates(rule, monthDay(day));
      if (rule && rule.type === 'range') datesOk = day >= rule.from && day <= rule.to;
      if (!datesOk) return;
      const weekly = rule && rule.type === 'weekly';
      // Ore accese in questo giorno (le fasce che passano la mezzanotte sono già comprese)
      const mask = weekly ? weekMask(rule)[isoDay(day)] : 0;
      if (weekly && !mask) return;
      for (let i = 0; i < entries.length; i += 1) {
        const v = entries[i];
        const h = (v >>> 8) & 31;
        if (weekly && !((mask >>> h) & 1)) continue;
        const n = v & 255;
        add(v >>> 14, n * dec * (timeOf ? timeOf(h, weekend) : 1), n);
      }
    };
    days.forEach((entries, day) => { if (day !== today.day) visitDay(day, entries); });
    if (today.day >= 0) visitDay(today.day, todayEntries());
    months.forEach((entries, start) => {
      const dec = decay(nowDay - (start + 14), halfLife);
      if (!rule && dec < 1e-4) return;
      for (let i = 0; i < entries.length; i += 1) {
        const v = entries[i];
        const h = (v >>> 8) & 31;
        const weekend = Boolean((v >>> 13) & 1);
        const part = rule ? monthFraction(rule, start, h, weekend) : 1;
        if (!part) continue;
        const n = v & 255;
        add(v >>> 14, n * dec * part * (timeOf ? timeOf(h, weekend) : 1), n * part);
      }
    });
    return out;
  }

  // Combinazioni di un contesto (anche non ancora salvato): storico filtrato + pesi di partenza + modifiche dell'adulto
  function contextPairs(ctx, now = new Date()) {
    const filter = filterOf(ctx);
    if (!filter) return [];
    const map = filteredWeights(filter, CONTEXT_HALF_LIFE_DAYS, localDay(now), null);
    base.filter((b) => b.ctx && b.ctx === ctx.id).forEach((b) => {
      const key = pairKey(b.prev, b.word);
      const value = b.weight * decay(localDay(now) - b.day, CONTEXT_HALF_LIFE_DAYS);
      const item = map.get(key);
      if (item) item.weight += value; else map.set(key, { prev: b.prev, word: b.word, weight: value, uses: 0 });
    });
    (ctx.edits || []).forEach((e) => {
      const key = pairKey(e.prev, e.word);
      const item = map.get(key);
      if (item) { item.weight = e.weight; item.edited = true; } else map.set(key, { prev: e.prev, word: e.word, weight: e.weight, uses: 0, edited: true });
    });
    return [...map.values()].map((item) => ({ ...item, removed: Boolean(item.edited && item.weight === 0) }))
      .sort((a, b) => (a.removed - b.removed) || (b.weight - a.weight));
  }

  /*
   * Ore di accensione di un contesto per ciascuno dei prossimi 371 giorni (un anno e una settimana): per ogni giorno
   * un numero in cui il bit h vale 1 se il contesto è acceso all'ora h. Si calcola una volta per contesto.
   */
  const ALL_HOURS = (1 << 24) - 1;
  function hourMasks(ctx, startDay) {
    const masks = new Int32Array(371);
    if (ctx.mode === 'off') return masks;
    if (ctx.mode === 'on') return masks.fill(ALL_HOURS);
    const rule = ctx.rule;
    if (rule.type === 'weekly') {
      // Le ore di un giorno dipendono solo da quale giorno della settimana è (e da quello prima)
      const week = weekMask(rule);
      for (let i = 0; i < 371; i += 1) masks[i] = week[isoDay(startDay + i)];
    } else {
      for (let i = 0; i < 371; i += 1) masks[i] = inDates(rule, monthDay(startDay + i)) ? ALL_HOURS : 0;
    }
    return masks;
  }

  /*
   * Contesti che si accendono negli stessi orari di ctx (anche non ancora salvato) e hanno combinazioni in comune:
   * [{ name, count }]. Se si accendono in orari diversi non si segnala nulla. pairs = combinazioni di ctx già
   * calcolate (facoltativo). Le combinazioni dei contesti salvati vengono dalla memoria (vedi savedPairs).
   */
  function sharedPairs(ctx, pairs, now = new Date()) {
    const rule = cleanRule(ctx.rule);
    if (!rule || ctx.mode === 'off') return [];
    const startDay = localDay(now);
    const mine = hourMasks({ mode: ctx.mode, rule }, startDay);
    let keys = null;
    const out = [];
    contexts.forEach((other) => {
      if (other.id === ctx.id || other.mode === 'off') return;
      const theirs = hourMasks(other, startDay);
      let overlap = false;
      for (let i = 0; i < 371 && !overlap; i += 1) overlap = (mine[i] & theirs[i]) !== 0;
      if (!overlap) return;
      if (!keys) keys = new Set((pairs || contextPairs(ctx, now)).filter((p) => !p.removed).map((p) => pairKey(p.prev, p.word)));
      const count = savedPairs(other, now).filter((p) => !p.removed && keys.has(pairKey(p.prev, p.word))).length;
      if (count) out.push({ name: other.name, count });
    });
    return out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  }

  /*
   * Combinazioni di un contesto salvato, tenute in memoria finché non cambia qualcosa (storico, pesi, contesti):
   * la memoria si svuota a ogni ricalcolo della tabella e a ogni tessera registrata.
   */
  const pairsCache = new Map();
  function savedPairs(ctx, now = new Date()) {
    if (!pairsCache.has(ctx.id)) pairsCache.set(ctx.id, contextPairs(ctx, now));
    return pairsCache.get(ctx.id);
  }

  // Peso generale (senza preferenza per l'ora): per statistiche ed esportazione
  // withStarter = false: senza la base di PicSpeak (le statistiche mostrano solo le abitudini vere del bambino)
  function generalWeights(now = new Date(), withStarter = true) {
    const nowDay = localDay(now);
    const map = filteredWeights(null, HALF_LIFE_DAYS, nowDay, null);
    base.filter((b) => !b.ctx && (withStarter || b.src !== STARTER)).forEach((b) => {
      const key = pairKey(b.prev, b.word);
      const value = b.weight * decay(nowDay - b.day, HALF_LIFE_DAYS);
      const item = map.get(key);
      if (item) item.weight += value; else map.set(key, { prev: b.prev, word: b.word, weight: value, uses: 0 });
    });
    return map;
  }

  // Prepara la tabella dei punteggi per l'ora attuale e i contesti attivi
  function rebuild(now = new Date()) {
    const nowDay = localDay(now);
    const hour = now.getHours();
    const weekendNow = isWeekendDay(nowDay);
    // Le abitudini della stessa ora e dello stesso tipo di giorno contano un po' di più
    const timeOf = (h, weekend) => 1 + (h === hour ? 0.5 : 0) + (weekend === weekendNow ? 0.25 : 0);
    const next = new Map();
    pairsCache.clear();
    filteredWeights(null, HALF_LIFE_DAYS, nowDay, timeOf).forEach((item) => addScore(next, item.prev, item.word, item.weight));
    base.filter((b) => !b.ctx).forEach((b) => addScore(next, b.prev, b.word, b.weight * decay(nowDay - b.day, HALF_LIFE_DAYS)));
    /*
     * Spinta dei contesti accesi. Se la stessa combinazione è in più contesti accesi insieme, le spinte NON si
     * sommano: vale solo la più forte (altrimenti due contesti simili gonfierebbero troppo la stessa parola).
     */
    const boosts = new Map();
    activeContexts(now).forEach((ctx) => {
      savedPairs(ctx, now).forEach((item) => {
        if (item.removed) return;
        const key = pairKey(item.prev, item.word);
        const value = ctx.boost * item.weight;
        const old = boosts.get(key);
        if (!old || value > old.value) boosts.set(key, { prev: item.prev, word: item.word, value });
      });
    });
    boosts.forEach((b) => addScore(next, b.prev, b.word, b.value));
    table = next;
    tableHour = nowDay * 24 + hour;
    updateContextTag(now);
  }

  // Ricalcolo allo scoccare di ogni ora (i contesti si accendono e si spengono da soli)
  function scheduleHourly() {
    clearTimeout(hourTimer);
    const now = new Date();
    const wait = (60 - now.getMinutes()) * 60000 - now.getSeconds() * 1000 + 500;
    hourTimer = setTimeout(() => {
      rebuild();
      scheduleHourly();
      if (window.PicSpeak.app) window.PicSpeak.app.applySuggestions();
    }, wait);
  }

  function ensureFresh(now) {
    if (localDay(now) * 24 + now.getHours() !== tableHour) rebuild(now);
  }

  // ---------- Registrazione ----------

  /*
   * Registra una tessera aggiunta alla frase. prevItem = tessera precedente nella frase (o null).
   */
  function record(item, prevItem) {
    if (!settings.collect || !profileId || !item) return;
    const word = wordKey(item.label);
    if (!word) return;
    const prev = prevItem ? wordKey(prevItem.label) || START : START;
    const now = new Date();
    const day = localDay(now);
    if (day !== today.day) {
      if (today.day >= 0 && today.counts.size) { days.set(today.day, todayEntries()); dirtyDays.add(today.day); }
      startDay(day);
    }
    const c = comboFor(prev, word, true);
    if (c < 0) return;
    const key = c * 32 + now.getHours();
    const n = today.counts.get(key) || 0;
    if (n >= MAX_COUNT) return;
    today.counts.set(key, n + 1);
    dirtyDays.add(day);
    pairsCache.clear();
    // La tabella si aggiorna subito, senza ricalcolare tutto
    ensureFresh(now);
    // Uso di adesso: stessa ora e stesso tipo di giorno, più la spinta del contesto più forte (non la somma)
    let ctxBoost = 0;
    activeContexts(now).forEach((ctx) => {
      const edited = ctx.edits.some((e) => e.prev === prev && e.word === word);
      if (!edited && ruleMatches(ctx.rule, day, now.getHours())) ctxBoost = Math.max(ctxBoost, ctx.boost);
    });
    addScore(table, prev, word, 1.75 + ctxBoost);
    scheduleSave();
  }

  /*
   * Parole probabili dopo la tessera indicata (null = inizio della frase), in ordine.
   * Restituisce [{ word, score }].
   */
  function candidates(prevItem) {
    const prev = prevItem ? wordKey(prevItem.label) || START : START;
    ensureFresh(new Date());
    const row = table.get(prev);
    if (!row) return [];
    const list = [];
    row.forEach((score, word) => { if (score >= MIN_SCORE) list.push({ word, score }); });
    return list.sort((a, b) => b.score - a.score);
  }

  function stats() {
    const weights = generalWeights(new Date(), false);
    let uses = 0;
    let entries = 0;
    const count = (list) => { entries += list.length; list.forEach((v) => { uses += v & 255; }); };
    days.forEach((list, day) => { if (day !== today.day) count(list); });
    count(todayEntries());
    months.forEach(count);
    base.forEach((b) => { if (!b.ctx && b.weight > 0 && b.src !== STARTER) uses += Math.round(b.weight); });
    const top = [...weights.values()].filter((item) => item.prev !== START && item.weight > 0)
      .sort((a, b) => b.weight - a.weight).slice(0, 5).map((item) => ({ from: item.prev, to: item.word, score: item.weight }));
    const dayCount = new Set([...days.keys(), ...(today.counts.size ? [today.day] : [])]).size;
    // Spazio approssimato: 4 byte per voce più le parole delle combinazioni
    let bytes = entries * 4;
    combos.forEach((p) => { bytes += (p[0].length + p[1].length + 8); });
    bytes += base.length * 40;
    return { uses, pairs: weights.size, top, days: dayCount, months: months.size, bytes };
  }

  /*
   * Cancella lo storico e i pesi di partenza del profilo (i contesti e le loro modifiche restano).
   * keepStarter: la base di partenza e i pesi dei contesti pronti restano (pulsante «Cancella le abitudini»);
   * senza, si cancella tutto (Cancella tutto, Sostituisci da file).
   */
  async function clearAll({ keepStarter = false } = {}) {
    clearTimeout(saveTimer);
    const ids = [];
    (await usageRecordsOf(profileId)).forEach((r) => ids.push(r.id));
    const kept = keepStarter ? base.filter((b) => b.src === STARTER) : [];
    resetStateKeepContexts();
    await Promise.all(ids.map((id) => storage.deleteRecord('usage', id)));
    if (kept.length) { base = kept; dirtyBase = true; await flush(); }
    rebuild();
  }

  function resetStateKeepContexts() {
    const keep = contexts;
    resetState();
    contexts = keep;
    startDay(localDay(new Date()));
  }

  // ---------- Contesti: elenco, salvataggio, eliminazione ----------

  function listContexts() {
    const now = new Date();
    const day = localDay(now);
    return contexts.map((ctx) => ({ ...ctx, edits: ctx.edits.map((e) => ({ ...e })), activeNow: isActive(ctx, day, now.getHours()) }));
  }

  // Salva un contesto (nuovo o modificato). Restituisce il contesto salvato o lancia ContextError
  async function saveContext(raw) {
    const ctx = cleanContext({ ...raw, name: raw.name });
    if (!String(raw.name || '').trim()) throw new ContextError('name');
    if (!ctx) throw new ContextError('rule');
    const index = contexts.findIndex((c) => c.id === ctx.id);
    // Un contesto pronto resta tale anche dopo le modifiche (si può riportare all'originale)
    if (index >= 0 && contexts[index].builtin) { ctx.builtin = contexts[index].builtin; ctx.lang = contexts[index].lang; }
    const clash = contexts.find((c) => c.id !== ctx.id && c.name.toLowerCase() === ctx.name.toLowerCase());
    if (clash) throw new ContextError('duplicate');
    if (index < 0 && contexts.length >= MAX_CONTEXTS) throw new ContextError('full');
    if (index >= 0) contexts[index] = ctx; else contexts.push(ctx);
    await storage.putRecord('contexts', ctx);
    rebuild();
    return ctx;
  }

  async function deleteContext(id) {
    contexts = contexts.filter((c) => c.id !== id);
    const before = base.length;
    base = base.filter((b) => b.ctx !== id);
    if (base.length !== before) { dirtyBase = true; await flush(); }
    await storage.deleteRecord('contexts', id);
    rebuild();
  }

  class ContextError extends Error {}

  // ---------- Esportare e importare le abitudini (CSV modificabile con un foglio di calcolo) ----------

  class CsvError extends Error {}

  // Un testo che inizia con = + - @ verrebbe letto come formula dal foglio di calcolo: si fa precedere da '
  function csvCell(value) {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    // Anche dopo un separatore interno: un foglio di calcolo che divide sulla virgola non deve vedere una formula
    text = text.replace(/([,;\t])(\s*)([=+\-@])/g, "$1$2'$3");
    return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function startLabel(lang) {
    return lang === 'it' ? '(inizio)' : '(start)';
  }

  /*
   * Testo CSV: una riga per coppia con il peso attuale (colonna «contesto» vuota) e, per ogni contesto,
   * le sue combinazioni con il peso nel contesto. Le righe con peso quasi nullo non si scrivono
   * (reimportate con peso 0 cancellerebbero la coppia). Separatore «;».
   */
  function exportCsv(lang) {
    const decimal = lang === 'it' ? ',' : '.';
    const head = lang === 'it' ? ['parola precedente', 'parola', 'peso', 'contesto'] : ['previous word', 'word', 'weight', 'context'];
    const rows = [];
    generalWeights().forEach((item) => { if (item.weight >= 0.05) rows.push([item.prev, item.word, item.weight, '']); });
    rows.sort((a, b) => b[2] - a[2]);
    contexts.forEach((ctx) => {
      contextPairs(ctx).forEach((item) => {
        if (item.removed) rows.push([item.prev, item.word, 0, ctx.name]);
        else if (item.weight >= 0.05) rows.push([item.prev, item.word, item.weight, ctx.name]);
      });
    });
    const lines = [head.map(csvCell).join(';')];
    rows.forEach(([prev, word, weight, ctx]) => {
      lines.push([csvCell(prev === START ? startLabel(lang) : prev), csvCell(word),
        (Math.round(weight * 10) / 10).toString().replace('.', decimal), csvCell(ctx)].join(';'));
    });
    return `﻿${lines.join('\r\n')}\r\n`;
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
   * Legge un CSV delle abitudini. Restituisce { rows: [{ prev, word, weight, context }], skipped }.
   * prev = START per l'inizio della frase; context = nome del contesto ('' = abitudini generali).
   * Le righe non valide vengono saltate e contate. I file con tre colonne (versione precedente) restano validi.
   */
  function parseCsv(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim());
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
      const context = String(cells[3] || '').slice(0, NAME_MAX).trim();
      rows.push({ prev, word, weight: Math.min(weight, CSV_MAX_WEIGHT), context });
    });
    if (!rows.length) throw new CsvError('empty');
    return { rows, skipped };
  }

  async function readCsvFile(file) {
    if (!file || file.size > CSV_MAX_BYTES) throw new CsvError('size');
    return parseCsv(await file.text());
  }

  // Toglie dallo storico tutti gli usi di una combinazione (peso 0 nel file)
  // set = insieme degli indici delle combinazioni da togliere (un solo passaggio sullo storico)
  function deletePairHistory(set) {
    const strip = (entries) => entries.filter((v) => !set.has(v >>> 14));
    days.forEach((entries, day) => {
      const next = strip(entries);
      if (next.length !== entries.length) { days.set(day, next); dirtyDays.add(day); }
    });
    months.forEach((entries, start) => {
      const next = strip(entries);
      if (next.length !== entries.length) {
        months.set(start, next);
        if (next.length && !frozen) storage.putRecord('usage', { id: monthId(start), profileId, kind: 'month', day: start, entries: next });
        else deletedIds.add(monthId(start));
      }
    });
    [...today.counts.keys()].forEach((key) => { if (set.has(Math.floor(key / 32))) today.counts.delete(key); });
    if (today.day >= 0) dirtyDays.add(today.day);
  }

  /*
   * Applica le righe importate. Righe senza contesto: il peso della coppia diventa quello del file
   * (si aggiunge un peso di partenza pari alla differenza con lo storico); peso 0 toglie la coppia anche dallo storico.
   * Righe con un contesto: il peso nel contesto diventa quello del file (0 = tolta dal contesto);
   * un contesto che non esiste su questo dispositivo fa saltare la riga.
   * mode 'replace': prima si tolgono tutti i pesi di partenza e le modifiche dei contesti (lo storico resta).
   * Restituisce { imported, unknown }.
   */
  async function importRows(rows, mode) {
    if (!profileId) return { imported: 0, unknown: 0 };
    if (mode === 'replace') {
      // Restano solo i pesi dei contesti pronti (fanno parte del contesto, non delle abitudini)
      base = base.filter((b) => b.ctx && b.src === STARTER);
      dirtyBase = true;
      contexts.forEach((ctx) => { ctx.edits = []; });
    }
    if (base.length + rows.filter((r) => !r.context).length > MAX_BASE) throw new CsvError('full');
    const nowDay = localDay(new Date());
    const history = generalWeightsFromHistory(nowDay);
    let imported = 0;
    let unknown = 0;
    const touched = new Set();
    // Pesi generali indicizzati per coppia (niente ricerche ripetute su tutto l'elenco)
    const general = new Map();
    const others = [];
    base.forEach((b) => { if (b.ctx) others.push(b); else general.set(pairKey(b.prev, b.word), b); });
    const toDelete = new Set();
    rows.forEach(({ prev, word, weight, context }) => {
      const key = pairKey(prev, word);
      if (context) {
        const ctx = contexts.find((c) => c.name.toLowerCase() === context.toLowerCase());
        if (!ctx) { unknown += 1; return; }
        ctx.edits = ctx.edits.filter((e) => pairKey(e.prev, e.word) !== key);
        if (ctx.edits.length >= MAX_EDITS) { unknown += 1; return; }
        ctx.edits.push({ prev, word, weight: Math.round(weight * 10) / 10 });
        touched.add(ctx);
        imported += 1;
        return;
      }
      general.delete(key);
      if (weight === 0) {
        const c = comboFor(prev, word, false);
        if (c >= 0) toDelete.add(c);
      } else {
        const fromHistory = history.get(key) || 0;
        general.set(key, { prev, word, weight: Math.round((weight - fromHistory) * 100) / 100, day: nowDay, ctx: null });
      }
      dirtyBase = true;
      imported += 1;
    });
    base = [...others, ...general.values()];
    if (toDelete.size) deletePairHistory(toDelete);
    const changed = mode === 'replace' ? contexts : [...touched];
    await Promise.all(changed.map((ctx) => storage.putRecord('contexts', ctx)));
    await flush();
    rebuild();
    return { imported, unknown };
  }

  function generalWeightsFromHistory(nowDay) {
    const out = new Map();
    filteredWeights(null, HALF_LIFE_DAYS, nowDay, null).forEach((item, key) => out.set(key, item.weight));
    return out;
  }

  // ---------- Storico completo e contesti in un file a parte (anche parte del futuro backup) ----------

  class HistoryError extends Error {}

  // Oggetto con lo storico, i pesi di partenza e i contesti del profilo attivo (formato in docs/FORMATO-DATI.md)
  function exportData() {
    const dayList = [];
    days.forEach((entries, day) => { if (day !== today.day && entries.length) dayList.push([day, Array.from(entries)]); });
    if (today.counts.size) dayList.push([today.day, Array.from(todayEntries())]);
    dayList.sort((a, b) => a[0] - b[0]);
    const monthList = [...months].filter(([, e]) => e.length).map(([start, e]) => [start, Array.from(e)]).sort((a, b) => a[0] - b[0]);
    const nameOf = (id) => (contexts.find((c) => c.id === id) || {}).name || null;
    return {
      format: 'picspeak',
      kind: 'habits',
      formatVersion: HISTORY_FORMAT_VERSION,
      app: 'PicSpeak',
      createdAt: new Date().toISOString(),
      combos: combos.map((p) => [p[0], p[1]]),
      days: dayList,
      months: monthList,
      base: base.map((b) => [b.prev, b.word, b.weight, b.day, b.ctx ? nameOf(b.ctx) : null]).filter((b) => b[4] !== undefined),
      contexts: contexts.map(contextOut),
    };
  }

  function contextOut(c) {
    return { name: c.name, rule: c.rule, source: c.source, mode: c.mode, boost: c.boost, edits: c.edits.map((e) => [e.prev, e.word, e.weight]) };
  }

  // Un contesto da solo (regola, periodo, modifiche e pesi di partenza), per darlo a un'altra famiglia o a scuola
  function exportContextJson(id) {
    const ctx = contexts.find((c) => c.id === id);
    if (!ctx) return null;
    return JSON.stringify({
      format: 'picspeak',
      kind: 'contexts',
      formatVersion: HISTORY_FORMAT_VERSION,
      app: 'PicSpeak',
      createdAt: new Date().toISOString(),
      combos: [],
      days: [],
      months: [],
      base: base.filter((b) => b.ctx === id).map((b) => [b.prev, b.word, b.weight, b.day, ctx.name]),
      contexts: [contextOut(ctx)],
    });
  }

  function exportJson() {
    return JSON.stringify(exportData());
  }

  // Controlla un file dello storico e restituisce i dati puliti (lancia HistoryError)
  function parseHistory(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (error) { throw new HistoryError('format'); }
    if (!obj || obj.format !== 'picspeak' || (obj.kind !== 'habits' && obj.kind !== 'contexts')) throw new HistoryError('format');
    if (!Number.isInteger(obj.formatVersion) || obj.formatVersion > HISTORY_FORMAT_VERSION) throw new HistoryError('version');
    const list = (v) => (Array.isArray(v) ? v : []);
    if (list(obj.combos).length > MAX_COMBOS || list(obj.days).length > HISTORY_MAX_DAYS
      || list(obj.months).length > HISTORY_MAX_DAYS || list(obj.base).length > MAX_BASE
      || list(obj.contexts).length > MAX_CONTEXTS) throw new HistoryError('size');
    const pairs = list(obj.combos).map((p) => {
      if (!Array.isArray(p)) return null;
      const prev = p[0] === START ? START : wordKey(p[0]);
      const word = wordKey(p[1]);
      return prev && word ? [prev, word] : null;
    });
    const cleanEntries = (raw, allowWeekend) => {
      const out = [];
      const items = list(raw).slice(0, HISTORY_MAX_ENTRIES_PER_DAY);
      totalEntries += items.length;
      if (totalEntries > HISTORY_MAX_TOTAL_ENTRIES) throw new HistoryError('size');
      items.forEach((v) => {
        if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) return;
        const c = v >>> 14;
        const h = (v >>> 8) & 31;
        const n = v & 255;
        if (!pairs[c] || h > 23 || !n || (!allowWeekend && ((v >>> 13) & 1))) return;
        out.push(v >>> 0);
      });
      return out;
    };
    // Niente giorni nel futuro: non sbiadirebbero mai
    const maxDay = localDay(new Date()) + 1;
    const validDay = (d) => Number.isInteger(d) && d > 0 && d <= maxDay;
    // Tetto sul totale delle voci (memoria e tempo di calcolo)
    let totalEntries = 0;
    const daysOut = list(obj.days).filter((d) => Array.isArray(d) && validDay(d[0])).map((d) => [d[0], cleanEntries(d[1], false)]);
    const monthsOut = list(obj.months).filter((d) => Array.isArray(d) && validDay(d[0])).map((d) => [monthStart(d[0]), cleanEntries(d[1], true)]);
    const ctxOut = list(obj.contexts).map((c) => {
      if (!c || typeof c !== 'object') return null;
      return cleanContext({
        name: c.name, rule: c.rule, source: c.source, mode: c.mode, boost: c.boost,
        edits: list(c.edits).map((e) => (Array.isArray(e) ? { prev: e[0], word: e[1], weight: e[2] } : null)),
      });
    }).filter(Boolean);
    const baseOut = list(obj.base).map((b) => {
      if (!Array.isArray(b)) return null;
      const prev = b[0] === START ? START : wordKey(b[0]);
      const word = wordKey(b[1]);
      const weight = Number(b[2]);
      if (!prev || !word || !Number.isFinite(weight) || Math.abs(weight) > CSV_MAX_WEIGHT || !validDay(b[3])) return null;
      const ctxName = typeof b[4] === 'string' ? b[4].replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, NAME_MAX) : null;
      return { prev, word, weight, day: b[3], ctxName: ctxName || null };
    }).filter(Boolean);
    // Un file «solo contesti» (da un'altra famiglia o dalla scuola) non tocca lo storico né i pesi generali
    if (obj.kind === 'contexts') {
      const names = new Set(ctxOut.map((c) => c.name.toLowerCase()));
      return { kind: obj.kind, pairs: [], days: [], months: [], base: baseOut.filter((b) => b.ctxName && names.has(b.ctxName.toLowerCase())), contexts: ctxOut };
    }
    return { kind: obj.kind, pairs, days: daysOut, months: monthsOut, base: baseOut, contexts: ctxOut };
  }

  async function readHistoryFile(file) {
    if (!file || file.size > HISTORY_MAX_BYTES) throw new HistoryError('size');
    const parsed = parseHistory(await file.text());
    const dayCount = parsed.days.length;
    return { parsed, summary: { kind: parsed.kind, days: dayCount, contexts: parsed.contexts.length, names: parsed.contexts.map((c) => c.name) } };
  }

  /*
   * Applica un file dello storico. mode 'merge': i conteggi si sommano, i contesti con lo stesso nome vengono
   * sostituiti da quelli del file; 'replace': storico, pesi di partenza e contesti del profilo vengono sostituiti.
   */
  async function importData(parsed, mode) {
    if (!profileId) return;
    await flush();
    if (mode === 'replace') {
      const ids = contexts.map((c) => c.id);
      await clearAll();
      await Promise.all(ids.map((id) => storage.deleteRecord('contexts', id)));
      contexts = [];
    }
    // Contesti
    const idByName = new Map(contexts.map((c) => [c.name.toLowerCase(), c.id]));
    const fromFile = new Map(); // nome nel file → id su questo dispositivo
    for (const ctx of parsed.contexts) {
      // Il file può essere stato letto mentre era attivo un altro profilo (ripristino in un profilo nuovo):
      // il contesto appartiene sempre al profilo in cui entra
      ctx.profileId = profileId;
      const fileName = ctx.name.toLowerCase();
      let existing = idByName.get(fileName);
      // Un contesto pronto non viene sostituito da uno importato: quello del file entra accanto, con un altro nome
      if (existing && contexts.some((c) => c.id === existing && c.builtin)) {
        ctx.name = freeName(ctx.name, idByName);
        existing = null;
      }
      if (existing) ctx.id = existing;
      else if (contexts.length >= MAX_CONTEXTS) { fromFile.set(fileName, null); continue; } // non entra: i suoi pesi neanche
      fromFile.set(fileName, ctx.id);
      const index = contexts.findIndex((c) => c.id === ctx.id);
      if (index >= 0) contexts[index] = ctx; else contexts.push(ctx);
      idByName.set(ctx.name.toLowerCase(), ctx.id);
      await storage.putRecord('contexts', ctx);
    }
    // Combinazioni del file → combinazioni di questo dispositivo
    // Si creano solo le combinazioni davvero usate da qualche voce del file
    const map = new Map();
    const remap = (v) => {
      const from = v >>> 14;
      if (!map.has(from)) {
        const p = parsed.pairs[from];
        map.set(from, p ? comboFor(p[0], p[1], true) : -1);
      }
      const c = map.get(from);
      return c >= 0 ? (((c << 14) | (v & 0x3fff)) >>> 0) : null;
    };
    const mergeInto = (target, keyFn, entries) => {
      const m = new Map();
      (target || []).forEach((v) => m.set(v & ~255, (m.get(v & ~255) || 0) + (v & 255)));
      entries.forEach((v) => {
        const r = remap(v);
        if (r === null) return;
        m.set(r & ~255, Math.min(MAX_COUNT, (m.get(r & ~255) || 0) + (r & 255)));
      });
      const out = new Uint32Array(m.size);
      let i = 0;
      m.forEach((n, key) => { out[i] = (key | Math.min(MAX_COUNT, n)) >>> 0; i += 1; });
      return out;
    };
    parsed.days.forEach(([day, entries]) => {
      if (day === today.day) {
        entries.forEach((v) => {
          const r = remap(v);
          if (r === null) return;
          const key = (r >>> 14) * 32 + ((r >>> 8) & 31);
          today.counts.set(key, Math.min(MAX_COUNT, (today.counts.get(key) || 0) + (r & 255)));
        });
      } else days.set(day, mergeInto(days.get(day), null, entries));
      dirtyDays.add(day);
    });
    const monthRecords = [];
    parsed.months.forEach(([start, entries]) => {
      const merged = mergeInto(months.get(start), null, entries);
      months.set(start, merged);
      monthRecords.push({ id: monthId(start), profileId, kind: 'month', day: start, entries: merged });
    });
    if (monthRecords.length) await storage.putRecords('usage', monthRecords);
    // Pesi di partenza
    const byKey = new Map(base.map((x) => [`${x.ctx || ''}\u0002${pairKey(x.prev, x.word)}`, x]));
    parsed.base.forEach((b) => {
      const lower = b.ctxName ? b.ctxName.toLowerCase() : null;
      const ctxId = lower ? (fromFile.has(lower) ? fromFile.get(lower) : idByName.get(lower)) : null;
      // Mai pesi da un file su un contesto pronto
      if (ctxId && contexts.some((c) => c.id === ctxId && c.builtin)) return;
      if (b.ctxName && !ctxId) return;
      const key = `${ctxId || ''}\u0002${pairKey(b.prev, b.word)}`;
      if (!byKey.has(key) && byKey.size >= MAX_BASE) return;
      byKey.set(key, { prev: b.prev, word: b.word, weight: b.weight, day: b.day, ctx: ctxId || null });
    });
    base = [...byKey.values()];
    dirtyBase = true;
    await flush();
    rebuild();
  }

  // Nome libero per un contesto importato che ha lo stesso nome di un contesto pronto: «SCUOLA 2», «SCUOLA 3»…
  function freeName(name, idByName) {
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${name.slice(0, NAME_MAX - 3).trim()} ${n}`;
      if (!idByName.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  // ---------- Base di partenza e contesti pronti (dati costanti in prediction-base.js) ----------

  /*
   * Base generale: combinazioni di parole di base con pesi bassi (2–4), salvate come pesi di partenza con il segno
   * src: 'starter' e la data di oggi, così sbiadiscono come l'uso reale e si tolgono tutte insieme.
   * Contesti pronti: contesti normali (modificabili, esportabili) con il campo builtin; le loro combinazioni sono pesi
   * di partenza del contesto (sbiadiscono in un anno) e non modifiche dell'adulto, così l'uso reale le supera.
   */
  const baseData = () => window.PicSpeak.predictionBase || { general: {}, contexts: [] };
  const baseLang = (lang) => (lang === 'it' ? 'it' : 'en');

  function builtinDef(id) {
    return baseData().contexts.find((c) => c.id === id) || null;
  }

  function starterBaseOn() {
    return base.some((b) => !b.ctx && b.src === STARTER);
  }

  // Accende (con la data di oggi) o spegne la base generale. Un peso già messo dall'adulto per la stessa coppia resta
  async function setStarterBase(on, lang) {
    if (!profileId) return;
    base = base.filter((b) => b.ctx || b.src !== STARTER);
    if (on) {
      const day = localDay(new Date());
      const have = new Set(base.filter((b) => !b.ctx).map((b) => pairKey(b.prev, b.word)));
      (baseData().general[baseLang(lang)] || []).forEach(([prev, word, weight]) => {
        if (have.has(pairKey(prev, word)) || base.length >= MAX_BASE) return;
        base.push({ prev, word, weight, day, ctx: null, src: STARTER });
      });
    }
    dirtyBase = true;
    await flush();
    rebuild();
  }

  // Contesti pronti con lo stato su questo profilo: { id, name, rule, contextId (se aggiunto), clash (nome già usato) }
  function builtinContexts(lang) {
    const l = baseLang(lang);
    return baseData().contexts.map((def) => {
      const added = contexts.find((c) => c.builtin === def.id);
      const name = def.name[l];
      return {
        id: def.id,
        name,
        rule: cleanRule(def.rule),
        count: def.pairs[l].length,
        contextId: added ? added.id : null,
        clash: !added && contexts.some((c) => c.name.toLowerCase() === name.toLowerCase()),
      };
    });
  }

  function putBuiltinWeights(ctx, def) {
    base = base.filter((b) => b.ctx !== ctx.id);
    const day = localDay(new Date());
    def.pairs[ctx.lang].forEach(([prev, word, weight]) => {
      if (base.length < MAX_BASE) base.push({ prev, word, weight, day, ctx: ctx.id, src: STARTER });
    });
    dirtyBase = true;
  }

  // Aggiunge un contesto pronto, acceso secondo la sua regola di esempio. Lancia ContextError
  async function addBuiltin(id, lang) {
    const def = builtinDef(id);
    if (!def || !profileId) throw new ContextError('rule');
    const already = contexts.find((c) => c.builtin === id);
    if (already) return already;
    const l = baseLang(lang);
    if (contexts.some((c) => c.name.toLowerCase() === def.name[l].toLowerCase())) throw new ContextError('duplicate');
    if (contexts.length >= MAX_CONTEXTS) throw new ContextError('full');
    const ctx = cleanContext({ name: def.name[l], rule: def.rule, mode: 'auto', boost: def.boost, builtin: id, lang: l, edits: [] });
    if (!ctx) throw new ContextError('rule');
    contexts.push(ctx);
    await storage.putRecord('contexts', ctx);
    putBuiltinWeights(ctx, def);
    await flush();
    rebuild();
    return ctx;
  }

  // Riporta un contesto pronto com'era all'inizio: nome, regola, accensione, prevalenza, combinazioni e pesi
  async function restoreBuiltin(id) {
    const index = contexts.findIndex((c) => c.id === id);
    const old = contexts[index];
    const def = old && builtinDef(old.builtin);
    if (!def) throw new ContextError('rule');
    const original = def.name[old.lang];
    const nameTaken = contexts.some((c) => c.id !== id && c.name.toLowerCase() === original.toLowerCase());
    const ctx = cleanContext({ id, name: nameTaken ? old.name : original, rule: def.rule, mode: 'auto', boost: def.boost, builtin: old.builtin, lang: old.lang, edits: [] });
    contexts[index] = ctx;
    await storage.putRecord('contexts', ctx);
    putBuiltinWeights(ctx, def);
    await flush();
    rebuild();
    return ctx;
  }

  // ---------- Aspetto dei suggerimenti ----------

  function applyLook() {
    document.documentElement.dataset.suggestWidth = settings.width;
    document.documentElement.dataset.suggestColor = settings.color;
    // Opacità delle tessere non suggerite = 100% meno la trasparenza scelta
    document.documentElement.style.setProperty('--suggest-fade-opacity', String((100 - settings.dimLevel) / 100));
  }

  /*
   * Nome del contesto acceso nella barra della pagina, accanto ai tre puntini (facoltativo, spento all'inizio).
   * Solo testo da leggere: non si tocca e non cambia nulla.
   */
  function updateContextTag(now = new Date()) {
    const tag = document.getElementById('context-tag');
    if (!tag) return;
    const names = settings.showContext ? activeContexts(now).map((c) => c.name) : [];
    tag.replaceChildren(...contextNameNodes(names));
    tag.hidden = !names.length;
  }

  /*
   * Più contesti accesi insieme: al massimo due nomi dove c'è spazio («SCUOLA · CASA +2»), uno sugli schermi stretti
   * («SCUOLA +3»; il CSS sceglie quale mostrare). Il primo è quello con la prevalenza più alta. L'elenco completo
   * resta nella pagina dei contesti.
   */
  function contextNameNodes(names) {
    // Il «+N» sta in un elemento a parte, fuori dal troncamento: con un nome lungo si accorcia solo il nome
    const variant = (cls, shown) => {
      const box = document.createElement('span');
      box.className = cls;
      const text = document.createElement('span');
      text.className = 'ctx-names-text';
      text.textContent = names.slice(0, shown).join(' · ');
      box.append(text);
      if (names.length > shown) {
        const more = document.createElement('span');
        more.className = 'ctx-names-more';
        more.textContent = `+${names.length - shown}`;
        box.append(more);
      }
      return box;
    };
    return [variant('ctx-names-full', 2), variant('ctx-names-short', 1)];
  }

  async function setSettings(changes) {
    settings = { ...settings, ...changes };
    applyLook();
    updateContextTag();
    await storage.set(SETTINGS_KEY, settings);
  }

  // Salva subito quando la pagina viene nascosta; al ritorno si ricalcola (può essere cambiata l'ora o il giorno)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
    else if (profileId) { rebuild(); scheduleHourly(); }
  });

  window.PicSpeak.predict = {
    load,
    usageRecordsOf,
    record,
    candidates,
    wordKey,
    stats,
    clearAll,
    setSettings,
    exportCsv,
    readCsvFile,
    importRows,
    exportJson,
    exportContextJson,
    exportData,
    readHistoryFile,
    importData,
    listContexts,
    saveContext,
    deleteContext,
    contextPairs,
    sharedPairs,
    starterBaseOn,
    setStarterBase,
    builtinContexts,
    addBuiltin,
    restoreBuiltin,
    MAX_SLOTS,
    HISTORY_FORMAT_VERSION,
    activeContexts: () => activeContexts().map((c) => c.name),
    cleanRule,
    cleanSource,
    flush,
    freeze,
    CsvError,
    ContextError,
    HistoryError,
    START,
    BOOSTS,
    MODES,
    NAME_MAX,
    STYLES,
    DIM_LEVEL,
    WIDTHS,
    COLORS,
    contextNameNodes,
    get settings() { return { ...settings }; },
    get ready() { return ready; },
  };
})();
