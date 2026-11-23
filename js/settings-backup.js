/*
 * Impostazioni: «Backup e ripristino», in quattro sezioni.
 * - Backup locale: nome del profilo, «Salva un backup adesso» (file .picspeak, password facoltativa), data dell'ultimo
 *   backup salvato da questo dispositivo. La logica del file è in backup.js.
 * - Backup online: in arrivo (pulsante in grigio con l'etichetta «Prossimamente»).
 * - Ripristina un backup: apre un file .picspeak, mostra di chi è, quando è stato salvato e cosa contiene, poi
 *   «Ripristina tutto» (sostituisce) oppure «Scegli cosa ripristinare» (per ogni parte: no, sostituisci, aggiungi o unisci).
 * - Azzera l'app: «Torna alle impostazioni iniziali» (solo le scelte delle impostazioni; restano schede, immagini,
 *   abitudini, modelli, pacchetti scaricati, uso di Internet e PIN) e «Cancella tutto e ricomincia da zero» (svuota
 *   tutti gli archivi, PIN compreso: propone prima un backup, chiede il PIN e la parola di conferma scritta a mano).
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, storage, security, symbols, predict, data, backup, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  // Chiavi dell'archivio "settings" che contengono solo scelte delle impostazioni.
  // Restano fuori, di proposito: security e securityAttempts (PIN), activeProfileId, previousPages:*,
  // userTemplates (modelli salvati), symbolPacks (pacchetti già scaricati), lastBackup e onlineSearch: una scelta
  // di privacy sull'uso di internet non deve tornare «Attiva» senza che l'adulto se ne accorga.
  const SETTINGS_KEYS = [
    'language', 'voice', 'colorMode', 'pageBackground', 'appearance', 'preset',
    'labelCase', 'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources',
    'keepScreenOn', 'autoFullscreen', 'sectionState', 'openSections',
  ];

  // Avviso da mostrare nella sezione del backup locale al prossimo disegno della pagina
  let notice = null;

  function format(key, values) {
    return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function dateText(date) {
    return date.toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function timeText(date) {
    return date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  }

  // where: sezione in cui mostrare l'avviso ('local' = Backup locale, 'restore' = Ripristina un backup)
  function showNotice(text, error, where = 'local') {
    notice = { text, error: Boolean(error), where };
    ui.render();
  }

  function renderNotice(wrap, where) {
    if (!notice || notice.where !== where) return;
    const box = el('p', `tpl-status${notice.error ? ' is-error' : ''}`, notice.text);
    box.setAttribute('role', 'status');
    wrap.append(box);
    notice = null;
  }

  // Riga con un pulsante disattivato e l'etichetta «Prossimamente»
  function comingRow(labelKey, helpKey, buttonKey) {
    const control = el('div', 'choice-group');
    const btn = ui.button(t(buttonKey), () => {}, false);
    btn.disabled = true;
    control.append(btn, el('span', 'setting-pending', t('backupSoon')));
    const row = ui.settingRow(labelKey, helpKey, control);
    row.classList.add('is-pending');
    return row;
  }

  // ---------- Backup locale ----------

  async function changeProfileName() {
    // Nomi degli altri profili: due profili con lo stesso nome non si distinguerebbero
    const others = (await storage.getAllRecords('profiles'))
      .filter((p) => p && data.profile && p.id !== data.profile.id && typeof p.name === 'string')
      .map((p) => p.name.trim().toLocaleLowerCase());
    const values = await ui.runDialog({
      title: t('backupProfileTitle'),
      help: t('backupProfileHelp'),
      fields: [{ id: 'name', label: t('backupProfileTitle'), plain: true, value: (data.profile && data.profile.name) || '', maxLength: 40 }],
      primary: t('backupProfileSave'),
      secondary: t('cancel'),
      onSubmit: (v) => {
        if (!v.name) return t('backupNameMissing');
        if (others.includes(v.name.trim().toLocaleLowerCase())) return t('profileNameTaken');
        return v;
      },
    });
    if (!values) return;
    await backup.setProfileName(values.name);
    ui.render();
  }

  /*
   * Chiede nome e password facoltativa, poi crea e salva il file. Restituisce true se il backup è stato salvato.
   * Usata anche prima di «Ripristina tutto» e di «Cancella tutto».
   */
  async function saveBackup(where = 'local') {
    const values = await ui.runDialog({
      title: t('backupSaveTitle'),
      help: t('backupSaveHelp'),
      fields: [
        { id: 'name', label: t('backupNameLabel'), plain: true, value: (data.profile && data.profile.name) || '', maxLength: 40 },
        { id: 'pass', label: t('backupPassLabel'), secret: true },
        { id: 'pass2', label: t('backupPass2Label'), secret: true },
      ],
      primary: t('backupSaveBtn'),
      secondary: t('cancel'),
      onSubmit: (v) => {
        if (!v.name) return t('backupNameMissing');
        if (v.pass || v.pass2) {
          if ([...v.pass].length < 4) return t('backupPassShort');
          if (v.pass !== v.pass2) return t('backupPassMismatch');
        }
        return v;
      },
    });
    if (!values) return false;
    showNotice(t('backupSaving'), false, where);
    try {
      const file = await backup.create({ name: values.name, password: values.pass, fallbackName: t('backupFileWord') });
      backup.save(file.blob, file.name);
      showNotice(format('backupSaved', { file: file.name }), false, where);
      return true;
    } catch (error) {
      const code = error instanceof backup.BackupError ? error.message : '';
      const key = { unsupported: 'backupOpenError_unsupported', verify: 'backupVerifyFailed' }[code] || 'backupSaveFailed';
      showNotice(t(key), true, where);
      return false;
    }
  }

  function renderLocalSection() {
    const wrap = ui.section('secBackupLocalTitle', 'secBackupLocalHelp');
    renderNotice(wrap, 'local');

    const name = data.profile && data.profile.name;
    const nameControl = el('div', 'choice-group backup-profile');
    nameControl.append(
      el('span', `backup-profile-name${name ? '' : ' is-empty'}`, name || t('backupProfileNone')),
      ui.button(t('backupProfileBtn'), changeProfileName, false),
    );
    wrap.append(ui.settingRow('backupProfile', 'backupProfileHelp', nameControl));
    wrap.append(ui.settingRow('backupNow', 'backupNowHelp', ui.button(t('backupNowBtn'), saveBackup, true)));

    // Data dell'ultimo backup salvato da questo dispositivo (si legge dall'archivio, poi si scrive)
    const last = el('p', 'settings-help backup-last');
    wrap.append(last);
    backup.lastBackup().then((info) => {
      last.textContent = info
        ? format('backupLast', { date: dateText(info.at), time: timeText(info.at), name: info.name || '—' })
        : t('backupLastNone');
    }).catch(() => { last.textContent = t('backupLastNone'); });
  }

  function renderOnlineSection() {
    const wrap = ui.section('secBackupOnlineTitle', 'secBackupOnlineHelp');
    wrap.append(comingRow('backupAuto', 'backupAutoHelp', 'backupAutoBtn'));
  }

  // ---------- Ripristina un backup ----------

  // Scelta del file: va chiamata direttamente dal tocco (Safari apre la finestra solo così)
  function pickFile() {
    return new Promise((resolve) => {
      const input = el('input');
      input.type = 'file';
      // Nessun filtro sul tipo: su iPad e iPhone un'estensione sconosciuta come .picspeak resterebbe in grigio
      input.addEventListener('change', () => resolve((input.files && input.files[0]) || null));
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  function errorText(error) {
    const code = error instanceof backup.BackupError ? error.message : 'damaged';
    const key = `backupOpenError_${code}`;
    return t(key) === key ? t('backupOpenError_damaged') : t(key);
  }

  async function showError(error) {
    await ui.runDialog({ title: t('backupOpenErrorTitle'), help: errorText(error), primary: t('close') });
  }

  // Parti presenti nel backup, con il testo che le descrive
  function partLines(parts) {
    const s = parts.summary;
    const lines = [];
    if (s.boards) lines.push(['boards', format('backupPartBoards', { pages: s.boards.pages })]);
    if (s.habits) lines.push(['habits', format('backupPartHabits', { days: s.habits.days, contexts: s.habits.contexts })]);
    if (s.templates && s.templates.n) lines.push(['templates', format('backupPartTemplates', { n: s.templates.n })]);
    if (s.appearance) lines.push(['appearance', t('backupPartAppearance')]);
    if (s.settings) lines.push(['settings', t('backupPartSettings')]);
    return lines;
  }

  function summaryTexts(info, issues) {
    const texts = [];
    if (info.createdAt) {
      const values = { date: dateText(info.createdAt), time: timeText(info.createdAt), device: info.device };
      texts.push(format(info.device ? 'backupSummaryWhenDevice' : 'backupSummaryWhen', values));
    }
    if (issues && (issues.images || issues.parts.length)) texts.push(t('backupSummaryIssues'));
    const here = data.profile && data.profile.name;
    if (here && info.name && here.toLocaleLowerCase() !== info.name.toLocaleLowerCase()) {
      texts.push(format('backupSummaryOther', { name: here }));
    }
    return texts;
  }

  // Riepilogo: di chi è, quando, cosa contiene. Risolve 'all', 'some' o null
  function askSummary(info, parts) {
    return ui.runPanelDialog({
      title: info.name ? format('backupSummaryTitle', { name: info.name }) : t('backupSummaryNoName'),
      className: 'choice-dialog',
      build(close) {
        const box = el('div', 'backup-summary');
        summaryTexts(info, parts.issues).forEach((text, index) => box.append(el('p', index ? 'tpl-status' : 'dialog-help', text)));
        const list = el('ul', 'settings-list');
        partLines(parts).forEach(([, text]) => list.append(el('li', null, text)));
        box.append(list);
        const options = el('div', 'choice-options');
        [
          { value: 'all', label: t('backupRestoreAll'), help: t('backupRestoreAllHelp'), className: 'is-danger' },
          { value: 'some', label: t('backupRestoreSome'), help: t('backupRestoreSomeHelp'), className: 'is-primary' },
        ].forEach((opt) => {
          const btn = el('button', `choice-option ${opt.className}`);
          btn.type = 'button';
          btn.append(el('strong', null, opt.label), el('small', null, opt.help));
          btn.addEventListener('click', () => close(opt.value));
          options.append(btn);
        });
        box.append(options);
        return box;
      },
    });
  }

  // Modi possibili per ogni parte (il primo, «No», lascia la parte com'è)
  const PART_MODES = {
    boards: [['', 'valNo'], ['replace', 'backupModeReplace'], ['add', 'backupModeAdd']],
    habits: [['', 'valNo'], ['merge', 'backupModeMerge'], ['replace', 'backupModeReplace']],
    templates: [['', 'valNo'], ['add', 'backupModeAdd']],
    appearance: [['', 'valNo'], ['replace', 'backupModeReplace']],
    settings: [['', 'valNo'], ['replace', 'backupModeReplace']],
  };
  const PART_HELP = {
    boards: 'backupChooseBoards',
    habits: 'backupChooseHabits',
    templates: 'backupChooseTemplates',
    appearance: 'backupChooseReplaceOnly',
    settings: 'backupChooseReplaceOnly',
  };

  /*
   * Scelta delle singole parti. Risolve { choice } per ripristinare, { safety: true, choice } per salvare prima
   * un backup di adesso (poi la finestra si riapre con le stesse scelte), oppure null.
   */
  function askParts(parts, initial) {
    const choice = { ...initial };
    return ui.runPanelDialog({
      title: t('backupChooseTitle'),
      help: t('backupChooseHelp'),
      className: 'choice-dialog backup-choose',
      build(close) {
        const box = el('div', 'backup-parts');
        partLines(parts).forEach(([part, text]) => {
          const row = el('div', 'backup-part');
          const label = el('div', 'backup-part-text');
          label.append(el('strong', null, text), el('small', null, t(PART_HELP[part])));
          const group = el('div', 'segmented');
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', text);
          PART_MODES[part].forEach(([value, key]) => {
            const btn = el('button', null, t(key));
            btn.type = 'button';
            btn.setAttribute('aria-pressed', String((choice[part] || '') === value));
            btn.addEventListener('click', () => {
              choice[part] = value || null;
              group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
              error.textContent = '';
            });
            group.append(btn);
          });
          row.append(label, group);
          box.append(row);
        });
        const link = el('button', 'dialog-link', t('backupSafetyLink'));
        link.type = 'button';
        link.addEventListener('click', () => close({ safety: true, choice }));
        const error = el('p', 'dialog-error');
        error.setAttribute('role', 'alert');
        const go = ui.button(t('backupRestoreGo'), () => {
          if (!Object.values(choice).some(Boolean)) { error.textContent = t('backupChooseNone'); return; }
          close({ choice });
        }, true);
        box.append(link, error);
        // Il pulsante «Ripristina» va accanto a «Chiudi», in fondo alla finestra
        queueMicrotask(() => {
          const actions = box.parentNode && box.parentNode.querySelector('.dialog-actions');
          if (actions) actions.append(go); else box.append(go);
        });
        return box;
      },
    });
  }

  // Conferma di «Ripristina tutto», con la possibilità di salvare prima un backup di adesso
  async function confirmAll() {
    for (;;) {
      const answer = await ui.runDialog({
        title: t('backupAllConfirmTitle'),
        help: t('backupAllConfirmHelp'),
        link: t('backupSafetyLink'),
        primary: t('backupAllConfirmBtn'),
        destructive: true,
        secondary: t('cancel'),
      });
      if (!answer) return false;
      if (answer.link) { await saveBackup('restore'); continue; }
      return true;
    }
  }

  // Altre schede del browser con PicSpeak aperto: dopo un ripristino o «Cancella tutto» devono ripartire anche loro,
  // senza riscrivere i dati che hanno ancora in memoria. Il nome del canale segue quello dell'archivio, così il sito
  // ufficiale e l'anteprima (stesso dominio, archivi diversi) non si disturbano.
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(`${storage.name}-reset`) : null;
  if (channel) {
    channel.onmessage = async (event) => {
      if (event.data === 'restoring') {
        // Un'altra scheda sta ripristinando: questa smette di scrivere le abitudini e aspetta di ripartire
        if (predict && typeof predict.freeze === 'function') predict.freeze();
        return;
      }
      if (event.data === 'restored') {
        location.reload();
        return;
      }
      if (event.data !== 'erased') return;
      try {
        if (predict) await predict.clearAll();
      } finally {
        location.reload();
      }
    };
  }

  async function restoreBackup() {
    // Il file si sceglie subito, dentro il tocco
    const file = await pickFile();
    if (!file) return;
    let opened;
    let parts;
    try {
      opened = await backup.open(file);
      if (!opened.info.encryption) parts = await backup.read(opened);
    } catch (error) {
      await showError(error);
      return;
    }
    if (opened.info.encryption) {
      parts = await ui.runDialog({
        title: t('backupPassTitle'),
        help: t('backupPassAsk'),
        fields: [{ id: 'pass', label: t('backupPassField'), secret: true }],
        primary: t('backupPassOpen'),
        secondary: t('cancel'),
        onSubmit: async (v) => {
          try {
            return await backup.read(opened, v.pass);
          } catch (error) {
            return error instanceof backup.BackupError && error.message === 'password' ? t('backupPassWrong') : errorText(error);
          }
        },
      });
      if (!parts) return;
    }
    const present = partLines(parts).map(([part]) => part);
    if (!present.length) {
      await showError(new backup.BackupError('damaged'));
      return;
    }

    const mode = await askSummary(opened.info, parts);
    if (!mode) return;
    let choice;
    if (mode === 'all') {
      if (!(await confirmAll())) return;
      // Tutte le parti del file, anche quelle vuote (es. nessun modello): «tutto» vuol dire diventare uguali al backup
      choice = Object.fromEntries(Object.keys(parts.summary).map((part) => [part, 'replace']));
    } else {
      let initial = {};
      for (;;) {
        const answer = await askParts(parts, initial);
        if (!answer) return;
        if (answer.safety) { initial = answer.choice; await saveBackup('restore'); continue; }
        choice = answer.choice;
        break;
      }
    }

    showNotice(t('backupRestoring'), false, 'restore');
    if (channel) channel.postMessage('restoring');
    let report;
    try {
      const when = opened.info.createdAt ? ` ${dateText(opened.info.createdAt)}` : '';
      report = await backup.restore(parts, choice, opened.info, {
        all: mode === 'all',
        folderName: `${opened.info.name || t('backupFileWord')}${when}`.slice(0, 60),
      });
    } catch (error) {
      await ui.runDialog({ title: t('backupRestoreFailed'), primary: t('close') });
      if (channel) channel.postMessage('restored');
      location.reload();
      return;
    }
    const notes = [t('backupRestoredHelp')];
    if (report.missing) notes.push(format('backupRestoredMissing', { n: report.missing }));
    if (report.packs.length) notes.push(format('backupRestoredPacks', { names: report.packs.join(', ') }));
    if (report.online && report.online.length) notes.push(format('backupRestoredOnline', { names: report.online.join(', ') }));
    if (report.templatesFull) notes.push(format('backupRestoredFull', { n: backup.MAX_TEMPLATES }));
    if (report.lostParts.length) {
      notes.push(format('backupRestoredLostParts', { parts: report.lostParts.map((part) => t(`backupPartName_${part}`)).join(', ') }));
    }
    if (report.lostImages) notes.push(format('backupRestoredLostImages', { n: report.lostImages }));
    await ui.runDialog({ title: t('backupRestoredTitle'), help: notes.join(' '), primary: t('close') });
    if (channel) channel.postMessage('restored');
    location.reload();
  }

  function renderRestoreSection() {
    const wrap = ui.section('secBackupRestoreTitle', 'secBackupRestoreHelp');
    renderNotice(wrap, 'restore');
    wrap.append(ui.settingRow('backupRestore', 'backupRestoreHelp', ui.button(t('backupRestoreBtn'), restoreBackup, false)));
  }

  // ---------- Azzera l'app ----------

  async function resetSettings() {
    const ok = await ui.runDialog({
      title: t('resetSettingsConfirmTitle'),
      help: t('resetSettingsConfirmHelp'),
      primary: t('resetSettingsConfirmBtn'),
      secondary: t('cancel'),
    });
    if (!ok) return;
    for (const key of SETTINGS_KEYS) {
      await storage.remove(key);
    }
    // Si riparte da capo: tutte le parti dell'app rileggono i valori iniziali
    location.reload();
  }

  async function eraseEverything() {
    // 1. Avviso: dopo si recupera solo da un backup, proposta di salvarne uno prima
    for (;;) {
      const first = await ui.runDialog({
        title: t('resetAllWarnTitle'),
        help: t('resetAllWarnHelp'),
        link: t('resetAllExport'),
        primary: t('resetAllContinue'),
        secondary: t('cancel'),
      });
      if (!first) return;
      if (first.link) {
        await saveBackup('reset');
        continue;
      }
      break;
    }

    // 2. Conferma definitiva: PIN (se c'è) e parola da scrivere
    const word = t('resetAllWord');
    const needPin = security.supported && await security.hasPin();
    const fields = [];
    if (needPin) fields.push({ id: 'pin', label: t('resetAllPin') });
    fields.push({ id: 'word', label: t('resetAllWordLabel').replace('{word}', word), text: true });
    const confirmed = await ui.runDialog({
      title: t('resetAllConfirmTitle'),
      help: t('resetAllConfirmHelp'),
      fields,
      primary: t('resetAllConfirmBtn'),
      destructive: true,
      secondary: t('cancel'),
      onSubmit: async (values) => {
        if (String(values.word || '').toLocaleUpperCase() !== word.toLocaleUpperCase()) {
          return t('resetAllWordWrong').replace('{word}', word);
        }
        if (needPin) {
          const res = await security.verifyPin(values.pin);
          if (!res.ok) {
            return res.waitSeconds ? t('pinLocked').replace('{s}', res.waitSeconds) : t('pinWrong');
          }
        }
        return true;
      },
    });
    if (!confirmed) return;

    // 3. Cancellazione e ripartenza come alla prima apertura
    try {
      // Prima le abitudini in memoria: un salvataggio rimasto in sospeso non deve riscriverle dopo
      if (predict) await predict.clearAll();
      await symbols.clearDownloads();
      await storage.clearAll();
      if (channel) channel.postMessage('erased');
    } catch (error) {
      await ui.runDialog({ title: t('resetAllFailed'), primary: t('close') });
      return;
    }
    location.reload();
  }

  function renderResetSection() {
    const wrap = ui.section('secResetTitle');
    renderNotice(wrap, 'reset');
    const btn = ui.button(t('resetSettingsBtn'), resetSettings, false);
    btn.classList.add('dlg-btn-danger');
    wrap.append(
      ui.settingRow('resetSettings', 'resetSettingsHelp', btn),
    );
    const erase = ui.button(t('resetAllBtn'), eraseEverything, false);
    erase.classList.add('dlg-btn-danger');
    wrap.append(ui.settingRow('resetAll', 'resetAllHelp', erase));
  }

  ui.addCategory({
    id: 'backup',
    icon: '<path d="M4 7.5v9c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-9"/><ellipse cx="12" cy="7.5" rx="8" ry="3.5"/><path d="M4 12c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5"/>',
    titleKey: 'catBackup',
    introKey: 'catBackupIntro',
    render: [renderLocalSection, renderOnlineSection, renderRestoreSection, renderResetSection],
  }, 'security');
})();
