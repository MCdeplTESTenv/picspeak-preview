/*
 * Impostazioni: «Schede» (schede pronte, i miei modelli, importa/esporta, disposizione e blocco
 * delle posizioni, colori per tipo di parola) e «Previsione» (suggerimenti e abitudini d'uso).
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, storage, data, app, templates, predict, obf, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  const LOCK_KEY = 'lockPositions';
  // Stato di un'operazione lunga (download dei pittogrammi, applicazione di un modello)
  let busy = null; // { text } mentre lavora
  let notice = null; // { text, error } esito dell'ultima operazione

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function format(key, values) {
    return Object.entries(values).reduce((text, [k, v]) => text.replace(`{${k}}`, String(v)), t(key));
  }

  function errorText(error) {
    let code = error instanceof templates.TemplateError ? error.message : 'generic';
    if (error instanceof window.PicSpeak.zip.ZipError) code = 'obfZip';
    return t(`tplError_${code}`) === `tplError_${code}` ? t('tplError_generic') : t(`tplError_${code}`);
  }

  // ---------- Blocco delle posizioni ----------

  function applyLock(on) {
    document.documentElement.dataset.lockPositions = on ? 'on' : 'off';
  }

  async function restoreLock() {
    applyLock((await storage.get(LOCK_KEY)) === 'on');
  }

  // ---------- Finestre ----------

  // Scelta tra più azioni: [{ value, label, help, primary, danger }]. Risolve con il valore o null.
  function choose(title, help, options) {
    return ui.runPanelDialog({
      title,
      help,
      className: 'choice-dialog',
      build(close) {
        const box = el('div', 'choice-options');
        options.forEach((opt) => {
          const btn = el('button', `choice-option${opt.primary ? ' is-primary' : ''}${opt.danger ? ' is-danger' : ''}`);
          btn.type = 'button';
          btn.append(el('strong', null, opt.label));
          if (opt.help) btn.append(el('small', null, opt.help));
          btn.addEventListener('click', () => close(opt.value));
          box.append(btn);
        });
        return box;
      },
    });
  }

  // Richiesta di un nome (testo libero, breve)
  function askName(title, help, initial) {
    return ui.runPanelDialog({
      title,
      help,
      build(close) {
        const form = el('form', 'name-form');
        const input = el('input', 'name-input');
        input.type = 'text';
        input.maxLength = 60;
        input.value = initial || '';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', title);
        const ok = el('button', 'dlg-btn dlg-btn-primary', t('tplSave'));
        ok.type = 'submit';
        form.append(input, ok);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const value = input.value.trim();
          if (value) close(value);
        });
        setTimeout(() => input.focus(), 0);
        return form;
      },
    });
  }

  // ---------- Usare un modello ----------

  function networkForImages() {
    const status = window.PicSpeak.network.onlineSearchStatus();
    return status; // 'allowed' | 'ask' | 'blocked'
  }

  async function useTemplate(template) {
    const name = templates.localized(template.name);
    const stats = templates.summary(template);
    const network = networkForImages();
    let help = format('tplUseHelp', { cells: stats.cells, pages: stats.pages });
    if (stats.images && network === 'blocked') help += ` ${t('tplUseOffline')}`;
    else if (stats.images && network === 'ask') help += ` ${t('tplUseAsk')}`;
    const mode = await choose(format('tplUseTitle', { name }), help, [
      { value: 'replace', label: t('tplModeReplace'), help: t('tplModeReplaceHelp'), primary: true },
      { value: 'add', label: t('tplModeAdd'), help: t('tplModeAddHelp') },
    ]);
    if (!mode) return;
    busy = { text: t('tplWorking') };
    notice = null;
    ui.render();
    let last = 0;
    try {
      const result = await templates.apply(template, {
        mode,
        // Con «Solo Wi-Fi» e rete sconosciuta non si scarica: l'adulto lo farà da «Recupero»
        online: network === 'allowed',
        onProgress(done, total) {
          // Aggiorna la scritta al massimo una volta ogni 300 ms
          if (Date.now() - last < 300 && done < total) return;
          last = Date.now();
          busy = { text: format('tplDownloading', { done, total }) };
          ui.render();
        },
      });
      notice = {
        text: result.missing ? format('tplDoneMissing', { name, missing: result.missing }) : format('tplDone', { name }),
      };
      app.goToPage(mode === 'replace' ? data.homePageId : app.pageId);
      app.renderGrid();
    } catch (error) {
      notice = { text: errorText(error), error: true };
    }
    busy = null;
    ui.render();
  }

  async function runSafely(action) {
    try {
      await action();
    } catch (error) {
      busy = null;
      notice = { text: errorText(error), error: true };
      ui.render();
    }
  }

  // ---------- Sezioni della categoria «Schede» ----------

  function renderStatus() {
    if (!busy && !notice) return;
    const box = el('p', `tpl-status${notice && notice.error ? ' is-error' : ''}`, busy ? busy.text : notice.text);
    box.setAttribute('role', 'status');
    ui.section('secTplStatusTitle').append(box);
  }

  // Anteprima colorata della Home del modello (righe di tipi di parola)
  function previewGrid(rows) {
    const cols = Math.max(...rows.map((r) => r.length));
    const grid = el('span', 'tpl-preview');
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.setAttribute('aria-hidden', 'true');
    rows.forEach((row) => row.forEach((type) => {
      grid.append(el('span', type ? `type-${type === 'folder' ? 'folder' : type}` : 'is-blank'));
    }));
    return grid;
  }

  function templateCard({ name, description, basis, stats, preview }, actions) {
    const card = el('article', 'tpl-card');
    if (preview) card.append(previewGrid(preview));
    const text = el('div', 'tpl-text');
    text.append(el('strong', 'tpl-name', name));
    if (description) text.append(el('span', 'tpl-desc', description));
    if (stats) {
      text.append(el('small', 'tpl-stats', format(stats.pages === 1 ? 'tplStatsOne' : 'tplStats', {
        home: stats.homeCells, pages: stats.pages, cells: stats.cells,
      })));
    }
    if (basis) text.append(el('small', 'tpl-basis', basis));
    const row = el('div', 'tpl-actions');
    actions.forEach((btn) => row.append(btn));
    card.append(text, row);
    return card;
  }

  async function renderBuiltInSection() {
    const wrap = ui.section('secTplTitle', 'secTplHelp');
    let list = [];
    try {
      list = await templates.builtIns();
    } catch (error) {
      wrap.append(el('p', 'tpl-status is-error', t('tplError_network')));
      return;
    }
    const cards = el('div', 'tpl-list');
    list.forEach((item) => {
      const use = ui.button(t('tplUse'), () => runSafely(async () => useTemplate(await templates.loadBuiltIn(item.id))), true);
      const exp = ui.button(t('tplExport'), () => runSafely(async () => templates.download(await templates.loadBuiltIn(item.id))));
      use.disabled = Boolean(busy);
      cards.append(templateCard({
        name: templates.localized(item.name),
        description: templates.localized(item.description),
        basis: templates.localized(item.basis),
        stats: item.stats,
        preview: item.preview,
      }, [use, exp]));
    });
    wrap.append(cards);
  }

  async function importFromFile() {
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => runSafely(async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const template = await templates.readFile(file);
      const choice = await choose(format('tplImportTitle', { name: templates.localized(template.name) }),
        format('tplUseHelp', templates.summary(template)), [
          { value: 'save', label: t('tplImportSave'), help: t('tplImportSaveHelp'), primary: true },
          { value: 'use', label: t('tplImportUse'), help: t('tplImportUseHelp') },
        ]);
      if (choice === 'save' || choice === 'use') {
        await templates.saveUserTemplate(template);
        notice = { text: format('tplSaved', { name: templates.localized(template.name) }) };
        ui.render();
      }
      if (choice === 'use') await useTemplate(template);
    }));
    input.click();
  }

  async function renderMyTemplatesSection() {
    const wrap = ui.section('secMyTplTitle', 'secMyTplHelp');
    const tools = el('div', 'tpl-tools');
    tools.append(
      ui.button(t('tplSaveCurrent'), () => runSafely(async () => {
        const name = await askName(t('tplSaveCurrent'), t('tplNameHelp'), '');
        if (!name) return;
        const template = await templates.fromCurrentPages(name, { embed: false });
        await templates.saveUserTemplate(template);
        notice = { text: format('tplSaved', { name }) };
        ui.render();
      })),
      ui.button(t('tplExportCurrent'), () => runSafely(async () => {
        const name = await askName(t('tplExportCurrent'), t('tplNameHelp'), '');
        if (!name) return;
        busy = { text: t('tplWorking') };
        ui.render();
        templates.download(await templates.fromCurrentPages(name, { embed: true }));
        busy = null;
        notice = { text: t('tplExported') };
        ui.render();
      })),
      ui.button(t('tplImport'), importFromFile),
    );
    wrap.append(tools);

    const mine = await templates.userTemplates();
    if (!mine.length) {
      wrap.append(el('p', 'settings-help', t('tplNoneYet')));
      return;
    }
    const cards = el('div', 'tpl-list');
    mine.forEach((entry) => {
      let template;
      try {
        template = templates.validate(entry.template);
      } catch (error) {
        return; // modello danneggiato: non si mostra
      }
      const stats = templates.summary(template);
      const use = ui.button(t('tplUse'), () => runSafely(() => useTemplate(template)), true);
      use.disabled = Boolean(busy);
      const exp = ui.button(t('tplExport'), () => runSafely(async () => templates.download(await templates.embedImages(template))));
      const del = ui.button(t('tplDelete'), () => runSafely(async () => {
        const ok = await choose(format('tplDeleteTitle', { name: templates.localized(template.name) }), t('tplDeleteHelp'), [
          { value: 'yes', label: t('tplDelete'), danger: true },
        ]);
        if (ok !== 'yes') return;
        await templates.deleteUserTemplate(entry.id);
        ui.render();
      }));
      del.classList.add('dlg-btn-danger');
      const saved = entry.savedAt ? new Date(entry.savedAt).toLocaleDateString(i18n.language) : '';
      cards.append(templateCard({
        name: templates.localized(template.name),
        description: saved ? format('tplSavedOn', { date: saved }) : '',
        stats,
      }, [use, exp, del]));
    });
    wrap.append(cards);
  }

  // ---------- Scambio con altre app (Open Board Format) ----------

  // Avvisi sull'importazione: ciò che non si è potuto portare in PicSpeak
  function obfReportText(report) {
    const notes = [];
    if (report.skippedActions) notes.push(format('obfNoteActions', { n: report.skippedActions }));
    if (report.externalImages) notes.push(format('obfNoteExternal', { n: report.externalImages }));
    if (report.badImages) notes.push(format('obfNoteBadImages', { n: report.badImages }));
    if (report.brokenLinks) notes.push(format('obfNoteLinks', { n: report.brokenLinks }));
    if (report.reflowed) notes.push(format('obfNoteReflow', { n: report.reflowed }));
    if (report.noLicense) notes.push(format('obfNoteLicense', { n: report.noLicense }));
    return notes.join(' ');
  }

  function importObf() {
    const input = el('input');
    input.type = 'file';
    input.accept = '.obf,.obz,application/json,application/zip';
    input.addEventListener('change', () => runSafely(async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      busy = { text: t('obfReading') };
      notice = null;
      ui.render();
      const { template, report } = await obf.readFile(file);
      busy = null;
      ui.render();
      const name = templates.localized(template.name);
      const help = `${format('tplUseHelp', templates.summary(template))} ${obfReportText(report)}`.trim();
      const choice = await choose(format('obfImportTitle', { name }), help, [
        { value: 'save', label: t('tplImportSave'), help: t('tplImportSaveHelp'), primary: true },
        { value: 'use', label: t('tplImportUse'), help: t('tplImportUseHelp') },
      ]);
      if (choice === 'save' || choice === 'use') {
        await templates.saveUserTemplate(template);
        notice = { text: format('tplSaved', { name }) };
        ui.render();
      }
      if (choice === 'use') await useTemplate(template);
    }));
    input.click();
  }

  async function exportObfFile(kind) {
    const page = data.page(app.pageId) || data.page(data.homePageId);
    let name = page ? page.title : '';
    if (kind === 'obz') {
      name = await askName(t('obfExportAll'), t('obfExportNameHelp'), '');
      if (!name) return;
    } else {
      const ok = await choose(format('obfExportPageTitle', { page: name }), t('obfLicenseNote'), [
        { value: 'yes', label: t('obfExportPageGo'), primary: true },
      ]);
      if (ok !== 'yes') return;
    }
    busy = { text: t('tplWorking') };
    notice = null;
    ui.render();
    let last = 0;
    const onProgress = (done, total) => {
      if (Date.now() - last < 300 && done < total) return;
      last = Date.now();
      busy = { text: format('obfPreparing', { done, total }) };
      ui.render();
    };
    if (kind === 'obz') await obf.exportObz(name, { onProgress });
    else await obf.exportObf(page.id, { onProgress });
    busy = null;
    notice = { text: t('tplExported') };
    ui.render();
  }

  function renderObfSection() {
    const wrap = ui.section('secObfTitle', 'secObfHelp');
    const tools = el('div', 'tpl-tools');
    const imp = ui.button(t('obfImport'), importObf, true);
    const all = ui.button(t('obfExportAll'), () => runSafely(() => exportObfFile('obz')));
    const one = ui.button(t('obfExportPage'), () => runSafely(() => exportObfFile('obf')));
    [imp, all, one].forEach((b) => { b.disabled = Boolean(busy); });
    tools.append(imp, all, one);
    wrap.append(tools, el('p', 'settings-help', t('obfLicenseNote')));
  }

  function renderLayoutSection() {
    const page = data.page(app.pageId) || data.page(data.homePageId);
    if (!page) return;
    const wrap = ui.section('secLayoutTitle', 'secLayoutHelp');
    wrap.append(el('p', 'tpl-page-name', format('layoutPage', { page: page.title })));
    const fixed = data.isFixed(page);
    wrap.append(ui.settingRow('optLayout', 'optLayoutHelp', ui.segmented(
      [['auto', 'valLayoutAuto'], ['fixed', 'valLayoutFixed']], fixed ? 'fixed' : 'auto',
      async (value) => {
        await data.setPageLayout(page.id, { fixed: value === 'fixed', cols: page.grid.cols });
        app.renderGrid();
        ui.render();
      },
    )));
    if (fixed) {
      const stepper = el('div', 'stepper');
      const set = async (cols) => {
        await data.setPageLayout(page.id, { fixed: true, cols });
        app.renderGrid();
        ui.render();
      };
      const minus = el('button', 'stepper-btn', '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', t('layoutFewer'));
      minus.disabled = page.grid.cols <= 1;
      minus.addEventListener('click', () => set(page.grid.cols - 1));
      const value = el('span', 'stepper-value', String(page.grid.cols));
      const plus = el('button', 'stepper-btn', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', t('layoutMore'));
      plus.disabled = page.grid.cols >= 12;
      plus.addEventListener('click', () => set(page.grid.cols + 1));
      stepper.append(minus, value, plus);
      wrap.append(ui.settingRow('optColumns', 'optColumnsHelp', stepper));
    }
    const locked = document.documentElement.dataset.lockPositions === 'on';
    wrap.append(ui.settingRow('optLockPositions', 'optLockPositionsHelp', ui.segmented(
      [['off', 'valNo'], ['on', 'valYes']], locked ? 'on' : 'off',
      async (value) => {
        applyLock(value === 'on');
        await storage.set(LOCK_KEY, value);
        ui.render();
      },
    )));
  }

  function renderLegendSection() {
    const wrap = ui.section('secLegendTitle', 'secLegendHelp');
    const legend = el('ul', 'type-legend');
    [...data.WORD_TYPES, 'folder'].forEach((type) => {
      const li = el('li', `type-${type}`);
      li.append(el('span', 'legend-swatch'), el('span', null, t(type === 'folder' ? 'legendFolder' : `wordType_${type}`)),
        el('small', null, t(`legendExample_${type}`)));
      legend.append(li);
    });
    wrap.append(legend);
  }

  async function renderPreviousSection() {
    const snapshot = await data.previousPages();
    const missing = templates.missingImages();
    if (!snapshot && !missing.length) return;
    const wrap = ui.section('secRecoverTitle');
    if (missing.length) {
      const btn = ui.button(format('tplDownloadMissing', { n: missing.length }), () => runSafely(async () => {
        if (networkForImages() === 'blocked') {
          notice = { text: t('tplUseOffline'), error: true };
          ui.render();
          return;
        }
        busy = { text: t('tplWorking') };
        ui.render();
        const result = await templates.downloadMissing((done, total) => {
          busy = { text: format('tplDownloading', { done, total }) };
          if (done % 5 === 0 || done === total) ui.render();
        });
        busy = null;
        notice = result.failed
          ? { text: format('tplMissingFailed', { n: result.failed }), error: true }
          : { text: t('tplMissingDone') };
        app.renderGrid();
        ui.render();
      }));
      btn.disabled = Boolean(busy);
      wrap.append(ui.settingRow('optMissing', 'optMissingHelp', btn));
    }
    if (snapshot) {
      const date = new Date(snapshot.savedAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
      wrap.append(ui.settingRow('optPrevious', null, ui.button(t('tplRestore'), () => runSafely(async () => {
        const ok = await choose(t('tplRestoreTitle'), format('tplRestoreHelp', { date }), [
          { value: 'yes', label: t('tplRestore'), primary: true },
        ]);
        if (ok !== 'yes') return;
        await data.restorePreviousPages();
        app.goToPage(data.homePageId);
        app.renderGrid();
        notice = { text: t('tplRestored') };
        ui.render();
      }))));
      wrap.lastChild.querySelector('.setting-text').append(el('small', null, format('tplPreviousFrom', { date })));
    }
  }

  // ---------- Categoria «Previsione» ----------

  function renderSuggestSection() {
    const s = predict.settings;
    const wrap = ui.section('secSuggestTitle', 'secSuggestHelp');
    wrap.append(ui.settingRow('optSuggest', 'optSuggestHelp', ui.segmented(
      [['off', 'valNo'], ['on', 'valYes']], s.suggest ? 'on' : 'off',
      async (value) => { await predict.setSettings({ suggest: value === 'on' }); app.applySuggestions(); ui.render(); },
    )));
    if (s.suggest) {
      wrap.append(ui.settingRow('optSuggestCount', 'optSuggestCountHelp', ui.segmented(
        [['1', 'val1'], ['2', 'val2'], ['3', 'val3']], String(s.count),
        async (value) => { await predict.setSettings({ count: Number(value) }); app.applySuggestions(); ui.render(); },
      )));
    }
    // Esempio dell'aspetto della tessera evidenziata
    const sample = el('div', 'suggest-sample');
    const tile = el('span', 'suggest-sample-tile is-suggested', t('suggestSample'));
    sample.append(tile, el('small', null, t('suggestSampleHelp')));
    wrap.append(sample);
  }

  function renderHabitsSection() {
    const s = predict.settings;
    const wrap = ui.section('secHabitsTitle', 'secHabitsHelp');
    wrap.append(ui.settingRow('optCollect', 'optCollectHelp', ui.segmented(
      [['off', 'valNo'], ['on', 'valYes']], s.collect ? 'on' : 'off',
      async (value) => { await predict.setSettings({ collect: value === 'on' }); ui.render(); },
    )));
    const stats = predict.stats();
    wrap.append(el('p', 'habits-stats', format('habitsStats', { uses: stats.uses, pairs: stats.pairs })));
    if (stats.top.length) {
      wrap.append(el('p', 'habits-top-title', t('habitsTop')));
      const ol = el('ol', 'habits-top');
      stats.top.forEach((pair) => ol.append(el('li', null, `${pair.from} → ${pair.to}`)));
      wrap.append(ol);
    }
    const clear = ui.button(t('habitsClear'), () => runSafely(async () => {
      const ok = await choose(t('habitsClearTitle'), t('habitsClearHelp'), [
        { value: 'yes', label: t('habitsClear'), danger: true },
      ]);
      if (ok !== 'yes') return;
      await predict.clearAll();
      app.applySuggestions();
      ui.render();
    }));
    clear.classList.add('dlg-btn-danger');
    clear.disabled = !stats.pairs;
    wrap.append(clear);
  }

  function renderHowSection() {
    const wrap = ui.section('secPredictHowTitle');
    wrap.append(ui.list(t('predictHow')));
  }

  // ---------- Registrazione delle categorie ----------

  ui.addCategory({
    id: 'boards',
    icon: '<rect x="3.5" y="6.5" width="13" height="13" rx="2"/><path d="M7.5 3.5h11a2 2 0 0 1 2 2v11"/><path d="M7 11h6M7 15h4"/>',
    titleKey: 'catBoards',
    introKey: 'catBoardsIntro',
    render: [renderStatus, renderBuiltInSection, renderMyTemplatesSection, renderObfSection,
      () => { if (window.PicSpeak.print) window.PicSpeak.print.renderPrintSection(); },
      renderLayoutSection, renderPreviousSection, renderLegendSection],
  }, 'appearance');

  ui.addCategory({
    id: 'prediction',
    icon: '<path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    titleKey: 'catPrediction',
    introKey: 'catPredictionIntro',
    render: [renderSuggestSection, renderHabitsSection, renderHowSection],
  }, 'boards');

  restoreLock();
})();
