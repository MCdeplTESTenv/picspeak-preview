/*
 * Stampa delle schede (o salvataggio in PDF dalla finestra di stampa del browser).
 * Ogni scheda va su un foglio, con le tessere nella stessa posizione dello schermo (griglia fissa),
 * i colori per tipo di parola e, in fondo al foglio, i crediti delle immagini usate (obbligo delle licenze).
 * Le misure sono in centimetri: utile per tabelle di carta e per ritagliare uno scudo (keyguard).
 * Testi solo con textContent.
 */
(function () {
  'use strict';

  const { i18n, data, app, storage, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  const KEY = 'printOptions';
  // Spazio utile del foglio (A4 o Letter con margini di 12 mm), titolo e crediti esclusi
  const AREA = { portrait: { w: 18, h: 23 }, landscape: { w: 25.5, h: 15.5 } };
  const GAP_CM = 0.3;
  let options = { which: 'page', size: 'fit' };

  const area = document.getElementById('print-area');

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Tessere da stampare con la loro casella (le nascoste non si stampano)
  function placedCells(page) {
    const cells = data.orderedCells(page).filter((c) => c.kind !== 'empty');
    const cols = Math.max(1, page.grid.cols || data.DEFAULT_COLS);
    if (data.isFixed(page)) return { cols, cells: cells.filter((c) => c.col < cols).map((c) => ({ cell: c, row: c.row, col: c.col })) };
    return { cols, cells: cells.map((c, i) => ({ cell: c, row: Math.floor(i / cols), col: i % cols })) };
  }

  // Crediti delle immagini di un foglio, raggruppati per fonte
  function creditsFor(cells) {
    const lines = new Set();
    cells.forEach(({ cell }) => {
      const image = cell.imageId ? data.image(cell.imageId) : null;
      if (!image && cell.imageId && cell.imageId.startsWith('img_ar_')) lines.add(t('printCreditArasaac'));
      if (!image) return;
      if (image.source === 'arasaac') lines.add(t('printCreditArasaac'));
      else if (image.source === 'mulberry') lines.add(t('printCreditMulberry'));
      else if (image.source === 'openmoji') lines.add(t('printCreditOpenmoji'));
      else if (image.source === 'twemoji') lines.add(t('printCreditTwemoji'));
      else if (image.source === 'other' && (image.author || image.license)) {
        lines.add([image.author, image.license, image.licenseUrl && image.licenseUrl.replace(/^https:\/\//, '')]
          .filter(Boolean).join(' – '));
      }
    });
    return [...lines];
  }

  function buildSheet(page) {
    const { cols, cells } = placedCells(page);
    const rows = Math.max(1, ...cells.map((c) => c.row + 1));
    const landscape = cols > rows;
    const room = landscape ? AREA.landscape : AREA.portrait;
    const fit = Math.min((room.w - GAP_CM * (cols - 1)) / cols, (room.h - GAP_CM * (rows - 1)) / rows);
    const wanted = options.size === 'fit' ? fit : Number(options.size);
    const side = Math.max(1.5, Math.min(fit, wanted));

    const sheet = el('section', `print-sheet${landscape ? ' is-landscape' : ''}`);
    sheet.append(el('h2', 'print-title', page.title || ''));
    const grid = el('div', 'print-grid');
    grid.style.gridTemplateColumns = `repeat(${cols}, ${side.toFixed(2)}cm)`;
    grid.style.gridAutoRows = `${side.toFixed(2)}cm`;
    grid.style.gap = `${GAP_CM}cm`;
    grid.style.setProperty('--print-side', `${side.toFixed(2)}cm`);
    cells.forEach(({ cell, row, col }) => {
      const tile = el('div', `print-tile type-${cell.kind === 'folder' ? 'folder' : (cell.wordType || 'noun')}`);
      tile.style.gridRow = String(row + 1);
      tile.style.gridColumn = String(col + 1);
      if (cell.color && /^#[0-9a-f]{6}$/i.test(cell.color)) {
        tile.style.setProperty('--cat', cell.color);
        tile.style.setProperty('--tint', `color-mix(in srgb, ${cell.color} 22%, white)`);
      }
      const src = data.imageUrl(cell.imageId);
      if (src) {
        const img = el('img', 'print-image');
        img.src = src;
        img.alt = '';
        tile.append(img);
      }
      tile.append(el('span', 'print-label', cell.label || ''));
      grid.append(tile);
    });
    sheet.append(grid);
    const credits = creditsFor(cells);
    if (credits.length) sheet.append(el('p', 'print-credits', credits.join(' · ')));
    return sheet;
  }

  // Aspetta che le immagini siano pronte (al massimo 5 secondi), così il foglio non esce senza figure
  function imagesReady(root) {
    const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete)
      .map((img) => new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }));
    return Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  async function printBoards() {
    const pages = options.which === 'all'
      ? [data.page(data.homePageId), ...data.profilePages().filter((p) => p.id !== data.homePageId)].filter(Boolean)
      : [data.page(app.pageId) || data.page(data.homePageId)].filter(Boolean);
    if (!pages.length) return;
    area.replaceChildren(...pages.map(buildSheet));
    document.body.classList.add('is-printing');
    await imagesReady(area);
    const done = () => {
      document.body.classList.remove('is-printing');
      area.replaceChildren();
    };
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    // Safari non sempre manda «afterprint»: si pulisce comunque poco dopo
    setTimeout(() => { if (document.body.classList.contains('is-printing')) done(); }, 60000);
  }

  // ---------- Impostazioni (categoria «Schede») ----------

  async function save(changes) {
    options = { ...options, ...changes };
    await storage.set(KEY, options);
    ui.render();
  }

  function renderPrintSection() {
    const wrap = ui.section('secPrintTitle', 'secPrintHelp');
    wrap.append(ui.settingRow('optPrintWhich', null, ui.segmented(
      [['page', 'valPrintPage'], ['all', 'valPrintAll']], options.which, (value) => save({ which: value }),
    )));
    wrap.append(ui.settingRow('optPrintSize', 'optPrintSizeHelp', ui.segmented(
      [['fit', 'valPrintFit'], ['3', 'valCm3'], ['4', 'valCm4'], ['5', 'valCm5']], options.size, (value) => save({ size: value }),
    )));
    const page = data.page(app.pageId) || data.page(data.homePageId);
    if (page && options.which === 'page') wrap.append(el('p', 'tpl-page-name', t('printPageName').replace('{page}', () => page.title)));
    wrap.append(ui.button(t('printGo'), printBoards, true));
  }

  async function restore() {
    const saved = await storage.get(KEY);
    if (saved && ['page', 'all'].includes(saved.which)) options.which = saved.which;
    if (saved && ['fit', '3', '4', '5'].includes(saved.size)) options.size = saved.size;
  }

  // La sezione si aggiunge alla categoria «Schede» (dopo lo scambio con altre app)
  window.PicSpeak.print = { printBoards, renderPrintSection };
  restore();
})();
