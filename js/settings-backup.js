/*
 * Impostazioni: «Backup e ripristino».
 * Per ora è attivo solo «Ripristina le impostazioni iniziali»: riporta ai valori di partenza le scelte
 * delle impostazioni, senza toccare schede, immagini, abitudini d'uso, modelli, pacchetti scaricati, uso di
 * internet e PIN.
 * Le funzioni della Tappa 5 (copia di sicurezza, backup automatico, ripristino da file, cancellazione
 * completa) sono già visibili ma disattivate, con l'etichetta «Prossimamente».
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, storage, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  // Chiavi dell'archivio "settings" che contengono solo scelte delle impostazioni.
  // Restano fuori, di proposito: security e securityAttempts (PIN), activeProfileId, previousPages:*,
  // userTemplates (modelli salvati), symbolPacks (pacchetti già scaricati) e onlineSearch: una scelta
  // di privacy sull'uso di internet non deve tornare «Attiva» senza che l'adulto se ne accorga.
  const SETTINGS_KEYS = [
    'language', 'voice', 'colorMode', 'pageBackground', 'appearance', 'preset',
    'labelCase', 'communication', 'prediction', 'printOptions', 'lockPositions', 'symbolSources',
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

  function renderResetSection() {
    const wrap = ui.section('secResetTitle');
    const btn = ui.button(t('resetSettingsBtn'), resetSettings, false);
    btn.classList.add('dlg-btn-danger');
    wrap.append(
      ui.settingRow('resetSettings', 'resetSettingsHelp', btn),
      comingRow('resetAll', 'resetAllHelp', 'resetAllBtn'),
    );
  }

  ui.addCategory({
    id: 'backup',
    icon: '<path d="M4 7.5v9c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-9"/><ellipse cx="12" cy="7.5" rx="8" ry="3.5"/><path d="M4 12c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5"/>',
    titleKey: 'catBackup',
    introKey: 'catBackupIntro',
    render: [renderCopySection, renderResetSection],
  }, 'security');
})();
