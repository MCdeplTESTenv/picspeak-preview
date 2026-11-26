/*
 * Finestra «Più tessere insieme» (aperta dalla tessera «+», solo con le impostazioni sbloccate).
 * L'adulto scrive più parole (separate da virgola o una per riga) e preme «Cerca»: per ogni parola compaiono
 * i simboli di tutte le fonti attive (dispositivo, pacchetti scaricati, ARASAAC e le altre fonti online se le
 * impostazioni lo consentono), con il primo già scelto. Con «Crea» le tessere vanno tutte nella pagina aperta
 * (Home o cartella); colore, tipo di parola e le altre opzioni si cambiano poi tessera per tessera.
 * Sicurezza: testi solo con textContent; immagini scaricate e salvate con symbols.acquire (stesse regole della
 * ricerca singola: fonte, autore e licenza conservati).
 */
(function () {
  'use strict';

  const { i18n, data, symbols, symbolSearch, lexicon } = window.PicSpeak;
  const t = i18n.t;

  const MAX_WORDS = 40;       // parole per volta: abbastanza per una cartella, senza tempestare ARASAAC
  const MAX_LABEL = 40;       // come nella modifica della tessera
  const MAX_RESULTS = 24;     // simboli mostrati per parola
  const PARALLEL = 3;         // ricerche contemporanee

  // ---------- Logica (provata dai test) ----------

  /*
   * Testo scritto → elenco di parole: separatori virgola, punto e virgola, a capo e tabulazione
   * (così si può incollare anche una colonna di un foglio di calcolo). Spazi tolti, doppioni tolti
   * senza badare a maiuscole e accenti, ogni parola al massimo 40 caratteri, al massimo 40 parole.
   * Restituisce { words, extra } dove extra è il numero di parole lasciate fuori oltre il limite.
   */
  function parseWords(text) {
    const seen = new Set();
    const words = [];
    let extra = 0;
    String(text || '').split(/[,;\n\r\t]+/).forEach((raw) => {
      const word = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL).trim();
      if (!word) return;
      const key = word.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (seen.has(key)) return;
      seen.add(key);
      if (words.length >= MAX_WORDS) { extra += 1; return; }
      words.push(word);
    });
    return { words, extra };
  }

  // Risultati di symbols.search → un solo elenco nell'ordine delle fonti, senza la stessa immagine due volte
  function flattenGroups(groups) {
    const seen = new Set();
    const items = [];
    symbolSearch.GROUP_ORDER.forEach((id) => {
      const group = groups[id];
      if (!group || !group.items) return;
      group.items.forEach((result) => {
        if (seen.has(result.imageId)) return;
        seen.add(result.imageId);
        items.push(result);
      });
    });
    return items.slice(0, MAX_RESULTS);
  }

  /*
   * Crea le tessere in fondo alla pagina, nell'ordine delle parole.
   * rows = [{ word, result }] con result = simbolo scelto oppure null (tessera con la sola parola).
   * Il tipo di parola si propone come nella tessera singola: dal lessico, poi da ARASAAC, altrimenti «cosa».
   * Se un'immagine non arriva la tessera si crea lo stesso, solo con la parola.
   * Restituisce { created, withoutImage } (withoutImage = parole il cui simbolo non è arrivato).
   */
  async function createTiles(pageId, rows, onProgress) {
    if (!data.page(pageId)) throw new Error('page-missing');
    const created = [];
    const withoutImage = [];
    for (let i = 0; i < rows.length; i += 1) {
      const { word, result } = rows[i];
      const label = String(word || '').trim().slice(0, MAX_LABEL);
      if (!label) continue;
      if (onProgress) onProgress(i + 1, rows.length);
      let imageId = null;
      if (result) {
        try {
          const acquired = await symbols.acquire(result);
          if (acquired.record) await data.saveImage(acquired.record);
          imageId = acquired.imageId;
        } catch (error) {
          withoutImage.push(label);
        }
      }
      const guessed = lexicon && lexicon.guess(label);
      const wordType = [guessed, result && result.wordType].find((w) => w && data.WORD_TYPES.includes(w)) || 'noun';
      created.push(await data.addCell(pageId, { label, wordType, imageId }));
    }
    return { created, withoutImage };
  }

  // ---------- Interfaccia ----------

  let dialog = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const btn = el('button', className, label);
    btn.type = 'button';
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  /*
   * Apre la finestra per la pagina indicata. Restituisce una promessa con il numero di tessere create
   * (0 se si annulla).
   */
  function open(pageId) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'pin-dialog search-dialog bulk-dialog';
      document.body.append(dialog);
    }
    return new Promise((resolve) => {
      let finished = false;
      let busy = false;
      let seq = 0;
      let rows = []; // { word, items, state: 'loading'|'done', chosen: result|null, touched, removed, node }

      const finish = (value) => {
        if (finished) return;
        finished = true;
        seq += 1;
        if (dialog.open) dialog.close();
        dialog.replaceChildren();
        resolve(value);
      };

      const form = el('form', 'dialog-form search-form bulk-form');
      form.noValidate = true;
      const head = el('div', 'search-head');
      const page = data.page(pageId);
      const where = pageId === data.homePageId || !page ? t('bulkWhereHome') : t('bulkWhereFolder').replace('{name}', () => page.title);
      head.append(el('h2', null, t('bulkTitle')), el('p', 'bulk-where', where));

      const input = el('textarea', 'search-input bulk-input');
      input.rows = 3;
      input.maxLength = 2000;
      input.autocomplete = 'off';
      input.spellcheck = true;
      input.placeholder = t('bulkPlaceholder');
      input.setAttribute('aria-label', t('bulkPlaceholder'));
      const go = el('button', 'dlg-btn dlg-btn-primary search-go', t('searchGo'));
      go.type = 'submit';
      const bar = el('div', 'search-bar bulk-bar');
      bar.append(input, go);
      head.append(bar, el('small', 'editor-hint', t('bulkHint')));

      const notice = el('div', 'search-notice');
      notice.hidden = true;
      const results = el('div', 'search-results bulk-results');
      results.setAttribute('aria-live', 'polite');
      const status = el('p', 'dialog-error search-error');
      status.setAttribute('role', 'alert');

      const actions = el('div', 'dialog-actions search-actions');
      const cancel = button(t('cancel'), 'dlg-btn', () => { if (!busy) finish(0); });
      const create = el('button', 'dlg-btn dlg-btn-primary bulk-create', t('bulkCreate'));
      create.type = 'button';
      create.disabled = true;
      actions.append(cancel, create);

      form.append(head, notice, results, status, actions);
      results.append(el('p', 'search-hint', t('bulkStart')));

      function renderNotice(state) {
        notice.replaceChildren();
        notice.hidden = state === 'allowed';
        if (state === 'allowed') return;
        notice.append(el('p', null, t(`searchNet_${state}`)));
        if (state === 'ask') {
          notice.append(button(t('searchAllowOnline'), 'dlg-btn search-allow', () => {
            symbolSearch.allowOnlineOnce();
            runSearch();
          }));
        }
      }

      const activeRows = () => rows.filter((r) => !r.removed);

      function updateCreate() {
        const count = activeRows().length;
        create.disabled = busy || !count || rows.some((r) => !r.removed && r.state === 'loading');
        create.textContent = count ? t('bulkCreateCount').replace('{n}', () => String(count)) : t('bulkCreate');
      }

      function choiceTile(row, result) {
        const tile = button(null, 'search-tile bulk-choice');
        const selected = result ? row.chosen && row.chosen.imageId === result.imageId : !row.chosen;
        tile.setAttribute('aria-pressed', String(Boolean(selected)));
        const frame = el('span', 'search-tile-image');
        if (result && result.thumb) {
          const img = el('img');
          img.src = result.thumb;
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.addEventListener('error', () => { frame.classList.add('is-missing'); img.remove(); }, { once: true });
          frame.append(img);
        } else if (!result) {
          frame.classList.add('bulk-noimage');
          frame.textContent = row.word;
        }
        const source = result ? symbolSearch.groupTitle(result.source === 'device' ? 'device' : result.source) : '';
        tile.setAttribute('aria-label', result ? `${result.label} – ${source}` : t('bulkNoImage'));
        tile.title = result ? source : t('bulkNoImage');
        tile.append(frame, el('span', 'search-tile-label', result ? source : t('bulkNoImage')));
        tile.addEventListener('click', () => {
          row.chosen = result;
          row.touched = true;
          renderRow(row);
        });
        return tile;
      }

      function renderRow(row) {
        const node = row.node;
        node.replaceChildren();
        node.classList.toggle('is-removed', row.removed);
        node.classList.toggle('is-empty', row.state === 'done' && !row.items.length);
        const title = el('h3', 'search-group-title bulk-row-title');
        title.append(el('span', 'search-group-name', row.word));
        const toggle = button(row.removed ? t('bulkPutBack') : t('bulkRemove'), 'dlg-btn bulk-remove', () => {
          row.removed = !row.removed;
          renderRow(row);
          updateCreate();
        });
        toggle.setAttribute('aria-label', `${row.removed ? t('bulkPutBack') : t('bulkRemove')}: ${row.word}`);
        title.append(toggle);
        node.append(title);
        if (row.removed) { updateCreate(); return; }
        if (row.state === 'loading' && !row.items.length) {
          node.append(el('p', 'search-status', t('searchLoading')));
        } else {
          if (row.state === 'done' && !row.items.length) node.append(el('p', 'search-status bulk-empty-note', t('bulkNothing')));
          const strip = el('div', 'bulk-strip');
          row.items.forEach((result) => strip.append(choiceTile(row, result)));
          strip.append(choiceTile(row, null));
          node.append(strip);
          if (row.state === 'loading') node.append(el('p', 'search-status', t('searchLoading')));
          if (row.onlineError) node.append(el('p', 'search-status', t('bulkOnlineError')));
        }
        updateCreate();
      }

      async function searchRow(row, online, mySeq) {
        const groups = await symbols.search(row.word, {
          online,
          onUpdate: (g) => {
            if (mySeq !== seq) return;
            row.items = flattenGroups(g);
            if (!row.touched) row.chosen = row.items[0] || null;
            renderRow(row);
          },
        }).catch(() => ({}));
        if (mySeq !== seq) return;
        row.items = flattenGroups(groups);
        if (!row.touched) row.chosen = row.items[0] || null;
        row.onlineError = Object.values(groups).some((g) => g && g.state === 'error');
        row.state = 'done';
        row.online = online;
        renderRow(row);
      }

      async function runSearch() {
        const mySeq = ++seq;
        status.textContent = '';
        const { words, extra } = parseWords(input.value);
        results.replaceChildren();
        const state = symbolSearch.networkState();
        renderNotice(state);
        if (!words.length) {
          rows = [];
          results.append(el('p', 'search-hint', t('bulkStart')));
          updateCreate();
          return;
        }
        if (extra) status.textContent = t('bulkTooMany').replace('{n}', () => String(MAX_WORDS));
        // Le scelte già fatte restano se la parola c'era già (es. dopo aver corretto una parola sola)
        const online = state === 'allowed';
        const previous = new Map(rows.map((r) => [r.word.toLocaleLowerCase(), r]));
        rows = words.map((word) => {
          const old = previous.get(word.toLocaleLowerCase());
          // (solo se la ricerca era andata online come ora: dopo «Cerca anche su internet» si rifà online)
          if (old && old.state === 'done' && !old.onlineError && old.online === online) {
            return { ...old, word, node: el('section', 'search-group bulk-row') };
          }
          return { word, items: [], state: 'loading', online, chosen: null, touched: false, removed: false, node: el('section', 'search-group bulk-row') };
        });
        rows.forEach((row) => { results.append(row.node); renderRow(row); });
        const queue = rows.filter((r) => r.state === 'loading');
        const worker = async () => {
          while (queue.length && mySeq === seq) await searchRow(queue.shift(), online, mySeq);
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
      }

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (busy) return;
        input.blur(); // chiude la tastiera sul telefono per mostrare i risultati
        runSearch();
      });
      // Invio = a capo (una parola per riga); Ctrl/⌘+Invio = Cerca
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      create.addEventListener('click', async () => {
        const chosen = activeRows();
        if (!chosen.length || busy) return;
        busy = true;
        seq += 1; // ferma le ricerche ancora in corso
        updateCreate();
        go.disabled = true;
        cancel.disabled = true;
        try {
          const { created, withoutImage } = await createTiles(pageId, chosen.map((r) => ({ word: r.word, result: r.chosen })),
            (n, total) => { create.textContent = t('bulkCreating').replace('{n}', () => String(n)).replace('{total}', () => String(total)); });
          const message = t('bulkDone').replace('{n}', () => String(created.length));
          finish(created.length);
          const app = window.PicSpeak.app;
          if (app) {
            app.renderGrid();
            app.notice(withoutImage.length ? `${message} ${t('bulkSomeWithoutImage').replace('{n}', () => String(withoutImage.length))}` : message);
          }
        } catch (error) {
          busy = false;
          go.disabled = false;
          cancel.disabled = false;
          status.textContent = t('bulkCreateError');
          updateCreate();
        }
      });

      dialog.oncancel = (event) => { event.preventDefault(); if (!busy) finish(0); };
      dialog.replaceChildren(form);
      dialog.showModal();
      input.focus();
    });
  }

  window.PicSpeak.bulkAdd = { open, parseWords, flattenGroups, createTiles, MAX_WORDS };
})();
