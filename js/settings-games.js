/*
 * Impostazioni › Giochi (dietro il PIN, come tutte le impostazioni).
 * - Giochi sì/no (spenti all'inizio) e scelta dei giochi da mostrare.
 * - Orari senza giochi (per esempio a scuola): la casella «Giochi» non compare.
 * - Pittogrammi dei giochi: si scaricano una sola volta, rispettando la scelta sull'uso di internet.
 * - Storie: storie pronte (attivabili una per una) e storie dell'adulto, con livello, modifica, copia,
 *   prova, esportazione e importazione, ripristino delle pronte. Le frasi si compongono toccando le tessere vere.
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, games, settingsUi: ui, data } = window.PicSpeak;
  const t = i18n.t;

  const MAX_FILE = 512 * 1024; // un file di storie è piccolo: oltre questa misura non si legge

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function format(key, values) {
    return t(key).replace(/\{(\w+)\}/g, (match, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : match));
  }

  let draft = null; // storia in modifica (null = si vede la pagina dei giochi)
  let notice = null;
  let downloading = null; // { done, total }
  let newSlot = { days: [1, 2, 3, 4, 5], from: 8, to: 13 };

  const refresh = () => ui.render();

  function statusBox(wrap) {
    if (!notice) return;
    const box = el('p', `tpl-status${notice.error ? ' is-error' : ''}`, notice.text);
    box.setAttribute('role', 'status');
    wrap.append(box);
    notice = null;
  }

  function yesNo(value, onChange) {
    return ui.segmented([['off', 'valNo'], ['on', 'valYes']], value ? 'on' : 'off', (v) => onChange(v === 'on'));
  }

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

  // ---------- Giochi sì/no e scelta dei giochi ----------

  function renderMain() {
    const s = games.settings;
    const wrap = ui.section('gamesSecTitle', 'gamesSecHelp');
    statusBox(wrap);
    wrap.append(ui.settingRow('gamesEnabled', 'gamesEnabledHelp', yesNo(s.enabled, async (on) => {
      await games.saveSettings({ enabled: on });
      // Accendendo i giochi si scaricano subito i pittogrammi mancanti, se internet è permesso
      if (on && games.missingPictograms().length && window.PicSpeak.network.onlineSearchStatus() === 'allowed') download();
      refresh();
    })));
    if (s.enabled && games.quietNow()) wrap.append(el('p', 'tpl-status', t('gamesQuietNow')));

    const list = ui.section('gamesWhichTitle', 'gamesWhichHelp');
    games.GAMES.forEach((game) => {
      list.append(ui.settingRow(game.nameKey, game.descKey, yesNo(s.games[game.id], async (on) => {
        await games.saveSettings({ games: { ...s.games, [game.id]: on } });
        refresh();
      })));
    });
    // Parole e lettere: suoni delle lettere (predefiniti, come chiede la logopedia) o nomi delle lettere
    if (s.games.words) {
      list.append(ui.settingRow('gamesLetterMode', 'gamesLetterModeHelp', ui.segmented(
        [['sounds', 'gamesLetterSounds'], ['names', 'gamesLetterNames']], s.letterMode,
        async (value) => { await games.saveSettings({ letterMode: value }); refresh(); },
      ), { advanced: true }));
    }
  }

  // ---------- Orari senza giochi ----------

  function daysText(days) {
    const names = t('ctxDayShort');
    const runs = [];
    days.forEach((d) => {
      const last = runs[runs.length - 1];
      if (last && d === last[1] + 1) last[1] = d; else runs.push([d, d]);
    });
    return runs.map(([a, b]) => (a === b ? names[a - 1] : `${names[a - 1]}${b - a === 1 ? ', ' : '–'}${names[b - 1]}`)).join(', ');
  }

  function slotText(slot) {
    return format('gamesSlotText', { days: daysText(slot.days), from: slot.from, to: slot.to });
  }

  function renderQuiet() {
    const s = games.settings;
    const wrap = ui.section('gamesQuietTitle', 'gamesQuietHelp', { advanced: true });
    if (s.quiet.length) {
      const ul = el('ul', 'ctx-list');
      s.quiet.forEach((slot, index) => {
        const li = el('li', 'ctx-item');
        const text = el('div', 'ctx-text');
        text.append(el('strong', 'ctx-name', slotText(slot)));
        const del = ui.button(t('gamesSlotRemove'), async () => {
          await games.saveSettings({ quiet: s.quiet.filter((_, i) => i !== index) });
          refresh();
        });
        del.setAttribute('aria-label', `${t('gamesSlotRemove')}: ${slotText(slot)}`);
        li.append(text, del);
        ul.append(li);
      });
      wrap.append(ul);
    } else {
      wrap.append(el('p', 'settings-help', t('gamesQuietNone')));
    }
    if (s.quiet.length >= 8) return;
    // Nuova fascia: giorni e ore, come per i contesti
    const daysBox = el('div', 'choice-group ctx-days');
    daysBox.setAttribute('role', 'group');
    daysBox.setAttribute('aria-label', t('ctxDays'));
    t('ctxDayShort').forEach((name, i) => {
      const day = i + 1;
      const btn = el('button', 'dlg-btn ctx-day', name);
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(newSlot.days.includes(day)));
      btn.addEventListener('click', () => {
        const set = new Set(newSlot.days);
        if (set.has(day)) set.delete(day); else set.add(day);
        newSlot.days = [...set].sort((a, b) => a - b);
        refresh();
      });
      daysBox.append(btn);
    });
    wrap.append(field('ctxDays', daysBox));
    const hours = el('div', 'ctx-pair-fields');
    hours.append(
      field('ctxFrom', select(range(0, 23).map((h) => [h, `${h}:00`]), newSlot.from, (v) => { newSlot.from = Number(v); refresh(); })),
      field('ctxTo', select(range(1, 24).map((h) => [h, `${h}:00`]), newSlot.to, (v) => { newSlot.to = Number(v); refresh(); })),
    );
    wrap.append(hours);
    const tools = el('div', 'tpl-tools');
    const add = ui.button(t('gamesSlotAdd'), async () => {
      if (!newSlot.days.length || newSlot.from === newSlot.to) {
        notice = { text: t('gamesSlotError'), error: true };
        refresh();
        return;
      }
      await games.saveSettings({ quiet: [...s.quiet, { ...newSlot }] });
      notice = { text: format('gamesSlotAdded', { slot: slotText(newSlot) }) };
      refresh();
    }, true);
    tools.append(add);
    wrap.append(tools);
  }

  // ---------- Pittogrammi dei giochi ----------

  async function download() {
    if (downloading) return;
    const status = window.PicSpeak.network.onlineSearchStatus();
    if (status === 'blocked') {
      notice = { text: t('gamesPicsBlocked'), error: true };
      refresh();
      return;
    }
    if (status === 'ask') {
      const ok = await ui.runDialog({ title: t('gamesPicsAskTitle'), help: t('gamesPicsAskHelp'), primary: t('gamesPicsDownload'), secondary: t('cancel') });
      if (!ok) return;
    }
    downloading = { done: 0, total: games.missingPictograms().length };
    refresh();
    const result = await games.downloadPictograms((done, total) => { downloading = { done, total }; refresh(); });
    downloading = null;
    notice = result.failed
      ? { text: format('gamesPicsFailed', { n: result.failed }), error: true }
      : { text: t('gamesPicsDone') };
    refresh();
  }

  function renderPictograms() {
    const wrap = ui.section('gamesPicsTitle', 'gamesPicsHelp', { advanced: true });
    const missing = games.missingPictograms().length;
    const total = window.PicSpeak.gamesData.words.length;
    if (downloading) {
      wrap.append(el('p', 'tpl-status', format('gamesPicsProgress', { done: downloading.done, total: downloading.total })));
      return;
    }
    wrap.append(el('p', 'settings-help', format('gamesPicsStatus', { have: total - missing, total })));
    if (missing) {
      const tools = el('div', 'tpl-tools');
      tools.append(ui.button(format('gamesPicsDownloadN', { n: missing }), download, true));
      wrap.append(tools);
    }
  }

  // ---------- Storie: file ----------

  function safeName(name) {
    return String(name).normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'storia';
  }

  function exportFile(stories, name) {
    const payload = {
      format: 'picspeak-stories',
      formatVersion: games.FORMAT_VERSION,
      app: 'PicSpeak',
      exportedAt: new Date().toISOString(),
      // Solo le parole: gli id delle tessere valgono solo su questo dispositivo
      stories: stories.map((s) => ({
        title: s.title, level: s.level, lang: s.lang || i18n.language,
        sentences: s.sentences.map((sentence) => sentence.map((w) => w.label)),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = `PicSpeak-${i18n.language === 'it' ? 'storie' : 'stories'}-${safeName(name)}-${new Date().toISOString().slice(0, 10)}.json`;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // Legge un file di storie: controlla misura, formato e versione, poi ogni storia una per una
  async function readStoriesFile(file) {
    if (!file || file.size > MAX_FILE) throw new Error('size');
    let raw;
    try { raw = JSON.parse(await file.text()); } catch (error) { throw new Error('format'); }
    if (!raw || raw.format !== 'picspeak-stories' || !Array.isArray(raw.stories)) throw new Error('format');
    if (!Number.isInteger(raw.formatVersion) || raw.formatVersion < 1 || raw.formatVersion > games.FORMAT_VERSION) throw new Error('version');
    // Versione 1: nessuna migrazione necessaria (le versioni future andranno convertite qui)
    // Solo le parole: un id di tessera in un file (che PicSpeak non scrive mai) potrebbe far toccare un'altra tessera
    const wordsOnly = (sentences) => (Array.isArray(sentences) ? sentences.map((sentence) => (Array.isArray(sentence)
      ? sentence.map((w) => (typeof w === 'string' ? w : w && w.label)) : [])) : []);
    return raw.stories.slice(0, games.LIMITS.stories).filter((s) => s && typeof s === 'object')
      .map((s) => games.cleanStory({ title: s.title, level: s.level, lang: s.lang, sentences: wordsOnly(s.sentences), id: null, from: null, enabled: true }))
      .filter(Boolean);
  }

  function importFile() {
    const input = el('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const list = await readStoriesFile(file);
        if (!list.length) throw new Error('empty');
        const own = games.userStories;
        const room = games.LIMITS.stories - own.length;
        const added = list.slice(0, Math.max(0, room));
        await games.saveStories([...own, ...added]);
        const incomplete = added.filter((s) => !games.resolveStory(s).complete).length;
        notice = { text: format(incomplete ? 'storyImportedSome' : 'storyImported', { n: added.length, m: incomplete }) };
      } catch (error) {
        const key = `storyImportError_${error.message}`;
        notice = { text: t(key) === key ? t('storyImportError_format') : t(key), error: true };
      }
      refresh();
    });
    input.click();
  }

  // ---------- Storie: elenco ----------

  function levelText(level) {
    return format('storyLevelN', { n: level });
  }

  function storyLine(story) {
    return story.sentences.map((s) => s.map((w) => w.label).join(' ')).join(' · ');
  }

  async function setEnabled(story, on) {
    if (story.builtIn) {
      const set = new Set(games.settings.disabledBuiltIns);
      if (on) set.delete(story.builtIn); else set.add(story.builtIn);
      await games.saveSettings({ disabledBuiltIns: [...set] });
    } else {
      await games.saveStories(games.userStories.map((s) => (s.id === story.id ? { ...s, enabled: on } : s)));
    }
    refresh();
  }

  function draftFrom(story, copy) {
    return {
      id: copy || story.builtIn ? null : story.id,
      from: copy ? null : story.builtIn || story.from || null,
      title: copy ? format('storyCopyTitle', { title: story.title }).slice(0, games.LIMITS.title) : story.title,
      level: story.level,
      lang: story.lang || i18n.language,
      enabled: story.enabled !== false,
      sentences: story.sentences.map((s) => s.map((w) => ({ ...w }))),
    };
  }

  async function removeStory(story) {
    const ok = await ui.runDialog({ title: format('storyDeleteTitle', { title: story.title }), help: t(story.builtIn ? 'storyDeleteBuiltInHelp' : 'storyDeleteHelp'), primary: t('storyDelete'), secondary: t('cancel'), destructive: true });
    if (!ok) return;
    if (story.builtIn) {
      await games.saveSettings({ hiddenBuiltIns: [...games.settings.hiddenBuiltIns, story.builtIn] });
    } else {
      await games.saveStories(games.userStories.filter((s) => s.id !== story.id));
    }
    notice = { text: format('storyDeleted', { title: story.title }) };
    refresh();
  }

  async function restoreBuiltIns() {
    const ok = await ui.runDialog({ title: t('storyRestoreTitle'), help: t('storyRestoreHelp'), primary: t('storyRestore'), secondary: t('cancel') });
    if (!ok) return;
    await games.saveStories(games.userStories.filter((s) => !s.from));
    await games.saveSettings({ hiddenBuiltIns: [], disabledBuiltIns: [] });
    notice = { text: t('storyRestored') };
    refresh();
  }

  function renderStories() {
    const s = games.settings;
    const wrap = ui.section('storySecTitle', 'storySecHelp');
    wrap.id = 'games-stories';
    wrap.append(ui.settingRow('storySpeed', 'storySpeedHelp', ui.segmented(
      [['slow', 'storySpeedSlow'], ['normal', 'storySpeedNormal'], ['fast', 'storySpeedFast']], s.storySpeed,
      async (value) => { await games.saveSettings({ storySpeed: value }); refresh(); },
    ), { advanced: true }));
    const stories = games.allStories();
    const ul = el('ul', 'ctx-list story-list');
    stories.forEach((story) => {
      const plan = games.resolveStory(story);
      const li = el('li', `ctx-item story-item${plan.complete ? '' : ' is-incomplete'}`);
      const text = el('div', 'ctx-text');
      text.append(el('strong', 'ctx-name', story.title));
      text.append(el('small', null, `${levelText(story.level)} · ${story.builtIn ? t('storyBuiltIn') : t('storyOwn')}`));
      text.append(el('small', 'story-preview', storyLine(story)));
      if (!plan.complete) text.append(el('small', 'story-missing', format('storyIncomplete', { words: plan.missing.join(', ') })));
      const state = el('span', `ctx-state${plan.complete && story.enabled ? ' is-active' : ''}`,
        !plan.complete ? t('storyStateIncomplete') : story.enabled ? t('storyStateOn') : t('storyStateOff'));
      const row = el('div', 'story-actions');
      const toggle = yesNo(story.enabled, (on) => setEnabled(story, on));
      toggle.setAttribute('aria-label', `${t('storyShow')}: ${story.title}`);
      row.append(toggle);
      const tryBtn = ui.button(t('storyTry'), () => { ui.closeSettings(); games.playStory(story); });
      tryBtn.disabled = !plan.complete;
      row.append(
        tryBtn,
        ui.button(t('storyEdit'), () => { draft = draftFrom(story, false); refresh(); }),
        ui.button(t('storyDuplicate'), async () => {
          const copy = draftFrom(story, true);
          await games.saveStories([...games.userStories, copy]);
          notice = { text: format('storyDuplicated', { title: copy.title }) };
          refresh();
        }),
        ui.advanced(ui.button(t('storyExport'), () => exportFile([story], story.title))),
        ui.button(t('storyDelete'), () => removeStory(story)),
      );
      li.append(text, state, row);
      ul.append(li);
    });
    if (stories.length) wrap.append(ul); else wrap.append(el('p', 'settings-help', t('storyNone')));
    wrap.append(ui.advanced(el('p', 'settings-help', t('storyExportPrivacy'))));
    const tools = el('div', 'tpl-tools');
    tools.append(
      ui.button(t('storyNew'), () => {
        draft = { id: null, from: null, title: '', level: 1, lang: i18n.language, enabled: true, sentences: [] };
        refresh();
      }, true),
      ui.advanced(ui.button(t('storyImport'), importFile)),
    );
    if (stories.length) tools.append(ui.advanced(ui.button(t('storyExportAll'), () => exportFile(stories, i18n.language === 'it' ? 'tutte' : 'all'))));
    if (s.hiddenBuiltIns.length || s.disabledBuiltIns.length || games.userStories.some((x) => x.from)) {
      tools.append(ui.button(t('storyRestore'), restoreBuiltIns));
    }
    wrap.append(tools);
  }

  // ---------- Storie: modifica ----------

  function compose(index) {
    const words = index === null ? [] : draft.sentences[index];
    const keep = draft;
    games.startComposer({
      words,
      onDone(result) {
        draft = keep;
        if (index === null) draft.sentences.push(result); else draft.sentences[index] = result;
        ui.openSettings('games');
      },
      onCancel() {
        draft = keep;
        ui.openSettings('games');
      },
    });
  }

  async function saveDraft() {
    const title = draft.title.trim();
    if (!title) { notice = { text: t('storyErrorTitle'), error: true }; refresh(); return; }
    if (!draft.sentences.length) { notice = { text: t('storyErrorSentences'), error: true }; refresh(); return; }
    const story = games.cleanStory({ ...draft, title, id: draft.id || null });
    if (!story) { notice = { text: t('storyErrorSentences'), error: true }; refresh(); return; }
    const own = games.userStories;
    const at = own.findIndex((s) => s.id === draft.id);
    if (at >= 0) own[at] = story;
    else {
      if (own.length >= games.LIMITS.stories) { notice = { text: t('storyErrorTooMany'), error: true }; refresh(); return; }
      own.push(story);
    }
    await games.saveStories(own);
    notice = { text: format('storySaved', { title }) };
    draft = null;
    refresh();
  }

  function renderEditor() {
    const head = ui.section(draft.id ? 'storyEditTitle' : 'storyNewTitle', draft.from ? 'storyEditBuiltInHelp' : 'storyEditHelp');
    head.id = 'games-stories';
    statusBox(head);
    const title = el('input', 'name-input');
    title.type = 'text';
    title.maxLength = games.LIMITS.title;
    title.value = draft.title;
    title.placeholder = t('storyTitlePlaceholder');
    title.autocomplete = 'off';
    title.addEventListener('input', () => { draft.title = title.value; });
    head.append(field('storyTitle', title));
    head.append(ui.settingRow('storyLevel', 'storyLevelHelp', ui.segmented(
      [['1', 'storyLevel1'], ['2', 'storyLevel2'], ['3', 'storyLevel3']], String(draft.level),
      (value) => { draft.level = Number(value); refresh(); },
    )));

    const sec = ui.section('storySentencesTitle', 'storySentencesHelp');
    if (draft.sentences.length) {
      const plan = games.resolveStory({ sentences: draft.sentences });
      const missing = new Set(plan.missing);
      const ol = el('ol', 'ctx-pairs story-sentences');
      draft.sentences.forEach((sentence, index) => {
        const li = el('li', 'ctx-pair');
        const text = el('div', 'ctx-pair-text');
        const words = el('strong', 'ctx-pair-words');
        sentence.forEach((w, i) => {
          if (i) words.append(' ');
          const span = el('span', missing.has(w.label) ? 'story-word is-missing' : 'story-word', w.label);
          words.append(span);
        });
        text.append(words);
        if (sentence.some((w) => missing.has(w.label))) text.append(el('small', 'story-missing', t('storyWordMissing')));
        const acts = el('div', 'ctx-pair-actions');
        const up = ui.button('↑', () => { [draft.sentences[index - 1], draft.sentences[index]] = [draft.sentences[index], draft.sentences[index - 1]]; refresh(); });
        up.disabled = index === 0;
        up.setAttribute('aria-label', t('storyMoveUp'));
        const down = ui.button('↓', () => { [draft.sentences[index + 1], draft.sentences[index]] = [draft.sentences[index], draft.sentences[index + 1]]; refresh(); });
        down.disabled = index === draft.sentences.length - 1;
        down.setAttribute('aria-label', t('storyMoveDown'));
        acts.append(
          ui.button(t('storySentenceEdit'), () => compose(index)),
          up, down,
          ui.button(t('storySentenceRemove'), () => { draft.sentences.splice(index, 1); refresh(); }),
        );
        li.append(text, acts);
        ol.append(li);
      });
      sec.append(ol);
    } else {
      sec.append(el('p', 'settings-help', t('storySentencesNone')));
    }
    const tools = el('div', 'tpl-tools');
    const add = ui.button(t('storySentenceAdd'), () => compose(null), true);
    add.disabled = draft.sentences.length >= games.LIMITS.sentences;
    tools.append(add);
    sec.append(tools);

    const end = ui.section('storyActionsTitle');
    const endTools = el('div', 'tpl-tools');
    endTools.append(ui.button(t('storySave'), saveDraft, true), ui.button(t('cancel'), () => { draft = null; refresh(); }));
    end.append(endTools);
  }

  function render() {
    if (draft) { renderEditor(); return; }
    renderMain();
    renderQuiet();
    renderStories();
    renderPictograms();
  }

  ui.addCategory({
    id: 'games',
    icon: '<rect x="2.5" y="7" width="19" height="11" rx="5.5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="15.5" cy="11.5" r=".9" fill="currentColor"/><circle cx="17.8" cy="13.8" r=".9" fill="currentColor"/>',
    titleKey: 'catGames',
    introKey: 'catGamesIntro',
    render: [render],
  }, 'communication');

  // Uscendo dalla modalità adulto si perde una storia lasciata a metà
  const bar = document.getElementById('adult-bar');
  if (bar) new MutationObserver(() => { if (bar.hidden && !document.body.classList.contains('mode-adult')) draft = null; }).observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  void data;
})();
