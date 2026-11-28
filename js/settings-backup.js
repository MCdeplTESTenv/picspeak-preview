/*
 * Impostazioni: «Backup e ripristino», in quattro sezioni.
 * - Backup locale: nome del profilo, «Salva un backup adesso» (file .picspeak, password facoltativa), data dell'ultimo
 *   backup salvato da questo dispositivo. La logica del file è in backup.js.
 * - Backup automatico in una cartella (logica in folder-backup.js): scelta della cartella, stato, «Salva adesso»,
 *   «Consenti di nuovo» se il browser ha dimenticato il permesso, «Smetti». Dove il browser non lo permette, una nota.
 * - Backup online su Dropbox (logica in cloud.js): «Collega Dropbox» (si incolla il codice mostrato da Dropbox), stato
 *   dell'ultima copia, aggiornamento manuale o automatico, «Aggiorna adesso», «Salva una copia» (con nome),
 *   «Apri un profilo», dispositivi, «Scollega». Il link alla pagina sulla
 *   privacy compare solo qui, all'adulto, tra le prime voci di «Backup online».
 * - Ripristina: un file .picspeak dal dispositivo o una copia su Dropbox; mostra di chi è, quando è stato salvato e
 *   cosa contiene, poi
 *   «Ripristina tutto» (sostituisce) oppure «Scegli cosa ripristinare» (per ogni parte: no, sostituisci, aggiungi o unisci).
 * - Azzera l'app: «Torna alle impostazioni iniziali» (solo le scelte delle impostazioni; restano schede, immagini,
 *   abitudini, modelli, pacchetti scaricati, uso di Internet e PIN) e «Cancella tutto e ricomincia da zero» (svuota
 *   tutti gli archivi, PIN compreso: propone prima un backup, chiede il PIN e la parola di conferma scritta a mano).
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, storage, security, symbols, predict, data, backup, cloud, folderBackup, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  // Chiavi dell'archivio "settings" che contengono solo scelte delle impostazioni.
  // Restano fuori, di proposito: security (PIN), activeProfileId, previousPages:*,
  // userTemplates (modelli salvati), symbolPacks (pacchetti già scaricati), lastBackup e onlineSearch: una scelta
  // di privacy sull'uso di internet non deve tornare «Attiva» senza che l'adulto se ne accorga.
  const SETTINGS_KEYS = [
    'language', 'voice', 'colorMode', 'pageBackground', 'appearance', 'preset', 'typeColors',
    'labelCase', 'communication', 'prediction', 'printOptions', 'lockPositions', 'gridDefault', 'symbolSources',
    'keepScreenOn', 'autoFullscreen', 'sectionState', 'openSections',
  ];

  // Avviso da mostrare nella sezione del backup locale al prossimo disegno della pagina
  let notice = null;

  // Un solo passaggio: un nome che contiene «{here}» resta com'è, non viene sostituito a sua volta
  function format(key, values) {
    return t(key).replace(/\{(\w+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : all));
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

  /*
   * Avviso «sto lavorando» (elenco delle copie, scaricamento, salvataggio...): si mostra in basso sopra la pagina,
   * senza spingere giù il resto della sezione. In cima alla sezione farebbe saltellare il pulsante appena toccato.
   */
  function showBusy(text, where = 'local') {
    notice = { text, error: false, where, busy: true };
    ui.render();
  }

  function renderNotice(wrap, where) {
    if (!notice || notice.where !== where) return;
    const box = el('p', `tpl-status${notice.error ? ' is-error' : ''}${notice.busy ? ' is-busy' : ''}`, notice.text);
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
    // Archivio guasto: in memoria potrebbero esserci solo le schede di prova, mai un backup fatto con quelle
    if (storage.saveProblem()) { await ui.showStorageProblem(); return false; }
    // Il backup contiene le abitudini del bambino: con il PIN privacy serve anche qui (es. dal promemoria)
    if (ui.requestPrivateAccess && !(await ui.requestPrivateAccess())) return false;
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
    showBusy(t('backupSaving'), where);
    try {
      const file = await backup.create({ name: values.name, password: values.pass, fallbackName: t('backupFileWord') });
      backup.save(file.blob, file.name);
      await refreshReminder();
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

  // ---------- Backup automatico in una cartella ----------

  async function chooseFolder() {
    // Il file contiene le abitudini del bambino: con il PIN privacy serve anche qui
    if (ui.requestPrivateAccess && !(await ui.requestPrivateAccess())) return;
    // Prima di scegliere: cosa c'è nel file (privacy) e password facoltativa, come per il backup su file
    const values = await ui.runDialog({
      title: t('folderPrivacyTitle'),
      help: t('folderPrivacyHelp'),
      fields: [
        { id: 'pass', label: t('backupPassLabel'), secret: true },
        { id: 'pass2', label: t('backupPass2Label'), secret: true },
      ],
      primary: t('folderChooseBtn'),
      secondary: t('cancel'),
      onSubmit: (v) => {
        if (v.pass || v.pass2) {
          if ([...v.pass].length < 4) return t('backupPassShort');
          if (v.pass !== v.pass2) return t('backupPassMismatch');
        }
        return v;
      },
    });
    if (!values) return;
    try {
      const ok = await folderBackup.choose(values.pass || '');
      if (ok) await refreshReminder();
      ui.render();
    } catch (error) {
      showNotice(t('folderErr'), true, 'folder');
    }
  }

  async function folderAction(fn) {
    const ok = await fn().catch(() => false);
    if (!ok) showNotice(t(folderBackup.info() && folderBackup.info().status === 'permission' ? 'folderNeedPermission' : 'folderErr'), true, 'folder');
    else ui.render();
    refreshReminder();
  }

  async function stopFolder() {
    const ok = await ui.runDialog({ title: t('folderStopTitle'), help: t('folderStopHelp'), primary: t('folderStopBtn'), secondary: t('cancel') });
    if (!ok) return;
    await folderBackup.stop();
    await refreshReminder();
    ui.render();
  }

  function folderStatusText(info) {
    if (info.status === 'permission') return t('folderNeedPermission');
    if (info.status === 'error') return t('folderErr');
    if (!info.lastAt) return format('folderChosen', { folder: info.folder || '—' });
    return `${format('folderLast', { folder: info.folder || '—', date: dateText(info.lastAt), time: timeText(info.lastAt), file: info.file })} ${t(info.locked ? 'folderLocked' : 'folderOpen')}`;
  }

  function renderFolderSection() {
    const wrap = ui.section('secFolderTitle', 'secFolderHelp');
    renderNotice(wrap, 'folder');
    if (!folderBackup || !folderBackup.isSupported()) {
      wrap.append(el('p', 'settings-help backup-last', t('folderUnsupported')));
      return;
    }
    const info = folderBackup.info();
    if (!info) {
      wrap.append(ui.settingRow('folderChoose', 'folderChooseHelp', ui.button(t('folderChooseBtn'), chooseFolder, true)));
      wrap.append(ui.settingRow('folderKeep', 'folderAllowHelp', el('span')));
      return;
    }
    const status = el('p', `settings-help backup-last${info.status === 'ok' ? '' : ' is-error'}`, folderStatusText(info));
    status.setAttribute('role', 'status');
    wrap.append(status);
    if (info.status === 'permission') {
      wrap.append(ui.settingRow('folderAllow', 'folderAllowHelp', ui.button(t('folderAllowBtn'), () => folderAction(folderBackup.allow), true)));
    } else {
      wrap.append(ui.settingRow('folderNow', 'folderNowHelp', ui.button(t('folderNowBtn'), () => folderAction(() => folderBackup.writeNow(true)), false)));
      // Cosa fare nel browser perché il permesso non si debba ridare a ogni apertura
      wrap.append(ui.settingRow('folderKeep', 'folderAllowHelp', el('span')));
    }
    wrap.append(ui.settingRow('folderChange', 'folderChangeHelp', ui.button(t('folderChangeBtn'), chooseFolder, false)));
    const off = ui.button(t('folderStopBtn'), stopFolder, false);
    off.classList.add('dlg-btn-danger');
    wrap.append(ui.settingRow('folderStop', 'folderStopRowHelp', off));
  }

  // ---------- Backup online (Dropbox) ----------

  // Coppia PKCE preparata prima del tocco: la pagina di Dropbox si apre subito, dentro il tocco (Safari lo richiede)
  let pkce = null;

  function prepareLink() {
    if (pkce || !cloud || !cloud.isConfigured()) return;
    cloud.newPkce().then((value) => { pkce = value; }).catch(() => { pkce = null; });
  }

  function cloudErrorText(error) {
    const code = error instanceof cloud.CloudError ? error.message : '';
    const key = `cloudErr_${code}`;
    return t(key) === key ? t('cloudErr_server') : t(key);
  }

  /*
   * Collega un account Dropbox per il profilo in uso. account: chiave di un account da ricollegare (permesso scaduto);
   * senza, se ne aggiunge uno nuovo (con un nome dato dall'adulto, se sul dispositivo ce n'è già un altro).
   */
  async function connectDropbox(options = {}) {
    // addOnly: solo un account in più (per aprire un profilo da un altro Dropbox); risolve con la sua chiave
    const { account, addOnly } = options && typeof options === 'object' && !(options instanceof Event) ? options : {};
    if (!pkce) {
      prepareLink();
      showBusy(t('cloudPreparing'), 'online');
      return;
    }
    const current = pkce;
    // La pagina di Dropbox si apre in una scheda nuova: lì l'adulto preme «Consenti» e copia il codice
    window.open(cloud.authorizeUrl(current), '_blank', 'noopener,noreferrer');
    const done = await ui.runDialog({
      title: t('cloudCodeTitle'),
      help: t('cloudCodeHelp'),
      fields: [
        { id: 'code', label: t('cloudCodeField'), raw: true },
        // Più account sullo stesso dispositivo: un nome per riconoscerlo (PicSpeak non chiede a Dropbox nome o email)
        ...((!account && cloud.listAccounts().length) || addOnly ? [{ id: 'name', label: t('cloudAccountName'), plain: true, maxLength: 40 }] : []),
      ],
      primary: t('cloudCodeBtn'),
      secondary: t('cancel'),
      onSubmit: async (v) => {
        try {
          // hold: prima di salvare questo profilo si chiede se continuare con uno già su Dropbox
          const result = await cloud.connect(v.code, current, { name: v.name, account, hold: true, attach: !addOnly });
          return result || true;
        } catch (error) {
          return cloudErrorText(error);
        }
      },
    });
    // Ogni collegamento usa una coppia nuova
    pkce = null;
    if (addOnly) return done && done.key ? done.key : null;
    if (done && done.held) await offerExisting();
    else if (done && done.sameAs) showNotice(format('cloudAccountSame', { name: done.sameAs }), false, 'online');
    else if (done) showNotice(t('cloudConnected'), false, 'online');
    else ui.render();
  }

  /*
   * Profili su Dropbox che su questo dispositivo non ci sono ancora. Risolve con l'elenco (anche vuoto) oppure lancia
   * l'errore di rete. Mostra l'avviso di attesa mentre legge.
   */
  async function dropboxProfiles(account) {
    showBusy(t('cloudListing'), 'online');
    try {
      return (await viaAccount(account, () => cloud.listProfiles())).filter((p) => !cloud.linkedHere(p.id));
    } finally {
      notice = null;
      ui.render();
    }
  }

  function profileChoices(profiles) {
    return profiles.map((p) => ({
      value: p.id,
      label: p.name || t('backupRestoredProfileName'),
      help: [whenText(p.updatedAt), p.device].filter(Boolean).join(' · '),
    }));
  }

  /*
   * «Apri un profilo»: un profilo che è su Dropbox (secondo dispositivo, dispositivo nuovo, un altro bambino da
   * seguire, anche da un altro account) diventa un profilo nuovo qui, sincronizzato. Il profilo in uso non cambia.
   */
  async function openProfile() {
    if (!(await window.PicSpeak.profiles.canAddProfile())) {
      await ui.runDialog({ title: format('profileTooMany', { n: window.PicSpeak.profiles.MAX_PROFILES }), primary: t('close') });
      return;
    }
    prepareLink(); // se servirà collegare un altro Dropbox
    let account = await pickAccount();
    if (account === null) return;
    for (;;) {
      let profiles;
      try {
        profiles = await dropboxProfiles(account);
      } catch (error) {
        await ui.runDialog({ title: t('cloudOpenTitle'), help: cloudErrorText(error), primary: t('close') });
        return;
      }
      // In fondo, sempre: un altro Dropbox (per esempio quello dei genitori)
      const folder = await askChoice(t('cloudOpenTitle'), t(profiles.length ? 'cloudOpenPick' : 'cloudOpenNone'), [
        ...profileChoices(profiles),
        { value: 'other', label: t('cloudOpenOther'), help: t('cloudOpenOtherHelp') },
      ]);
      if (!folder) return;
      if (folder !== 'other') {
        const picked = profiles.find((p) => p.id === folder);
        await openSynced(account, folder, (picked && picked.name) || t('backupRestoredProfileName'));
        return;
      }
      const current = account || (cloud.listAccounts().find((a) => a.here) || {}).key;
      const others = cloud.listAccounts().filter((a) => a.key !== current);
      const next = await askChoice(t('cloudAccountTitle'), t('cloudAccountPick'), [
        ...others.map((a) => ({ value: a.key, label: a.name })),
        { value: 'new', label: t('cloudAccountNew'), help: t('cloudAccountNewHelp') },
      ]);
      if (!next) return;
      account = next === 'new' ? await connectDropbox({ addOnly: true }) : next;
      if (!account) { ui.render(); return; }
    }
  }

  // Profilo nuovo legato alla cartella scelta, solo download; poi la pagina si ricarica su questa sezione
  async function openSynced(account, folder, name) {
    // Account vero (quello scelto, o quello del profilo in uso): il profilo nuovo non ne ha ancora uno
    const own = cloud.listAccounts().find((a) => a.here);
    const key = account || (own && own.key);
    if (!key) { showNotice(t('cloudErr_auth'), true, 'online'); return; }
    showBusy(t('cloudDownloading'), 'online');
    let created = false;
    try {
      // withAccount ferma le copie automatiche: nessuna copia del profilo di prima mentre si cambia profilo
      await cloud.withAccount(key, async () => {
        if (!(await window.PicSpeak.profiles.startRestoredProfile(name))) throw new cloud.CloudError('server');
        created = true;
        await cloud.follow(folder);
      });
    } catch (error) {
      notice = null;
      ui.render();
      const help = created ? `${cloudErrorText(error)} ${format('cloudOpenFailed', { name })}` : cloudErrorText(error);
      await ui.runDialog({ title: t('cloudOpenTitle'), help, primary: t('close') });
      if (created) ui.reopenAfterReload('backup');
      return;
    }
    ui.reopenAfterReload('backup');
  }

  /*
   * Appena collegato Dropbox: se ci sono già dei profili (dispositivo nuovo, perso o cambiato) si propone di
   * continuare con uno di quelli nel profilo appena collegato, solo scaricando. Finché l'adulto non sceglie, cloud non
   * invia nulla (connect con hold); «No», finestra chiusa o un errore lasciato così: il profilo si salva come nuovo.
   */
  async function offerExisting() {
    let profiles;
    try {
      // Il profilo appena collegato non c'è: dropboxProfiles toglie quelli già collegati qui
      profiles = await dropboxProfiles('');
    } catch (error) {
      await existingFailed(error);
      return;
    }
    if (!profiles.length) {
      cloud.release();
      showNotice(t('cloudConnected'), false, 'online');
      return;
    }
    const here = (data.profile && data.profile.name) || t('backupRestoredProfileName');
    for (;;) {
      const folder = await askChoice(t('cloudExistingTitle'), t('cloudExistingHelp'), [
        ...profileChoices(profiles),
        { value: 'new', label: format('cloudExistingNew', { name: here }), help: t('cloudExistingNewHelp') },
      ]);
      if (!folder || folder === 'new') {
        cloud.release();
        showNotice(t('cloudConnected'), false, 'online');
        return;
      }
      const picked = profiles.find((p) => p.id === folder);
      const ok = await ui.runDialog({
        title: t('cloudExistingTitle'),
        help: format('cloudExistingConfirm', { name: (picked && picked.name) || t('backupRestoredProfileName'), here }),
        primary: t('cloudExistingBtn'),
        secondary: t('cancel'),
      });
      if (!ok) continue;
      showBusy(t('cloudDownloading'), 'online');
      try {
        await cloud.follow(folder);
        location.reload();
      } catch (error) {
        await existingFailed(error);
      }
      return;
    }
  }

  // Errore mentre si sceglie: «Riprova» oppure si salva come profilo nuovo (il backup non resta mai fermo in silenzio)
  async function existingFailed(error) {
    notice = null;
    ui.render();
    const again = await ui.runDialog({
      title: t('cloudExistingTitle'),
      help: cloudErrorText(error),
      primary: t('cloudExistingRetry'),
      secondary: t('cloudExistingSaveNew'),
    });
    if (again) { await offerExisting(); return; }
    cloud.release();
    showNotice(t('cloudConnected'), false, 'online');
  }

  /*
   * Account da usare in un profilo che non ha ancora il backup online: quello unico, oppure scelto dall'adulto.
   * Risolve con la chiave, con '' se il profilo usa già il suo, con null se l'adulto annulla.
   * withNew: aggiunge «Collega un altro account Dropbox» (risolve con 'new').
   */
  async function pickAccount(withNew = false) {
    if (cloud.isEnabledHere()) return '';
    const accounts = cloud.listAccounts();
    if (accounts.length === 1 && !withNew) return accounts[0].key;
    const choices = accounts.map((a) => ({
      value: a.key,
      label: a.name,
      help: format(a.profiles === 1 ? 'cloudAccountUsedOne' : 'cloudAccountUsed', { n: a.profiles }),
    }));
    if (withNew) choices.push({ value: 'new', label: t('cloudAccountNew'), help: t('cloudAccountNewHelp') });
    return (await askChoice(t('cloudAccountTitle'), t('cloudAccountPick'), choices)) || null;
  }

  // Esegue una richiesta a Dropbox con l'account scelto ('' = quello del profilo in uso)
  function viaAccount(key, fn) {
    return key ? cloud.withAccount(key, fn) : fn();
  }

  async function enableProfile() {
    const key = await pickAccount(true);
    if (!key) return;
    if (key === 'new') { await connectDropbox(); return; }
    await cloud.enableHere(key);
    showNotice(t('cloudConnected'), false, 'online');
  }

  async function disconnectDropbox() {
    const ok = await ui.runDialog({
      title: t('cloudDisconnectTitle'),
      help: t('cloudDisconnectHelp'),
      primary: t('cloudDisconnectBtn'),
      secondary: t('cancel'),
    });
    if (!ok) return;
    await cloud.disconnect();
    showNotice(t('cloudDisconnected'), false, 'online');
  }

  async function saveNamedCopy() {
    const values = await ui.runDialog({
      title: t('cloudPhotoTitle'),
      help: t('cloudPhotoHelp'),
      fields: [{ id: 'name', label: t('cloudPhotoName'), plain: true, maxLength: 30 }],
      primary: t('cloudPhotoBtn'),
      secondary: t('cancel'),
      // Senza onSubmit la finestra restituirebbe solo «true» e il nome scritto andrebbe perso
      onSubmit: (v) => v,
    });
    if (!values) return;
    showBusy(t('cloudPhotoSaving'), 'online');
    try {
      await cloud.saveSnapshot('photo', values.name);
      showNotice(t('cloudPhotoSaved'), false, 'online');
    } catch (error) {
      showNotice(cloudErrorText(error), true, 'online');
    }
  }

  async function syncDropbox() {
    showBusy(t('cloudSyncing'), 'online');
    await cloud.syncNow();
    if (cloud.isAuto()) {
      // Si guarda anche se altri dispositivi hanno inviato qualcosa (le schede arrivano all'uscita dalla modalità adulto)
      await cloud.pullNow();
    } else {
      // Manuale: è l'unico momento in cui arrivano le modifiche degli altri dispositivi, quindi si applicano subito
      let changed = false;
      try { changed = await cloud.applyNow(); } catch (error) { /* senza rete: lo dice la riga di stato */ }
      if (changed) {
        // Ricarica la pagina e riapre questa sezione delle impostazioni
        ui.reopenAfterReload('backup');
        return;
      }
    }
    if (cloud.hasConflict()) { await askConflict(); return; }
    const st = cloud.status();
    showNotice(st === 'idle' ? t('cloudSynced') : t(`cloudStatus_${st}`), st !== 'idle', 'online');
  }

  function cloudStatusText() {
    const st = cloud.status();
    const last = cloud.lastCopy();
    const lastText = last ? format('cloudLast', { date: dateText(last), time: timeText(last) }) : t('cloudLastNone');
    const synced = cloud.isSynced() ? ` ${t('cloudSyncedDevices')}` : '';
    const accounts = cloud.listAccounts();
    const own = accounts.find((a) => a.here);
    const which = accounts.length > 1 && own ? `${format('cloudAccountIs', { name: own.name })} ` : '';
    if (st === 'idle' || st === 'off') return which + lastText + (cloud.pending() ? ` ${t('cloudPending')}` : '') + synced;
    return `${which}${t(`cloudStatus_${st}`)} ${lastText}`;
  }

  /*
   * Le schede sono state cambiate qui e su un altro dispositivo prima che si potessero scambiare le modifiche:
   * l'adulto sceglie quale versione tenere. L'altra resta su Dropbox come copia «prima di…».
   */
  let asking = false;
  async function askConflict() {
    if (asking || !cloud || !cloud.hasConflict()) return;
    asking = true;
    try {
      const info = await cloud.conflictInfo();
      const there = info.there ? format('cloudConflictThere', { device: info.there }) : t('cloudConflictThereUnknown');
      const which = await askChoice(t('cloudConflictTitle'), t('cloudConflictHelp'), [
        { value: 'mine', label: t('cloudConflictMine'), help: format('cloudConflictHere', { device: info.here }), className: 'is-primary' },
        { value: 'theirs', label: t('cloudConflictTheirs'), help: `${there}${info.thereAt ? ` ${whenText(info.thereAt)}` : ''}` },
      ]);
      if (!which) return;
      showBusy(t('cloudSyncing'), 'online');
      const reload = await cloud.resolveConflict(which);
      if (reload) { location.reload(); return; }
      showNotice(t('cloudConflictDone'), false, 'online');
    } catch (error) {
      if (error instanceof cloud.CloudError && error.message === 'conflict') {
        asking = false;
        showNotice(t('cloudConflictAgain'), true, 'online');
        await askConflict();
        return;
      }
      showNotice(cloudErrorText(error), true, 'online');
    } finally {
      asking = false;
    }
  }

  // Dispositivi che usano questo profilo, con «Escludi» per uno perso, rubato o non più usato
  async function showDevices() {
    showBusy(t('cloudListing'), 'online');
    let devices;
    try {
      devices = await cloud.listDevices();
    } catch (error) {
      showNotice(cloudErrorText(error), true, 'online');
      return;
    }
    notice = null;
    ui.render();
    const picked = await ui.runPanelDialog({
      title: t('cloudDevicesTitle'),
      help: t('cloudDevicesHelp'),
      className: 'choice-dialog',
      build(close) {
        const list = el('div', 'choice-options cloud-choices');
        devices.forEach((d) => {
          const row = el('div', 'choice-option cloud-device');
          const text = el('div', 'cloud-device-text');
          text.append(el('strong', null, d.label || t('cloudDeviceUnknown')));
          const when = d.at ? format('cloudDeviceLast', { when: whenText(d.at) }) : '';
          text.append(el('small', null, [d.here ? t('cloudDeviceHere') : '', when].filter(Boolean).join(' · ')));
          row.append(text);
          if (d.here) {
            // Il nome si cambia solo da qui: ogni dispositivo scrive solo il suo
            row.append(ui.button(t('cloudDeviceRename'), () => close({ rename: true }), false));
          } else {
            const btn = ui.button(t('cloudDeviceExclude'), () => close(d), false);
            btn.classList.add('dlg-btn-danger');
            row.append(btn);
          }
          list.append(row);
        });
        return list;
      },
    });
    if (!picked) return;
    if (picked.rename) {
      const values = await ui.runDialog({
        title: t('cloudDeviceNameTitle'),
        help: t('cloudDeviceNameHelp'),
        fields: [{ id: 'name', label: t('cloudDeviceNameField'), plain: true, maxLength: 30, value: cloud.deviceName() }],
        primary: t('confirm'),
        secondary: t('cancel'),
        onSubmit: (v) => v,
      });
      if (!values) return;
      await cloud.setDeviceName(values.name);
      showNotice(t('cloudDeviceNamed'), false, 'online');
      return;
    }
    const ok = await ui.runDialog({
      title: t('cloudDeviceExcludeTitle'),
      help: format('cloudDeviceExcludeHelp', { device: picked.label || t('cloudDeviceUnknown') }),
      primary: t('cloudDeviceExclude'),
      secondary: t('cancel'),
    });
    if (!ok) return;
    try {
      await cloud.excludeDevice(picked.id);
      showNotice(t('cloudDeviceExcluded'), false, 'online');
    } catch (error) {
      showNotice(cloudErrorText(error), true, 'online');
    }
  }

  // Riga «Privacy» tra le prime voci della sezione, sempre visibile: cosa succede ai dati con il backup online.
  // Il testo è generico (oggi Dropbox, domani anche altri servizi): la pagina della privacy elenca i servizi usati.
  // Una pagina per lingua: si apre quella della lingua del tool (privacy.html in italiano, privacy-en.html in inglese).
  const PRIVACY_PAGES = { it: 'privacy.html', en: 'privacy-en.html' };
  function privacyRow() {
    const a = el('a', 'dlg-btn link-btn', t('cloudPrivacyBtn'));
    a.href = PRIVACY_PAGES[i18n.language] || PRIVACY_PAGES.it;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return ui.settingRow('cloudPrivacy', 'cloudPrivacyHelp', a);
  }

  function renderOnlineSection() {
    const wrap = ui.section('secBackupOnlineTitle', 'secBackupOnlineHelp');
    renderNotice(wrap, 'online');
    if (!cloud || !cloud.isConfigured()) {
      wrap.append(comingRow('cloudDropbox', 'cloudDropboxHelp', 'cloudConnectBtn'));
      return;
    }
    if (!cloud.isConnected()) {
      prepareLink();
      wrap.append(ui.settingRow('cloudDropbox', 'cloudDropboxHelp', ui.button(t('cloudConnectBtn'), connectDropbox, true)), privacyRow());
      return;
    }
    if (!cloud.isEnabledHere()) {
      // Collegato da un altro profilo: questo profilo non va su Dropbox finché l'adulto non lo decide
      wrap.append(el('p', 'settings-help backup-last', t(cloud.wasExcluded() ? 'cloudExcludedHere' : 'cloudOtherProfile')));
      wrap.append(ui.settingRow('cloudEnable', 'cloudEnableHelp', ui.button(t('cloudEnableBtn'), enableProfile, true)), privacyRow());
      wrap.append(ui.settingRow('cloudOpen', 'cloudOpenHelp', ui.button(t('cloudOpenBtn'), openProfile, false)));
      return;
    }
    const status = el('p', `settings-help backup-last${['error', 'reconnect', 'full'].includes(cloud.status()) ? ' is-error' : ''}`,
      `${t('cloudConnectedPlain')} ${cloudStatusText()}`);
    status.setAttribute('role', 'status');
    wrap.append(status, privacyRow());
    if (cloud.hasConflict()) {
      wrap.append(ui.settingRow('cloudConflictRow', 'cloudConflictRowHelp', ui.button(t('cloudConflictRowBtn'), askConflict, true)));
    }
    if (cloud.status() === 'reconnect') {
      const control = el('div', 'choice-group');
      // Si ricollega lo stesso account (stesso nome, stessi profili): basta il codice nuovo di Dropbox
      const own = cloud.listAccounts().find((a) => a.here);
      prepareLink();
      control.append(ui.button(t('cloudReconnectBtn'), () => connectDropbox({ account: own && own.key }), true));
      wrap.append(ui.settingRow('cloudReconnect', 'cloudReconnectHelp', control));
    }
    // Aggiornamento automatico o manuale (si parte da manuale): vale per questo profilo su questo dispositivo
    const auto = cloud.isAuto();
    wrap.append(ui.settingRow('cloudAuto', 'cloudAutoHelp', ui.segmented(
      [['manual', 'valCloudManual'], ['auto', 'valCloudAuto']], auto ? 'auto' : 'manual',
      async (value) => {
        if ((value === 'auto') === auto) return;
        await cloud.setAuto(value === 'auto');
        ui.render();
      },
    )));
    wrap.append(ui.settingRow('cloudSync', auto ? 'cloudSyncHelp' : 'cloudSyncHelpManual', ui.button(t('cloudSyncBtn'), syncDropbox, !auto && cloud.pending())));
    wrap.append(ui.settingRow('cloudPhoto', 'cloudPhotoRowHelp', ui.button(t('cloudPhotoRowBtn'), saveNamedCopy, true)));
    wrap.append(ui.settingRow('cloudOpen', 'cloudOpenHelp', ui.button(t('cloudOpenBtn'), openProfile, false)));
    if (cloud.isSynced()) wrap.append(ui.settingRow('cloudDevices', 'cloudDevicesRowHelp', ui.button(t('cloudDevicesBtn'), showDevices, false)));
    const off = ui.button(t('cloudDisconnectBtn'), disconnectDropbox, false);
    off.classList.add('dlg-btn-danger');
    wrap.append(ui.settingRow('cloudDisconnect', 'cloudDisconnectRowHelp', off));
  }

  // Icona del cestino (disegnata senza innerHTML)
  function trashIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    [['width', '26'], ['height', '26'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]
      .forEach(([k, v]) => svg.setAttribute(k, v));
    ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'].forEach((d) => {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    });
    return svg;
  }

  /*
   * Elenco di scelte (profili o copie) in una finestra; risolve con il valore scelto o null.
   * Una scelta con deletable ha accanto il cestino: toccarlo risolve con { remove: valore }.
   */
  function askChoice(title, help, choices) {
    return ui.runPanelDialog({
      title,
      help,
      className: 'choice-dialog',
      build(close) {
        const options = el('div', 'choice-options cloud-choices');
        choices.forEach((opt) => {
          const btn = el('button', `choice-option ${opt.className || ''}`.trim());
          btn.type = 'button';
          btn.append(el('strong', null, opt.label));
          if (opt.help) btn.append(el('small', null, opt.help));
          btn.addEventListener('click', () => close(opt.value));
          if (!opt.deletable) { options.append(btn); return; }
          const row = el('div', 'cloud-copy-row');
          const del = el('button', 'cloud-copy-delete');
          del.type = 'button';
          del.setAttribute('aria-label', format('cloudDeleteCopyLabel', { name: opt.label }));
          del.title = t('cloudDeleteCopyBtn');
          del.append(trashIcon());
          del.addEventListener('click', () => close({ remove: opt.value }));
          row.append(btn, del);
          options.append(row);
        });
        return options;
      },
    });
  }

  function whenText(date) {
    return date ? format('cloudWhen', { date: dateText(date), time: timeText(date) }) : '';
  }

  async function restoreFromDropbox() {
    if (storage.saveProblem()) { await ui.showStorageProblem(); return; }
    const account = await pickAccount();
    if (account === null) return;
    showBusy(t('cloudListing'), 'restore');
    let profiles;
    try {
      profiles = await viaAccount(account, () => cloud.listProfiles());
    } catch (error) {
      showNotice(cloudErrorText(error), true, 'restore');
      return;
    }
    ui.render();
    if (!profiles.length) {
      await ui.runDialog({ title: t('cloudRestoreTitle'), help: t('cloudNoCopies'), primary: t('close') });
      return;
    }
    // Cartella del profilo in uso (per un profilo sincronizzato con un altro è quella dell'altro)
    const hereId = (cloud.isEnabledHere() && cloud.folder()) || (data.profile && data.profile.id);
    const profileId = profiles.length === 1 ? profiles[0].id : await askChoice(t('cloudRestoreTitle'), t('cloudPickProfile'),
      profiles.map((p) => ({
        value: p.id,
        label: (p.name || t('backupRestoredProfileName')) + (p.id === hereId ? ` ${t('cloudThisProfile')}` : ''),
        help: [whenText(p.updatedAt), p.device].filter(Boolean).join(' · '),
        className: p.id === hereId ? 'is-primary' : '',
      })));
    if (!profileId) return;
    // Si possono cancellare solo le copie del profilo in uso (con il suo account), mai quelle di altri profili
    const own = account === '' && cloud.isEnabledHere() && profileId === cloud.folder();
    let copies;
    let picked;
    for (;;) {
      try {
        copies = await viaAccount(account, () => cloud.listCopies(profileId));
      } catch (error) {
        showNotice(cloudErrorText(error), true, 'restore');
        return;
      }
      ui.render();
      if (!copies.length) {
        await ui.runDialog({ title: t('cloudRestoreTitle'), help: t('cloudNoCopies'), primary: t('close') });
        return;
      }
      // Copia più recente del profilo in uso: è quasi uguale a quello che c'è già sul dispositivo, quindi va in fondo,
      // non evidenziata, con la spiegazione di quando serve (dispositivo nuovo, dopo «Cancella tutto»)
      const same = profileId === hereId;
      const choices = copies.map((c, index) => {
        const kind = c.kind === 'latest' && same ? 'latestHere' : c.kind;
        return {
          value: String(index),
          kind,
          label: c.kind === 'photo' && c.label ? format('cloudKind_photoNamed', { name: c.label }) : t(`cloudKind_${kind}`),
          // Data e, sotto, a cosa serve quella copia
          help: format(`cloudExplain_${kind}`, { when: c.kind === 'daily' && c.date ? dateText(c.date) : whenText(c.date) }),
          className: kind === 'latest' ? 'is-primary' : '',
          deletable: own && cloud.canDeleteCopy(c),
        };
      });
      const ordered = [...choices.filter((c) => c.kind !== 'latestHere'), ...choices.filter((c) => c.kind === 'latestHere')];
      const help = ordered.some((c) => c.deletable) ? `${t('cloudPickCopy')} ${t('cloudPickCopyDelete')}` : t('cloudPickCopy');
      picked = await askChoice(t('cloudRestoreTitle'), help, ordered);
      if (picked === null || picked === undefined) return;
      if (typeof picked !== 'object') break;
      // Cestino: conferma, cancellazione e di nuovo l'elenco aggiornato
      const index = Number(picked.remove);
      const target = copies[index];
      const choice = choices[index];
      if (!target || !choice) return;
      const ok = await ui.runDialog({
        title: t('cloudDeleteCopyTitle'),
        help: format('cloudDeleteCopyHelp', { name: choice.label, when: target.kind === 'daily' && target.date ? dateText(target.date) : whenText(target.date) }),
        primary: t('cloudDeleteCopyBtn'),
        secondary: t('cancel'),
      });
      if (!ok) continue;
      showBusy(t('cloudDeleting'), 'restore');
      try {
        await cloud.deleteCopy(target);
      } catch (error) {
        showNotice(cloudErrorText(error), true, 'restore');
        return;
      }
      showBusy(t('cloudListing'), 'restore');
    }
    const copy = copies[Number(picked)];
    showBusy(t('cloudDownloading'), 'restore');
    let result;
    try {
      result = await viaAccount(account, () => cloud.openCopy(profileId, copy));
    } catch (error) {
      if (error instanceof backup.BackupError) await showError(error);
      else showNotice(cloudErrorText(error), true, 'restore');
      return;
    }
    ui.render();
    await restoreOpened(result.opened, result.parts);
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
    // Versione di PicSpeak che ha creato il backup (manca nei backup più vecchi)
    if (info.appVersion) texts.push(format('backupSummaryVersion', { version: info.appVersion }));
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

  /*
   * Prima domanda del ripristino: in un profilo nuovo o nel profilo in uso. Se il backup è di un'altra persona
   * (nome diverso) la scelta evidenziata è il profilo nuovo. Risolve 'new', 'current' o null.
   */
  async function askTarget(info, parts) {
    const profiles = window.PicSpeak.profiles;
    // Un vecchio file «storico e contesti» ha solo le abitudini, senza nome né schede: va nel profilo in uso
    if (info.legacy || !profiles || !(await profiles.canAddProfile())) return 'current';
    const here = profiles.displayName(data.profile);
    const same = Boolean(info.name && data.profile && data.profile.name
      && info.name.toLocaleLowerCase() === data.profile.name.toLocaleLowerCase());
    return ui.runPanelDialog({
      title: info.name ? format('backupSummaryTitle', { name: info.name }) : t('backupSummaryNoName'),
      className: 'choice-dialog',
      build(close) {
        const box = el('div', 'backup-summary');
        summaryTexts({ ...info, name: null }, parts.issues).forEach((text, index) => box.append(el('p', index ? 'tpl-status' : 'dialog-help', text)));
        const list = el('ul', 'settings-list');
        partLines(parts).forEach(([, text]) => list.append(el('li', null, text)));
        box.append(list, el('p', 'dialog-help', t('backupTargetAsk')));
        const options = el('div', 'choice-options');
        const newName = info.name || t('backupRestoredProfileName');
        const choices = [
          { value: 'new', label: format('backupTargetNew', { name: newName }), help: format('backupTargetNewHelp', { current: here }), className: same ? '' : 'is-primary' },
          { value: 'current', label: format('backupTargetCurrent', { current: here }), help: format('backupTargetCurrentHelp', { current: here }), className: same ? 'is-primary' : '' },
        ];
        if (same) choices.reverse();
        choices.forEach((opt) => {
          const btn = el('button', `choice-option ${opt.className}`.trim());
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

  /*
   * Un solo «Ripristina»: con Dropbox collegato si sceglie da dove (un file sul dispositivo o una copia su Dropbox),
   * altrimenti si apre subito la scelta del file.
   */
  async function restoreBackup() {
    if (storage.saveProblem()) { await ui.showStorageProblem(); return; }
    let filePicked = null;
    if (cloud && cloud.isConfigured() && cloud.listAccounts().length) {
      const from = await ui.runPanelDialog({
        title: t('restoreFromTitle'),
        className: 'choice-dialog',
        build(close) {
          const options = el('div', 'choice-options');
          [['file', 'restoreFromFile', 'restoreFromFileHelp'], ['dropbox', 'restoreFromDropbox', 'restoreFromDropboxHelp']]
            .forEach(([value, labelKey, helpKey]) => {
              const btn = el('button', 'choice-option');
              btn.type = 'button';
              btn.append(el('strong', null, t(labelKey)), el('small', null, t(helpKey)));
              btn.addEventListener('click', () => {
                // La scelta del file si apre dentro il tocco (Safari non la apre più tardi)
                if (value === 'file') filePicked = pickFile();
                close(value);
              });
              options.append(btn);
            });
          return options;
        },
      });
      if (!from) return;
      if (from === 'dropbox') { await restoreFromDropbox(); return; }
    }
    // Senza Dropbox il file si sceglie subito, dentro il tocco
    const file = await (filePicked || pickFile());
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
    await restoreOpened(opened, parts);
  }

  // Copia automatica su Dropbox prima di un'operazione grande (se collegato); non blocca l'operazione se non riesce
  async function cloudSafetyCopy(where) {
    if (!cloud || !cloud.isConnected()) return;
    showBusy(t('cloudSafetySaving'), where);
    try {
      await cloud.saveSnapshot('before');
    } catch (error) {
      // Si prosegue: l'adulto ha già avuto la proposta del backup sul dispositivo
    }
  }

  // Ripristino di un backup già aperto (da un file o da Dropbox); parts è null se il backup è protetto da password
  async function restoreOpened(opened, parts) {
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

    // Profilo di destinazione: uno nuovo (il profilo in uso resta com'è) oppure quello in uso
    const target = await askTarget(opened.info, parts);
    if (!target) return;
    let mode;
    if (target === 'new') {
      const started = cloud && cloud.pauseDuring
        ? await cloud.pauseDuring(() => window.PicSpeak.profiles.startRestoredProfile(opened.info.name))
        : await window.PicSpeak.profiles.startRestoredProfile(opened.info.name);
      if (!started) {
        await showError(new backup.BackupError('damaged'));
        return;
      }
      mode = 'all';
    } else {
      mode = await askSummary(opened.info, parts);
      if (!mode) return;
    }
    let choice;
    if (target === 'new') {
      // Profilo nuovo: entra tutto il backup; i modelli salvati, che sono del dispositivo, si aggiungono
      choice = Object.fromEntries(Object.keys(parts.summary).map((part) => [part, part === 'templates' ? 'add' : 'replace']));
    } else if (mode === 'all') {
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

    await cloudSafetyCopy('restore');
    showBusy(t('backupRestoring'), 'restore');
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
          if (!res.ok) return t('pinWrong');
        }
        return true;
      },
    });
    if (!confirmed) return;

    // 3. Cancellazione e ripartenza come alla prima apertura (prima una copia su Dropbox, se collegato, poi si scollega)
    await cloudSafetyCopy('reset');
    if (cloud && cloud.isConnected()) await cloud.disconnectAll();
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

  // ---------- Promemoria del backup ----------
  // Solo per l'adulto (impostazioni e barra della modalità adulto, mai nella vista del bambino) e solo se il profilo
  // non ha il backup online attivo qui. Un pallino sul pulsante «Impostazioni» e un avviso in cima alle impostazioni,
  // con «Salva un backup» e «Più tardi» (una settimana). Le regole sono in backup.reminderDue.
  let reminder = { due: false, days: null };

  // Copie automatiche attive (Dropbox o cartella): il promemoria non serve
  function onlineActive() {
    return Boolean(cloud && cloud.isConfigured() && cloud.isConnected() && cloud.isEnabledHere())
      || Boolean(folderBackup && folderBackup.isActive());
  }

  async function refreshReminder() {
    try {
      reminder = await backup.reminderState(onlineActive());
    } catch (error) {
      reminder = { due: false, days: null };
    }
    const btn = document.getElementById('btn-open-settings');
    if (btn) {
      btn.classList.toggle('has-reminder', reminder.due);
      // Chi usa un lettore di schermo sente il motivo del pallino
      if (reminder.due) {
        btn.title = reminderText();
        btn.setAttribute('aria-description', reminderText());
      } else {
        btn.removeAttribute('title');
        btn.removeAttribute('aria-description');
      }
    }
  }

  function reminderText() {
    return reminder.days === null ? t('backupReminderNever') : format('backupReminderDays', { n: reminder.days });
  }

  function reminderBanner(categoryId) {
    if (!reminder.due || categoryId === 'backup') return null;
    const box = el('div', 'settings-banner');
    box.setAttribute('role', 'status');
    const text = reminderText();
    const hint = cloud && cloud.isConfigured() ? t('backupReminderHintOnline') : t('backupReminderHint');
    const words = el('p', 'settings-banner-text');
    words.append(el('strong', '', text), document.createTextNode(` ${hint}`));
    const actions = el('div', 'settings-banner-actions');
    actions.append(
      ui.button(t('backupReminderSave'), async () => {
        const saved = await saveBackup();
        await refreshReminder();
        // Salvato: si va su «Backup e ripristino», dove compare la conferma con il nome del file
        if (saved) ui.openSettings('backup');
        else ui.render();
      }, true),
      ui.button(t('backupReminderLater'), async () => {
        await backup.snoozeReminder();
        await refreshReminder();
        ui.render();
      }, false),
    );
    box.append(words, actions);
    return box;
  }

  ui.addBanner(reminderBanner);
  // Dropbox collegato o scollegato: il promemoria compare o sparisce
  if (cloud && cloud.onStatus) cloud.onStatus(() => { refreshReminder(); });
  if (folderBackup) folderBackup.onStatus(() => { refreshReminder(); });
  document.addEventListener('picspeak:adult-enter', () => { refreshReminder().then(() => ui.render()); });

  // Entrando in modalità adulto: se ci sono due versioni delle schede, si chiede subito quale tenere
  document.addEventListener('picspeak:adult-enter', () => { setTimeout(askConflict, 300); });

  ui.addCategory({
    id: 'backup',
    icon: '<path d="M4 7.5v9c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-9"/><ellipse cx="12" cy="7.5" rx="8" ry="3.5"/><path d="M4 12c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5"/>',
    titleKey: 'catBackup',
    introKey: 'catBackupIntro',
    render: [renderLocalSection, renderFolderSection, renderOnlineSection, renderRestoreSection, renderResetSection],
  }, 'security');
})();
