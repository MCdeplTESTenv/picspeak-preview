/*
 * Modello dei dati di PicSpeak (vedi docs/FORMATO-DATI.md).
 * Carica il profilo attivo con le sue schede e immagini; al primo avvio crea il profilo
 * predefinito "bambino" a partire dalle schede di prova (sample-data.js).
 * Tutto resta sul dispositivo (IndexedDB tramite storage.js).
 */
(function () {
  'use strict';

  const { storage, sampleData, i18n } = window.PicSpeak;

  const DEFAULT_COLS = 4;
  // Tipi di parola (chiave di Fitzgerald modificata): ognuno ha il suo colore automatico.
  // 'question' (domande) e 'connector' (parole di collegamento: e, con, di…) aggiunti il 17/11/2026.
  const WORD_TYPES = ['pronoun', 'verb', 'noun', 'adjective', 'social', 'negation', 'question', 'connector'];

  const model = {
    profile: null,
    pages: new Map(),
    images: new Map(),
  };
  const objectUrls = new Map(); // id immagine → URL temporaneo del blob

  // Identificativo casuale, stabile per tutta la vita dell'elemento
  function newId(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  function now() {
    return new Date().toISOString();
  }

  // ---------- Primo avvio: profilo predefinito dalle schede di prova ----------

  function arasaacImage(id, labelIt, labelEn) {
    return {
      id: `img_ar_${id}`,
      source: 'arasaac',
      sourceId: String(id),
      author: 'Sergio Palao',
      owner: 'Gobierno de Aragón',
      license: 'CC BY-NC-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      mime: 'image/png',
      path: `symbols/arasaac/${id}.png`, // immagine inclusa nel tool (nessun blob da salvare)
      keywords: { it: [labelIt], en: [labelEn] },
      addedAt: now(),
    };
  }

  // Crea un profilo con le schede di prova (prima apertura o «Aggiungi un profilo»), senza renderlo attivo
  async function seedDefaultProfile(profileId, name = '') {
    const lang = i18n.language;
    const images = new Map();
    const pageIds = {};
    Object.keys(sampleData.pages).forEach((key) => { pageIds[key] = newId('pg'); });

    const pages = Object.entries(sampleData.pages).map(([key, page]) => {
      const cells = page.cells.map((symbolKey, index) => {
        const item = sampleData.symbols[symbolKey] || sampleData.folders[symbolKey];
        let imageId = null;
        if (item.arasaac) {
          const image = arasaacImage(item.arasaac, item.label.it, item.label.en);
          images.set(image.id, image);
          imageId = image.id;
        }
        const isFolder = item.type === 'folder';
        return {
          id: newId('c'),
          row: Math.floor(index / DEFAULT_COLS),
          col: index % DEFAULT_COLS,
          kind: isFolder ? 'folder' : 'symbol',
          label: item.label[lang] ?? item.label.it,
          speak: null,
          imageId,
          wordType: isFolder ? null : item.type,
          color: null,
          targetPageId: isFolder ? pageIds[item.target] : null,
          hidden: false,
          locked: false,
          audioId: null,
        };
      });
      return {
        id: pageIds[key],
        profileId,
        title: page.title[lang] ?? page.title.it,
        grid: { rows: Math.ceil(cells.length / DEFAULT_COLS), cols: DEFAULT_COLS },
        contextIds: [],
        cells,
        updatedAt: now(),
      };
    });

    const profile = {
      id: profileId,
      name,
      kind: 'child',
      language: lang,
      homePageId: pageIds[sampleData.homePage],
      activeContextIds: [],
      createdAt: now(),
      updatedAt: now(),
    };

    await storage.putRecords('images', [...images.values()]);
    await storage.putRecords('pages', pages);
    await storage.putRecord('profiles', profile);
    return profile;
  }

  // ---------- Caricamento ----------

  async function load() {
    // Si carica solo il profilo in uso; alla prima apertura si crea con l'id già preparato dall'archivio
    const profileId = await storage.activeProfileId();
    let profile = await storage.getRecord('profiles', profileId);
    if (!profile) profile = await seedDefaultProfile(profileId);
    const [pages, images] = await Promise.all([
      storage.getAllRecords('pages'),
      storage.getAllRecords('images'),
    ]);
    model.profile = profile;
    model.pages = new Map(pages.filter((p) => p.profileId === profileId).map((p) => [p.id, p]));
    model.images = new Map(images.map((img) => [img.id, img]));
    return model;
  }

  // ---------- Lettura ----------

  function page(id) {
    return model.pages.get(id) || null;
  }

  // Celle in ordine di lettura (riga, poi colonna)
  function orderedCells(pageRecord, { includeHidden = false } = {}) {
    return [...pageRecord.cells]
      .filter((cell) => includeHidden || !cell.hidden)
      .sort((a, b) => (a.row - b.row) || (a.col - b.col));
  }

  function findCell(cellId) {
    for (const p of model.pages.values()) {
      const cell = p.cells.find((c) => c.id === cellId);
      if (cell) return { page: p, cell };
    }
    return null;
  }

  // URL da usare in <img>: file incluso nel tool oppure blob salvato sul dispositivo
  function imageUrl(imageId) {
    if (!imageId) return null;
    const image = model.images.get(imageId);
    if (!image) return null;
    if (image.path) return image.path;
    if (image.blob) {
      if (!objectUrls.has(imageId)) objectUrls.set(imageId, URL.createObjectURL(image.blob));
      return objectUrls.get(imageId);
    }
    return null;
  }

  // ---------- Modifica ----------

  async function savePage(pageRecord) {
    pageRecord.updatedAt = now();
    model.pages.set(pageRecord.id, pageRecord);
    await storage.putRecord('pages', pageRecord);
  }

  // Griglia fissa: ogni tessera resta nella sua riga e colonna su ogni schermo (memoria motoria)
  function isFixed(pageRecord) {
    return Boolean(pageRecord && pageRecord.grid && pageRecord.grid.fixed === true);
  }

  // Prima casella libera (in ordine di lettura) di una griglia fissa
  function firstFreeSlot(pageRecord) {
    const cols = pageRecord.grid.cols || DEFAULT_COLS;
    const used = new Set(pageRecord.cells.map((c) => `${c.row}:${c.col}`));
    for (let index = 0; ; index += 1) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      if (!used.has(`${row}:${col}`)) return { row, col };
    }
  }

  function updateRows(pageRecord) {
    const maxRow = pageRecord.cells.reduce((max, c) => Math.max(max, c.row), -1);
    pageRecord.grid.rows = Math.max(1, maxRow + 1);
  }

  /*
   * Assegna le posizioni seguendo un ordine di celle: le tessere bloccate restano dove sono,
   * le altre occupano, nell'ordine dato, le caselle libere in ordine di lettura.
   */
  function placeInOrder(pageRecord, ordered) {
    const cols = pageRecord.grid.cols || DEFAULT_COLS;
    const locked = new Set(ordered.filter((c) => c.locked).map((c) => `${c.row}:${c.col}`));
    let index = 0;
    ordered.filter((c) => !c.locked).forEach((cell) => {
      while (locked.has(`${Math.floor(index / cols)}:${index % cols}`)) index += 1;
      cell.row = Math.floor(index / cols);
      cell.col = index % cols;
      index += 1;
    });
    updateRows(pageRecord);
  }

  // Ricompatta le posizioni in ordine di lettura (dopo spostamenti o cancellazioni)
  function renumber(pageRecord) {
    const cols = pageRecord.grid.cols || DEFAULT_COLS;
    const ordered = [...pageRecord.cells].sort((a, b) => (a.row - b.row) || (a.col - b.col));
    ordered.forEach((cell, index) => {
      cell.row = Math.floor(index / cols);
      cell.col = index % cols;
    });
    pageRecord.grid.rows = Math.max(1, Math.ceil(ordered.length / cols));
  }

  async function updateCell(pageId, cellId, changes) {
    const p = page(pageId);
    const cell = p && p.cells.find((c) => c.id === cellId);
    if (!cell) return null;
    Object.assign(cell, changes);
    await savePage(p);
    return cell;
  }

  async function addCell(pageId, fields) {
    const p = page(pageId);
    if (!p) return null;
    const cols = p.grid.cols || DEFAULT_COLS;
    const index = p.cells.length;
    // Griglia fissa: la nuova tessera va nella prima casella libera, senza spostare le altre
    const slot = isFixed(p) ? firstFreeSlot(p) : { row: Math.floor(index / cols), col: index % cols };
    const cell = {
      id: newId('c'),
      row: slot.row,
      col: slot.col,
      kind: 'symbol',
      label: '',
      speak: null,
      imageId: null,
      wordType: 'noun',
      color: null,
      targetPageId: null,
      hidden: false,
      locked: false,
      audioId: null,
      ...fields,
    };
    p.cells.push(cell);
    if (isFixed(p)) updateRows(p);
    else renumber(p);
    await savePage(p);
    return cell;
  }

  async function addFolder(pageId, title) {
    const folderPage = {
      id: newId('pg'),
      profileId: model.profile.id,
      title,
      grid: { rows: 1, cols: DEFAULT_COLS },
      contextIds: [],
      cells: [],
      updatedAt: now(),
    };
    await savePage(folderPage);
    const cell = await addCell(pageId, {
      kind: 'folder', label: title, wordType: null, targetPageId: folderPage.id,
    });
    return { cell, page: folderPage };
  }

  async function deleteCell(pageId, cellId) {
    const p = page(pageId);
    if (!p) return;
    p.cells = p.cells.filter((c) => c.id !== cellId);
    // Griglia fissa: la casella resta vuota, le altre tessere non si spostano
    if (isFixed(p)) updateRows(p);
    else renumber(p);
    await savePage(p);
  }

  // Sposta una cella di una posizione (in ordine di lettura): -1 prima, +1 dopo
  async function moveCell(pageId, cellId, delta) {
    const p = page(pageId);
    if (!p) return;
    const ordered = [...p.cells].sort((a, b) => (a.row - b.row) || (a.col - b.col));
    const index = ordered.findIndex((c) => c.id === cellId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    // Le tessere bloccate non si scambiano: restano nella loro casella
    if (ordered[index].locked || ordered[target].locked) return;
    // Scambio delle caselle: vale sia per la griglia automatica sia per quella fissa
    const a = ordered[index];
    const b = ordered[target];
    [a.row, a.col, b.row, b.col] = [b.row, b.col, a.row, a.col];
    await savePage(p);
  }

  // Nuovo ordine completo delle celle (dal trascinamento): le posizioni seguono l'elenco di id.
  // Eventuali celle non presenti nell'elenco restano in fondo, nel loro ordine.
  async function reorderCells(pageId, cellIds) {
    const p = page(pageId);
    if (!p || !Array.isArray(cellIds)) return;
    const byId = new Map(p.cells.map((c) => [c.id, c]));
    const ordered = [];
    cellIds.forEach((id) => {
      const cell = byId.get(id);
      if (cell) { ordered.push(cell); byId.delete(id); }
    });
    const rest = [...byId.values()].sort((a, b) => (a.row - b.row) || (a.col - b.col));
    placeInOrder(p, [...ordered, ...rest]);
    await savePage(p);
  }

  // ---------- Cartelle: gerarchia e spostamento tra schede ----------

  // Schede raggiungibili da una scheda attraverso le sue cartelle (compresa la scheda stessa)
  function pagesUnder(pageId) {
    const seen = new Set();
    const queue = [pageId];
    while (queue.length) {
      const id = queue.shift();
      const p = page(id);
      if (!p || seen.has(id)) continue;
      seen.add(id);
      p.cells.forEach((c) => { if (c.kind === 'folder' && c.targetPageId) queue.push(c.targetPageId); });
    }
    return seen;
  }

  // Percorso più breve dalla Home a una scheda, attraverso le cartelle: [Home, …, scheda]
  // (null se la scheda non è raggiungibile dalla Home)
  function pathTo(pageId) {
    const home = model.profile && model.profile.homePageId;
    if (!home || !page(pageId)) return null;
    const previous = new Map([[home, null]]);
    const queue = [home];
    while (queue.length) {
      const id = queue.shift();
      if (id === pageId) break;
      const p = page(id);
      if (!p) continue;
      p.cells.forEach((c) => {
        if (c.kind === 'folder' && c.targetPageId && page(c.targetPageId) && !previous.has(c.targetPageId)) {
          previous.set(c.targetPageId, id);
          queue.push(c.targetPageId);
        }
      });
    }
    if (!previous.has(pageId)) return null;
    const path = [];
    for (let id = pageId; id; id = previous.get(id)) path.unshift(id);
    return path;
  }

  /*
   * Albero delle schede a partire dalla Home, per scegliere dove spostare una tessera:
   * [{ pageId, title, depth }] in ordine di lettura; ogni scheda compare una sola volta.
   */
  function pageTree() {
    const home = model.profile && model.profile.homePageId;
    const result = [];
    const seen = new Set();
    const visit = (pageId, title, depth) => {
      const p = page(pageId);
      if (!p || seen.has(pageId)) return;
      seen.add(pageId);
      result.push({ pageId, title, depth });
      orderedCells(p, { includeHidden: true }).forEach((c) => {
        if (c.kind === 'folder' && c.targetPageId) visit(c.targetPageId, c.label || (page(c.targetPageId) || {}).title || '', depth + 1);
      });
    };
    if (home) visit(home, '', 0);
    return result;
  }

  // Si può spostare la tessera in quella scheda? Una cartella non può finire dentro sé stessa
  function canMoveCellTo(fromPageId, cellId, toPageId) {
    const from = page(fromPageId);
    const cell = from && from.cells.find((c) => c.id === cellId);
    if (!cell || !page(toPageId) || toPageId === fromPageId) return false;
    if (cell.kind === 'folder' && cell.targetPageId && pagesUnder(cell.targetPageId).has(toPageId)) return false;
    return true;
  }

  // Sposta una tessera (o una cartella con tutto il suo contenuto) in un'altra scheda, in fondo
  async function moveCellToPage(fromPageId, cellId, toPageId) {
    if (!canMoveCellTo(fromPageId, cellId, toPageId)) return false;
    const from = page(fromPageId);
    const to = page(toPageId);
    const cell = from.cells.find((c) => c.id === cellId);
    from.cells = from.cells.filter((c) => c.id !== cellId);
    if (isFixed(from)) updateRows(from);
    else renumber(from);
    // Nella nuova scheda va nella prima casella libera (griglia fissa) o in fondo; la posizione non è più bloccata
    const cols = to.grid.cols || DEFAULT_COLS;
    const slot = isFixed(to) ? firstFreeSlot(to) : { row: Math.floor(to.cells.length / cols), col: to.cells.length % cols };
    Object.assign(cell, { row: slot.row, col: slot.col, locked: false });
    to.cells.push(cell);
    if (isFixed(to)) updateRows(to);
    else renumber(to);
    await savePage(from);
    await savePage(to);
    return true;
  }

  // Disposizione della pagina: automatica (si adatta allo schermo) o fissa con un numero di colonne
  async function setPageLayout(pageId, { fixed, cols }) {
    const p = page(pageId);
    if (!p) return;
    const ordered = [...p.cells].sort((a, b) => (a.row - b.row) || (a.col - b.col));
    const newCols = Math.min(12, Math.max(1, Math.round(cols || p.grid.cols || DEFAULT_COLS)));
    const changedCols = newCols !== p.grid.cols;
    p.grid = { ...p.grid, cols: newCols, fixed: Boolean(fixed) };
    // Cambiando il numero di colonne le tessere si ridispongono in ordine di lettura
    // (le bloccate restano nella loro casella se ancora dentro la griglia)
    if (changedCols) {
      ordered.forEach((c) => { if (c.locked && c.col >= newCols) c.locked = false; });
      placeInOrder(p, ordered);
    }
    await savePage(p);
  }

  // ---------- Schede intere (schede pronte, modelli, ripristino) ----------

  function profilePages() {
    return [...model.pages.values()];
  }

  // Copia di sicurezza delle schede attuali, prima di sostituirle con un modello
  async function snapshotPages() {
    const snapshot = {
      savedAt: now(),
      homePageId: model.profile.homePageId,
      pages: JSON.parse(JSON.stringify(profilePages())),
    };
    await storage.set(`previousPages:${model.profile.id}`, snapshot);
    return snapshot;
  }

  async function previousPages() {
    if (!model.profile) return null;
    const snapshot = await storage.get(`previousPages:${model.profile.id}`);
    return snapshot && Array.isArray(snapshot.pages) ? snapshot : null;
  }

  // Sostituisce tutte le schede del profilo (la copia di sicurezza va fatta prima)
  async function replacePages(pages, homePageId) {
    const oldIds = [...model.pages.keys()];
    await Promise.all(oldIds.map((id) => storage.deleteRecord('pages', id)));
    model.pages = new Map();
    pages.forEach((p) => { p.profileId = model.profile.id; p.updatedAt = now(); model.pages.set(p.id, p); });
    await storage.putRecords('pages', pages);
    model.profile.homePageId = homePageId;
    model.profile.updatedAt = now();
    await storage.putRecord('profiles', model.profile);
  }

  async function restorePreviousPages() {
    const snapshot = await previousPages();
    if (!snapshot) return false;
    const current = await snapshotPages();
    await replacePages(snapshot.pages, snapshot.homePageId);
    // La copia ora contiene le schede appena tolte: si può tornare indietro di nuovo
    await storage.set(`previousPages:${model.profile.id}`, current);
    return true;
  }

  // Aggiunge schede nuove al profilo (es. un modello aggiunto come cartella)
  async function addPages(pages) {
    pages.forEach((p) => { p.profileId = model.profile.id; p.updatedAt = now(); model.pages.set(p.id, p); });
    await storage.putRecords('pages', pages);
  }

  // Immagine nuova (foto o immagine da un file): appartiene al profilo in uso, gli altri profili non la vedono
  // nella ricerca (le immagini restano comunque in comune per le schede che le usano, per esempio dopo «Duplica»)
  async function addImage(fields) {
    const image = { id: newId('img'), addedAt: now(), profileId: model.profile ? model.profile.id : undefined, ...fields };
    model.images.set(image.id, image);
    await storage.putRecord('images', image);
    return image;
  }

  /*
   * Immagini che il profilo in uso può trovare con la ricerca «sul dispositivo». Le foto e le immagini personali
   * (fonte «photo» o «other») si vedono solo nel profilo che le ha aggiunte o se le usano le sue schede: per
   * privacy un profilo non vede le foto di un altro. Simboli delle raccolte (ARASAAC, pacchetti…) per tutti.
   */
  function searchableImages() {
    const own = model.profile ? model.profile.id : null;
    const used = new Set();
    model.pages.forEach((p) => (Array.isArray(p.cells) ? p.cells : []).forEach((c) => { if (c && c.imageId) used.add(c.imageId); }));
    return [...model.images.values()].filter((image) => {
      if (image.source !== 'photo' && image.source !== 'other') return true;
      return (image.profileId && image.profileId === own) || used.has(image.id);
    });
  }

  // Salva un'immagine con id stabile (es. img_ar_2462): se esiste già sul dispositivo la riusa
  async function saveImage(record) {
    if (model.images.has(record.id)) return model.images.get(record.id);
    const image = { addedAt: now(), ...record };
    model.images.set(image.id, image);
    await storage.putRecord('images', image);
    return image;
  }

  window.PicSpeak.data = {
    WORD_TYPES,
    DEFAULT_COLS,
    newId,
    load,
    isFixed,
    get profile() { return model.profile; },
    get homePageId() { return model.profile ? model.profile.homePageId : null; },
    page,
    orderedCells,
    findCell,
    imageUrl,
    image: (id) => model.images.get(id) || null,
    updateCell,
    addCell,
    addFolder,
    deleteCell,
    moveCell,
    reorderCells,
    setPageLayout,
    pagesUnder,
    pathTo,
    pageTree,
    canMoveCellTo,
    moveCellToPage,
    profilePages,
    seedDefaultProfile,
    snapshotPages,
    previousPages,
    replacePages,
    restorePreviousPages,
    addPages,
    addImage,
    saveImage,
    allImages: () => [...model.images.values()],
    searchableImages,
  };
})();
