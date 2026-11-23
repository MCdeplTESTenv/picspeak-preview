/*
 * Modalità adulto: accesso protetto (lucchetto da tenere premuto + PIN),
 * uscita manuale o automatica per inattività, pagina delle impostazioni.
 */
(function () {
  'use strict';

  const { i18n, storage, security, install, app, speech, data, symbols, kiosk } = window.PicSpeak;
  const t = i18n.t;

  const HOLD_MS = 3000;
  const INACTIVITY_MS = 5 * 60 * 1000;

  // Modalità colori disponibili (vedi css/style.css, attributo data-color-mode su <html>)
  const DEFAULT_COLOR_MODE = 'card';
  const COLOR_MODES = [
    { id: 'card', nameKey: 'colorModeCard', descKey: 'colorModeCardDesc' },
    { id: 'sheet', nameKey: 'colorModeSheet', descKey: 'colorModeSheetDesc' },
    { id: 'full', nameKey: 'colorModeFull', descKey: 'colorModeFullDesc' },
    { id: 'border', nameKey: 'colorModeBorder', descKey: 'colorModeBorderDesc' },
    { id: 'none', nameKey: 'colorModeNone', descKey: 'colorModeNoneDesc' },
  ];

  // Colori di sfondo della pagina proposti (il primo è quello predefinito)
  const PAGE_BACKGROUNDS = [
    { id: 'auto', color: '', nameKey: 'bgAuto' },
    { id: 'white', color: '#ffffff', nameKey: 'bgWhite' },
    { id: 'vanilla', color: '#fbfaf7', nameKey: 'bgVanilla' },
    { id: 'grey', color: '#eceef2', nameKey: 'bgGrey' },
    { id: 'sky', color: '#e6f0fb', nameKey: 'bgSky' },
    { id: 'sage', color: '#e9f2ea', nameKey: 'bgSage' },
    { id: 'sand', color: '#f3ebdd', nameKey: 'bgSand' },
    { id: 'night', color: '#1f2430', nameKey: 'bgNight' },
  ];

  // Testo chiaro sugli sfondi scuri, scuro sugli sfondi chiari
  function isDark(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
  }

  function applyPageBackground(color) {
    const root = document.documentElement.style;
    if (!color || !/^#[0-9a-f]{6}$/i.test(color)) {
      root.removeProperty('--page-bg');
      root.removeProperty('--page-text');
      root.removeProperty('--page-icon-filter');
      delete document.documentElement.dataset.pageDark;
      return;
    }
    root.setProperty('--page-bg', color);
    root.setProperty('--page-text', isDark(color) ? '#f4f5f7' : '#1a1d24');
    root.setProperty('--page-icon-filter', isDark(color) ? 'invert(1)' : 'none');
    document.documentElement.dataset.pageDark = String(isDark(color));
  }

  function applyColorMode(mode) {
    document.documentElement.dataset.colorMode = mode;
    app.layoutGrid();
  }

  const el = {
    lock: document.getElementById('btn-lock'),
    adultBar: document.getElementById('adult-bar'),
    openSettings: document.getElementById('btn-open-settings'),
    exitAdult: document.getElementById('btn-exit-adult'),
    dialog: document.getElementById('pin-dialog'),
    settings: document.getElementById('settings-screen'),
    settingsBody: document.getElementById('settings-body'),
    settingsBack: document.getElementById('btn-settings-back'),
  };

  let inactivityTimer = null;
  let closeCurrentDialog = null;

  // ---------- Finestra di dialogo generica (PIN, recupero, messaggi) ----------

  /*
   * cfg: { title, help, code, fields: [{ id, label, text }], primary, secondary, link, onSubmit }
   * onSubmit(values) restituisce: una stringa = errore (la finestra resta aperta),
   * altrimenti il risultato con cui chiudere. Risolve null se annullata.
   */
  function runDialog(cfg) {
    return new Promise((resolve) => {
      const dialog = el.dialog;
      const form = document.createElement('form');
      form.className = 'dialog-form';
      form.noValidate = true;

      const title = document.createElement('h2');
      title.textContent = cfg.title;
      form.append(title);

      if (cfg.help) {
        const help = document.createElement('p');
        help.className = 'dialog-help';
        help.textContent = cfg.help;
        form.append(help);
      }

      if (cfg.code) {
        const code = document.createElement('p');
        code.className = 'recovery-code';
        code.textContent = cfg.code;
        form.append(code);
      }

      const inputs = (cfg.fields || []).map((field) => {
        const label = document.createElement('label');
        label.className = 'dialog-field';
        const caption = document.createElement('span');
        caption.textContent = field.label;
        const input = document.createElement('input');
        input.name = field.id;
        input.autocomplete = 'off';
        input.autocapitalize = 'characters';
        input.spellcheck = false;
        if (field.text) {
          input.type = 'text';
        } else {
          input.type = 'password';
          input.inputMode = 'numeric';
          input.maxLength = 6;
        }
        label.append(caption, input);
        form.append(label);
        return input;
      });

      const error = document.createElement('p');
      error.className = 'dialog-error';
      error.setAttribute('role', 'alert');
      form.append(error);

      if (cfg.link) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'dialog-link';
        link.textContent = cfg.link;
        link.addEventListener('click', () => close({ link: true }));
        form.append(link);
      }

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      if (cfg.secondary) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dlg-btn';
        cancel.textContent = cfg.secondary;
        cancel.addEventListener('click', () => close(null));
        actions.append(cancel);
      }
      const primary = document.createElement('button');
      primary.type = 'submit';
      primary.className = cfg.destructive ? 'dlg-btn dlg-btn-primary dlg-btn-destructive' : 'dlg-btn dlg-btn-primary';
      primary.textContent = cfg.primary;
      actions.append(primary);
      form.append(actions);

      function close(result) {
        closeCurrentDialog = null;
        if (dialog.open) dialog.close();
        dialog.replaceChildren();
        resolve(result);
      }
      closeCurrentDialog = () => close(null);

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        primary.disabled = true;
        const values = Object.fromEntries(inputs.map((input) => [input.name, input.value.trim()]));
        const outcome = cfg.onSubmit ? await cfg.onSubmit(values) : true;
        primary.disabled = false;
        if (typeof outcome === 'string') {
          error.textContent = outcome;
          inputs.forEach((input) => { input.value = ''; });
          if (inputs[0]) inputs[0].focus();
          return;
        }
        close(outcome ?? true);
      });

      // Tasto Esc = annulla
      dialog.oncancel = (event) => {
        event.preventDefault();
        if (cfg.secondary) close(null);
      };

      dialog.replaceChildren(form);
      dialog.showModal();
      if (inputs[0]) inputs[0].focus();
    });
  }

  /*
   * Finestra informativa o di scelta, senza campi: contenuto già costruito con createElement,
   * pulsante "Chiudi" in fondo. Risolve con il valore passato a close (null se chiusa).
   */
  function runPanelDialog({ title, help, build, className }) {
    return new Promise((resolve) => {
      const dialog = el.dialog;
      const box = document.createElement('div');
      box.className = `dialog-form ${className || ''}`.trim();

      const heading = document.createElement('h2');
      heading.textContent = title;
      box.append(heading);
      if (help) {
        const p = document.createElement('p');
        p.className = 'dialog-help';
        p.textContent = help;
        box.append(p);
      }

      function close(result) {
        closeCurrentDialog = null;
        if (dialog.open) dialog.close();
        dialog.replaceChildren();
        resolve(result);
      }
      closeCurrentDialog = () => close(null);

      box.append(build(close));

      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'dlg-btn';
      closeBtn.textContent = t('close');
      closeBtn.addEventListener('click', () => close(null));
      actions.append(closeBtn);
      box.append(actions);

      dialog.oncancel = (event) => {
        event.preventDefault();
        close(null);
      };
      dialog.replaceChildren(box);
      dialog.showModal();
      const first = box.querySelector('button');
      if (first) first.focus();
    });
  }

  // ---------- Menu dei tre puntini: Impostazioni, Crediti, Guida ----------

  // Icone costanti (mai dati dell'utente)
  const MENU_ITEMS = [
    { id: 'settings', labelKey: 'menuSettings', descKey: 'menuSettingsDesc',
      icon: '<path d="M19.4 10.1 L21.9 10.3 L21.9 13.7 L19.4 13.9 L18.5 15.9 L20.2 17.8 L17.8 20.2 L15.9 18.5 L13.9 19.4 L13.7 21.9 L10.3 21.9 L10.1 19.4 L8.1 18.5 L6.2 20.2 L3.8 17.8 L5.5 15.9 L4.6 13.9 L2.1 13.7 L2.1 10.3 L4.6 10.1 L5.5 8.1 L3.8 6.2 L6.2 3.8 L8.1 5.5 L10.1 4.6 L10.3 2.1 L13.7 2.1 L13.9 4.6 L15.9 5.5 L17.8 3.8 L20.2 6.2 L18.5 8.1Z"/><circle cx="12" cy="12" r="3"/>' },
    { id: 'credits', labelKey: 'menuCredits', descKey: 'menuCreditsDesc',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M15 9.5a3.5 3.5 0 1 0 0 5"/>' },
    { id: 'guide', labelKey: 'menuGuide', descKey: 'menuGuideDesc',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>' },
  ];

  async function openMainMenu() {
    if (closeCurrentDialog) return;
    const choice = await runPanelDialog({
      title: t('menuTitle'),
      className: 'menu-dialog',
      build: (close) => {
        const listNode = document.createElement('div');
        listNode.className = 'menu-list';
        MENU_ITEMS.forEach((item) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'menu-item';
          const icon = document.createElement('span');
          icon.className = 'menu-item-icon';
          icon.setAttribute('aria-hidden', 'true');
          // innerHTML solo con icone costanti scritte nel codice
          icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>`;
          const text = document.createElement('span');
          text.className = 'menu-item-text';
          const name = document.createElement('strong');
          name.textContent = t(item.labelKey);
          const desc = document.createElement('span');
          desc.textContent = t(item.descKey);
          text.append(name, desc);
          btn.append(icon, text);
          btn.addEventListener('click', () => close(item.id));
          listNode.append(btn);
        });
        return listNode;
      },
    });
    if (choice === 'settings') requestAdultAccess();
    else if (choice === 'credits') showCredits();
    else if (choice === 'guide') openGuide();
  }

  // Crediti senza PIN: sono solo da leggere e devono restare sempre raggiungibili (obbligo delle licenze)
  async function showCredits() {
    const ul = await buildCreditsList(false);
    await runPanelDialog({
      title: t('secCreditsTitle'),
      help: t('secCreditsHelp'),
      className: 'credits-dialog',
      build: () => ul,
    });
  }

  // Guida all'uso: pagina statica dello stesso sito (funziona anche offline)
  function openGuide() {
    window.location.assign('guida.html');
  }

  function lockedMessage(seconds) {
    return t('pinLocked').replace('{s}', String(seconds));
  }

  // ---------- Flussi del PIN ----------

  async function createPinFlow() {
    const result = await runDialog({
      title: t('pinCreateTitle'),
      help: t('pinCreateHelp'),
      fields: [{ id: 'pin', label: t('pinLabel') }, { id: 'pin2', label: t('pinConfirmLabel') }],
      primary: t('confirm'),
      secondary: t('cancel'),
      onSubmit: async (values) => {
        if (!security.isValidPin(values.pin)) return t('pinInvalid');
        if (values.pin !== values.pin2) return t('pinMismatch');
        const code = await security.setPin(values.pin, { newRecovery: true });
        return { code };
      },
    });
    if (!result) return false;
    await runDialog({
      title: t('recoveryTitle'),
      help: t('recoveryHelp'),
      code: result.code,
      primary: t('recoveryDone'),
    });
    return true;
  }

  async function recoveryFlow() {
    const ok = await runDialog({
      title: t('recoveryEnterTitle'),
      help: t('recoveryEnterHelp'),
      fields: [{ id: 'code', label: t('recoveryLabel'), text: true }],
      primary: t('confirm'),
      secondary: t('cancel'),
      onSubmit: async (values) => {
        const res = await security.verifyRecovery(values.code);
        if (res.ok) return true;
        return res.waitSeconds ? lockedMessage(res.waitSeconds) : t('recoveryWrong');
      },
    });
    // Codice corretto: si crea un nuovo PIN (e un nuovo codice di recupero)
    return ok === true ? createPinFlow() : false;
  }

  async function changePinFlow() {
    const ok = await runDialog({
      title: t('changePinTitle'),
      fields: [
        { id: 'current', label: t('currentPinLabel') },
        { id: 'pin', label: t('pinNewLabel') },
        { id: 'pin2', label: t('pinConfirmLabel') },
      ],
      primary: t('confirm'),
      secondary: t('cancel'),
      onSubmit: async (values) => {
        if (!security.isValidPin(values.pin)) return t('pinInvalid');
        if (values.pin !== values.pin2) return t('pinMismatch');
        const res = await security.verifyPin(values.current);
        if (!res.ok) return res.waitSeconds ? lockedMessage(res.waitSeconds) : t('pinWrong');
        // Il codice di recupero esistente resta valido
        await security.setPin(values.pin, { newRecovery: false });
        return true;
      },
    });
    if (ok === true) {
      await runDialog({ title: t('pinChanged'), primary: t('close') });
    }
  }

  async function requestAdultAccess() {
    // Se PicSpeak è aperto dentro un'altra pagina (iframe), le impostazioni restano chiuse:
    // evita che un sito esterno induca a digitare il PIN dentro una cornice ingannevole
    if (window.top !== window.self) return;
    if (!security.supported) {
      await runDialog({ title: t('adultMode'), help: t('cryptoUnavailable'), primary: t('close') });
      return;
    }
    if (!(await security.hasPin())) {
      if (await createPinFlow()) enterAdult();
      return;
    }
    const result = await runDialog({
      title: t('pinEnterTitle'),
      fields: [{ id: 'pin', label: t('pinLabel') }],
      primary: t('confirm'),
      secondary: t('cancel'),
      link: t('pinForgot'),
      onSubmit: async (values) => {
        const res = await security.verifyPin(values.pin);
        if (res.ok) return true;
        return res.waitSeconds ? lockedMessage(res.waitSeconds) : t('pinWrong');
      },
    });
    if (result === true) {
      enterAdult();
    } else if (result && result.link && (await recoveryFlow())) {
      enterAdult();
    }
  }

  // ---------- Ingresso e uscita ----------

  function enterAdult() {
    app.setMode('adult');
    storage.requestPersistence();
    setTimeout(updateZoomLabel, 0);
    el.adultBar.hidden = false;
    el.lock.hidden = true;
    resetInactivity();
    app.layoutGrid();
  }

  function exitAdult() {
    if (closeCurrentDialog) closeCurrentDialog();
    closeSettings();
    clearTimeout(inactivityTimer);
    app.setMode('child');
    el.adultBar.hidden = true;
    el.lock.hidden = false;
    app.layoutGrid();
  }

  function resetInactivity() {
    clearTimeout(inactivityTimer);
    if (app.mode !== 'adult') return;
    inactivityTimer = setTimeout(exitAdult, INACTIVITY_MS);
  }

  // Tre puntini: serve una pressione continua di 3 secondi (un tocco veloce non fa nulla),
  // poi si apre il menu con Impostazioni (con PIN), Crediti e Guida
  function bindLock() {
    let holdTimer = null;
    const indicator = document.getElementById('hold-indicator');
    const cancel = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      el.lock.classList.remove('is-holding');
      indicator.hidden = true;
      indicator.classList.remove('is-running');
    };
    const start = (event) => {
      if (event.type === 'pointerdown' && event.button !== 0) return;
      cancel();
      el.lock.classList.add('is-holding');
      // La barra parte in cima allo schermo, dove il dito non la copre
      indicator.hidden = false;
      void indicator.offsetWidth;
      indicator.classList.add('is-running');
      holdTimer = setTimeout(() => {
        cancel();
        openMainMenu();
      }, HOLD_MS);
    };
    el.lock.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((name) => el.lock.addEventListener(name, cancel));
    el.lock.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
        event.preventDefault();
        start(event);
      }
    });
    el.lock.addEventListener('keyup', (event) => {
      if (event.key === 'Enter' || event.key === ' ') cancel();
    });
    el.lock.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // ---------- Impostazioni ----------

  // Sezioni richiudibili: il titolo resta sempre visibile, con una freccia che apre o chiude il contenuto.
  // All'inizio sono chiuse; quelle aperte dall'adulto restano aperte (elenco salvato sul dispositivo).
  // Chiudere una sezione non cambia nulla: i valori scelti continuano a valere.
  let openSections = new Set();

  function saveOpenSections() {
    storage.set('openSections', [...openSections]);
  }

  // options.collapsible: true = sezione richiudibile; options.key: nome con cui ricordarla (predefinito: il titolo)
  function section(titleKey, helpKey, options = {}) {
    const wrap = document.createElement('section');
    wrap.className = 'settings-section';
    const title = document.createElement('h3');
    if (options.collapsible) {
      const key = options.key || titleKey;
      const open = openSections.has(key);
      wrap.classList.add('is-collapsible');
      wrap.classList.toggle('is-collapsed', !open);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'section-toggle';
      toggle.setAttribute('aria-expanded', String(open));
      const arrow = document.createElement('span');
      arrow.className = 'section-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = t(titleKey);
      toggle.append(arrow, text);
      // Si apre e si chiude senza ridisegnare la pagina: la posizione resta dov'era
      toggle.addEventListener('click', () => {
        const nowOpen = wrap.classList.contains('is-collapsed');
        wrap.classList.toggle('is-collapsed', !nowOpen);
        toggle.setAttribute('aria-expanded', String(nowOpen));
        if (nowOpen) openSections.add(key); else openSections.delete(key);
        saveOpenSections();
      });
      title.append(toggle);
    } else {
      title.textContent = t(titleKey);
    }
    wrap.append(title);
    if (helpKey) {
      const help = document.createElement('p');
      help.className = 'settings-help';
      help.textContent = t(helpKey);
      wrap.append(help);
    }
    currentPanel.append(wrap);
    return wrap;
  }

  // Pannello della categoria in costruzione (vedi renderSettings)
  let currentPanel = null;
  let currentCategory = 'general';
  // Su telefono: true = si vede il contenuto della categoria, false = l'elenco delle categorie
  let showPanelOnPhone = false;

  function list(items, ordered) {
    const node = document.createElement(ordered ? 'ol' : 'ul');
    node.className = 'settings-list';
    (Array.isArray(items) ? items : [items]).forEach((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      node.append(li);
    });
    return node;
  }

  function button(label, onClick, primary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = primary ? 'dlg-btn dlg-btn-primary' : 'dlg-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderInstallSection() {
    const wrap = section('secInstallTitle', 'secInstallHelp');
    if (install.isStandalone()) {
      wrap.append(list(t('installDone')));
      return;
    }
    if (!location.protocol.startsWith('http')) {
      wrap.append(list(t('installFromFile')));
      return;
    }
    if (install.canPrompt()) {
      wrap.append(button(t('installButton'), async () => {
        await install.prompt();
        renderSettings();
      }, true));
    }
    const steps = {
      ios: 'installIos',
      android: 'installAndroid',
      'mac-safari': 'installMacSafari',
      firefox: 'installFirefox',
      chromium: 'installChromium',
    }[install.platform()];
    if (!install.canPrompt() || install.platform() === 'chromium') {
      wrap.append(list(t(steps), true));
    }
  }

  // App sempre aperta: opzioni del browser (schermo acceso, schermo intero) e istruzioni per ogni sistema,
  // con quelle del dispositivo in uso per prime e aperte, le altre richiudibili
  const KEEP_OPEN_SYSTEMS = [
    { os: 'ios', titleKey: 'keepOpenIosTitle', stepsKey: 'keepOpenIos', noteKey: 'keepOpenIosNote' },
    { os: 'android', titleKey: 'keepOpenAndroidTitle', stepsKey: 'keepOpenAndroid', noteKey: 'keepOpenAndroidNote' },
    { os: 'windows', titleKey: 'keepOpenWindowsTitle', stepsKey: 'keepOpenWindows', noteKey: 'keepOpenWindowsNote' },
    { os: 'mac', titleKey: 'keepOpenMacTitle', stepsKey: 'keepOpenMac', noteKey: 'keepOpenMacNote' },
  ];

  // Testi di stato aggiornati sul posto quando cambia lo schermo intero o lo schermo acceso
  const keepOpenStatus = { wake: null, full: null };

  function updateKeepOpenStatus() {
    if (keepOpenStatus.wake && keepOpenStatus.wake.isConnected) {
      let key = 'keepScreenOnOff';
      if (!kiosk.wakeLockSupported()) key = 'keepScreenOnUnsupported';
      else if (kiosk.keepScreenOn()) key = kiosk.isScreenKeptOn() ? 'keepScreenOnActive' : 'keepScreenOnWaiting';
      keepOpenStatus.wake.textContent = t(key);
      keepOpenStatus.wake.hidden = !t(key);
    }
    if (keepOpenStatus.full && keepOpenStatus.full.isConnected) {
      let key = 'autoFullscreenOff';
      if (!kiosk.fullscreenSupported()) key = 'autoFullscreenUnsupported';
      else if (kiosk.autoFullscreen()) key = kiosk.isFullscreen() ? 'autoFullscreenActive' : 'autoFullscreenWaiting';
      keepOpenStatus.full.textContent = t(key);
      keepOpenStatus.full.hidden = !t(key);
    }
  }
  kiosk.onChange(updateKeepOpenStatus);

  function statusLine() {
    const node = document.createElement('p');
    node.className = 'settings-help keep-open-status';
    node.setAttribute('aria-live', 'polite');
    return node;
  }

  function renderGuidedSection() {
    const wrap = section('secKeepOpenTitle', 'secKeepOpenHelp');

    // Opzioni che il browser consente
    const yesNo = [['off', 'valNo'], ['on', 'valYes']];
    const wakeRow = settingRow('optKeepScreenOn', 'optKeepScreenOnHelp', segmented(yesNo, kiosk.keepScreenOn() ? 'on' : 'off',
      async (value) => { try { await kiosk.setKeepScreenOn(value === 'on'); } finally { renderSettings(); } }));
    keepOpenStatus.wake = statusLine();
    const fullRow = settingRow('optAutoFullscreen', 'optAutoFullscreenHelp', segmented(yesNo, kiosk.autoFullscreen() ? 'on' : 'off',
      (value) => { kiosk.setAutoFullscreen(value === 'on'); renderSettings(); }));
    keepOpenStatus.full = statusLine();
    wrap.append(wakeRow, keepOpenStatus.wake, fullRow, keepOpenStatus.full);
    updateKeepOpenStatus();

    // Istruzioni dei sistemi: prima quello riconosciuto
    const sub = document.createElement('h4');
    sub.textContent = t('keepOpenStepsTitle');
    const intro = document.createElement('p');
    intro.className = 'settings-help';
    intro.textContent = t('keepOpenStepsHelp');
    wrap.append(sub, intro);

    const current = kiosk.osFamily();
    const ordered = KEEP_OPEN_SYSTEMS.filter((item) => item.os === current)
      .concat(KEEP_OPEN_SYSTEMS.filter((item) => item.os !== current));
    ordered.forEach((item) => {
      const box = document.createElement('details');
      box.className = 'os-guide';
      box.open = item.os === current;
      const summary = document.createElement('summary');
      const title = document.createElement('span');
      title.textContent = t(item.titleKey);
      summary.append(title);
      if (item.os === current) {
        const badge = document.createElement('span');
        badge.className = 'os-guide-badge';
        badge.textContent = t('keepOpenThisDevice');
        summary.append(badge);
      }
      const note = document.createElement('p');
      note.className = 'settings-help';
      note.textContent = t(item.noteKey);
      box.append(summary, list(t(item.stepsKey), true), note);
      wrap.append(box);
    });
  }

  function renderLanguageSection() {
    const wrap = section('secLanguageTitle', 'secLanguageHelp');
    const group = document.createElement('div');
    group.className = 'choice-group';
    i18n.supported.forEach((lang) => {
      const btn = button(i18n.languageNames[lang], async () => {
        i18n.setLanguage(lang);
        await storage.set('language', lang);
        app.refreshTexts();
        renderSettings();
      }, false);
      btn.setAttribute('aria-pressed', String(i18n.language === lang));
      btn.lang = lang;
      group.append(btn);
    });
    wrap.append(group);
  }

  function renderVoiceSection() {
    const wrap = section('secVoiceTitle', 'secVoiceHelp');
    const lang = i18n.language;
    const prefs = speech.getPrefs();
    const available = speech.voicesFor(i18n.speechLocale);

    const savePrefs = async (next) => {
      speech.setPrefs(next);
      await storage.set('voice', speech.getPrefs());
    };

    // Elenco delle voci della lingua corrente
    const field = document.createElement('label');
    field.className = 'settings-field';
    const caption = document.createElement('span');
    caption.textContent = t('voiceLabel');
    const select = document.createElement('select');
    const auto = new Option(t('voiceAuto'), '');
    select.append(auto);
    available.forEach((voice) => {
      const suffix = voice.localService ? '' : ` (${t('voiceOnline')})`;
      select.append(new Option(`${voice.name}${suffix}`, voice.name));
    });
    select.value = prefs.voiceByLang[lang] || '';
    select.addEventListener('change', () => {
      const voiceByLang = { ...speech.getPrefs().voiceByLang, [lang]: select.value || undefined };
      if (!select.value) delete voiceByLang[lang];
      savePrefs({ voiceByLang });
    });
    field.append(caption, select);
    wrap.append(field);
    if (!available.length) wrap.append(list(t('voiceNone')));

    // Cursori per velocità e tono
    [['rate', 'rateLabel', 0.5, 1.5], ['pitch', 'pitchLabel', 0.5, 1.5]].forEach(([key, labelKey, min, max]) => {
      const row = document.createElement('label');
      row.className = 'settings-field';
      const text = document.createElement('span');
      const value = document.createElement('output');
      text.textContent = t(labelKey);
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(min);
      range.max = String(max);
      range.step = '0.05';
      range.value = String(prefs[key]);
      value.textContent = `${Number(prefs[key]).toFixed(2)}×`;
      range.addEventListener('input', () => {
        value.textContent = `${Number(range.value).toFixed(2)}×`;
      });
      range.addEventListener('change', () => savePrefs({ [key]: Number(range.value) }));
      text.append(' ', value);
      row.append(text, range);
      wrap.append(row);
    });

    wrap.append(button(t('voiceTest'), () => speech.speak(t('voiceSample'), i18n.speechLocale), true));

    const guide = document.createElement('h4');
    guide.textContent = t('voiceGuideTitle');
    wrap.append(guide, list(t('voiceGuide')));
  }

  function renderSecuritySection() {
    const wrap = section('secSecurityTitle', 'secSecurityHelp');
    wrap.append(button(t('changePin'), changePinFlow, false));
  }

  // Ricerca online di nuovi simboli: attiva, solo con Wi-Fi, disattivata (nessun traffico dati)
  const ONLINE_SEARCH_VALUES = [['on', 'valOnlineOn'], ['wifi', 'valOnlineWifi'], ['off', 'valOnlineOff']];
  let onlineSearch = 'on';

  // Usata dalla ricerca simboli (Tappa 3): decide se si può usare la rete.
  // 'wifi': Chrome su Android dice il tipo di connessione; dove il browser non lo dice
  // (Safari, Firefox, PC) la ricerca chiederà conferma prima di usare internet.
  function onlineSearchStatus() {
    if (onlineSearch === 'off' || !navigator.onLine) return 'blocked';
    if (onlineSearch === 'wifi') {
      const type = navigator.connection && navigator.connection.type;
      if (type === 'wifi' || type === 'ethernet') return 'allowed';
      if (type) return 'blocked';
      return 'ask';
    }
    return 'allowed';
  }

  function renderOnlineSection() {
    const wrap = section('secOnlineTitle', 'secOnlineHelp');
    wrap.append(settingRow('optOnlineSearch', 'optOnlineSearchHelp', segmented(ONLINE_SEARCH_VALUES, onlineSearch, async (value) => {
      onlineSearch = value;
      await storage.set('onlineSearch', value);
      renderSettings();
    })));
  }

  // Fonti dei simboli: ognuna con stile e "quando sceglierla"; attivazione salvata in 'symbolSources'.
  // Mulberry e OpenMoji sono pacchetti: si scaricano una sola volta quando vengono attivati.
  // Twemoji è una fonte online leggera (piccolo indice delle parole + un'immagine alla volta).
  const SYMBOL_SOURCES = [
    { id: 'arasaac', nameKey: 'srcArasaac', descKey: 'srcArasaacDesc' },
    { id: 'mulberry', nameKey: 'srcMulberry', descKey: 'srcMulberryDesc', pack: true, approxMb: '3,8' },
    { id: 'openmoji', nameKey: 'srcOpenmoji', descKey: 'srcOpenmojiDesc', pack: true, approxMb: '3,1' },
    // Fonte online leggera: nessun pacchetto, si scarica solo il simbolo scelto
    { id: 'twemoji', nameKey: 'srcTwemoji', descKey: 'srcTwemojiDesc', online: true },
    { id: 'photo', nameKey: 'srcPhoto', descKey: 'srcPhotoDesc' },
    // Promemoria: fonte pronta ma non attivabile finché il repository di Mada non dichiara una licenza
    { id: 'tawasol', nameKey: 'srcTawasol', descKey: 'srcTawasolPending', pending: true },
  ];

  // Scaricamenti in corso: id → { done, total }; errori dell'ultimo tentativo: id → messaggio
  const packJobs = new Map();
  const packErrors = new Map();
  const packStatusNodes = new Map(); // id → elemento da aggiornare durante lo scaricamento

  function formatMb(bytes) {
    return (bytes / 1048576).toLocaleString(i18n.language, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  }

  // Lo scaricamento rispetta l'interruttore "Ricerca online"
  function packNetworkProblem() {
    if (!navigator.onLine) return t('packErrOffline');
    if (onlineSearch === 'off') return t('packErrOnlineOff');
    if (onlineSearchStatus() === 'blocked') return t('packErrWifi');
    return null;
  }

  async function startPackDownload(id) {
    if (packJobs.has(id)) return;
    const problem = packNetworkProblem();
    if (problem) {
      packErrors.set(id, problem);
      renderSettings();
      return;
    }
    // "Solo Wi-Fi" dove il browser non dice il tipo di rete: si chiede conferma
    // eslint-disable-next-line no-alert
    if (onlineSearchStatus() === 'ask' && !window.confirm(t('packAskWifi'))) {
      packErrors.set(id, t('packMissing'));
      renderSettings();
      return;
    }
    packErrors.delete(id);
    packJobs.set(id, { done: 0, total: 0 });
    renderSettings();
    try {
      await symbols.downloadPack(id, (done, total) => {
        packJobs.set(id, { done, total });
        const node = packStatusNodes.get(id);
        if (node && node.isConnected) updatePackProgress(node, done, total);
      });
    } catch (error) {
      packErrors.set(id, t('packErrDownload'));
    }
    packJobs.delete(id);
    if (!el.settings.hidden) renderSettings();
  }

  function updatePackProgress(node, done, total) {
    const text = node.querySelector('.pack-progress-text');
    const fill = node.querySelector('.pack-progress-fill');
    if (text) text.textContent = total ? t('packDownloading').replace('{done}', done).replace('{total}', total) : t('packPreparing');
    if (fill) fill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  }

  function packStatusLine(src, status) {
    const box = document.createElement('div');
    box.className = 'pack-status';
    const job = packJobs.get(src.id);
    if (job) {
      box.classList.add('is-loading');
      const text = document.createElement('p');
      text.className = 'pack-progress-text';
      const bar = document.createElement('div');
      bar.className = 'pack-progress';
      const fill = document.createElement('div');
      fill.className = 'pack-progress-fill';
      bar.append(fill);
      box.append(text, bar);
      updatePackProgress(box, job.done, job.total);
      packStatusNodes.set(src.id, box);
      return box;
    }
    const info = status[src.id];
    if (info) {
      box.classList.add('is-ready');
      const text = document.createElement('p');
      text.textContent = t('packReady').replace('{count}', info.count).replace('{mb}', formatMb(info.bytes || 0));
      box.append(text);
      return box;
    }
    const text = document.createElement('p');
    text.textContent = packErrors.get(src.id) || t('packMissing');
    if (packErrors.has(src.id)) box.classList.add('is-error');
    box.append(text, button(t('packDownload').replace('{mb}', src.approxMb), () => startPackDownload(src.id), true));
    return box;
  }

  async function renderSourcesSection() {
    const wrap = section('secSourcesTitle', 'secSourcesHelp');
    const [saved, status] = await Promise.all([symbols.activeSources(), symbols.packStatus()]);
    SYMBOL_SOURCES.forEach((src) => {
      if (src.pending) {
        const badge = document.createElement('span');
        badge.className = 'setting-pending';
        badge.textContent = t('srcPendingBadge');
        const row = settingRow(src.nameKey, src.descKey, badge);
        row.classList.add('is-pending');
        wrap.append(row);
        return;
      }
      const active = saved[src.id];
      const helpKey = src.pack && !status[src.id] ? null : src.descKey;
      const row = settingRow(src.nameKey, helpKey, segmented([['on', 'valOn2'], ['off', 'valOff2']], active ? 'on' : 'off',
        async (value) => {
          const next = { ...((await storage.get('symbolSources')) || {}), [src.id]: value === 'on' };
          await storage.set('symbolSources', next);
          if (src.pack && value === 'on' && !(await symbols.packStatus())[src.id]) {
            startPackDownload(src.id);
            return;
          }
          if (src.pack && value === 'off') {
            packErrors.delete(src.id);
            await symbols.removePack(src.id);
          }
          if (src.online && value === 'off') await symbols.removeSource(src.id);
          // Indice delle parole (pochi KB) preparato subito se la rete lo consente, altrimenti alla prima ricerca
          if (src.online && value === 'on' && !packNetworkProblem() && onlineSearchStatus() === 'allowed') {
            symbols.loadSourceIndex(src.id, true).catch(() => {});
          }
          renderSettings();
        }));
      if (src.online) {
        const help = row.querySelector('.setting-text small');
        if (help) help.textContent = `${t(src.descKey)} ${t('srcOnlineLight')}`;
      }
      if (src.pack && !status[src.id]) {
        // Descrizione con il peso del pacchetto, finché non è scaricato
        const help = document.createElement('small');
        help.textContent = `${t(src.descKey)} ${t('packSize').replace('{mb}', src.approxMb)}`;
        row.querySelector('.setting-text').append(help);
      }
      wrap.append(row);
      if (src.pack && active) wrap.append(packStatusLine(src, status));
    });
  }

  // Crediti automatici: si elencano le fonti presenti sul dispositivo (ARASAAC c'è sempre: set incluso)
  function creditText(href, label) {
    const span = document.createElement('span');
    span.className = 'credit-url';
    const address = href.replace(/^https:\/\//, '');
    // L'indirizzo della licenza resta leggibile anche senza link (requisito delle licenze CC)
    span.textContent = address.startsWith(label) ? address : `${label} (${address})`;
    return span;
  }

  function creditAnchor(href, label) {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = label;
    return link;
  }

  // links=false: indirizzi scritti ma non toccabili (crediti aperti senza PIN: il bambino non esce dall'app)
  async function buildCreditsList(links = true) {
    const creditLink = links ? creditAnchor : creditText;
    const [status, sources] = await Promise.all([symbols.packStatus(), symbols.activeSources()]);
    const used = new Set(data.allImages().map((image) => image.source));
    const ul = document.createElement('ul');
    ul.className = 'settings-list credits-list';
    const add = (...parts) => {
      const li = document.createElement('li');
      li.append(...parts);
      ul.append(li);
    };
    // Formula ufficiale di attribuzione indicata da ARASAAC («Come citare la licenza ARASAAC»)
    add(`${t('creditsArasaacAuthor')} `, creditLink('https://arasaac.org', 'ARASAAC (http://www.arasaac.org)'),
      `. ${t('creditsArasaacLicenseLabel')} `, creditLink('https://creativecommons.org/licenses/by-nc-sa/4.0/deed.it', 'CC (BY-NC-SA)'),
      `. ${t('creditsArasaacOwner')}`);
    if (used.has('mulberry') || status.mulberry) {
      add(`${t('creditsMulberry')} `, creditLink('https://mulberrysymbols.org', 'mulberrysymbols.org'), ` – ${t('creditsLicense')} `,
        creditLink('https://creativecommons.org/licenses/by-sa/4.0/deed.it', 'CC BY-SA 4.0'), `. ${t('creditsChanged')}`);
    }
    if (used.has('openmoji') || status.openmoji) {
      add(`${t('creditsOpenmoji')} `, creditLink('https://openmoji.org', 'openmoji.org'), ` – ${t('creditsLicense')} `,
        creditLink('https://creativecommons.org/licenses/by-sa/4.0/deed.it', 'CC BY-SA 4.0'), `. ${t('creditsChanged')}`);
    }
    if (used.has('twemoji') || sources.twemoji) {
      add(`${t('creditsTwemoji')} `, creditLink('https://github.com/jdecked/twemoji', 'github.com/jdecked/twemoji'),
        ` – ${t('creditsTwemojiLicense')} `, creditLink('https://creativecommons.org/licenses/by/4.0/deed.it', 'CC BY 4.0'),
        `. ${t('creditsChanged')}`);
    }
    // Immagini arrivate da schede di altre app (Open Board Format): autore e licenza dichiarati nel file
    const others = new Map();
    data.allImages().forEach((image) => {
      if (image.source !== 'other' || !(image.author || image.license)) return;
      const key = `${image.author || ''}|${image.license || ''}|${image.licenseUrl || ''}`;
      if (!others.has(key)) others.set(key, image);
    });
    if (others.size) {
      const inner = document.createElement('ul');
      [...others.values()].forEach((image) => {
        const li = document.createElement('li');
        li.append([image.author, image.license].filter(Boolean).join(' – '));
        if (image.licenseUrl) li.append(' ', creditLink(image.licenseUrl, image.licenseUrl.replace(/^https:\/\//, '')));
        inner.append(li);
      });
      add(t('creditsOther'), inner);
    }
    if (used.has('photo')) add(t('creditsPhotos'));
    add(t('creditsPrivacy'));
    add(`${t('creditsCode')} `, creditLink('https://github.com/MCdeplTESTenv/picspeak', 'github.com/MCdeplTESTenv/picspeak'));
    return ul;
  }

  async function renderCreditsSection() {
    const wrap = section('secCreditsTitle', 'secCreditsHelp');
    wrap.append(await buildCreditsList());
  }

  function renderGuideSection() {
    const wrap = section('secGuideTitle', 'secGuideHelp');
    wrap.append(button(t('guideOpen'), openGuide));
  }

  function renderComingSection() {
    const wrap = section('secComingTitle', 'secComingHelp');
    wrap.append(list(t('comingList')));
  }

  // Modalità colori: anteprima in miniatura + nome + descrizione
  function renderColorModeSection() {
    const wrap = section('secColorsTitle', 'secColorsHelp');
    const options = document.createElement('div');
    options.className = 'mode-options';
    const current = document.documentElement.dataset.colorMode || DEFAULT_COLOR_MODE;
    COLOR_MODES.forEach((mode) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'mode-option';
      option.setAttribute('aria-pressed', String(current === mode.id));
      const preview = document.createElement('span');
      preview.className = `mode-preview is-${mode.id}`;
      ['pronoun', 'verb', 'noun', 'adjective', 'social', 'folder'].forEach((type) => {
        const swatch = document.createElement('span');
        swatch.className = `type-${type}`;
        preview.append(swatch);
      });
      const name = document.createElement('strong');
      name.textContent = t(mode.nameKey);
      const desc = document.createElement('small');
      desc.textContent = t(mode.descKey);
      option.append(preview, name, desc);
      option.addEventListener('click', async () => {
        applyColorMode(mode.id);
        await storage.set('colorMode', mode.id);
        renderSettings();
      });
      options.append(option);
    });
    wrap.append(options);
  }

  // Personalizzazioni grafiche: ogni opzione diventa un attributo data-* su <html> (vedi css/style.css).
  // Il primo valore di ogni elenco è quello predefinito.
  const APPEARANCE_GROUPS = [
    { titleKey: 'grpSymbols', options: [
      { key: 'symbolColor', labelKey: 'optSymbolColor', helpKey: 'optSymbolColorHelp',
        values: [['color', 'valColor'], ['gray', 'valGray'], ['contrast', 'valContrast']] },
      { key: 'cellContent', labelKey: 'optCellContent', helpKey: 'optCellContentHelp',
        values: [['both', 'valBoth'], ['image', 'valImageOnly'], ['text', 'valTextOnly']] },
      { key: 'labelPosition', labelKey: 'optLabelPosition',
        values: [['below', 'valBelow'], ['above', 'valAbove']] },
      { key: 'imageFrame', labelKey: 'optImageFrame', helpKey: 'optImageFrameHelp',
        values: [['none', 'valNo'], ['frame', 'valYes']] },
    ] },
    { titleKey: 'grpText', options: [
      { key: 'labelCase', labelKey: 'secCaseTitle', helpKey: 'secCaseHelp',
        values: [['upper', 'caseUpper'], ['lower', 'caseLower'], ['as-is', 'caseAsIs']] },
      { key: 'textSize', labelKey: 'optTextSize',
        values: [['m', 'valMedium'], ['s', 'valSmall'], ['l', 'valLarge'], ['xl', 'valXLarge']] },
      { key: 'font', labelKey: 'optFont', helpKey: 'optFontHelp',
        values: [['standard', 'valStandard'], ['readable', 'valReadable'], ['rounded', 'valRounded']] },
    ] },
    { titleKey: 'grpCells', options: [
      { key: 'cellGap', labelKey: 'optCellGap',
        values: [['normal', 'valNormal'], ['tight', 'valTight'], ['wide', 'valWide']] },
      { key: 'border', labelKey: 'optBorder',
        values: [['normal', 'valNormal'], ['thin', 'valThin'], ['thick', 'valThick']] },
      { key: 'corners', labelKey: 'optCorners',
        values: [['rounded', 'valRoundedCorners'], ['square', 'valSquare']] },
      { key: 'cellOpacity', labelKey: 'optCellOpacity', helpKey: 'optCellOpacityHelp',
        values: [['solid', 'valSolid'], ['translucent', 'valTranslucent']] },
    ] },
    { titleKey: 'grpLayout', options: [
      { key: 'sentencePosition', labelKey: 'optSentencePosition',
        values: [['top', 'valTop'], ['bottom', 'valBottom']] },
      { key: 'sentenceSize', labelKey: 'optSentenceSize', helpKey: 'optSentenceSizeHelp',
        values: [['normal', 'valNormal'], ['l', 'valLarge'], ['xl', 'valXLarge']] },
      { key: 'controlsSide', labelKey: 'optControlsSide', helpKey: 'optControlsSideHelp',
        values: [['right', 'valRight'], ['left', 'valLeft']] },
      { key: 'pageTitle', labelKey: 'optPageTitle',
        values: [['shown', 'valShown'], ['hidden', 'valHidden']] },
      { key: 'touchFeedback', labelKey: 'optTouchFeedback', helpKey: 'optTouchFeedbackHelp',
        values: [['on', 'valOn'], ['strong', 'valStrong'], ['off', 'valOff']] },
      { key: 'shakeHome', labelKey: 'optShakeHome', helpKey: 'optShakeHomeHelp',
        values: [['off', 'valNo'], ['on', 'valYes']] },
      { key: 'swipeClear', labelKey: 'optSwipeClear', helpKey: 'optSwipeClearHelp',
        values: [['off', 'valNo'], ['on', 'valYes']] },
    ] },
  ];
  const APPEARANCE_OPTIONS = APPEARANCE_GROUPS.flatMap((group) => group.options);
  let appearance = {};

  function applyAppearance() {
    APPEARANCE_OPTIONS.forEach((opt) => {
      const value = appearance[opt.key] || opt.values[0][0];
      document.documentElement.dataset[opt.key] = value;
    });
    applyImageZoom();
    if (appearance.tileZoom) document.documentElement.dataset.tileZoom = String(appearance.tileZoom);
    else delete document.documentElement.dataset.tileZoom;
    app.layoutGrid();
  }

  // Stili pronti: punto di partenza da cui poi personalizzare ogni dettaglio
  const PRESETS = [
    { id: 'card', nameKey: 'presetCard', descKey: 'presetCardDesc', colorMode: 'card', background: '',
      appearance: {} },
    { id: 'card-big', nameKey: 'presetCardBig', descKey: 'presetCardBigDesc', colorMode: 'card', background: '',
      appearance: { textSize: 'l', font: 'readable', border: 'thick', touchFeedback: 'strong' } },
    { id: 'sheet', nameKey: 'presetSheet', descKey: 'presetSheetDesc', colorMode: 'sheet', background: '',
      appearance: { labelCase: 'as-is' } },
    { id: 'full', nameKey: 'presetFull', descKey: 'presetFullDesc', colorMode: 'full', background: '',
      appearance: { imageFrame: 'frame' } },
    { id: 'clean', nameKey: 'presetClean', descKey: 'presetCleanDesc', colorMode: 'border', background: '#ffffff',
      appearance: { labelCase: 'lower', border: 'thin' } },
    { id: 'minimal', nameKey: 'presetMinimal', descKey: 'presetMinimalDesc', colorMode: 'none', background: '#eceef2',
      appearance: { labelCase: 'as-is', corners: 'square', border: 'thin', cellGap: 'tight' } },
    { id: 'contrast', nameKey: 'presetContrast', descKey: 'presetContrastDesc', colorMode: 'card', background: '#ffffff',
      appearance: { symbolColor: 'contrast', border: 'thick', textSize: 'l', touchFeedback: 'strong', corners: 'square' } },
    { id: 'bw', nameKey: 'presetBw', descKey: 'presetBwDesc', colorMode: 'none', background: '#ffffff',
      appearance: { symbolColor: 'gray', border: 'thick' } },
    { id: 'night', nameKey: 'presetNight', descKey: 'presetNightDesc', colorMode: 'card', background: '#1f2430',
      appearance: {} },
    { id: 'words', nameKey: 'presetWords', descKey: 'presetWordsDesc', colorMode: 'border', background: '#ffffff',
      appearance: { cellContent: 'text', labelCase: 'as-is', font: 'readable' } },
  ];

  function currentBackground() {
    return (document.documentElement.style.getPropertyValue('--page-bg') || '').trim().toLowerCase();
  }

  // Scelte che gli stili pronti non cambiano (dipendono dalla persona, non dallo stile)
  const KEPT_BY_PRESETS = ['sentenceSize'];

  // Uno stile è "attivo" se tutte le scelte coincidono con le sue
  function presetMatches(preset) {
    if ((document.documentElement.dataset.colorMode || DEFAULT_COLOR_MODE) !== preset.colorMode) return false;
    if (currentBackground() !== (preset.background || '').toLowerCase()) return false;
    if ((appearance.imageZoom || 100) !== (preset.appearance.imageZoom || 100)) return false;
    return APPEARANCE_OPTIONS.every((opt) => {
      if (KEPT_BY_PRESETS.includes(opt.key)) return true;
      const def = opt.values[0][0];
      return (appearance[opt.key] || def) === (preset.appearance[opt.key] || def);
    });
  }

  async function applyPreset(preset) {
    applyColorMode(preset.colorMode);
    applyPageBackground(preset.background);
    // Lo zoom delle tessere dipende dallo schermo, non dallo stile: si conserva.
    // Si conservano anche le scelte legate alla vista della persona (altezza della frase).
    const kept = {};
    if (appearance.tileZoom) kept.tileZoom = appearance.tileZoom;
    KEPT_BY_PRESETS.forEach((key) => { if (appearance[key]) kept[key] = appearance[key]; });
    appearance = { ...preset.appearance, ...kept };
    applyAppearance();
    await storage.set('colorMode', preset.colorMode);
    await storage.set('pageBackground', preset.background);
    await storage.set('appearance', appearance);
    await storage.set('preset', preset.id);
  }

  function renderPresetSection() {
    const wrap = section('secPresetsTitle', 'secPresetsHelp');
    const grid = document.createElement('div');
    grid.className = 'preset-grid';
    PRESETS.forEach((preset) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'preset-card';
      card.setAttribute('aria-pressed', String(presetMatches(preset)));
      const preview = document.createElement('span');
      const look = preset.appearance;
      preview.className = [
        'preset-preview', `is-${preset.colorMode}`,
        look.symbolColor === 'gray' ? 'is-gray' : '',
        look.corners === 'square' ? 'is-square' : '',
        look.border === 'thick' ? 'is-thick' : '',
      ].join(' ');
      preview.style.background = preset.background
        || (preset.colorMode === 'sheet' ? 'linear-gradient(180deg, #d5f4f0, #4fc6ba)' : '#ffffff');
      ['pronoun', 'verb', 'noun', 'adjective', 'social', 'folder'].forEach((type) => {
        const swatch = document.createElement('span');
        swatch.className = `type-${type}`;
        preview.append(swatch);
      });
      const name = document.createElement('strong');
      name.textContent = t(preset.nameKey);
      const desc = document.createElement('small');
      desc.textContent = t(preset.descKey);
      card.append(preview, name, desc);
      card.addEventListener('click', async () => {
        await applyPreset(preset);
        renderSettings();
      });
      grid.append(card);
    });
    wrap.append(grid);
    if (!PRESETS.some(presetMatches)) {
      const note = document.createElement('p');
      note.className = 'preset-custom-note';
      note.textContent = t('presetCustomNote');
      wrap.append(note);
    }
  }

  function settingRow(labelKey, helpKey, control) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const text = document.createElement('div');
    text.className = 'setting-text';
    const label = document.createElement('strong');
    label.textContent = t(labelKey);
    text.append(label);
    if (helpKey) {
      const help = document.createElement('small');
      help.textContent = t(helpKey);
      text.append(help);
    }
    row.append(text, control);
    return row;
  }

  function segmented(values, current, onChoose) {
    const group = document.createElement('div');
    group.className = 'segmented';
    group.setAttribute('role', 'group');
    values.forEach(([value, nameKey]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = t(nameKey);
      btn.setAttribute('aria-pressed', String(current === value));
      btn.addEventListener('click', () => onChoose(value));
      group.append(btn);
    });
    return group;
  }

  // Zoom delle immagini nelle tessere: − / + a passi del 10%, da 60% a 160%, "100%" per ripristinare
  const IMAGE_ZOOM = { min: 60, max: 160, step: 10, def: 100 };

  // Lo zoom ora agisce sull'intera tessera (numero di colonne); l'immagine resta al 100%
  function applyImageZoom() {
    document.documentElement.style.setProperty('--image-zoom', '1');
  }

  function imageZoomRow() {
    const zoom = appearance.imageZoom || IMAGE_ZOOM.def;
    const group = document.createElement('div');
    group.className = 'stepper';
    const set = async (value) => {
      const next = Math.min(IMAGE_ZOOM.max, Math.max(IMAGE_ZOOM.min, value));
      appearance = { ...appearance, imageZoom: next };
      applyAppearance();
      await storage.set('appearance', appearance);
      renderSettings();
    };
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'stepper-btn';
    minus.textContent = '−';
    minus.setAttribute('aria-label', t('zoomLess'));
    minus.disabled = zoom <= IMAGE_ZOOM.min;
    minus.addEventListener('click', () => set(zoom - IMAGE_ZOOM.step));
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'stepper-value';
    reset.textContent = `${zoom}%`;
    reset.title = t('zoomReset');
    reset.setAttribute('aria-label', `${zoom}% – ${t('zoomReset')}`);
    reset.addEventListener('click', () => set(IMAGE_ZOOM.def));
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'stepper-btn';
    plus.textContent = '+';
    plus.setAttribute('aria-label', t('zoomMore'));
    plus.disabled = zoom >= IMAGE_ZOOM.max;
    plus.addEventListener('click', () => set(zoom + IMAGE_ZOOM.step));
    group.append(minus, reset, plus);
    return settingRow('optImageZoom', 'optImageZoomHelp', group);
  }

  // ---------- Zoom delle tessere ----------
  // − = tessere più piccole, + = più grandi, a passi del 10% rispetto alla misura automatica
  // (100%); tocco sulla percentuale = di nuovo automatico. Mentre si regola, la pagina passa in
  // anteprima: identica a quella che vede il bambino (vedi app.setPreview).
  const zoomEl = {
    out: document.getElementById('btn-zoom-out'),
    reset: document.getElementById('btn-zoom-reset'),
    in: document.getElementById('btn-zoom-in'),
  };

  function updateZoomLabel() {
    const zoom = app.currentZoom();
    const { min, max } = app.zoomRange();
    zoomEl.reset.textContent = `${zoom}%`;
    zoomEl.out.disabled = zoom <= min;
    zoomEl.in.disabled = zoom >= max;
  }

  async function setTileZoom(percent) {
    const { min, max } = app.zoomRange();
    const zoom = Math.min(max, Math.max(min, Math.round(percent || 100)));
    if (zoom === 100) {
      const { tileZoom, ...rest } = appearance;
      appearance = rest;
    } else {
      appearance = { ...appearance, tileZoom: zoom };
    }
    app.setPreview(true);
    applyAppearance();
    updateZoomLabel();
    await storage.set('appearance', appearance);
  }

  // Passo successivo: dal valore mostrato (già entro i limiti dello schermo) di 10 in 10
  function stepTileZoom(direction) {
    const step = app.zoomRange().step;
    const current = app.currentZoom();
    const next = direction > 0
      ? Math.floor(current / step) * step + step
      : Math.ceil(current / step) * step - step;
    setTileZoom(next);
  }

  // Fine dell'anteprima: al primo tocco fuori dai pulsanti dello zoom si torna alla modifica.
  // Quel tocco non apre nulla (es. la modifica di una tessera), serve solo a uscire dall'anteprima.
  function bindZoomPreview() {
    // Il clic che segue quel tocco va ignorato; se il browser non lo genera (l'elemento toccato è
    // stato ridisegnato) l'attesa scade da sola, così il tocco successivo funziona normalmente
    let swallowUntil = 0;
    document.addEventListener('pointerdown', (event) => {
      if (!app.preview || event.target.closest('.zoom-control')) return;
      const passThrough = Boolean(event.target.closest('.adult-btn'));
      swallowUntil = passThrough ? 0 : Date.now() + 800;
      app.setPreview(false);
      // Il tocco non deve avviare altro (es. lo spostamento della tessera tenuta premuta)
      if (!passThrough) event.stopPropagation();
    }, true);
    document.addEventListener('click', (event) => {
      if (Date.now() > swallowUntil) return;
      swallowUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  function tileZoomRow() {
    const zoom = appearance.tileZoom;
    const control = document.createElement('div');
    control.className = 'choice-group';
    const status = document.createElement('span');
    status.className = 'setting-status';
    status.textContent = zoom ? t('tileZoomFixed').replace('{n}', zoom) : t('tileZoomAuto');
    control.append(status);
    if (zoom) {
      control.append(button(t('tileZoomBackAuto'), async () => {
        await setTileZoom(100);
        app.setPreview(false);
        renderSettings();
      }, false));
    }
    return settingRow('optTileZoom', 'optTileZoomHelp', control);
  }

  function renderAppearanceGroups() {
    APPEARANCE_GROUPS.forEach((group) => {
      const wrap = section(group.titleKey, null, { collapsible: true });
      if (group.titleKey === 'grpCells') wrap.append(tileZoomRow());
      group.options.forEach((opt) => {
        const current = appearance[opt.key] || opt.values[0][0];
        wrap.append(settingRow(opt.labelKey, opt.helpKey, segmented(opt.values, current, async (value) => {
          // iPad/iPhone chiedono il permesso per i sensori di movimento: va chiesto subito, dentro il tocco
          if (opt.key === 'shakeHome' && value === 'on' && window.DeviceMotionEvent
            && typeof DeviceMotionEvent.requestPermission === 'function') {
            try {
              if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return;
            } catch (error) {
              return;
            }
          }
          appearance = { ...appearance, [opt.key]: value };
          applyAppearance();
          await storage.set('appearance', appearance);
          renderSettings();
        })));
      });
    });
  }

  // Colore di sfondo della pagina: colori pronti + colore a piacere
  function renderBackgroundSection() {
    const wrap = section('secBackgroundTitle', 'secBackgroundHelp');
    const options = document.createElement('div');
    options.className = 'bg-options';
    // '' = sfondo automatico, quello previsto dalla modalità colori scelta
    const current = (document.documentElement.style.getPropertyValue('--page-bg') || '').trim().toLowerCase();

    const choose = async (color) => {
      applyPageBackground(color);
      await storage.set('pageBackground', color);
      renderSettings();
    };

    PAGE_BACKGROUNDS.forEach((bg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bg-swatch';
      btn.setAttribute('aria-pressed', String(current === bg.color));
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      if (bg.color) {
        swatch.style.background = bg.color;
      } else {
        swatch.classList.add('swatch-auto');
        swatch.textContent = 'A';
      }
      const name = document.createElement('span');
      name.textContent = t(bg.nameKey);
      btn.append(swatch, name);
      btn.addEventListener('click', () => choose(bg.color));
      options.append(btn);
    });

    // Colore a piacere
    const custom = document.createElement('label');
    custom.className = 'bg-swatch';
    const isCustom = !PAGE_BACKGROUNDS.some((bg) => bg.color === current);
    custom.setAttribute('aria-pressed', String(isCustom));
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = current || '#ffffff';
    picker.addEventListener('change', () => choose(picker.value.toLowerCase()));
    const name = document.createElement('span');
    name.textContent = t('bgCustom');
    custom.append(picker, name);
    options.append(custom);

    wrap.append(options);
  }

  // Categorie delle impostazioni: icona, titolo, sezioni contenute
  const CATEGORIES = [
    { id: 'general', icon: '<path d="M19.4 10.1 L21.9 10.3 L21.9 13.7 L19.4 13.9 L18.5 15.9 L20.2 17.8 L17.8 20.2 L15.9 18.5 L13.9 19.4 L13.7 21.9 L10.3 21.9 L10.1 19.4 L8.1 18.5 L6.2 20.2 L3.8 17.8 L5.5 15.9 L4.6 13.9 L2.1 13.7 L2.1 10.3 L4.6 10.1 L5.5 8.1 L3.8 6.2 L6.2 3.8 L8.1 5.5 L10.1 4.6 L10.3 2.1 L13.7 2.1 L13.9 4.6 L15.9 5.5 L17.8 3.8 L20.2 6.2 L18.5 8.1Z"/><circle cx="12" cy="12" r="3"/>', titleKey: 'catGeneral', introKey: 'catGeneralIntro',
      render: [renderLanguageSection, renderOnlineSection, renderInstallSection, renderGuideSection, renderCreditsSection] },
    { id: 'appearance', icon: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>', titleKey: 'catAppearance', introKey: 'catAppearanceIntro',
      render: [renderPresetSection, renderColorModeSection, renderBackgroundSection, renderAppearanceGroups] },
    { id: 'sources', icon: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="m20.5 15-4.5-4.5-9 9"/>', titleKey: 'catSources', introKey: 'catSourcesIntro',
      render: [renderSourcesSection] },
    { id: 'voice', icon: '<path d="M11 5 6.5 9H3.5v6h3L11 19z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6"/><path d="M18.5 6a8.5 8.5 0 0 1 0 12"/>', titleKey: 'catVoice', introKey: 'catVoiceIntro',
      render: [renderVoiceSection] },
    { id: 'security', icon: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>', titleKey: 'catSecurity', introKey: 'catSecurityIntro',
      render: [renderSecuritySection, renderGuidedSection] },
    { id: 'coming', icon: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/>', titleKey: 'catComing', introKey: 'catComingIntro',
      render: [renderComingSection] },
  ];

  function renderSettings() {
    const layout = document.createElement('div');
    layout.className = 'settings-layout';
    layout.classList.toggle('show-panel', showPanelOnPhone);

    // Menu delle categorie
    const nav = document.createElement('ul');
    nav.className = 'settings-nav';
    CATEGORIES.forEach((cat) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-nav-btn';
      btn.setAttribute('aria-current', String(cat.id === currentCategory));
      const icon = document.createElement('span');
      icon.className = 'nav-icon';
      icon.setAttribute('aria-hidden', 'true');
      // Unico uso di innerHTML: solo icone costanti scritte nel codice, mai dati inseriti dall'utente
      icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${cat.icon}</svg>`;
      const label = document.createElement('span');
      label.textContent = t(cat.titleKey);
      const chevron = document.createElement('span');
      chevron.className = 'nav-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';
      btn.append(icon, label, chevron);
      btn.addEventListener('click', () => {
        currentCategory = cat.id;
        showPanelOnPhone = true;
        renderSettings();
        el.settings.scrollTop = 0;
      });
      li.append(btn);
      nav.append(li);
    });

    // Contenuto della categoria scelta
    const category = CATEGORIES.find((cat) => cat.id === currentCategory) || CATEGORIES[0];
    const panel = document.createElement('div');
    panel.className = 'settings-panel';
    const title = document.createElement('h3');
    title.className = 'settings-panel-title';
    title.textContent = t(category.titleKey);
    const intro = document.createElement('p');
    intro.className = 'settings-panel-intro';
    intro.textContent = t(category.introKey);
    panel.append(title, intro);
    currentPanel = panel;
    category.render.forEach((fn) => fn());

    layout.append(nav, panel);
    el.settingsBody.replaceChildren(layout);
  }


  // categoryId (facoltativo): apre direttamente quella categoria (es. 'prediction' dal pulsante del contesto)
  function openSettings(categoryId) {
    showPanelOnPhone = false;
    if (typeof categoryId === 'string' && CATEGORIES.some((cat) => cat.id === categoryId)) {
      currentCategory = categoryId;
      showPanelOnPhone = true;
    }
    renderSettings();
    el.settings.hidden = false;
    document.body.classList.add('settings-open');
    el.settings.scrollTop = 0;
    el.settingsBack.focus();
  }

  function closeSettings() {
    el.settings.hidden = true;
    document.body.classList.remove('settings-open');
    // Chiusura con un tocco: se richiesto, si torna subito a schermo intero
    if (kiosk.autoFullscreen()) kiosk.enterFullscreen();
  }

  // ---------- Avvio ----------

  function bindEvents() {
    bindLock();
    el.openSettings.addEventListener('click', openSettings);
    el.exitAdult.addEventListener('click', exitAdult);
    // "Indietro": su telefono, dal contenuto di una categoria torna all'elenco; altrimenti chiude
    zoomEl.in.addEventListener('click', () => stepTileZoom(1));
    zoomEl.out.addEventListener('click', () => stepTileZoom(-1));
    zoomEl.reset.addEventListener('click', () => setTileZoom(100));
    bindZoomPreview();
    window.addEventListener('resize', () => { if (app.mode === 'adult') setTimeout(updateZoomLabel, 150); });
    el.settingsBack.addEventListener('click', () => {
      if (showPanelOnPhone && window.matchMedia('(max-width: 720px)').matches) {
        showPanelOnPhone = false;
        renderSettings();
        return;
      }
      closeSettings();
    });
    // Ogni tocco o tasto in modalità adulto rimanda l'uscita automatica
    ['pointerdown', 'keydown'].forEach((name) => {
      document.addEventListener(name, resetInactivity, true);
    });
    install.onChange(() => {
      if (!el.settings.hidden) renderSettings();
    });
    // Le voci possono arrivare dopo l'apertura delle impostazioni (Chrome)
    speech.onVoicesChanged(() => {
      if (!el.settings.hidden && !el.settings.contains(document.activeElement)) renderSettings();
    });
  }

  // Lingua salvata dall'adulto (quella nell'indirizzo, se presente, ha la precedenza)
  async function restoreLanguage() {
    if (i18n.urlLanguage) return;
    const saved = await storage.get('language');
    if (saved && saved !== i18n.language && i18n.supported.includes(saved)) {
      i18n.setLanguage(saved);
      app.refreshTexts();
    }
  }

  // Preferenze di voce salvate dall'adulto
  async function restoreVoice() {
    speech.setPrefs(await storage.get('voice'));
  }

  // Modalità colori salvata (predefinita: colore pieno)
  async function restoreColorMode() {
    const saved = await storage.get('colorMode');
    if (saved && COLOR_MODES.some((mode) => mode.id === saved)) applyColorMode(saved);
  }

  // Colore di sfondo salvato (predefinito: vaniglia)
  async function restorePageBackground() {
    const saved = await storage.get('pageBackground');
    if (saved) applyPageBackground(saved);
  }

  // Personalizzazioni grafiche salvate (con recupero della vecchia impostazione "labelCase")
  async function restoreAppearance() {
    appearance = (await storage.get('appearance')) || {};
    delete appearance.imageZoom; // vecchia impostazione (zoom solo immagini), sostituita dallo zoom delle tessere
    // Vecchio zoom a numero di colonne: non si traduce in una misura, si torna alla misura automatica
    if ('columns' in appearance) {
      delete appearance.columns;
      await storage.set('appearance', appearance);
    }
    // Zoom delle tessere: solo numeri interi plausibili (dati letti dal dispositivo o da un backup)
    if (!Number.isInteger(appearance.tileZoom) || appearance.tileZoom < 30 || appearance.tileZoom > 300) {
      delete appearance.tileZoom;
    }
    if (!appearance.labelCase) {
      const legacy = await storage.get('labelCase');
      if (legacy) appearance.labelCase = legacy;
    }
    applyAppearance();
  }

  // Sezioni richiudibili aperte dall'adulto (solo nomi di testo plausibili).
  // La vecchia preferenza «Mostra impostazioni avanzate» non esiste più e si toglie.
  async function restoreOpenSections() {
    const saved = await storage.get('openSections');
    if (Array.isArray(saved)) {
      openSections = new Set(saved.filter((key) => typeof key === 'string' && key.length <= 60).slice(0, 100));
    }
    if ((await storage.get('showAdvanced')) !== undefined) await storage.remove('showAdvanced');
  }

  async function restoreOnlineSearch() {
    const saved = await storage.get('onlineSearch');
    if (ONLINE_SEARCH_VALUES.some(([value]) => value === saved)) onlineSearch = saved;
  }

  window.PicSpeak.network = { onlineSearchStatus, onlineSearchMode: () => onlineSearch };

  // Strumenti condivisi con le altre pagine delle impostazioni (schede pronte, previsione)
  window.PicSpeak.settingsUi = {
    section: (titleKey, helpKey, options) => section(titleKey, helpKey, options),
    settingRow,
    segmented,
    button,
    list,
    runDialog,
    runPanelDialog,
    render: () => { if (!el.settings.hidden) renderSettings(); },
    closeSettings,
    openSettings,
    // Nuova categoria nel menu delle impostazioni, dopo quella indicata
    addCategory(category, afterId) {
      const index = CATEGORIES.findIndex((cat) => cat.id === afterId);
      CATEGORIES.splice(index < 0 ? CATEGORIES.length : index + 1, 0, category);
    },
  };

  bindEvents();
  restoreOpenSections();
  restoreOnlineSearch();
  restorePageBackground();
  restoreAppearance();
  restoreLanguage();
  restoreVoice();
  restoreColorMode();
})();
