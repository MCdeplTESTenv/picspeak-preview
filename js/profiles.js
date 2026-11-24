/*
 * Profili multipli: più persone sullo stesso dispositivo (per esempio una terapista con più bambini).
 * Ogni profilo ha le sue schede, i suoi contesti, le sue abitudini d'uso e le sue scelte (aspetto, voce, lingua,
 * tocco e frase, previsione…: vedi storage.PROFILE_KEYS). Le immagini sono in comune: un pittogramma usato da
 * due profili si salva una volta sola.
 *
 * L'app si apre sempre sull'ultimo profilo usato, senza schermate di scelta: il bambino non può cambiarlo.
 * Il cambio si fa solo nelle Impostazioni (protette dal PIN), categoria «Profili»: usa, aggiungi (con le schede
 * di partenza), duplica (anche un profilo non in uso), rinomina, elimina. Per cambiare profilo la pagina si ricarica:
 * ogni parte dell'app riparte pulita con le scelte del nuovo profilo, e si torna in questa pagina.
 * Tutto il testo entra nel DOM con textContent/createElement (mai innerHTML con dati).
 */
(function () {
  'use strict';

  const { i18n, storage, data, predict, security, settingsUi: ui } = window.PicSpeak;
  const t = i18n.t;

  const NAME_MAX = 40;
  const MAX_PROFILES = 20;
  // Colori dei cerchi con l'iniziale: tutti con testo bianco leggibile (contrasto ≥ 4,5:1)
  const COLORS = ['#1f5fbf', '#b0306f', '#2e7d32', '#6a3fc1', '#a04a00', '#00727d'];

  function fmt(key, values) {
    return Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Niente caratteri di controllo né di direzione del testo, spazi semplici, al massimo 40 caratteri
  function cleanName(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  }

  function displayName(profile) {
    return (profile && cleanName(profile.name)) || t('profileNoName');
  }

  function colorOf(profile) {
    let hash = 0;
    for (const ch of String(profile.id)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return COLORS[hash % COLORS.length];
  }

  // ---------- Dati ----------

  async function listProfiles() {
    const [profiles, pages, contexts] = await Promise.all([
      storage.getAllRecords('profiles'),
      storage.getAllRecords('pages'),
      storage.getAllRecords('contexts'),
    ]);
    const count = (list, id) => list.reduce((n, r) => n + (r && r.profileId === id ? 1 : 0), 0);
    return profiles
      .filter((p) => p && typeof p.id === 'string')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map((profile) => ({
        profile,
        pages: count(pages, profile.id),
        contexts: contexts.filter((c) => c && c.profileId === profile.id && c.kind === 'prediction').length,
      }));
  }

  function nameTaken(list, name, exceptId) {
    const key = name.toLocaleLowerCase();
    return list.some(({ profile }) => profile.id !== exceptId && cleanName(profile.name).toLocaleLowerCase() === key);
  }

  // Passa al profilo indicato: si salva quello che è in sospeso, poi PicSpeak si riapre su «Profili»
  async function switchTo(profileId) {
    if (predict) await predict.flush();
    await storage.setActiveProfileId(profileId);
    ui.reopenAfterReload('profiles');
  }

  // Profilo nuovo con le schede di partenza (le stesse della prima apertura) e le scelte iniziali
  async function createStarter(name) {
    const id = storage.newProfileId();
    await data.seedDefaultProfile(id, name);
    return id;
  }

  /*
   * Copia identica di un profilo qualsiasi, in uso o no: schede (tessere negli stessi posti, cartelle che puntano
   * alle nuove schede), contesti, abitudini d'uso e scelte. Le immagini restano in comune.
   */
  async function duplicateProfile(sourceId, name) {
    const isCurrent = sourceId === data.profile.id;
    const source = isCurrent ? data.profile : await storage.getRecord('profiles', sourceId);
    if (!source) throw new Error('profile-missing');
    const id = storage.newProfileId();
    // Per il profilo in uso si salvano prima le abitudini ancora in memoria
    if (isCurrent && predict) await predict.flush();

    const [allPages, allContexts, usage, settings] = await Promise.all([
      storage.getAllRecords('pages'),
      storage.getAllRecords('contexts'),
      predict ? predict.usageRecordsOf(source.id) : [],
      storage.getProfileSettings(source.id),
    ]);
    const stamp = new Date().toISOString();

    const contextIds = new Map();
    const contexts = allContexts.filter((c) => c && c.profileId === source.id).map((c) => {
      const copy = { ...structuredClone(c), id: `ctx_${data.newId('c').slice(2)}`, profileId: id };
      contextIds.set(c.id, copy.id);
      return copy;
    });
    const mapContexts = (list) => (Array.isArray(list) ? list.map((x) => contextIds.get(x)).filter(Boolean) : []);

    const sourcePages = allPages.filter((p) => p && p.profileId === source.id);
    const pageIds = new Map(sourcePages.map((p) => [p.id, data.newId('pg')]));
    const pages = sourcePages.map((p) => {
      const copy = structuredClone(p);
      copy.id = pageIds.get(p.id);
      copy.profileId = id;
      copy.contextIds = mapContexts(p.contextIds);
      copy.updatedAt = stamp;
      copy.cells = (copy.cells || []).map((cell) => ({
        ...cell,
        id: data.newId('c'),
        targetPageId: cell.targetPageId ? pageIds.get(cell.targetPageId) || null : null,
      }));
      return copy;
    });

    // Gli id delle abitudini contengono il codice del profilo (es. ud_<profilo>_<giorno>)
    const records = usage.map((r) => ({ ...r, id: r.id.replace(`_${source.id}`, `_${id}`), profileId: id }));

    const profile = {
      ...structuredClone(source),
      id,
      name,
      homePageId: pageIds.get(source.homePageId) || null,
      activeContextIds: mapContexts(source.activeContextIds),
      createdAt: stamp,
      updatedAt: stamp,
    };
    const { lastBackup, ...choices } = settings; // la data dell'ultimo backup non si copia

    await storage.putRecords('contexts', contexts);
    await storage.putRecords('pages', pages);
    if (records.length) await storage.putRecords('usage', records);
    await storage.setProfileSettings(id, choices);
    // Il profilo per ultimo: se qualcosa si interrompe prima, non compare un profilo a metà
    await storage.putRecord('profiles', profile);
    return id;
  }

  async function rename(profileId, name) {
    const profile = profileId === data.profile.id ? data.profile : await storage.getRecord('profiles', profileId);
    if (!profile) return;
    profile.name = name;
    profile.updatedAt = new Date().toISOString();
    await storage.putRecord('profiles', profile);
  }

  /*
   * Elimina un profilo e tutto ciò che è solo suo: schede, contesti, abitudini, registrazioni, scelte, copia delle
   * schede di prima e le foto o i pittogrammi scaricati che nessun altro profilo usa.
   */
  async function removeProfile(profileId) {
    const isCurrent = profileId === data.profile.id;
    if (isCurrent && predict) {
      await predict.clearAll();
      predict.freeze(); // nessun salvataggio in sospeso deve riscrivere le abitudini cancellate
    }
    const [profiles, pages, contexts, audio, images] = await Promise.all([
      storage.getAllRecords('profiles'),
      storage.getAllRecords('pages'),
      storage.getAllRecords('contexts'),
      storage.getAllRecords('audio'),
      storage.getAllRecords('images'),
    ]);
    const own = pages.filter((p) => p && p.profileId === profileId);

    // Immagini ancora usate dagli altri profili (schede attuali e copie delle schede di prima)
    const used = new Set();
    const collect = (list) => list.forEach((p) => (p && Array.isArray(p.cells) ? p.cells : [])
      .forEach((c) => { if (c && c.imageId) used.add(c.imageId); }));
    collect(pages.filter((p) => p && p.profileId !== profileId));
    for (const other of profiles) {
      if (!other || other.id === profileId) continue;
      const snapshot = await storage.get(`previousPages:${other.id}`);
      if (snapshot && Array.isArray(snapshot.pages)) collect(snapshot.pages);
    }
    // «I miei modelli» sono del dispositivo, non del profilo: le immagini a cui rimandano restano
    const saved = await storage.get('userTemplates');
    (Array.isArray(saved) ? saved : []).forEach((entry) => {
      const images = entry && entry.template && entry.template.images;
      if (!images || typeof images !== 'object') return;
      Object.values(images).forEach((img) => { if (img && typeof img.localId === 'string') used.add(img.localId); });
    });
    // Candidate: le immagini delle sue schede attuali e della sua copia delle schede di prima
    const candidates = new Set();
    const addCandidates = (list) => list.forEach((p) => (p && Array.isArray(p.cells) ? p.cells : [])
      .forEach((c) => { if (c && c.imageId) candidates.add(c.imageId); }));
    addCandidates(own);
    const ownSnapshot = await storage.get(`previousPages:${profileId}`);
    if (ownSnapshot && Array.isArray(ownSnapshot.pages)) addCandidates(ownSnapshot.pages);
    // Solo le immagini salvate sul dispositivo (foto, pittogrammi scaricati): quelle incluse nel tool non pesano
    const orphanImages = images
      .filter((img) => img && candidates.has(img.id) && !used.has(img.id) && img.blob)
      .map((img) => img.id);

    await storage.deleteRecords('pages', own.map((p) => p.id));
    await storage.deleteRecords('contexts', contexts.filter((c) => c && c.profileId === profileId).map((c) => c.id));
    await storage.deleteRecords('audio', audio.filter((a) => a && a.profileId === profileId).map((a) => a.id));
    if (predict) await storage.deleteRecords('usage', (await predict.usageRecordsOf(profileId)).map((r) => r.id));
    await storage.deleteRecords('images', orphanImages);
    await storage.removeProfileSettings(profileId);
    await storage.remove(`previousPages:${profileId}`);
    if (window.PicSpeak.cloud) await window.PicSpeak.cloud.forgetProfile(profileId);
    await storage.deleteRecord('profiles', profileId);
    if (channel) channel.postMessage({ deleted: profileId });
  }

  /*
   * PicSpeak aperto in un'altra scheda sullo stesso profilo appena eliminato: si fermano i salvataggi e la scheda
   * si ricarica sul profilo in uso, così non riscrive dati del profilo cancellato.
   */
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(`${storage.name}-profiles`) : null;
  if (channel) {
    channel.onmessage = (event) => {
      const deleted = event.data && event.data.deleted;
      if (typeof deleted !== 'string' || !data.profile || data.profile.id !== deleted) return;
      if (predict) predict.freeze();
      location.reload();
    };
  }

  // ---------- Finestre ----------

  async function askName({ title, help, value, primary, list, exceptId }) {
    const values = await ui.runDialog({
      title,
      help,
      fields: [{ id: 'name', label: t('profileNameLabel'), plain: true, value: value || '', maxLength: NAME_MAX }],
      primary,
      secondary: t('cancel'),
      onSubmit: (v) => {
        const name = cleanName(v.name);
        if (!name) return t('profileNameMissing');
        if (nameTaken(list, name, exceptId)) return t('profileNameTaken');
        return { name };
      },
    });
    return values ? values.name : null;
  }

  async function failed() {
    await ui.runDialog({ title: t('profileFailed'), primary: t('close') });
  }

  async function addProfile(list) {
    if (list.length >= MAX_PROFILES) {
      await ui.runDialog({ title: fmt('profileTooMany', { n: MAX_PROFILES }), primary: t('close') });
      return;
    }
    const name = await askName({
      title: t('profileAddTitle'),
      help: t('profileAddHelp'),
      value: '',
      primary: t('profileCreateBtn'),
      list,
    });
    if (!name) return;
    try {
      await switchTo(await createStarter(name));
    } catch (error) {
      await failed();
    }
  }

  // Duplica: il nuovo profilo compare nell'elenco, quello in uso resta lo stesso
  async function duplicate(entry, list) {
    if (list.length >= MAX_PROFILES) {
      await ui.runDialog({ title: fmt('profileTooMany', { n: MAX_PROFILES }), primary: t('close') });
      return;
    }
    const sourceName = displayName(entry.profile);
    const suggested = cleanName(fmt('profileCopyName', { name: sourceName }));
    const name = await askName({
      title: fmt('profileDuplicateTitle', { name: sourceName }),
      help: fmt('profileDuplicateHelp', { name: sourceName }),
      value: nameTaken(list, suggested) ? '' : suggested,
      primary: t('profileDuplicateBtn'),
      list,
    });
    if (!name) return;
    try {
      await duplicateProfile(entry.profile.id, name);
    } catch (error) {
      await failed();
    }
    ui.render();
  }

  async function renameProfile(entry, list) {
    const name = await askName({
      title: t('profileRenameTitle'),
      help: t('profileNameHelp'),
      value: cleanName(entry.profile.name),
      primary: t('profileNameSave'),
      list,
      exceptId: entry.profile.id,
    });
    if (!name) return;
    try {
      await rename(entry.profile.id, name);
    } catch (error) {
      await failed();
    }
    ui.render();
  }

  // Backup del profilo in uso senza password, prima di eliminarlo (il backup completo è in «Backup e ripristino»)
  async function quickBackup() {
    const { backup } = window.PicSpeak;
    try {
      const file = await backup.create({ name: cleanName(data.profile.name), password: '', fallbackName: t('backupFileWord') });
      backup.save(file.blob, file.name);
      await ui.runDialog({ title: t('profileBackupDone'), help: file.name, primary: t('close') });
    } catch (error) {
      await ui.runDialog({ title: t('backupSaveFailed'), primary: t('close') });
    }
  }

  async function deleteProfile(entry, list) {
    const profile = entry.profile;
    const isCurrent = profile.id === data.profile.id;
    const name = displayName(profile);
    const canBackup = isCurrent && window.PicSpeak.backup;

    // 1. Cosa si cancella; per il profilo in uso, proposta di salvarne prima un backup
    for (;;) {
      const first = await ui.runDialog({
        title: fmt('profileDeleteTitle', { name }),
        help: `${t('profileDeleteHelp')} ${t(canBackup ? 'profileDeleteBackupHint' : 'profileDeleteOtherHint')}`,
        link: canBackup ? t('profileDeleteBackup') : undefined,
        primary: t('profileDeleteContinue'),
        secondary: t('cancel'),
      });
      if (!first) return;
      if (first.link) {
        await quickBackup();
        continue;
      }
      break;
    }

    // 2. Conferma definitiva: PIN (se c'è) e parola da scrivere, come per «Cancella tutto»
    const next = list.find((item) => item.profile.id !== profile.id);
    const word = t('profileDeleteWord');
    const needPin = security.supported && await security.hasPin();
    const fields = [];
    if (needPin) fields.push({ id: 'pin', label: t('resetAllPin') });
    fields.push({ id: 'word', label: fmt('profileDeleteWordLabel', { word }), text: true });
    const confirmed = await ui.runDialog({
      title: t('profileDeleteConfirmTitle'),
      help: isCurrent
        ? `${fmt('profileDeleteConfirmHelp', { name })} ${fmt('profileDeleteSwitch', { name: displayName(next.profile) })}`
        : fmt('profileDeleteConfirmHelp', { name }),
      fields,
      primary: t('profileDeleteBtn'),
      destructive: true,
      secondary: t('cancel'),
      onSubmit: async (values) => {
        if (String(values.word || '').toLocaleUpperCase() !== word.toLocaleUpperCase()) {
          return fmt('profileDeleteWordWrong', { word });
        }
        if (needPin) {
          const res = await security.verifyPin(values.pin);
          if (!res.ok) return t('pinWrong');
        }
        return true;
      },
    });
    if (!confirmed) return;

    try {
      await removeProfile(profile.id);
    } catch (error) {
      await failed();
      if (isCurrent) location.reload();
      return;
    }
    if (isCurrent) await switchTo(next.profile.id);
    else ui.render();
  }

  // ---------- Pagina «Profili» ----------

  function statsText(entry) {
    const pages = entry.pages === 1 ? t('profilePages1') : fmt('profilePagesN', { n: entry.pages });
    let contexts = t('profileContexts0');
    if (entry.contexts === 1) contexts = t('profileContexts1');
    else if (entry.contexts > 1) contexts = fmt('profileContextsN', { n: entry.contexts });
    return `${pages} · ${contexts}`;
  }

  function profileRow(entry, list) {
    const { profile } = entry;
    const isCurrent = profile.id === data.profile.id;
    const row = el('div', `setting-row profile-row${isCurrent ? ' is-current' : ''}`);

    const who = el('div', 'profile-who');
    const avatar = el('span', 'profile-avatar', [...displayName(profile)][0].toLocaleUpperCase());
    avatar.style.backgroundColor = colorOf(profile);
    avatar.setAttribute('aria-hidden', 'true');
    const text = el('div', 'setting-text');
    const title = el('strong', '', displayName(profile));
    if (isCurrent) title.append(el('span', 'profile-current', t('profileCurrent')));
    text.append(title, el('small', '', statsText(entry)));
    who.append(avatar, text);

    const actions = el('div', 'choice-group profile-actions');
    if (!isCurrent) {
      actions.append(ui.button(t('profileUse'), async () => {
        try { await switchTo(profile.id); } catch (error) { await failed(); }
      }, true));
    }
    actions.append(
      ui.button(t('profileDuplicate'), () => duplicate(entry, list), false),
      ui.button(t('profileRename'), () => renameProfile(entry, list), false),
    );
    if (list.length > 1) {
      const del = ui.button(t('profileDelete'), () => deleteProfile(entry, list), false);
      del.classList.add('dlg-btn-danger');
      actions.append(del);
    }
    row.append(who, actions);
    return row;
  }

  async function renderProfilesSection() {
    const wrap = ui.section('secProfilesTitle', 'secProfilesHelp');
    const listBox = el('div', 'profile-list');
    const add = el('div', 'choice-group profile-add');
    wrap.append(listBox, add);
    let list = [];
    try {
      list = await listProfiles();
    } catch (error) {
      list = [];
    }
    if (!list.some((item) => item.profile.id === data.profile.id)) list.unshift({ profile: data.profile, pages: 0, contexts: 0 });
    listBox.replaceChildren(...list.map((entry) => profileRow(entry, list)));
    add.append(ui.button(t('profileAdd'), () => addProfile(list), true));
    if (list.length === 1) wrap.append(el('p', 'settings-help profile-only', t('profileOnlyOne')));
  }

  ui.addCategory({
    id: 'profiles',
    icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 13.6c3.2-.4 5.5 2.2 5.5 5.4"/>',
    titleKey: 'catProfiles',
    introKey: 'catProfilesIntro',
    render: [renderProfilesSection],
  }, 'general');

  // ---------- Nome del profilo nella barra della modalità adulto (solo se i profili sono più di uno) ----------

  async function showProfileInBar() {
    const badge = document.getElementById('adult-profile');
    if (!badge || !data.profile) return;
    try {
      const profiles = await storage.getAllRecords('profiles');
      badge.textContent = displayName(data.profile);
      badge.hidden = profiles.length < 2;
    } catch (error) {
      badge.hidden = true;
    }
  }

  /*
   * Per «Ripristina un backup» in un profilo nuovo: crea il profilo e lo rende quello in uso subito, senza
   * ricaricare la pagina (il ripristino scrive poi schede, abitudini e scelte in questo profilo; alla fine la pagina
   * si ricarica comunque). Se il nome c'è già si aggiunge un numero: «Nome (2)».
   * Restituisce false se si è già al numero massimo di profili.
   */
  async function canAddProfile() {
    return (await storage.getAllRecords('profiles')).length < MAX_PROFILES;
  }

  async function startRestoredProfile(wanted) {
    const list = await listProfiles();
    if (list.length >= MAX_PROFILES) return false;
    const base = cleanName(wanted) || t('backupRestoredProfileName');
    let name = base;
    for (let n = 2; nameTaken(list, name); n += 1) name = cleanName(`${base.slice(0, NAME_MAX - 5)} (${n})`);
    if (predict) await predict.flush();
    const id = await createStarter(name);
    await storage.setActiveProfileId(id);
    await data.load();
    if (predict) await predict.load(id);
    return true;
  }

  window.PicSpeak.profiles = { cleanName, displayName, showProfileInBar, canAddProfile, startRestoredProfile };
})();
