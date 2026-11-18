/*
 * Finestra "Cerca simbolo" (aperta dalla modifica tessera, solo con le impostazioni sbloccate).
 * Mostra subito i simboli sul dispositivo e nei pacchetti scaricati, poi quelli di ARASAAC se
 * l'interruttore "Ricerca online" lo consente (Attiva: sì; Solo Wi-Fi: sì sul Wi-Fi, altrimenti
 * chiede conferma dove il browser non sa il tipo di rete; Disattivata: mai).
 * Sicurezza: testi solo con textContent; le miniature online arrivano solo da static.arasaac.org e, se l'adulto
 * l'ha attivata, da Twemoji (cdn.jsdelivr.net), come previsto dalla CSP.
 */
(function () {
  'use strict';

  const { i18n, symbols, network } = window.PicSpeak;
  const t = i18n.t;

  const GROUP_ORDER = ['device', 'arasaac', 'mulberry', 'openmoji', 'twemoji'];
  const DEBOUNCE_MS = 600;

  const dialog = document.createElement('dialog');
  dialog.className = 'pin-dialog search-dialog';
  document.body.append(dialog);

  // Conferma "usa internet" data in questa sessione (solo per "Solo Wi-Fi" dove il tipo di rete è ignoto)
  let askConsent = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function groupTitle(id) {
    if (id === 'device') return t('searchGroupDevice');
    return symbols.SOURCE_INFO[id].name;
  }

  function groupLicense(id) {
    if (id === 'device') return t('searchGroupDeviceHelp');
    return symbols.SOURCE_INFO[id].license;
  }

  // Stato della rete per la ricerca: 'allowed' | 'ask' | 'off' | 'offline' | 'wifi'
  function networkState() {
    if (!navigator.onLine) return 'offline';
    if (network.onlineSearchMode() === 'off') return 'off';
    const status = network.onlineSearchStatus();
    if (status === 'blocked') return 'wifi';
    if (status === 'ask' && !askConsent) return 'ask';
    return 'allowed';
  }

  function open(initialTerm) {
    return new Promise((resolve) => {
      let seq = 0;
      let timer = null;
      let finished = false;

      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        seq += 1;
        if (dialog.open) dialog.close();
        dialog.replaceChildren();
        resolve(value);
      };

      const form = el('form', 'dialog-form search-form');
      form.noValidate = true;
      form.setAttribute('role', 'search');
      const head = el('div', 'search-head');
      head.append(el('h2', null, t('searchTitle')));

      const bar = el('div', 'search-bar');
      const input = el('input', 'search-input');
      input.type = 'search';
      input.value = initialTerm || '';
      input.maxLength = 40;
      input.autocomplete = 'off';
      input.enterKeyHint = 'search';
      input.placeholder = t('searchPlaceholder');
      input.setAttribute('aria-label', t('searchPlaceholder'));
      const go = el('button', 'dlg-btn dlg-btn-primary search-go', t('searchGo'));
      go.type = 'submit';
      bar.append(input, go);
      head.append(bar);

      const notice = el('div', 'search-notice');
      notice.hidden = true;
      const results = el('div', 'search-results');
      results.setAttribute('aria-live', 'polite');
      const pickError = el('p', 'dialog-error search-error');
      pickError.setAttribute('role', 'alert');

      const actions = el('div', 'dialog-actions search-actions');
      const cancel = el('button', 'dlg-btn', t('cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => finish(null));
      actions.append(cancel);

      form.append(head, notice, results, pickError, actions);

      // Avviso sullo stato della rete (con eventuale pulsante di conferma)
      function renderNotice(state) {
        notice.replaceChildren();
        notice.hidden = state === 'allowed';
        if (state === 'allowed') return;
        notice.append(el('p', null, t(`searchNet_${state}`)));
        if (state === 'ask') {
          const allow = el('button', 'dlg-btn search-allow', t('searchAllowOnline'));
          allow.type = 'button';
          allow.addEventListener('click', () => { askConsent = true; runSearch(true); });
          notice.append(allow);
        }
      }

      async function pick(result, tile) {
        pickError.textContent = '';
        tile.classList.add('is-busy');
        tile.disabled = true;
        try {
          const acquired = await symbols.acquire(result);
          finish({ ...acquired, label: result.label, wordType: result.wordType || null });
        } catch (error) {
          tile.classList.remove('is-busy');
          tile.disabled = false;
          pickError.textContent = t('searchPickError');
        }
      }

      // explicit = ricerca chiesta con «Cerca»: solo allora la parola va su internet
      // (aprendo la finestra o mentre si scrive si cerca solo sul dispositivo: protegge nomi propri e parole a metà)
      function renderGroups(groups, term, explicit) {
        results.replaceChildren();
        if (!explicit && networkState() === 'allowed') {
          onlineOn.forEach((id) => { if (!groups[id]) groups = { ...groups, [id]: { state: 'idle', items: [] } }; });
        }
        let total = 0;
        let loading = false;
        GROUP_ORDER.forEach((id) => {
          const group = groups[id];
          if (!group) return;
          if (group.state === 'loading' || group.state === 'idle') loading = true;
          if (!group.items.length && !['loading', 'error', 'idle'].includes(group.state)) return;
          const section = el('section', 'search-group');
          const title = el('h3', 'search-group-title');
          title.append(el('span', 'search-group-name', groupTitle(id)), el('span', 'search-group-license', groupLicense(id)));
          section.append(title);
          if (group.state === 'idle') {
            section.append(el('p', 'search-status', t('searchPressToGoOnline')));
          } else if (group.state === 'loading') {
            section.append(el('p', 'search-status', t('searchLoading')));
          } else if (group.state === 'error') {
            section.append(el('p', 'search-status', t('searchOnlineError')));
          } else {
            const grid = el('div', 'search-grid');
            group.items.forEach((result) => {
              total += 1;
              const tile = el('button', 'search-tile');
              tile.type = 'button';
              tile.setAttribute('aria-label', `${result.label} – ${groupTitle(result.source === 'device' ? 'device' : result.source)}`);
              const frame = el('span', 'search-tile-image');
              if (result.thumb) {
                const img = el('img');
                img.src = result.thumb;
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.addEventListener('error', () => { frame.classList.add('is-missing'); img.remove(); }, { once: true });
                frame.append(img);
              }
              tile.append(frame, el('span', 'search-tile-label', result.label));
              tile.addEventListener('click', () => pick(result, tile));
              grid.append(tile);
            });
            section.append(grid);
          }
          results.append(section);
        });
        if (!total && !loading && term) {
          const empty = el('div', 'search-empty');
          empty.append(el('p', 'search-empty-title', t('searchNothing')), el('p', null, t('searchNothingHelp')));
          results.append(empty);
        }
      }

      async function runSearch(explicit) {
        clearTimeout(timer);
        const term = input.value.trim();
        const mySeq = ++seq;
        pickError.textContent = '';
        const state = networkState();
        renderNotice(state);
        if (!term) {
          results.replaceChildren(el('p', 'search-hint', t('searchHint')));
          return;
        }
        await symbols.search(term, {
          online: explicit === true && state === 'allowed',
          onUpdate: (groups) => { if (mySeq === seq) renderGroups(groups, term, explicit === true); },
        });
      }

      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => runSearch(false), DEBOUNCE_MS);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        input.blur(); // chiude la tastiera sul telefono per mostrare i risultati
        runSearch(true);
      });
      dialog.oncancel = (event) => { event.preventDefault(); finish(null); };

      // Fonti attive che cercano su internet (mostrano «premi Cerca» finché non si conferma la parola)
      let onlineOn = [];
      dialog.replaceChildren(form);
      dialog.showModal();
      symbols.activeSources().then((sources) => {
        onlineOn = ['arasaac', ...symbols.ONLINE_IDS].filter((id) => sources[id]);
        runSearch(false);
      });
      if (!input.value) input.focus();
    });
  }

  window.PicSpeak.symbolSearch = { open };
})();
