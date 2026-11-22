/*
 * Impostazioni › Previsione › Contesti (dietro il PIN, come tutte le impostazioni).
 * Elenco dei contesti (Scuola, Logopedia, Mare…) e scheda di modifica:
 *   quando vale (giorni della settimana e fasce di un'ora, oppure un periodo dell'anno),
 *   accensione (automatica, sempre accesa, spenta), da quali dati (come la regola o un periodo preciso
 *   dello storico), prevalenza (poca, media, molta) e combinazioni del contesto, modificabili.
 * Nella barra della modalità adulto un pulsante mostra il contesto attivo e apre questa pagina.
 * Nella schermata del bambino non c'è nulla dei contesti.
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, predict, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Una sola sostituzione con una funzione: un nome scritto dall'adulto resta testo semplice
  function format(key, values) {
    return t(key).replace(/\{(\w+)\}/g, (match, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : match));
  }

  const SHOWN_PAIRS = 30;
  let draft = null; // contesto in modifica (null = si vede l'elenco)
  let notice = null;

  // ---------- Testi delle regole ----------

  function dayNames() {
    return t('ctxDayShort'); // elenco lun…dom
  }

  function monthName(m) {
    return new Date(Date.UTC(2024, m - 1, 1)).toLocaleDateString(i18n.language, { month: 'short', timeZone: 'UTC' });
  }

  function mdText(md) {
    return `${Number(md.slice(3))} ${monthName(Number(md.slice(0, 2)))}`;
  }

  function isoText(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    return d.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // «lun–ven» per giorni consecutivi, altrimenti «lun, mer, ven»
  function daysText(days) {
    const names = dayNames();
    const runs = [];
    days.forEach((d) => {
      const last = runs[runs.length - 1];
      if (last && d === last[1] + 1) last[1] = d; else runs.push([d, d]);
    });
    return runs.map(([a, b]) => (a === b ? names[a - 1] : `${names[a - 1]}${b - a === 1 ? ', ' : '–'}${names[b - 1]}`)).join(', ');
  }

  function ruleText(rule) {
    if (!rule) return '';
    if (rule.type === 'weekly') {
      return rule.days.length === 7 && rule.from === 0 && rule.to === 24
        ? t('ctxAlways') : format(rule.to < rule.from ? 'ctxWeeklyNightText' : 'ctxWeeklyText', { days: daysText(rule.days), from: rule.from, to: rule.to });
    }
    return format('ctxDatesText', { from: mdText(rule.from), to: mdText(rule.to) });
  }

  function stateText(ctx) {
    if (ctx.mode === 'on') return t('ctxStateOn');
    if (ctx.mode === 'off') return t('ctxStateOff');
    return ctx.activeNow ? t('ctxStateAutoActive') : t('ctxStateAuto');
  }

  // ---------- Bozza del contesto in modifica ----------

  function isoOf(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function newDraft() {
    const now = new Date();
    const lastYear = now.getFullYear() - 1;
    return {
      id: null,
      name: '',
      type: 'weekly',
      weekly: { days: [1, 2, 3, 4, 5], from: 8, to: 12 },
      dates: { from: '06-01', to: '06-15' },
      mode: 'auto',
      boost: 4,
      sourceMode: 'rule',
      source: { from: `${lastYear}-06-01`, to: `${lastYear}-06-15` },
      edits: [],
      shown: SHOWN_PAIRS, // combinazioni visibili: si allunga di 30 alla volta
      error: null,
    };
  }

  function draftFrom(ctx) {
    const d = newDraft();
    d.id = ctx.id;
    d.name = ctx.name;
    d.type = ctx.rule.type;
    if (ctx.rule.type === 'weekly') d.weekly = { days: [...ctx.rule.days], from: ctx.rule.from, to: ctx.rule.to };
    else d.dates = { from: ctx.rule.from, to: ctx.rule.to };
    d.mode = ctx.mode;
    d.boost = ctx.boost;
    if (ctx.source) { d.sourceMode = 'range'; d.source = { ...ctx.source }; }
    d.edits = ctx.edits.map((e) => ({ ...e }));
    return d;
  }

  function draftContext() {
    return {
      id: draft.id || undefined,
      name: draft.name,
      rule: draft.type === 'weekly' ? { type: 'weekly', ...draft.weekly } : { type: 'dates', ...draft.dates },
      mode: draft.mode,
      boost: draft.boost,
      source: draft.sourceMode === 'range' ? { ...draft.source } : null,
      edits: draft.edits,
    };
  }

  function refresh() {
    ui.render();
  }

  // ---------- Pulsante del contesto nella barra della modalità adulto ----------

  const bar = document.getElementById('adult-bar');
  const settingsBtn = document.getElementById('btn-open-settings');
  let chip = null;

  function updateChip() {
    if (!bar || !settingsBtn) return;
    const list = predict.listContexts();
    if (!list.length) {
      if (chip) chip.hidden = true;
      return;
    }
    if (!chip) {
      chip = el('button', 'adult-btn ctx-chip');
      chip.type = 'button';
      chip.addEventListener('click', () => {
        draft = null;
        ui.openSettings('prediction');
        setTimeout(() => {
          const target = document.getElementById('ctx-section');
          if (target) target.scrollIntoView({ block: 'start' });
        }, 0);
      });
      bar.insertBefore(chip, settingsBtn);
    }
    const active = predict.activeContexts();
    chip.hidden = false;
    const name = el('span', 'ctx-chip-name');
    if (active.length) name.append(...predict.contextNameNodes(active)); else name.textContent = t('ctxChipNone');
    chip.replaceChildren(el('span', 'ctx-chip-label', t('ctxChip')), name);
    chip.setAttribute('aria-label', `${t('ctxChip')} ${active.length ? active.join(', ') : t('ctxChipNone')}`);
  }

  if (bar) {
    // Si aggiorna ogni volta che la barra compare (ingresso in modalità adulto) e allo scoccare dei minuti
    new MutationObserver(() => { if (bar.hidden) draft = null; else updateChip(); }).observe(bar, { attributes: true, attributeFilter: ['hidden'] });
    setInterval(() => { if (!bar.hidden) updateChip(); }, 60000);
  }

  // ---------- File ----------

  function download(text, name, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function safeName(name) {
    return String(name).normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'contesto';
  }

  const stamp = () => new Date().toISOString().slice(0, 10);

  function exportHistory() {
    download(predict.exportJson(), `PicSpeak-${i18n.language === 'it' ? 'storico' : 'history'}-${stamp()}.json`, 'application/json');
  }

  function exportOne(id, name) {
    const text = predict.exportContextJson(id);
    if (text) download(text, `PicSpeak-${i18n.language === 'it' ? 'contesto' : 'context'}-${safeName(name)}-${stamp()}.json`, 'application/json');
  }

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

  function historyError(error) {
    const key = error instanceof predict.HistoryError ? `historyError_${error.message}` : 'historyError_format';
    return t(key) === key ? t('historyError_format') : t(key);
  }

  // Importa un file dello storico o di un solo contesto. Il risultato appare come avviso nella sezione
  function importFile(onDone) {
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let message;
      try {
        const { parsed, summary } = await predict.readHistoryFile(file);
        if (summary.kind === 'contexts') {
          const ok = await choose(format('ctxImportTitle', { names: summary.names.join(', ') }), t('ctxImportHelp'), [
            { value: 'merge', label: t('ctxImportBtn'), primary: true },
          ]);
          if (ok !== 'merge') return;
          await predict.importData(parsed, 'merge');
          message = { text: format('ctxImported', { names: summary.names.join(', ') }) };
        } else {
          const mode = await choose(format('historyImportTitle', { days: summary.days, contexts: summary.contexts }), t('historyImportHelp'), [
            { value: 'merge', label: t('historyImportMerge'), help: t('historyImportMergeHelp'), primary: true },
            { value: 'replace', label: t('historyImportReplace'), help: t('historyImportReplaceHelp'), danger: true },
          ]);
          if (mode !== 'merge' && mode !== 'replace') return;
          await predict.importData(parsed, mode);
          message = { text: t('historyImported') };
        }
      } catch (error) {
        message = { text: historyError(error), error: true };
      }
      if (window.PicSpeak.app) window.PicSpeak.app.applySuggestions();
      updateChip();
      onDone(message);
    });
    input.click();
  }

  // ---------- Elenco dei contesti ----------

  function statusBox(wrap) {
    if (!notice) return;
    const box = el('p', `tpl-status${notice.error ? ' is-error' : ''}`, notice.text);
    box.setAttribute('role', 'status');
    wrap.append(box);
    notice = null;
  }

  function renderList(wrap) {
    statusBox(wrap);
    // Nome del contesto acceso anche nella schermata del bambino (solo da leggere)
    wrap.append(ui.settingRow('ctxShowTag', 'ctxShowTagHelp', ui.segmented(
      [['off', 'valNo'], ['on', 'valYes']], predict.settings.showContext ? 'on' : 'off',
      async (value) => { await predict.setSettings({ showContext: value === 'on' }); refresh(); },
    )));
    const list = predict.listContexts();
    // Molti contesti accesi insieme: nessun divieto, ma un avviso (le spinte si sommano e si diluiscono)
    const activeCount = list.filter((c) => c.activeNow).length;
    if (activeCount > 3) {
      const warn = el('p', 'tpl-status', format('ctxManyActive', { n: activeCount }));
      warn.setAttribute('role', 'status');
      wrap.append(warn);
    }
    if (!list.length) wrap.append(el('p', 'settings-help', t('ctxNone')));
    else {
      const ul = el('ul', 'ctx-list');
      list.forEach((ctx) => {
        const li = el('li', `ctx-item${ctx.activeNow ? ' is-active' : ''}`);
        const text = el('div', 'ctx-text');
        text.append(el('strong', 'ctx-name', ctx.name), el('small', null, ruleText(ctx.rule)));
        if (ctx.source) text.append(el('small', null, format('ctxSourceText', { from: isoText(ctx.source.from), to: isoText(ctx.source.to) })));
        const state = el('span', `ctx-state${ctx.activeNow ? ' is-active' : ''}`, stateText(ctx));
        const edit = ui.button(t('ctxEdit'), () => { draft = draftFrom(ctx); refresh(); });
        li.append(text, state, edit);
        ul.append(li);
      });
      wrap.append(ul);
    }
    const tools = el('div', 'tpl-tools');
    tools.append(
      ui.button(t('ctxNew'), () => { draft = newDraft(); refresh(); }, true),
      ui.button(t('ctxImportFile'), () => importFile((m) => { notice = m; refresh(); })),
    );
    wrap.append(tools);
  }

  // ---------- Scheda di modifica ----------

  function field(labelKey, control) {
    const label = el('label', 'settings-field ctx-field');
    label.append(el('span', null, t(labelKey)), control);
    return label;
  }

  function select(values, current, onChange) {
    const node = el('select');
    values.forEach(([value, text]) => {
      const opt = el('option', null, text);
      opt.value = String(value);
      if (String(value) === String(current)) opt.selected = true;
      node.append(opt);
    });
    node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  function renderWhen(wrap) {
    wrap.append(ui.settingRow('ctxType', 'ctxTypeHelp', ui.segmented(
      [['weekly', 'ctxTypeWeekly'], ['dates', 'ctxTypeDates']], draft.type,
      (value) => { draft.type = value; refresh(); },
    )));
    if (draft.type === 'weekly') {
      const daysBox = el('div', 'choice-group ctx-days');
      daysBox.setAttribute('role', 'group');
      daysBox.setAttribute('aria-label', t('ctxDays'));
      dayNames().forEach((name, i) => {
        const day = i + 1;
        const btn = el('button', 'dlg-btn ctx-day', name);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(draft.weekly.days.includes(day)));
        btn.addEventListener('click', () => {
          const set = new Set(draft.weekly.days);
          if (set.has(day)) set.delete(day); else set.add(day);
          draft.weekly.days = [...set].sort((a, b) => a - b);
          refresh();
        });
        daysBox.append(btn);
      });
      wrap.append(field('ctxDays', daysBox));
      const hours = el('div', 'ctx-pair-fields');
      hours.append(
        field('ctxFrom', select(range(0, 23).map((h) => [h, `${h}:00`]), draft.weekly.from, (v) => { draft.weekly.from = Number(v); refresh(); })),
        field('ctxTo', select(range(1, 24).map((h) => [h, `${h}:00`]), draft.weekly.to, (v) => { draft.weekly.to = Number(v); refresh(); })),
      );
      wrap.append(hours);
      if (draft.weekly.to < draft.weekly.from) wrap.append(el('p', 'settings-help', format('ctxNightHelp', { to: draft.weekly.to })));
    } else {
      const months = range(1, 12).map((m) => [m, monthName(m)]);
      const part = (key) => {
        const md = draft.dates[key];
        const box = el('div', 'ctx-date');
        const set = (day, month) => {
          const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
          draft.dates[key] = `${String(month).padStart(2, '0')}-${String(Math.min(day, max)).padStart(2, '0')}`;
          refresh();
        };
        const daySel = select(range(1, 31).map((d) => [d, String(d)]), Number(md.slice(3)), (v) => set(Number(v), Number(md.slice(0, 2))));
        daySel.setAttribute('aria-label', t('ctxDay'));
        const monthSel = select(months, Number(md.slice(0, 2)), (v) => set(Number(md.slice(3)), Number(v)));
        monthSel.setAttribute('aria-label', t('ctxMonth'));
        box.append(daySel, monthSel);
        return box;
      };
      const dates = el('div', 'ctx-pair-fields');
      dates.append(field('ctxDateFrom', part('from')), field('ctxDateTo', part('to')));
      wrap.append(dates, el('p', 'settings-help', t('ctxDatesHelp')));
    }
  }

  function renderSource(wrap) {
    wrap.append(ui.settingRow('ctxSource', 'ctxSourceHelp', ui.segmented(
      [['rule', 'ctxSourceRule'], ['range', 'ctxSourceRange']], draft.sourceMode,
      (value) => { draft.sourceMode = value; refresh(); },
    )));
    if (draft.sourceMode === 'range') {
      const box = el('div', 'ctx-pair-fields');
      const dateInput = (key) => {
        const input = el('input', 'name-input');
        input.type = 'date';
        input.value = draft.source[key];
        input.max = isoOf(new Date());
        input.addEventListener('change', () => { if (input.value) { draft.source[key] = input.value; refresh(); } });
        return input;
      };
      box.append(field('ctxSourceFrom', dateInput('from')), field('ctxSourceTo', dateInput('to')));
      wrap.append(box);
    }
  }

  async function askWeight(title, current) {
    return ui.runDialog({
      title,
      help: t('ctxWeightHelp'),
      fields: [{ id: 'weight', label: t('ctxWeight'), text: true }],
      primary: t('ctxWeightSave'),
      secondary: t('cancel'),
      onSubmit(values) {
        const value = Number(String(values.weight || current).replace(',', '.'));
        if (!Number.isFinite(value) || value < 0 || value > 1000) return t('ctxWeightError');
        return { weight: Math.round(value * 10) / 10 };
      },
    });
  }

  function setEdit(prev, word, weight) {
    draft.edits = draft.edits.filter((e) => !(e.prev === prev && e.word === word));
    if (weight !== null) draft.edits.push({ prev, word, weight });
  }

  function pairLabel(item) {
    return `${item.prev === predict.START ? t('ctxStartWord') : item.prev} → ${item.word}`;
  }

  function renderPairs(wrap) {
    const pairs = predict.contextPairs(draftContext());
    const visible = pairs.filter((p) => !p.removed);
    if (!pairs.length) wrap.append(el('p', 'settings-help', t('ctxPairsNone')));
    const shown = pairs.slice(0, draft.shown);
    if (shown.length) {
      const ol = el('ol', 'ctx-pairs');
      shown.forEach((item) => {
        const li = el('li', `ctx-pair${item.removed ? ' is-removed' : ''}${item.edited ? ' is-edited' : ''}`);
        const text = el('div', 'ctx-pair-text');
        text.append(el('strong', 'ctx-pair-words', pairLabel(item)));
        let detail = item.removed ? t('ctxPairRemoved') : format('ctxPairWeight', { weight: (Math.round(item.weight * 10) / 10).toLocaleString(i18n.language) });
        if (item.uses) detail += ` · ${format('ctxPairUses', { n: Math.round(item.uses) })}`;
        if (item.edited && !item.removed) detail += ` · ${t('ctxPairEdited')}`;
        text.append(el('small', null, detail));
        const actions = el('div', 'ctx-pair-actions');
        if (item.removed) {
          actions.append(ui.button(t('ctxPairRestore'), () => { setEdit(item.prev, item.word, null); refresh(); }));
        } else {
          actions.append(
            ui.button(t('ctxPairChange'), async () => {
              const res = await askWeight(pairLabel(item), item.weight);
              if (res && res.weight !== undefined) { setEdit(item.prev, item.word, res.weight); refresh(); }
            }),
            ui.button(t('ctxPairRemove'), () => { setEdit(item.prev, item.word, 0); refresh(); }),
          );
        }
        li.append(text, actions);
        ol.append(li);
      });
      wrap.append(ol);
    }
    const tools = el('div', 'tpl-tools');
    // Elenchi lunghi: 30 alla volta, dalla combinazione più pesante (la pagina non diventa infinita in un colpo)
    if (pairs.length > draft.shown) {
      const more = Math.min(SHOWN_PAIRS, pairs.length - draft.shown);
      tools.append(ui.button(`${format('ctxPairsMore', { n: more })} (${draft.shown}/${pairs.length})`, () => { draft.shown += SHOWN_PAIRS; refresh(); }));
    }
    if (draft.shown > SHOWN_PAIRS) {
      tools.append(ui.button(t('ctxPairsFewer'), () => { draft.shown = SHOWN_PAIRS; refresh(); }));
    }
    tools.append(ui.button(t('ctxPairAdd'), async () => {
      const res = await ui.runDialog({
        title: t('ctxPairAddTitle'),
        help: t('ctxPairAddHelp'),
        fields: [
          { id: 'prev', label: t('ctxPairPrev'), text: true },
          { id: 'word', label: t('ctxPairWord'), text: true },
          { id: 'weight', label: t('ctxWeight'), text: true },
        ],
        primary: t('ctxPairAddBtn'),
        secondary: t('cancel'),
        onSubmit(values) {
          const word = predict.wordKey(values.word);
          const prevRaw = predict.wordKey(values.prev);
          const prev = !prevRaw || prevRaw === '(inizio)' || prevRaw === '(start)' ? predict.START : prevRaw;
          const weight = Number(String(values.weight || '5').replace(',', '.'));
          if (!word) return t('ctxPairWordError');
          if (!Number.isFinite(weight) || weight <= 0 || weight > 1000) return t('ctxWeightError');
          return { prev, word, weight: Math.round(weight * 10) / 10 };
        },
      });
      if (res && res.word) { setEdit(res.prev, res.word, res.weight); refresh(); }
    }));
    if (draft.edits.length) {
      tools.append(ui.button(format('ctxEditsReset', { n: draft.edits.length }), () => { draft.edits = []; refresh(); }));
    }
    wrap.append(tools);
    if (pairs.length && !visible.length) wrap.append(el('p', 'settings-help', t('ctxPairsAllRemoved')));
  }

  async function save() {
    try {
      await predict.saveContext(draftContext());
      notice = { text: format('ctxSaved', { name: draft.name.trim() }) };
      draft = null;
      if (window.PicSpeak.app) window.PicSpeak.app.applySuggestions();
      updateChip();
    } catch (error) {
      const key = error instanceof predict.ContextError ? `ctxError_${error.message}` : 'ctxError_rule';
      draft.error = t(key) === key ? t('ctxError_rule') : t(key);
    }
    refresh();
  }

  async function remove() {
    const ok = await choose(format('ctxDeleteTitle', { name: draft.name }), t('ctxDeleteHelp'), [
      { value: 'yes', label: t('ctxDelete'), danger: true },
    ]);
    if (ok !== 'yes') return;
    await predict.deleteContext(draft.id);
    notice = { text: format('ctxDeleted', { name: draft.name }) };
    draft = null;
    if (window.PicSpeak.app) window.PicSpeak.app.applySuggestions();
    updateChip();
    refresh();
  }

  function renderEditor() {
    const head = ui.section(draft.id ? 'ctxEditTitle' : 'ctxNewTitle', 'ctxEditHelp');
    head.id = 'ctx-section';
    if (draft.error) {
      const box = el('p', 'tpl-status is-error', draft.error);
      box.setAttribute('role', 'alert');
      head.append(box);
      draft.error = null;
    }
    const name = el('input', 'name-input');
    name.type = 'text';
    name.maxLength = predict.NAME_MAX;
    name.value = draft.name;
    name.placeholder = t('ctxNamePlaceholder');
    name.autocomplete = 'off';
    // Il nome si scrive sempre in MAIUSCOLO, già mentre si digita (il cursore resta dov'era)
    name.autocapitalize = 'characters';
    name.addEventListener('input', () => {
      const upper = name.value.toUpperCase();
      if (upper !== name.value) {
        const { selectionStart: start, selectionEnd: end } = name;
        name.value = upper;
        if (upper.length === name.value.length) name.setSelectionRange(start, end);
      }
      draft.name = name.value;
    });
    head.append(field('ctxName', name));

    const when = ui.section('ctxWhenTitle', 'ctxWhenHelp');
    renderWhen(when);
    when.append(ui.settingRow('ctxMode', 'ctxModeHelp', ui.segmented(
      [['auto', 'ctxModeAuto'], ['on', 'ctxModeOn'], ['off', 'ctxModeOff']], draft.mode,
      (value) => { draft.mode = value; refresh(); },
    )));

    const data = ui.section('ctxDataTitle', 'ctxDataHelp');
    renderSource(data);
    data.append(ui.settingRow('ctxBoost', 'ctxBoostHelp', ui.segmented(
      [['2', 'ctxBoostLow'], ['4', 'ctxBoostMedium'], ['8', 'ctxBoostHigh']], String(draft.boost),
      (value) => { draft.boost = Number(value); refresh(); },
    )));

    const pairs = ui.section('ctxPairsTitle', 'ctxPairsHelp');
    renderPairs(pairs);

    const actions = ui.section('ctxActionsTitle');
    const tools = el('div', 'tpl-tools');
    tools.append(
      ui.button(t('ctxSave'), save, true),
      ui.button(t('cancel'), () => { draft = null; refresh(); }),
    );
    if (draft.id) {
      const id = draft.id;
      tools.append(ui.button(t('ctxExportOne'), () => exportOne(id, draft.name)));
      const del = ui.button(t('ctxDelete'), remove);
      del.classList.add('dlg-btn-danger');
      tools.append(del);
    }
    actions.append(tools);
  }

  function render() {
    if (draft) { renderEditor(); return; }
    const wrap = ui.section('ctxTitle', 'ctxHelp');
    wrap.id = 'ctx-section';
    renderList(wrap);
  }

  window.PicSpeak.contextsUi = {
    render,
    exportHistory,
    importFile,
    updateChip,
    get editing() { return Boolean(draft); },
  };

  if (predict.ready) predict.ready.then(updateChip);
})();
