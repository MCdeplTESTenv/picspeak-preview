/*
 * Impostazioni: «Backup e ripristino».
 * «Ripristina le impostazioni iniziali» riporta ai valori di partenza le scelte
 * delle impostazioni, senza toccare schede, immagini, abitudini d'uso, modelli, pacchetti scaricati, uso di
 * internet e PIN.
 * «Cancella tutto e ricomincia da zero» svuota tutti gli archivi del dispositivo, PIN compreso: avvisa che non
 * esiste ancora una copia di sicurezza, propone di esportare prima le schede (.obz), chiede il PIN e la parola
 * di conferma scritta a mano.
 * Le funzioni della Tappa 5 (copia di sicurezza, backup automatico, ripristino da file) sono già visibili
 * ma disattivate, con l'etichetta «Prossimamente».
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, storage, security, symbols, obf, predict, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  // Chiavi dell'archivio "settings" che contengono solo scelte delle impostazioni.
  // Restano fuori, di proposito: security e securityAttempts (PIN), activeProfileId, previousPages:*,
  // userTemplates (modelli salvati), symbolPacks (pacchetti già scaricati) e onlineSearch: una scelta
  // di privacy sull'uso di internet non deve tornare «Attiva» senza che l'adulto se ne accorga.
  const SETTINGS_KEYS = [
    'language', 'voice', 'colorMode', 'pageBackground', 'appearance', 'preset',
    'labelCase', 'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources',
    'keepScreenOn', 'autoFullscreen',
  ];

  // Riga con un pulsante disattivato e l'etichetta «Prossimamente»
  function comingRow(labelKey, helpKey, buttonKey) {
    const control = document.createElement('div');
    control.className = 'choice-group';
    const btn = ui.button(t(buttonKey), () => {}, false);
    btn.disabled = true;
    const badge = document.createElement('span');
    badge.className = 'setting-pending';
    badge.textContent = t('backupSoon');
    control.append(btn, badge);
    const row = ui.settingRow(labelKey, helpKey, control);
    row.classList.add('is-pending');
    return row;
  }

  function renderCopySection() {
    const wrap = ui.section('secBackupCopyTitle', 'secBackupCopyHelp');
    wrap.append(
      comingRow('backupNow', 'backupNowHelp', 'backupNowBtn'),
      comingRow('backupAuto', 'backupAutoHelp', 'backupAutoBtn'),
      comingRow('backupRestore', 'backupRestoreHelp', 'backupRestoreBtn'),
    );
    wrap.append(ui.list(t('backupMeanwhile')));
  }

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

  // Altre schede del browser con PicSpeak aperto: dopo «Cancella tutto» devono ripartire anche loro, senza
  // riscrivere i dati che hanno ancora in memoria. Il nome del canale segue quello dell'archivio, così il sito
  // ufficiale e l'anteprima (stesso dominio, archivi diversi) non si disturbano.
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(`${storage.name}-reset`) : null;
  if (channel) {
    channel.onmessage = async (event) => {
      if (event.data !== 'erased') return;
      try {
        if (predict) await predict.clearAll();
      } finally {
        location.reload();
      }
    };
  }

  // Esportazione delle schede prima di cancellare (stesso file .obz di Schede › Scambio con altre app)
  async function exportBoardsFirst() {
    try {
      await obf.exportObz(t('resetAllExportName'));
      return true;
    } catch (error) {
      return false;
    }
  }

  async function eraseEverything() {
    // 1. Avviso: nessuna copia di sicurezza, proposta di esportare prima le schede
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
        const ok = await exportBoardsFirst();
        await ui.runDialog({
          title: t(ok ? 'resetAllExported' : 'resetAllExportFailed'),
          help: ok ? t('tplExported') : '',
          primary: t('close'),
        });
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
    render: [renderCopySection, renderResetSection],
  }, 'security');
})();
