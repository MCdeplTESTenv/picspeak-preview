/*
 * Tocco (pagina «Tocco») e Frase (sezione in «Voce e frase»): opzioni di accesso (selezione al tocco o al rilascio, tempo di pressione, tocchi
 * ripetuti), gesti (sezione dell'aspetto, vedi adult.js), comportamento della frase (pronuncia, cancellazione dopo la lettura, ritorno alla Home)
 * e pulsanti rapidi («Ops», «Aiuto», frasi rapide sempre raggiungibili).
 * Le scelte si salvano sul dispositivo (chiave «communication»). Testi solo con textContent.
 */
(function () {
  'use strict';

  const { i18n, storage, app, speech, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  const KEY = 'communication';
  const MAX_PHRASES = 6;
  const MAX_PHRASE_LENGTH = 40;

  // Impostazioni predefinite: tutto come prima (nessun pulsante rapido, tocco classico)
  const DEFAULTS = {
    activation: 'release', holdMs: 0, repeatMs: 0, speakWords: 'each', clearAfter: false, autoHome: false,
    oops: false, help: false, alarm: true, phrasesOn: false, phrases: null, // null = frasi proposte nella lingua attuale
  };
  let settings = { ...DEFAULTS };

  const el = {
    bar: document.getElementById('quick-bar'),
    oops: document.getElementById('btn-oops'),
    help: document.getElementById('btn-help'),
    phrases: document.getElementById('quick-phrases'),
  };

  function cleanPhrase(text) {
    // eslint-disable-next-line no-control-regex
    return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_PHRASE_LENGTH);
  }

  // Frasi rapide attive: quelle scelte dall'adulto, oppure le proposte della lingua
  function phrases() {
    if (Array.isArray(settings.phrases)) return settings.phrases;
    return t('quickDefaultPhrases');
  }

  // ---------- Barra dei pulsanti rapidi ----------

  function renderBar() {
    const list = phrases();
    el.oops.hidden = !settings.oops;
    el.help.hidden = !settings.help;
    el.phrases.replaceChildren(...list.map((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-btn quick-phrase';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        app.flash(btn);
        app.say(text);
      });
      return btn;
    }));
    el.phrases.hidden = !settings.phrasesOn;
    const show = settings.oops || settings.help || (settings.phrasesOn && list.length > 0);
    const changed = el.bar.hidden === show;
    el.bar.hidden = !show;
    // La barra toglie spazio alla griglia: le tessere vanno ricalcolate
    if (changed) app.layoutGrid();
    markOverflow();
  }

  // Se le frasi non entrano tutte, il bordo destro sfuma: si capisce che la riga scorre
  function markOverflow() {
    const box = el.phrases;
    const more = box.scrollWidth > box.clientWidth + 1 && box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
    box.classList.toggle('has-more', more);
  }

  // Suono di allarme: tre note acute e forti (generate dal browser, nessun file)
  function alarmSound() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return 0;
    try {
      const ctx = new Context();
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      gain.connect(ctx.destination);
      [0, 0.35, 0.7].forEach((start) => {
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 880;
        osc.connect(gain);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + 0.25);
      });
      setTimeout(() => ctx.close(), 1500);
      return 1100;
    } catch (error) {
      return 0;
    }
  }

  function bindBar() {
    el.phrases.addEventListener('scroll', markOverflow, { passive: true });
    window.addEventListener('resize', () => setTimeout(markOverflow, 150));
    el.oops.addEventListener('click', () => {
      app.flash(el.oops);
      app.oops();
      app.say(t('quickOopsSpeech'));
    });
    el.help.addEventListener('click', () => {
      app.flash(el.help);
      const delay = settings.alarm ? alarmSound() : 0;
      setTimeout(() => speech.speak(t('quickHelpSpeech'), i18n.speechLocale), delay);
    });
  }

  // ---------- Salvataggio ----------

  function apply() {
    app.setOptions(settings);
    renderBar();
  }

  async function save(changes) {
    settings = { ...settings, ...changes };
    apply();
    await storage.set(KEY, settings);
    ui.render();
  }

  // Valori letti dal dispositivo: si tengono solo quelli validi
  async function restore() {
    const saved = await storage.get(KEY);
    if (saved && typeof saved === 'object') {
      const next = { ...DEFAULTS };
      ['oops', 'help', 'alarm', 'phrasesOn', 'clearAfter', 'autoHome'].forEach((k) => {
        if (typeof saved[k] === 'boolean') next[k] = saved[k];
      });
      ['activation', 'speakWords'].forEach((k) => { if (typeof saved[k] === 'string') next[k] = saved[k]; });
      ['holdMs', 'repeatMs'].forEach((k) => { if (Number.isInteger(saved[k])) next[k] = saved[k]; });
      if (Array.isArray(saved.phrases)) {
        next.phrases = saved.phrases.filter((p) => typeof p === 'string').map(cleanPhrase).filter(Boolean).slice(0, MAX_PHRASES);
      }
      settings = next;
    }
    apply();
  }

  // ---------- Impostazioni ----------

  function seg(key, values, labelKey, helpKey, wrap) {
    const current = String(settings[key]);
    wrap.append(ui.settingRow(labelKey, helpKey, ui.segmented(
      values.map(([v, k]) => [String(v), k]), current,
      (value) => {
        const original = values.find(([v]) => String(v) === value);
        save({ [key]: original ? original[0] : value });
      },
    )));
  }

  function renderTouchSection() {
    const wrap = ui.section('secTouchTitle', 'secTouchHelp');
    seg('activation', [['release', 'valOnRelease'], ['press', 'valOnPress']], 'optActivation', 'optActivationHelp', wrap);
    seg('holdMs', [[0, 'valNo'], [300, 'valSec03'], [600, 'valSec06'], [1000, 'valSec1'], [1500, 'valSec15']],
      'optHold', 'optHoldHelp', wrap);
    seg('repeatMs', [[0, 'valNo'], [500, 'valSec05'], [1000, 'valSec1'], [2000, 'valSec2']],
      'optRepeat', 'optRepeatHelp', wrap);
  }

  function renderSentenceSection() {
    const wrap = ui.section('secSentenceOptTitle', 'secSentenceOptHelp');
    seg('speakWords', [['each', 'valEachWord'], ['sentence', 'valOnlySentence']], 'optSpeakWords', 'optSpeakWordsHelp', wrap);
    seg('clearAfter', [[false, 'valNo'], [true, 'valYes']], 'optClearAfter', 'optClearAfterHelp', wrap);
    seg('autoHome', [[false, 'valNo'], [true, 'valYes']], 'optAutoHome', 'optAutoHomeHelp', wrap);
    renderFolderNames(wrap);
  }

  // Nome delle cartelle letto quando si aprono: la scelta è di ogni cartella (Modifica cartella);
  // qui si vede quante lo leggono e si può dare la stessa scelta a tutte, dopo una conferma.
  function renderFolderNames(wrap) {
    const data = window.PicSpeak.data;
    if (!data || !data.profile) return;
    const { folders, silent } = data.folderSpeechSummary();
    let help = folders
      ? t('optFolderNamesHelp').replace('{spoken}', String(folders - silent)).replace('{total}', String(folders))
      : t('optFolderNamesNone');
    if (settings.speakWords === 'sentence') help = `${help} ${t('optFolderNamesSentence')}`;
    const actions = document.createElement('div');
    actions.className = 'folder-names-actions';
    const choose = async (makeSilent) => {
      const ok = await ui.runDialog({
        title: t(makeSilent ? 'folderNamesOffTitle' : 'folderNamesOnTitle'),
        help: t('folderNamesConfirmHelp').replace('{total}', String(folders)),
        primary: t('folderNamesApply'),
        secondary: t('cancel'),
      });
      if (ok !== true) return;
      await data.setAllFoldersSilent(makeSilent);
      ui.render();
    };
    const allOn = ui.button(t('folderNamesAllOn'), () => choose(false));
    const allOff = ui.button(t('folderNamesAllOff'), () => choose(true));
    // Pulsante inutile (tutte le cartelle sono già così): disattivato
    allOn.disabled = !folders || silent === 0;
    allOff.disabled = !folders || silent === folders;
    actions.append(allOn, allOff);
    const row = ui.settingRow('optFolderNames', null, actions);
    const small = document.createElement('small');
    small.textContent = help;
    row.querySelector('.setting-text').append(small);
    wrap.append(row);
  }

  function renderQuickSection() {
    const wrap = ui.section('secQuickTitle', 'secQuickHelp');
    seg('oops', [[false, 'valNo'], [true, 'valYes']], 'optOops', 'optOopsHelp', wrap);
    seg('help', [[false, 'valNo'], [true, 'valYes']], 'optHelpBtn', 'optHelpBtnHelp', wrap);
    if (settings.help) seg('alarm', [[false, 'valNo'], [true, 'valYes']], 'optAlarm', 'optAlarmHelp', wrap);

    seg('phrasesOn', [[false, 'valNo'], [true, 'valYes']], 'optPhrases', 'optPhrasesHelp', wrap);
    if (!settings.phrasesOn) return;
    // Frasi rapide: un campo per frase, si salva quando si esce dal campo
    const box = document.createElement('div');
    box.className = 'phrase-editor';
    const title = document.createElement('strong');
    title.textContent = t('quickPhrasesTitle');
    const help = document.createElement('small');
    help.textContent = t('quickPhrasesHelp');
    box.append(title, help);
    const list = [...phrases()];
    list.forEach((text, index) => {
      const row = document.createElement('div');
      row.className = 'phrase-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'name-input';
      input.maxLength = MAX_PHRASE_LENGTH;
      input.value = text;
      input.autocomplete = 'off';
      input.setAttribute('aria-label', `${t('quickPhrasesTitle')} ${index + 1}`);
      input.addEventListener('change', () => {
        const next = [...list];
        next[index] = cleanPhrase(input.value);
        save({ phrases: next.filter(Boolean) });
      });
      const remove = ui.button(t('quickPhraseRemove'), () => {
        save({ phrases: list.filter((_, i) => i !== index) });
      });
      remove.setAttribute('aria-label', `${t('quickPhraseRemove')}: ${text}`);
      row.append(input, remove);
      box.append(row);
    });
    if (list.length < MAX_PHRASES) {
      const form = document.createElement('form');
      form.className = 'phrase-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'name-input';
      input.maxLength = MAX_PHRASE_LENGTH;
      input.placeholder = t('quickPhrasePlaceholder');
      input.autocomplete = 'off';
      input.setAttribute('aria-label', t('quickPhraseAdd'));
      const add = document.createElement('button');
      add.type = 'submit';
      add.className = 'dlg-btn dlg-btn-primary';
      add.textContent = t('quickPhraseAdd');
      form.append(input, add);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const value = cleanPhrase(input.value);
        if (value) save({ phrases: [...list, value] });
      });
      box.append(form);
    }
    wrap.append(box);
  }

  ui.addCategory({
    id: 'communication',
    icon: '<path d="M8.5 13V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11.5 11V9.5a1.5 1.5 0 0 1 3 0V12"/><path d="M14.5 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.5a6 6 0 0 1-5-2.7L4 15.5a1.5 1.5 0 0 1 2.5-1.6l2 2.1"/>',
    titleKey: 'catCommunication',
    introKey: 'catCommunicationIntro',
    render: [renderQuickSection, renderTouchSection, () => ui.renderAppearanceGroup('grpGestures')],
  }, 'appearance');
  // La sezione «Frase» (pronuncia, cancellazione, ritorno alla Home, nome delle cartelle) sta in Voce e frase
  ui.addSection('voice', renderSentenceSection);

  bindBar();
  restore();
  // Le frasi proposte cambiano con la lingua dell'app
  window.PicSpeak.communication = { refresh: renderBar };
})();
