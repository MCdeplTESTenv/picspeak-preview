/*
 * «Come iniziare»: tutorial breve per l'adulto che prepara PicSpeak (genitore, insegnante, terapista).
 * Compare da solo una volta sola, al primo avvio: quando sul dispositivo non c'è ancora un PIN, chi ha il dispositivo
 * in mano è per forza l'adulto che lo sta preparando. Saltato o finito, non ricompare da solo; si riapre dal menu dei
 * tre puntini (voce «Come iniziare») e da Impostazioni › Generale › Guida.
 * Nessun dato dell'utente nei testi: solo frasi costanti di i18n e icone costanti scritte qui.
 */
(function () {
  'use strict';

  const { i18n, storage, security, install } = window.PicSpeak;
  const t = i18n.t;

  // Chiave del dispositivo (non del profilo, non nel backup): 1 = tutorial già visto, saltato o finito
  const SEEN_KEY = 'tutorialSeen';
  // Attesa dopo il caricamento, perché la finestra compaia sopra le schede già disegnate
  const START_DELAY_MS = 500;

  // Icone a linea dei passi (costanti, mai dati dell'utente)
  const ICONS = {
    sentence: '<path d="M4 5h16v11H9.5L5 20v-4H4z"/><path d="M8 9.5h8M8 12.5h5"/>',
    pin: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
    privacy: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    boards: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="m14 20 1-3 4.5-4.5 2 2L17 19z"/>',
    settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    install: '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 7.5v6.5"/><path d="m9 11 3 3 3-3"/><path d="M10.5 18.5h3"/>',
    backup: '<path d="M12 3v11"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M4 16v4h16v-4"/>',
  };

  // Il passo «Installare come app» si toglie se PicSpeak è già aperto come app
  function steps() {
    const list = t('tutorialSteps');
    if (!Array.isArray(list)) return [];
    const installed = Boolean(install && install.isStandalone());
    return installed ? list.filter((step) => step.id !== 'install') : list;
  }

  // Passo «Installare come app»: righe del passo, poi le istruzioni del dispositivo in uso
  // (o il pulsante del browser, se c'è), come in Impostazioni › Generale
  function installBlock(rerender) {
    const nodes = [];
    if (!install) return nodes;
    if (!location.protocol.startsWith('http')) {
      nodes.push(el('p', 'tutorial-text', t('installFromFile')));
      return nodes;
    }
    // Solo su iPad e iPhone l'app installata non vede i dati di Safari: lo si dice prima dei passi
    if (install.platform() === 'ios') nodes.push(el('p', 'tutorial-text', t('tutorialInstallIos')));
    if (install.canPrompt()) {
      const btn = stepButton(t('installButton'), async () => {
        await install.prompt().catch(() => false);
        rerender();
      }, true);
      btn.classList.add('tutorial-install-btn');
      nodes.push(btn);
    }
    if (install.showSteps()) {
      const lines = t(install.stepsKey());
      if (Array.isArray(lines) && lines.length) {
        const ol = el('ol', 'tutorial-steps');
        ol.append(...lines.map((line) => el('li', '', line)));
        nodes.push(ol);
      }
    }
    nodes.push(el('p', 'tutorial-again', t('tutorialInstallLater')));
    return nodes;
  }

  async function markSeen() {
    await storage.set(SEEN_KEY, 1);
  }

  // Si propone da solo solo se: mai visto prima su questo dispositivo e nessuna protezione scelta oltre alla
  // pressione lunga (con un PIN o un'operazione davanti potrebbe esserci il bambino)
  async function shouldAutoStart() {
    if (await storage.get(SEEN_KEY)) return false;
    if (security && (await security.getLock()).mode !== 'hold') return false;
    return true;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stepButton(label, onClick, primary) {
    const btn = el('button', primary ? 'dlg-btn dlg-btn-primary' : 'dlg-btn', label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }

  let running = false;
  // Durata della pressione sui tre puntini, scritta nel passo del menu
  let holdSeconds = 3;
  // Ascolto del pulsante «Installa» del browser, tolto quando la finestra si chiude
  let stopListening = null;

  // Si apre solo se nessun'altra finestra è aperta (menu, PIN…): non ne prende mai il posto
  function busy() {
    const dialog = document.getElementById('pin-dialog');
    return Boolean(dialog && dialog.open);
  }

  // auto: true = avvio da solo al primo avvio (mai nella modalità adulto)
  async function open({ auto = false } = {}) {
    const adult = window.PicSpeak.settingsUi;
    if (running || !adult || !adult.runPanelDialog) return;
    const list = steps();
    if (!list.length) return;
    running = true;
    let result = null;
    try {
      // Sull'ultimo passo, se c'è solo la pressione lunga, si può scegliere subito una protezione
      const lock = security ? await security.getLock() : { mode: 'hold', holdSeconds: 3 };
      const offerPin = lock.mode === 'hold';
      holdSeconds = lock.holdSeconds;
      // Controllo ripetuto dopo l'attesa: nel frattempo l'adulto può aver aperto il menu
      const app = window.PicSpeak.app;
      if (busy() || (auto && app && app.mode === 'adult')) return;
      result = await runSteps(adult, list, offerPin);
      await markSeen().catch(() => {});
    } catch (error) {
      // Un errore dell'archivio non deve bloccare il tutorial né la comunicazione
    } finally {
      if (stopListening) stopListening();
      stopListening = null;
      running = false;
    }
    if (result === 'pin' && adult.openSecurity) adult.openSecurity();
  }

  function runSteps(adult, list, offerPin) {
    let index = 0;
    return adult.runPanelDialog({
      title: t('tutorialTitle'),
      className: 'tutorial-dialog',
      actions: false,
      build: (close) => {
        const box = el('div', 'tutorial');
        const count = el('p', 'tutorial-count');
        count.setAttribute('aria-live', 'polite');
        const icon = el('div', 'tutorial-icon');
        icon.setAttribute('aria-hidden', 'true');
        const heading = el('h3', 'tutorial-step-title');
        const body = el('div', 'tutorial-body');
        const dots = el('div', 'tutorial-dots');
        dots.setAttribute('aria-hidden', 'true');
        const actions = el('div', 'dialog-actions tutorial-actions');
        box.append(count, icon, heading, body, dots, actions);

        function show() {
          const step = list[index];
          const last = index === list.length - 1;
          count.textContent = t('tutorialStepOf').replace('{n}', index + 1).replace('{total}', list.length);
          // innerHTML solo con icone costanti scritte qui sopra
          icon.innerHTML = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[step.id] || ICONS.sentence}</svg>`;
          heading.textContent = step.title;
          body.replaceChildren(...step.text.map((line) => el('p', 'tutorial-text', line.replace('{n}', holdSeconds))));
          if (step.id === 'install') body.append(...installBlock(show));
          if (last) body.append(el('p', 'tutorial-again', t('tutorialAgain')));
          dots.replaceChildren(...list.map((_, i) => el('span', i === index ? 'tutorial-dot is-current' : 'tutorial-dot')));

          const buttons = [];
          if (!last) buttons.push(stepButton(t('tutorialSkip'), () => close('skip')));
          if (index > 0) buttons.push(stepButton(t('tutorialBack'), () => { index -= 1; show(); }));
          let main;
          if (!last) {
            main = stepButton(t('tutorialNext'), () => { index += 1; show(); }, true);
            buttons.push(main);
          } else if (offerPin) {
            buttons.push(stepButton(t('tutorialDone'), () => close('done')));
            main = stepButton(t('tutorialProtect'), () => close('pin'), true);
            buttons.push(main);
          } else {
            main = stepButton(t('tutorialDone'), () => close('done'), true);
            buttons.push(main);
          }
          main.dataset.autofocus = '';
          actions.replaceChildren(...buttons);
          // Il fuoco resta sul pulsante principale (tastiera e lettori di schermo)
          if (box.isConnected) main.focus();
        }
        // Chrome/Edge annunciano il pulsante «Installa» anche dopo l'apertura: si ridisegna il passo
        if (install) stopListening = install.onChange(() => { if (box.isConnected && list[index].id === 'install') show(); });
        // Altezza fissa: la finestra prende l'altezza del passo più alto, così sfogliando non cambia misura.
        // Si misurano tutti i passi una volta aperta la finestra e di nuovo quando cambia la misura dello schermo.
        function fixHeight() {
          if (!box.isConnected) {
            window.removeEventListener('resize', onResize);
            return;
          }
          const current = index;
          box.style.minHeight = '';
          let tallest = 0;
          for (index = 0; index < list.length; index += 1) {
            show();
            tallest = Math.max(tallest, box.offsetHeight);
          }
          index = current;
          show();
          box.style.minHeight = `${tallest}px`;
        }
        let resizeTimer = null;
        function onResize() {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(fixHeight, 150);
        }
        window.addEventListener('resize', onResize);
        show();
        requestAnimationFrame(fixHeight);
        return box;
      },
    });
  }

  // Primo avvio: quando le schede sono pronte, se nessuna altra finestra è aperta e non si è nelle impostazioni
  async function autoStart() {
    try {
      // Mai dentro un'altra pagina (iframe): la finestra deve comparire solo nell'app vera
      if (window.top !== window.self || !(await shouldAutoStart())) return;
      open({ auto: true });
    } catch (error) {
      // Senza archivio o senza finestra il tutorial non parte: la comunicazione non ne risente
    }
  }

  window.PicSpeak.tutorial = { open, steps, shouldAutoStart, markSeen, SEEN_KEY };

  const app = window.PicSpeak.app;
  if (app && app.ready && window.PicSpeak.settingsUi) {
    const pageLoaded = document.readyState === 'complete'
      ? Promise.resolve() : new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    Promise.all([app.ready, pageLoaded]).then(() => setTimeout(autoStart, START_DELAY_MS));
  }
})();
