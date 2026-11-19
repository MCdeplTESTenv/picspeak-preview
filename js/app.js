/*
 * PicSpeak – comunicazione: griglia di simboli, voce al tocco, striscia frase.
 * Le schede arrivano dal modello dati (data.js). In modalità comunicazione nulla modifica i dati;
 * con le impostazioni sbloccate il tocco su una tessera apre la modifica (editor.js).
 */
(function () {
  'use strict';

  const { i18n, speech, data } = window.PicSpeak;
  const t = i18n.t;

  // Limite di simboli nella frase, per tenerla leggibile su tablet
  const MAX_SENTENCE_LENGTH = 12;

  const state = {
    // 'child' = modalità utente (nessuna modifica possibile); 'adult' arriverà nella Tappa 2
    mode: 'child',
    pageId: null,
    // Percorso fatto per arrivare alla pagina: [Home, cartella, …, pagina] (per il percorso e la freccia «su»)
    trail: [],
    // Frase: copie delle tessere scelte (parola, voce, tipo, immagine), indipendenti dalla scheda
    sentence: [],
    ready: false,
    // Anteprima dello zoom: con le impostazioni sbloccate, griglia identica a quella del bambino
    preview: false,
    // La pagina corrente usa la griglia fissa (calcolato da layoutGrid in base allo schermo)
    fixed: false,
    // Ultima selezione di una tessera (per ignorare i tocchi ripetuti)
    lastSelectAt: 0,
  };

  /*
   * Opzioni di comunicazione (Impostazioni → Tocco e frase), applicate solo in modalità comunicazione:
   * - activation: 'release' = la tessera si sceglie quando si alza il dito (comportamento classico),
   *   'press' = appena la si tocca;
   * - holdMs: per scegliere bisogna tenere il dito sulla tessera per questo tempo (0 = no);
   * - repeatMs: dopo una scelta, i tocchi per questo tempo vengono ignorati (0 = no);
   * - speakWords: 'each' = ogni parola si pronuncia quando si sceglie, 'sentence' = solo leggendo la frase;
   * - clearAfter: la frase si svuota dopo averla letta;
   * - autoHome: dopo una parola presa in una cartella si torna alla Home.
   */
  const options = {
    activation: 'release', holdMs: 0, repeatMs: 0, speakWords: 'each', clearAfter: false, autoHome: false,
  };

  const el = {
    grid: document.getElementById('symbol-grid'),
    strip: document.getElementById('sentence-strip'),
    title: document.getElementById('page-title'),
    speak: document.getElementById('btn-speak'),
    backspace: document.getElementById('btn-backspace'),
    clear: document.getElementById('btn-clear'),
    home: document.getElementById('btn-home'),
    crumbs: document.getElementById('crumbs'),
    showAll: document.getElementById('btn-show-all'),
    trail: document.getElementById('crumb-trail'),
    up: document.getElementById('btn-up'),
  };

  function labelOf(item) {
    return item.label || '';
  }

  // Testo pronunciato: quello dedicato, se presente, altrimenti la parola mostrata
  function speechOf(item) {
    return item.speak || item.label || '';
  }

  // Classe di colore: cartella oppure categoria grammaticale (Fitzgerald)
  function typeOf(item) {
    return item.kind === 'folder' ? 'folder' : (item.wordType || 'noun');
  }

  // Colore scelto a mano per una tessera (vuoto = colore Fitzgerald automatico)
  function applyCustomColor(node, item) {
    // Solo colori nel formato #RRGGBB: un valore diverso (es. da un file importato) viene ignorato
    if (!item.color || !/^#[0-9a-f]{6}$/i.test(item.color)) return;
    node.classList.add('has-custom-color');
    node.style.setProperty('--cat', item.color);
    node.style.setProperty('--card-line', item.color);
    node.style.setProperty('--card-fill', `color-mix(in srgb, ${item.color} 18%, white)`);
    node.style.setProperty('--tint', `color-mix(in srgb, ${item.color} 25%, white)`);
  }

  // Crea il contenuto visivo (immagine + etichetta) condiviso da celle e striscia
  function buildFace(item, sizeClass) {
    const fragment = document.createDocumentFragment();
    const image = document.createElement('span');
    image.className = `symbol-image ${sizeClass}`;
    image.setAttribute('aria-hidden', 'true');
    const src = data.imageUrl(item.imageId);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      // Se l'immagine non si carica resta la parola: la cella continua a funzionare
      img.addEventListener('error', () => { img.remove(); }, { once: true });
      image.append(img);
    } else {
      image.classList.add('is-empty');
    }
    const label = document.createElement('span');
    label.className = 'symbol-label';
    label.textContent = labelOf(item);
    fragment.append(image, label);
    return fragment;
  }

  function renderGrid() {
    if (!state.ready) return;
    const page = data.page(state.pageId) || data.page(data.homePageId);
    if (!page) return;
    state.pageId = page.id;
    renderCrumbs(page);

    // In modalità impostazioni si vedono anche le tessere nascoste (attenuate) e la tessera "+",
    // tranne durante l'anteprima dello zoom, che mostra la pagina esattamente come la vede il bambino
    const editing = state.mode === 'adult' && !state.preview;
    const cells = data.orderedCells(page, { includeHidden: editing }).map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `symbol-cell type-${typeOf(item)}`;
      if (item.hidden) button.classList.add('is-hidden-cell');
      if (item.locked) button.classList.add('is-locked-cell');
      if (item.kind === 'empty') button.classList.add('is-empty-cell');
      button.dataset.id = item.id;
      // Casella nella griglia fissa (usata da layoutGrid quando la pagina ha la disposizione fissa)
      button.dataset.row = String(item.row);
      button.dataset.col = String(item.col);
      applyCustomColor(button, item);
      if (item.kind === 'folder') {
        button.setAttribute('aria-label', `${t('openPage')}: ${labelOf(item)}`);
        // Pagina della cartella: serve per lasciarci dentro una tessera trascinata (reorder.js)
        if (item.targetPageId) button.dataset.folder = item.targetPageId;
      }
      button.append(buildFace(item, 'size-cell'));
      // In modifica la cartella si apre col tocco; la matita nell'angolo apre le sue impostazioni
      if (editing && item.kind === 'folder') {
        const pencil = document.createElement('span');
        pencil.className = 'folder-edit';
        pencil.dataset.action = 'edit-folder';
        pencil.setAttribute('aria-hidden', 'true');
        button.append(pencil);
      }
      return button;
    });
    if (editing) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'symbol-cell add-cell';
      add.dataset.action = 'add';
      add.setAttribute('aria-label', t('addTile'));
      const plus = document.createElement('span');
      plus.className = 'symbol-image add-plus';
      plus.setAttribute('aria-hidden', 'true');
      plus.textContent = '+';
      const label = document.createElement('span');
      label.className = 'symbol-label';
      label.textContent = t('addTile');
      add.append(plus, label);
      cells.push(add);
    }

    el.grid.replaceChildren(...cells);
    el.grid.dataset.count = String(cells.length);
    layoutGrid();
    applySuggestions();
  }

  // Breve avviso in basso (es. «Spostata in Cibo»), letto anche dai lettori di schermo
  let noticeNode = null;
  let noticeTimer = null;
  function notice(text) {
    if (!noticeNode) {
      noticeNode = document.createElement('div');
      noticeNode.className = 'app-notice';
      noticeNode.setAttribute('role', 'status');
      document.body.append(noticeNode);
    }
    noticeNode.textContent = text;
    noticeNode.classList.add('is-visible');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => noticeNode.classList.remove('is-visible'), 2200);
  }

  // ---------- Percorso e freccia «su» ----------

  // Titolo mostrato per una pagina del percorso
  function pageTitle(pageId) {
    const p = data.page(pageId);
    return p ? p.title : '';
  }

  function crumbSeparator() {
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm9 6 6 6-6 6');
    svg.append(path);
    sep.append(svg);
    return sep;
  }

  /*
   * Percorso «HOME › cartella › … › pagina»: ogni cartella intermedia si tocca per tornarci;
   * la freccia «su» porta alla cartella precedente. Nella Home si vede solo «HOME».
   */
  function renderCrumbs(page) {
    // Il percorso deve finire con la pagina mostrata e cominciare dalla Home
    if (state.trail[state.trail.length - 1] !== page.id || state.trail[0] !== data.homePageId) {
      state.trail = data.pathTo(page.id) || [data.homePageId, page.id].filter((id, i, a) => a.indexOf(id) === i);
    }
    el.title.textContent = page.title;
    const isHome = page.id === data.homePageId;
    el.crumbs.classList.toggle('is-home', isHome);
    if (isHome) el.home.setAttribute('aria-current', 'page');
    else el.home.removeAttribute('aria-current');
    el.home.dataset.dropPage = data.homePageId;
    const middle = state.trail.slice(1, -1).map((pageId, index) => {
      const crumb = document.createElement('button');
      crumb.type = 'button';
      crumb.className = 'crumb crumb-link';
      crumb.dataset.trailIndex = String(index + 1);
      crumb.dataset.dropPage = pageId;
      crumb.textContent = pageTitle(pageId);
      return [crumbSeparator(), crumb];
    }).flat();
    el.trail.replaceChildren(...middle);
    el.up.hidden = isHome;
    if (!isHome) el.up.dataset.dropPage = state.trail[state.trail.length - 2] || data.homePageId;
  }

  // Torna alla pagina in quella posizione del percorso
  function goToTrail(index) {
    const pageId = state.trail[index];
    if (!pageId) return;
    state.trail = state.trail.slice(0, index + 1);
    goToPage(pageId);
  }

  function goUp() {
    if (state.trail.length > 1) goToTrail(state.trail.length - 2);
    else goToPage(data.homePageId);
  }

  // Apre una cartella dalla pagina attuale: il percorso si allunga di un passo
  function openFolder(pageId) {
    if (!data.page(pageId)) return;
    const at = state.trail.indexOf(pageId);
    // Cartella che riporta a una pagina già nel percorso (es. «torna a…»): il percorso si accorcia
    state.trail = at >= 0 ? state.trail.slice(0, at + 1) : [...state.trail, pageId];
    goToPage(pageId);
  }

  // ---------- Previsione: evidenzia (senza spostarle) le tessere probabili ----------

  // La cartella porta (direttamente o in una sottocartella) a una tessera con questa parola?
  function folderContains(pageId, word, depth, visited = new Set()) {
    const page = data.page(pageId);
    if (!page || visited.has(pageId)) return false;
    visited.add(pageId);
    const cells = data.orderedCells(page);
    if (cells.some((c) => c.kind !== 'folder' && window.PicSpeak.predict.wordKey(c.label) === word)) return true;
    if (depth <= 1) return false;
    return cells.some((c) => c.kind === 'folder' && folderContains(c.targetPageId, word, depth - 1, visited));
  }

  const SUGGEST_CLASSES = ['is-suggested', 'is-suggest-faded', 'is-suggest-hidden'];

  /*
   * Stili: «outline» contorno; «graded» contorno sempre più tenue per le parole meno frequenti;
   * «fade» contorno e tessere non suggerite trasparenti; «only» si vedono solo le suggerite (le altre lasciano
   * vuoto il loro posto, così nessuna tessera si sposta) con il pulsante «Mostra tutto» per tornare alla scheda intera.
   */
  function applySuggestions() {
    el.grid.querySelectorAll('.symbol-cell').forEach((node) => {
      node.classList.remove(...SUGGEST_CLASSES);
      node.style.removeProperty('--suggest-alpha');
    });
    if (el.showAll) el.showAll.hidden = true;
    const predict = window.PicSpeak.predict;
    // Solo in comunicazione (o nell'anteprima): mentre si modificano le schede non si evidenzia nulla
    if (!predict || !predict.settings.suggest || (state.mode === 'adult' && !state.preview)) return;
    const page = data.page(state.pageId);
    if (!page) return;
    const prevItem = state.sentence[state.sentence.length - 1] || null;
    const list = predict.candidates(prevItem);
    if (!list.length) return;
    const { style } = predict.settings;
    // Il contorno semplice resta al massimo a 3 tessere; gli altri stili arrivano fino a 10
    const max = style === 'outline' ? Math.min(predict.settings.count, 3) : predict.settings.count;
    const visible = data.orderedCells(page).filter((c) => c.kind !== 'empty');
    const marked = new Map(); // id tessera → punteggio
    for (const { word, score } of list) {
      if (marked.size >= max) break;
      let target = visible.find((c) => c.kind !== 'folder' && predict.wordKey(c.label) === word);
      if (!target) target = visible.find((c) => c.kind === 'folder' && folderContains(c.targetPageId, word, 2));
      if (target && !marked.has(target.id)) marked.set(target.id, score);
    }
    if (!marked.size) return;
    const top = Math.max(...marked.values());
    const filter = style === 'only' && !state.showAll;
    el.grid.querySelectorAll('.symbol-cell[data-id]').forEach((node) => {
      const score = marked.get(node.dataset.id);
      if (score !== undefined) {
        node.classList.add('is-suggested');
        // Sfumato: 1 per la parola più frequente, fino a 0,25 per le meno frequenti
        if (style === 'graded') node.style.setProperty('--suggest-alpha', (0.25 + 0.75 * (score / top)).toFixed(2));
      } else if (style === 'fade') {
        node.classList.add('is-suggest-faded');
      } else if (filter) {
        node.classList.add('is-suggest-hidden');
      }
    });
    if (filter && el.showAll) el.showAll.hidden = false;
  }

  // Sceglie il numero di colonne che rende le celle più grandi possibile
  // nello spazio disponibile (poche celle = celle grandi, come chiede la logopedista)
  const MIN_COMFORT_CELL = 88;
  const MIN_COMFORT_WIDTH = 76;
  // Zoom delle tessere (percentuale della misura automatica): limiti e passo
  const ZOOM = { step: 10, min: 30, max: 300, minTile: 64 }; // minTile = bersaglio di tocco minimo

  // Misure della griglia come le vede il bambino in comunicazione, anche quando le impostazioni
  // sono sbloccate: si contano solo le tessere visibili (non quelle nascoste né la tessera "+")
  // e si restituisce l'altezza occupata dalla barra scura delle impostazioni.
  // Così misura e disposizione delle tessere sono identiche nelle due modalità.
  function gridMetrics() {
    const style = getComputedStyle(el.grid);
    const count = el.grid.querySelectorAll('.symbol-cell:not(.is-hidden-cell):not(.add-cell):not(.reorder-ghost)').length;
    const bar = document.getElementById('adult-bar');
    const barHeight = bar && !bar.hidden && getComputedStyle(bar).position !== 'fixed' ? bar.offsetHeight : 0;
    return {
      count,
      gap: parseFloat(style.columnGap) || 0,
      width: el.grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      height: el.grid.clientHeight + barHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
  }

  // Disposizione "automatica": celle il più possibile grandi nello spazio disponibile
  function autoLayout(metrics = gridMetrics()) {
    const { count, gap, width, height } = metrics;
    let best = { cols: 1, size: 0 };
    for (let cols = 1; cols <= Math.max(1, count); cols += 1) {
      const rows = Math.ceil(Math.max(1, count) / cols);
      const cellW = (width - gap * (cols - 1)) / cols;
      const cellH = (height - gap * (rows - 1)) / rows;
      // Celle mai più strette di una misura comoda: su schermi bassi la griglia scorre invece di stringersi
      if (cols > 1 && cellW < MIN_COMFORT_WIDTH) continue;
      // Se le righe non entrano senza scorrere, la soluzione vale un po' meno (si preferisce vedere tutto)
      const size = cellH >= MIN_COMFORT_CELL
        ? Math.min(cellW, cellH)
        : Math.min(cellW, MIN_COMFORT_CELL) * 0.85;
      // A parità di misura si preferiscono più colonne (meno righe da scorrere)
      if (size > best.size || (size === best.size && cols > best.cols)) best = { cols, size };
    }
    const cols = best.cols;
    const rows = Math.ceil(Math.max(1, count) / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = Math.max((height - gap * (rows - 1)) / rows, MIN_COMFORT_CELL);
    return { cols, cellW, cellH };
  }

  // Percentuali di zoom ammesse su questo schermo e in questa pagina:
  // in giù finché la tessera resta toccabile (≥ 64 px), in su finché una tessera sta tutta nello schermo
  function zoomRange() {
    // Pagina a griglia fissa: la misura dipende solo dalle colonne scelte, lo zoom non si applica
    if (state.fixed) return { min: 100, max: 100, step: ZOOM.step };
    const metrics = gridMetrics();
    const { cellW, cellH } = autoLayout(metrics);
    const side = Math.min(cellW, cellH);
    const roundUp = (v) => Math.ceil(v / ZOOM.step) * ZOOM.step;
    const roundDown = (v) => Math.floor(v / ZOOM.step) * ZOOM.step;
    const min = Math.min(100, Math.max(ZOOM.min, roundUp((ZOOM.minTile / side) * 100)));
    const max = Math.max(100, Math.min(ZOOM.max,
      roundDown(Math.min(metrics.width / cellW, metrics.height / cellH) * 100)));
    return { min, max, step: ZOOM.step };
  }

  // Zoom scelto dall'adulto (data-tile-zoom su <html>), ricondotto ai limiti di questo schermo
  function currentZoom() {
    if (state.fixed) return 100;
    const saved = parseInt(document.documentElement.dataset.tileZoom, 10);
    if (!(saved > 0) || saved === 100) return 100;
    const { min, max } = zoomRange();
    return Math.min(max, Math.max(min, saved));
  }

  /*
   * Disposizione fissa (scelta per la pagina, es. le schede pronte di base): ogni tessera sta nella
   * sua riga e colonna, uguale su ogni schermo. Se lo schermo è troppo stretto per tessere da almeno
   * 64 px (telefono in verticale con molte colonne) si torna alla disposizione automatica,
   * che mantiene comunque l'ordine di lettura. Restituisce null se la pagina non è fissa.
   */
  function fixedLayout(metrics) {
    const page = data.page(state.pageId);
    if (!data.isFixed(page)) return null;
    const cols = page.grid.cols;
    const cellW = (metrics.width - metrics.gap * (cols - 1)) / cols;
    if (cellW < ZOOM.minTile) return null;
    const placed = [...el.grid.querySelectorAll('.symbol-cell[data-row]:not(.reorder-ghost)')];
    // Le righe previste dalla pagina restano anche se le ultime tessere sono nascoste: le misure non cambiano
    let rows = Math.max(1, page.grid.rows || 1, ...placed.map((n) => Number(n.dataset.row) + 1));
    // In modifica la tessera "+" occupa la prima casella libera: se la griglia è piena serve una riga in più
    if (el.grid.querySelector('.add-cell') && placed.length >= rows * cols) rows += 1;
    const cellH = Math.max(ZOOM.minTile, (metrics.height - metrics.gap * (rows - 1)) / rows);
    return { cols, rows, cellW, cellH };
  }

  function layoutGrid() {
    const metrics = gridMetrics();
    if (!el.grid.childElementCount) return;
    const fixed = fixedLayout(metrics);
    state.fixed = Boolean(fixed);
    el.grid.classList.toggle('is-fixed-grid', state.fixed);
    el.grid.querySelectorAll('.symbol-cell:not(.reorder-ghost)').forEach((node) => {
      if (fixed && node.dataset.row !== undefined) {
        node.style.gridRow = String(Number(node.dataset.row) + 1);
        node.style.gridColumn = String(Number(node.dataset.col) + 1);
      } else {
        node.style.gridRow = '';
        node.style.gridColumn = '';
      }
    });
    if (fixed) {
      el.grid.style.gridTemplateColumns = `repeat(${fixed.cols}, minmax(0, 1fr))`;
      el.grid.style.justifyContent = '';
      el.grid.style.gridAutoRows = `${fixed.cellH}px`;
      el.grid.style.setProperty('--cell-size', `${Math.min(fixed.cellW, fixed.cellH)}px`);
      fitLabels();
      return;
    }
    const auto = autoLayout(metrics);
    const zoom = currentZoom();
    let { cols, cellW, cellH } = auto;
    if (zoom === 100) {
      // Misura automatica: le tessere riempiono lo spazio
      el.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      el.grid.style.justifyContent = '';
    } else {
      // Zoom: la tessera automatica ingrandita o rimpicciolita in proporzione (larghezza e altezza);
      // entrano tante colonne quante ne permette lo schermo e la griglia resta centrata
      cellW = Math.max(ZOOM.minTile, auto.cellW * (zoom / 100));
      cellH = Math.max(ZOOM.minTile, auto.cellH * (zoom / 100));
      const fit = Math.floor((metrics.width + metrics.gap) / (cellW + metrics.gap));
      cols = Math.max(1, Math.min(fit, Math.max(1, metrics.count)));
      el.grid.style.gridTemplateColumns = `repeat(${cols}, ${cellW}px)`;
      el.grid.style.justifyContent = 'center';
    }
    el.grid.style.gridAutoRows = `${cellH}px`;
    // Immagine ed etichetta proporzionate al lato minore della cella
    el.grid.style.setProperty('--cell-size', `${Math.min(cellW, cellH)}px`);
    fitLabels();
  }

  // Riduce il carattere delle parole che non entrano nella cella (mai parole spezzate a metà).
  // Massimo due righe; si scende fino a 10 px, poi interviene il troncamento con i puntini.
  function fitLabels() {
    el.grid.querySelectorAll('.symbol-label').forEach((label) => {
      label.style.fontSize = '';
      if (getComputedStyle(label).position === 'absolute') return;
      let size = parseFloat(getComputedStyle(label).fontSize);
      const lineHeight = () => parseFloat(getComputedStyle(label).lineHeight) || size * 1.15;
      const overflows = () => label.scrollWidth > label.clientWidth + 1
        || label.scrollHeight > lineHeight() * 2 + 2
        || longestWordTooWide(label);
      label.classList.remove('is-hyphenated');
      while (overflows() && size > 10) {
        size -= 1;
        label.style.fontSize = `${size}px`;
      }
      // Ultima risorsa su tessere molto strette: sillabazione con il trattino (es. COSTRU-ZIONI),
      // mai parole che escono dal bordo o restano tagliate
      if (overflows()) label.classList.add('is-hyphenated');
    });
  }

  // Una parola più larga della cella verrebbe spezzata: la misuriamo a parte
  const measurer = document.createElement('span');
  measurer.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0';
  document.body.append(measurer);
  function longestWordTooWide(label) {
    const style = getComputedStyle(label);
    measurer.style.font = style.font;
    measurer.style.letterSpacing = style.letterSpacing;
    measurer.style.textTransform = style.textTransform;
    const available = label.parentElement.clientWidth
      - parseFloat(getComputedStyle(label.parentElement).paddingLeft)
      - parseFloat(getComputedStyle(label.parentElement).paddingRight);
    return label.textContent.split(/\s+/).some((word) => {
      measurer.textContent = word;
      return measurer.offsetWidth > available + 1;
    });
  }

  function renderSentence() {
    const chips = state.sentence.map((item, index) => {
      const li = document.createElement('li');
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `sentence-chip type-${typeOf(item)}`;
      applyCustomColor(chip, item);
      chip.dataset.index = String(index);
      chip.setAttribute('aria-label', state.mode === 'adult'
        ? `${t('removeFromSentence')}: ${labelOf(item)}`
        : labelOf(item));
      chip.append(buildFace(item, 'size-chip'));
      li.append(chip);
      return li;
    });
    el.strip.replaceChildren(...chips);
    el.strip.setAttribute('aria-label', chips.length ? '' : t('sentenceEmpty'));
    const empty = state.sentence.length === 0;
    el.speak.disabled = empty;
    el.backspace.disabled = empty;
    el.clear.disabled = empty;
    // Mantiene visibile l'ultimo simbolo aggiunto
    el.strip.scrollLeft = el.strip.scrollWidth;
    // Dopo ogni parola la vista «solo suggerite» riparte (il pulsante «Mostra tutto» vale fino alla prossima parola)
    state.showAll = false;
    if (state.ready) applySuggestions();
  }

  function sentenceText() {
    return state.sentence.map((item) => speechOf(item)).join(' ');
  }

  function say(text) {
    speech.speak(text, i18n.speechLocale);
  }

  // Breve evidenziazione visiva del tocco (senza animazioni invasive)
  function flash(node) {
    node.classList.add('is-pressed');
    setTimeout(() => node.classList.remove('is-pressed'), 180);
  }

  function goToPage(pageId) {
    if (!data.page(pageId)) return;
    // Pagina già nel percorso (Home, cartella superiore): si torna indietro fino a lì
    const at = state.trail.indexOf(pageId);
    if (at >= 0) state.trail = state.trail.slice(0, at + 1);
    state.pageId = pageId;
    renderGrid();
    el.grid.scrollTop = 0;
  }

  // Con «al tocco» o con il tempo di pressione la scelta avviene nei gestori del puntatore, non nel clic
  function pointerSelection() {
    return state.mode === 'child' && (options.activation === 'press' || options.holdMs > 0);
  }

  function onCellTap(event) {
    const cell = event.target.closest('.symbol-cell');
    if (!cell) return;
    // Impostazioni sbloccate: il tocco apre la modifica della tessera (o ne aggiunge una);
    // la cartella invece si apre, e le sue impostazioni sono sulla matita nell'angolo
    if (state.mode === 'adult' && window.PicSpeak.editor) {
      flash(cell);
      if (cell.dataset.action === 'add') {
        window.PicSpeak.editor.add(state.pageId);
        return;
      }
      const page = data.page(state.pageId);
      const item = page && page.cells.find((c) => c.id === cell.dataset.id);
      if (item && item.kind === 'folder' && !event.target.closest('.folder-edit') && !state.preview) {
        openFolder(item.targetPageId);
        return;
      }
      window.PicSpeak.editor.edit(state.pageId, cell.dataset.id);
      return;
    }
    // Clic generato da dito o mouse già gestito dai gestori del puntatore (la tastiera passa sempre di qui)
    if (pointerSelection() && event.detail !== 0) return;
    selectCell(cell);
  }

  // Scelta di una tessera in comunicazione
  function selectCell(cell) {
    const now = Date.now();
    // Tocchi ripetuti troppo vicini: ignorati (utile con tremori)
    if (options.repeatMs && now - state.lastSelectAt < options.repeatMs) return;
    const page = data.page(state.pageId);
    const item = page && page.cells.find((c) => c.id === cell.dataset.id);
    if (!item || item.kind === 'empty') return;
    state.lastSelectAt = now;
    flash(cell);
    const speakNow = options.speakWords !== 'sentence';
    if (item.kind === 'folder') {
      // Cartella «silenziosa» (opzione nelle sue impostazioni): si apre senza leggerne il nome
      if (speakNow && !item.silent) say(speechOf(item));
      openFolder(item.targetPageId);
      return;
    }
    if (speakNow) say(speechOf(item));
    // Ritorno automatico alla Home dopo una parola presa in una cartella
    if (options.autoHome && state.pageId !== data.homePageId) setTimeout(() => goToPage(data.homePageId), 250);
    if (state.sentence.length < MAX_SENTENCE_LENGTH) {
      const entry = {
        cellId: item.id, label: item.label, speak: item.speak, kind: item.kind,
        wordType: item.wordType, color: item.color, imageId: item.imageId,
      };
      // Abitudini d'uso (solo sul dispositivo): coppia «parola precedente → parola»
      if (window.PicSpeak.predict) window.PicSpeak.predict.record(entry, state.sentence[state.sentence.length - 1] || null);
      state.sentence.push(entry);
      renderSentence();
    }
  }

  // Striscia frase: in modalità bambino il tocco ripete solo la parola (nessuna cancellazione
  // accidentale); in modalità adulto il tocco toglie il simbolo dalla frase
  function onChipTap(event) {
    const chip = event.target.closest('.sentence-chip');
    if (!chip) return;
    const index = Number(chip.dataset.index);
    flash(chip);
    if (state.mode === 'adult') {
      state.sentence.splice(index, 1);
      renderSentence();
      return;
    }
    say(speechOf(state.sentence[index]));
  }

  function applyStaticLabels() {
    i18n.applyTo(document);
    document.title = t('appName');
  }

  // Cambio modalità: 'child' (comunicazione) o 'adult' (modifica, impostazioni)
  function setMode(mode) {
    state.mode = mode === 'adult' ? 'adult' : 'child';
    state.preview = false;
    document.body.classList.toggle('mode-adult', state.mode === 'adult');
    document.body.classList.remove('is-zoom-preview');
    renderGrid();
    renderSentence();
  }

  // Anteprima dello zoom (solo con le impostazioni sbloccate): la griglia appare identica a quella
  // della comunicazione, senza tessere nascoste, tessera "+" e segni di modifica
  function setPreview(on) {
    const next = Boolean(on) && state.mode === 'adult';
    if (next === Boolean(state.preview)) return;
    state.preview = next;
    document.body.classList.toggle('is-zoom-preview', next);
    renderGrid();
  }

  // Ridisegna tutti i testi dopo un cambio di lingua
  function refreshTexts() {
    applyStaticLabels();
    renderGrid();
    renderSentence();
    if (window.PicSpeak.communication) window.PicSpeak.communication.refresh();
  }

  // "Scuoti per tornare alla Home" (opzione in Impostazioni → Aspetto → Disposizione e tocco).
  // Servono due scosse decise entro un secondo: un movimento normale del tablet non basta.
  // Effetto: torna alla Home e cancella la frase.
  function bindShakeToHome() {
    if (!('DeviceMotionEvent' in window)) return;
    const THRESHOLD = 22; // variazione di accelerazione (m/s²) considerata una scossa
    let last = null;
    let peaks = [];
    let cooldownUntil = 0;
    window.addEventListener('devicemotion', (event) => {
      if (document.documentElement.dataset.shakeHome !== 'on' || state.mode !== 'child') return;
      const a = event.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const now = Date.now();
      if (last) {
        const delta = Math.abs(a.x - last.x) + Math.abs(a.y - last.y) + Math.abs(a.z - last.z);
        if (delta > THRESHOLD && now > cooldownUntil) {
          peaks = peaks.filter((t) => now - t < 1000);
          peaks.push(now);
          if (peaks.length >= 2) {
            peaks = [];
            cooldownUntil = now + 1500;
            // Scossa = "ricomincia": torna alla Home e svuota la frase, pronta per una nuova
            state.sentence = [];
            renderSentence();
            if (state.pageId !== data.homePageId) goToPage(data.homePageId);
          }
        }
      }
      last = { x: a.x, y: a.y, z: a.z };
    });
  }

  // "Spingi via": un colpo deciso del dito sulla striscia frase (in alto o in basso, oppure
  // di lato se la frase è corta e non scorre) cancella tutta la frase.
  let swallowClick = false;
  function bindSwipeToClear() {
    let start = null;
    el.strip.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY, t: Date.now() };
    });
    el.strip.addEventListener('pointerup', (event) => {
      // Il gesto è attivo solo se abilitato in Impostazioni → Aspetto → Disposizione e tocco
      if (document.documentElement.dataset.swipeClear !== 'on') { start = null; return; }
      if (!start || !state.sentence.length) { start = null; return; }
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      const fast = Date.now() - start.t < 700;
      const scrolls = el.strip.scrollWidth > el.strip.clientWidth + 1;
      const vertical = Math.abs(dy) > 45 && Math.abs(dy) > Math.abs(dx) * 1.2;
      const horizontal = !scrolls && Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.5;
      start = null;
      if (fast && (vertical || horizontal)) {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 300);
        clearSentenceAnimated(vertical ? (dy < 0 ? 'up' : 'down') : (dx < 0 ? 'left' : 'right'));
      }
    });
    el.strip.addEventListener('pointercancel', () => { start = null; });
  }

  function clearSentenceAnimated(direction) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      state.sentence = [];
      renderSentence();
      return;
    }
    el.strip.dataset.clearing = direction;
    setTimeout(() => {
      delete el.strip.dataset.clearing;
      state.sentence = [];
      renderSentence();
    }, 160);
  }

  /*
   * Selezione al tocco e tempo di pressione (solo in comunicazione). Con il tempo di pressione la tessera
   * si riempie piano piano dal basso e si sceglie quando il tempo è passato; alzando il dito prima, o
   * spostandolo fuori dalla tessera, non succede nulla.
   */
  function bindPointerSelection() {
    let hold = null; // { cell, timer, id, x, y }
    const MOVE_TOLERANCE = 24; // px: i piccoli movimenti (tremori) non annullano la pressione

    function cancelHold() {
      if (!hold) return;
      clearTimeout(hold.timer);
      hold.cell.classList.remove('is-holding');
      hold.cell.style.removeProperty('--hold-ms');
      hold = null;
    }

    el.grid.addEventListener('pointerdown', (event) => {
      if (!pointerSelection() || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const cell = event.target.closest('.symbol-cell');
      if (!cell || cell.classList.contains('is-empty-cell')) return;
      cancelHold();
      if (options.holdMs > 0) {
        cell.style.setProperty('--hold-ms', `${options.holdMs}ms`);
        cell.classList.add('is-holding');
        hold = {
          cell,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(() => {
            const target = hold && hold.cell;
            cancelHold();
            if (target) selectCell(target);
          }, options.holdMs),
        };
        return;
      }
      selectCell(cell);
    });
    el.grid.addEventListener('pointermove', (event) => {
      if (!hold || event.pointerId !== hold.id) return;
      const moved = Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > MOVE_TOLERANCE;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (moved && !(under && hold.cell.contains(under))) cancelHold();
    });
    ['pointerup', 'pointercancel'].forEach((name) => {
      el.grid.addEventListener(name, (event) => { if (hold && event.pointerId === hold.id) cancelHold(); });
    });
    // Tenendo premuto, il telefono non deve aprire il menu del testo o dell'immagine
    el.grid.addEventListener('contextmenu', (event) => { if (pointerSelection()) event.preventDefault(); });
  }

  // Legge la frase; con l'opzione «cancella dopo la lettura» la frase si svuota quando la voce finisce
  function speakSentence() {
    const text = sentenceText();
    if (!text) return;
    if (!options.clearAfter) { say(text); return; }
    const snapshot = state.sentence;
    const clear = () => {
      // Solo se nel frattempo non si è cominciata un'altra frase
      if (state.sentence === snapshot) { state.sentence = []; renderSentence(); }
    };
    if (!speech.speak(text, i18n.speechLocale, { onEnd: clear })) setTimeout(clear, 1500);
  }

  // Pulsante «Ops»: toglie l'ultima parola e lo dice ad alta voce
  function oops() {
    if (state.sentence.length) {
      state.sentence = state.sentence.slice(0, -1);
      renderSentence();
    }
  }

  function setOptions(next) {
    if (!next || typeof next !== 'object') return;
    if (['release', 'press'].includes(next.activation)) options.activation = next.activation;
    if ([0, 300, 600, 1000, 1500].includes(next.holdMs)) options.holdMs = next.holdMs;
    if ([0, 500, 1000, 2000].includes(next.repeatMs)) options.repeatMs = next.repeatMs;
    if (['each', 'sentence'].includes(next.speakWords)) options.speakWords = next.speakWords;
    if (typeof next.clearAfter === 'boolean') options.clearAfter = next.clearAfter;
    if (typeof next.autoHome === 'boolean') options.autoHome = next.autoHome;
  }

  function bindEvents() {
    el.grid.addEventListener('click', onCellTap);
    bindPointerSelection();
    el.strip.addEventListener('click', (event) => {
      if (swallowClick) return;
      onChipTap(event);
    });
    bindSwipeToClear();
    el.speak.addEventListener('click', () => {
      flash(el.speak);
      speakSentence();
    });
    el.backspace.addEventListener('click', () => {
      state.sentence.pop();
      renderSentence();
    });
    el.clear.addEventListener('click', () => {
      state.sentence = [];
      renderSentence();
    });
    el.home.addEventListener('click', () => goToPage(data.homePageId));
    // «Mostra tutto»: torna alla scheda intera fino alla prossima parola scelta
    if (el.showAll) {
      el.showAll.addEventListener('click', () => {
        state.showAll = true;
        applySuggestions();
      });
    }
    el.up.addEventListener('click', () => {
      flash(el.up);
      goUp();
    });
    el.trail.addEventListener('click', (event) => {
      const crumb = event.target.closest('.crumb-link');
      if (crumb) goToTrail(Number(crumb.dataset.trailIndex));
    });
    bindShakeToHome();
    // Ricalcola la griglia quando cambia la dimensione o l'orientamento dello schermo
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layoutGrid, 100);
    });
    // Evita lo zoom con doppio tocco su iOS durante l'uso rapido delle celle
    document.addEventListener('dblclick', (event) => event.preventDefault(), { passive: false });
  }

  applyStaticLabels();
  bindEvents();
  renderSentence();

  // Caricamento dei dati salvati sul dispositivo (al primo avvio: schede di prova)
  data.load().then(async () => {
    if (window.PicSpeak.predict) await window.PicSpeak.predict.load(data.profile.id);
    state.ready = true;
    state.pageId = data.homePageId;
    renderGrid();
  });

  window.PicSpeak.app = {
    setMode,
    refreshTexts,
    layoutGrid,
    renderGrid,
    goToPage,
    openFolder,
    goUp,
    notice,
    get pageId() { return state.pageId; },
    zoomRange,
    currentZoom,
    setPreview,
    applySuggestions,
    setOptions,
    getOptions: () => ({ ...options }),
    oops,
    say,
    flash,
    get fixedLayout() { return Boolean(state.fixed); },
    get preview() { return state.preview; },
    get mode() { return state.mode; },
  };
})();
