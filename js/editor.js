/*
 * Modifica delle schede (solo con le impostazioni sbloccate).
 * Tocco su una tessera → finestra di modifica: parola, voce, tipo di parola (colore Fitzgerald),
 * colore scelto a mano con ripristino, simbolo cercato nelle fonti (Tappa 3), immagine dal dispositivo,
 * nascosta, bloccata, posizione, elimina.
 * Tessera "+" → nuova tessera o nuova cartella.
 * Sicurezza: tutti i testi passano da textContent/value; le foto vengono ridisegnate su canvas
 * (niente SVG, niente metadati come la posizione GPS) e salvate solo sul dispositivo.
 */
(function () {
  'use strict';

  const { i18n, data, app, symbols, symbolSearch, lexicon } = window.PicSpeak;
  const t = i18n.t;

  const MAX_LABEL = 40;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const IMAGE_SIZE = 256;
  const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];
  const SWATCHES = ['#e0ac00', '#2e9a47', '#e57a12', '#2a6fd6', '#d0468f', '#cf3439', '#7a4fc9', '#6b717b'];
  const SWATCH_TYPES = ['pronoun', 'verb', 'noun', 'adjective', 'social', 'negation', 'question'];

  // Colori proposti: quelli dei tipi di parola scelti nelle impostazioni (di Fitzgerald se non cambiati), più il grigio
  function swatchColors() {
    const colors = window.PicSpeak.typeColors;
    if (!colors) return SWATCHES;
    const list = SWATCH_TYPES.map((type, i) => colors.colorOf(type) || SWATCHES[i]);
    list.push(SWATCHES[SWATCHES.length - 1]);
    return list.filter((color, i) => list.indexOf(color) === i); // due tipi con lo stesso colore: uno solo
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'pin-dialog editor-dialog';
  document.body.append(dialog);

  // ---------- Piccoli costruttori di interfaccia ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function field(labelText, input) {
    const wrap = el('label', 'dialog-field editor-field');
    wrap.append(el('span', null, labelText), input);
    return wrap;
  }

  function textInput(value, max) {
    const input = el('input');
    input.type = 'text';
    input.value = value || '';
    input.maxLength = max;
    input.autocomplete = 'off';
    input.spellcheck = true;
    return input;
  }

  function segmentedChoice(options, current, onChange) {
    const group = el('div', 'segmented editor-segmented');
    group.setAttribute('role', 'group');
    const buttons = options.map(([value, label]) => {
      const btn = el('button', null, label);
      btn.type = 'button';
      btn.dataset.value = value;
      btn.setAttribute('aria-pressed', String(value === current));
      btn.addEventListener('click', () => {
        buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        onChange(value);
      });
      return btn;
    });
    group.append(...buttons);
    return group;
  }

  function actionButton(label, onClick, extraClass) {
    const btn = el('button', `dlg-btn ${extraClass || ''}`.trim(), label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ---------- Immagini dal dispositivo ----------

  // Ridisegna la foto a 256 px: riduce il peso e toglie i metadati (es. posizione GPS)
  async function processPhoto(file) {
    if (!file || file.size > MAX_FILE_BYTES) throw new Error(t('editorImageTooBig'));
    if (file.type && !ALLOWED_TYPES.includes(file.type)) throw new Error(t('editorImageType'));
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (error) {
      throw new Error(t('editorImageType'));
    }
    const scale = Math.min(1, IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    // WebP dove supportato (più leggero), altrimenti PNG se c'è trasparenza o JPEG per le foto
    let blob = await toBlob('image/webp', 0.85);
    if (!blob || blob.type !== 'image/webp') {
      blob = await toBlob(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
    }
    return blob;
  }

  // capture: true = si apre direttamente la fotocamera (tablet e telefono; sul computer si sceglie un file)
  function pickFile(capture = false) {
    return new Promise((resolve) => {
      const input = el('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (capture) input.setAttribute('capture', 'environment');
      input.addEventListener('change', () => resolve(input.files && input.files[0]), { once: true });
      input.click();
    });
  }

  // ---------- Finestra di modifica ----------

  function close() {
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
  }

  function openEditor({ pageId, cell, isNew, slot }) {
    const draft = {
      kind: cell ? cell.kind : 'symbol',
      label: cell ? cell.label : '',
      speak: cell ? cell.speak : null,
      wordType: cell ? cell.wordType : 'noun',
      color: cell ? cell.color : null,
      imageId: cell ? cell.imageId : null,
      hidden: cell ? cell.hidden : false,
      locked: cell ? cell.locked : false,
      silent: cell ? cell.silent === true : false,
      placePageId: pageId,
      newImageBlob: null,
      pending: null, // simbolo scelto con "Cerca simbolo": { imageId, record, previewBlob }
    };

    const form = el('form', 'dialog-form editor-form');
    form.noValidate = true;
    form.append(el('h2', null, isNew ? t('editorNewTitle') : t(cell.kind === 'folder' ? 'editorFolderTitle' : 'editorTitle')));

    // Cartella esistente: si può aprire anche da qui (per aggiungere tessere al suo interno)
    if (!isNew && cell.kind === 'folder' && data.page(cell.targetPageId)) {
      const openRow = el('div', 'editor-actions-row');
      openRow.append(actionButton(`${t('editorOpenFolder')} →`, () => {
        close();
        app.openFolder(cell.targetPageId);
      }, 'dlg-btn-primary editor-open-folder'));
      // Copia della cartella (con le sottocartelle) tra «I miei modelli»
      const boardsUi = window.PicSpeak.boardsUi;
      if (boardsUi) {
        openRow.append(actionButton(t('tplSaveFolder'), () => {
          // Si propone il nome appena scritto, se c'è
          const name = labelInput.value.trim() || cell.label;
          close();
          boardsUi.saveFolderAsTemplate(cell.targetPageId, name);
        }, 'editor-save-template'));
      }
      form.append(openRow, el('small', 'editor-hint', t('editorFolderTapHint')));
    }

    // Tipo di tessera (solo per una nuova): simbolo o cartella
    if (isNew) {
      form.append(segmentedChoice(
        [['symbol', t('editorKindSymbol')], ['folder', t('editorKindFolder')]],
        draft.kind,
        (value) => {
          draft.kind = value;
          symbolOnly.forEach((n) => { n.hidden = value === 'folder'; });
          rowSilent.hidden = value !== 'folder';
          bulkRow.hidden = value === 'folder';
        },
      ));
      // Più tessere insieme: si scrivono più parole e per ognuna si sceglie solo l'immagine
      const bulkRow = el('div', 'editor-actions-row editor-bulk-row');
      bulkRow.append(actionButton(t('editorBulk'), () => {
        close();
        window.PicSpeak.bulkAdd.open(pageId);
      }, 'editor-bulk-btn'));
      form.append(bulkRow);
    }

    const labelInput = textInput(draft.label, MAX_LABEL);
    form.append(field(t('editorLabel'), labelInput));

    const speakInput = textInput(draft.speak, 80);
    speakInput.placeholder = t('editorSpeakPlaceholder');
    const speakField = field(t('editorSpeak'), speakInput);
    form.append(speakField);

    // Tipo di parola → colore Fitzgerald. Per una tessera nuova il tipo si propone da solo
    // (dalla parola scritta o dal simbolo ARASAAC scelto) finché l'adulto non lo cambia a mano.
    let typeTouched = !isNew;
    const typeField = el('div', 'editor-block');
    typeField.append(el('span', 'editor-block-title', t('editorWordType')));
    const typeChoice = segmentedChoice(
      data.WORD_TYPES.map((type) => [type, t(`wordType_${type}`)]),
      draft.wordType,
      (value) => { draft.wordType = value; typeTouched = true; renderSwatches(); },
    );
    typeChoice.classList.add('word-type-choice');
    typeChoice.querySelectorAll('button').forEach((b) => b.classList.add(`type-${b.dataset.value}`));
    typeField.append(typeChoice);
    const setWordType = (type) => {
      if (typeTouched || !type || !data.WORD_TYPES.includes(type)) return;
      draft.wordType = type;
      typeChoice.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === type)));
      renderSwatches();
    };
    labelInput.addEventListener('input', () => setWordType(lexicon && lexicon.guess(labelInput.value)));
    form.append(typeField);

    // Colore: automatico (Fitzgerald) oppure scelto a mano
    const colorField = el('div', 'editor-block');
    colorField.append(el('span', 'editor-block-title', t('editorColor')));
    const swatches = el('div', 'editor-swatches');
    const renderSwatches = () => {
      swatches.replaceChildren();
      const auto = el('button', 'editor-swatch swatch-auto', 'A');
      auto.type = 'button';
      auto.title = t('editorColorAuto');
      auto.setAttribute('aria-label', t('editorColorAuto'));
      auto.setAttribute('aria-pressed', String(!draft.color));
      auto.addEventListener('click', () => { draft.color = null; renderSwatches(); });
      swatches.append(auto);
      // «A» mostra nel bordo il colore che la tessera prende dal suo tipo
      const typeColor = window.PicSpeak.typeColors && window.PicSpeak.typeColors.colorOf(draft.wordType);
      if (typeColor) auto.style.borderColor = typeColor;
      swatchColors().forEach((color) => {
        const sw = el('button', 'editor-swatch');
        sw.type = 'button';
        sw.style.background = color;
        sw.setAttribute('aria-label', color);
        sw.setAttribute('aria-pressed', String(draft.color === color));
        sw.addEventListener('click', () => { draft.color = color; renderSwatches(); });
        swatches.append(sw);
      });
      const custom = el('input', 'editor-swatch-input');
      custom.type = 'color';
      custom.value = draft.color || '#888888';
      custom.setAttribute('aria-label', t('bgCustom'));
      custom.addEventListener('change', () => { draft.color = custom.value; renderSwatches(); });
      swatches.append(custom);
    };
    renderSwatches();
    colorField.append(swatches, el('small', 'editor-hint', t('editorColorHint')));
    form.append(colorField);

    // Immagine
    const imageField = el('div', 'editor-block');
    imageField.append(el('span', 'editor-block-title', t('editorImage')));
    const preview = el('div', 'editor-preview');
    let previewUrl = null;
    const renderPreview = () => {
      preview.replaceChildren();
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      let src = null;
      const blob = draft.newImageBlob || (draft.pending && draft.pending.previewBlob);
      if (blob) {
        previewUrl = URL.createObjectURL(blob);
        src = previewUrl;
      } else if (draft.pending) {
        src = data.imageUrl(draft.pending.imageId);
      } else {
        src = data.imageUrl(draft.imageId);
      }
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        preview.append(img);
      } else {
        preview.append(el('span', 'editor-preview-empty', t('editorNoImage')));
      }
    };
    renderPreview();
    const imageError = el('p', 'dialog-error');
    imageError.setAttribute('role', 'alert');
    const imageActions = el('div', 'editor-actions-row');
    // Cerca simbolo: fonti attive (dispositivo, pacchetti, ARASAAC online)
    const searchButton = actionButton(t('editorSearchSymbol'), async () => {
      imageError.textContent = '';
      const picked = await symbolSearch.open(labelInput.value.trim());
      if (!picked) return;
      draft.pending = picked;
      draft.newImageBlob = null;
      if (!labelInput.value.trim() && picked.label) labelInput.value = picked.label.slice(0, MAX_LABEL);
      // Tipo proposto: prima dal lessico (parola scritta), altrimenti da quello indicato da ARASAAC
      setWordType((lexicon && lexicon.guess(labelInput.value)) || picked.wordType);
      renderPreview();
    }, 'editor-search-btn');
    // Foto dal dispositivo o dalla fotocamera: stessa riduzione e stesso salvataggio
    const usePhoto = async (capture) => {
      imageError.textContent = '';
      try {
        const file = await pickFile(capture);
        if (!file) return;
        draft.newImageBlob = await processPhoto(file);
        draft.pending = null;
        renderPreview();
      } catch (error) {
        imageError.textContent = error.message;
      }
    };
    const photoButton = actionButton(t('editorPickImage'), () => usePhoto(false));
    const cameraButton = actionButton(t('editorTakePhoto'), () => usePhoto(true));
    photoButton.hidden = true;
    cameraButton.hidden = true;
    // Immagini dal dispositivo e fotocamera si accendono e spengono in Impostazioni → Simboli;
    // la fotocamera solo su tablet e telefono (sul computer il pulsante aprirebbe la scelta di un file)
    const hasCamera = Boolean(window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches);
    symbols.activeSources().then((sources) => {
      photoButton.hidden = !sources.photo;
      cameraButton.hidden = !(sources.camera && hasCamera);
    });
    imageActions.append(
      searchButton,
      photoButton,
      cameraButton,
      actionButton(t('editorRemoveImage'), () => {
        draft.imageId = null;
        draft.newImageBlob = null;
        draft.pending = null;
        renderPreview();
      }),
    );
    imageField.append(preview, imageActions, imageError);
    form.append(imageField);

    // Opzioni: nascosta, bloccata
    const optionsField = el('div', 'editor-block');
    const hiddenChoice = segmentedChoice([['no', t('valNo')], ['yes', t('valYes')]], draft.hidden ? 'yes' : 'no',
      (v) => { draft.hidden = v === 'yes'; });
    const lockedChoice = segmentedChoice([['no', t('valNo')], ['yes', t('valYes')]], draft.locked ? 'yes' : 'no',
      (v) => { draft.locked = v === 'yes'; });
    const rowHidden = el('div', 'editor-option');
    rowHidden.append(el('span', null, t('editorHidden')), hiddenChoice);
    const rowLocked = el('div', 'editor-option');
    rowLocked.append(el('span', null, t('editorLocked')), lockedChoice);
    // «Blocca la posizione di tutte le tessere» attivo: decide l'impostazione generale. La voce si vede bloccata,
    // grigia e non si tocca; la nota dice da dove viene e cosa succede togliendola (la scelta della tessera resta)
    if (document.documentElement.dataset.lockPositions === 'on') {
      rowLocked.classList.add('is-overridden');
      lockedChoice.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
        b.setAttribute('aria-pressed', String(b.dataset.value === 'yes'));
      });
      rowLocked.append(el('small', 'editor-hint', t(draft.locked ? 'editorLockedByAllOwn' : 'editorLockedByAll')));
    }
    optionsField.append(rowHidden, rowLocked);
    // Solo per le cartelle: leggere o no il nome quando si apre
    const silentChoice = segmentedChoice([['yes', t('valYes')], ['no', t('valNo')]], draft.silent ? 'no' : 'yes',
      (v) => { draft.silent = v === 'no'; });
    const rowSilent = el('div', 'editor-option');
    rowSilent.append(el('span', null, t('editorSpeakFolder')), silentChoice);
    rowSilent.hidden = draft.kind !== 'folder';
    optionsField.append(rowSilent);
    form.append(optionsField);

    // Dove si trova (tessere esistenti): scegliendo un'altra cartella la tessera si sposta lì
    if (!isNew) {
      const placeField = el('div', 'editor-block');
      const select = el('select', 'editor-place');
      data.pageTree().forEach(({ pageId: id, title, depth }) => {
        const option = el('option', null, `${'\u00a0\u00a0\u00a0'.repeat(depth)}${depth ? '› ' : ''}${depth ? title : t('editorPlaceHome')}`);
        option.value = id;
        option.disabled = id !== pageId && !data.canMoveCellTo(pageId, cell.id, id);
        option.selected = id === pageId;
        select.append(option);
      });
      // Pagina non raggiungibile dalla Home (caso raro): resta comunque scelta quella attuale
      if (select.value !== pageId) {
        const here = el('option', null, (data.page(pageId) || {}).title || '');
        here.value = pageId;
        select.prepend(here);
        select.value = pageId;
      }
      select.addEventListener('change', () => { draft.placePageId = select.value; });
      placeField.append(field(t('editorPlace'), select), el('small', 'editor-hint', t('editorPlaceHint')));
      form.append(placeField);
    }

    // Posizione ed eliminazione (solo per tessere esistenti)
    if (!isNew) {
      const manage = el('div', 'editor-actions-row');
      // Posizioni bloccate (per tutte le tessere o per questa): niente «Prima»/«Dopo»
      const canMove = document.documentElement.dataset.lockPositions !== 'on' && !cell.locked;
      if (canMove) {
        manage.append(
          actionButton(`← ${t('editorMoveBefore')}`, async () => {
            await data.moveCell(pageId, cell.id, -1);
            app.renderGrid();
          }),
          actionButton(`${t('editorMoveAfter')} →`, async () => {
            await data.moveCell(pageId, cell.id, 1);
            app.renderGrid();
          }),
        );
      }
      manage.append(
        actionButton(t('editorDelete'), async () => {
          if (await confirmDelete(pageId, cell.id)) close();
        }, 'dlg-btn-danger'),
      );
      form.append(manage, el('small', 'editor-hint', canMove ? t('editorMoveHint') : t('editorMoveLocked')));
    }

    const error = el('p', 'dialog-error');
    error.setAttribute('role', 'alert');
    form.append(error);

    const actions = el('div', 'dialog-actions');
    const cancel = actionButton(t('cancel'), close);
    const save = el('button', 'dlg-btn dlg-btn-primary', t('editorSave'));
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(actions);

    const symbolOnly = [speakField, typeField];
    if (draft.kind === 'folder') symbolOnly.forEach((n) => { n.hidden = true; });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const label = labelInput.value.trim().slice(0, MAX_LABEL);
      if (!label) {
        error.textContent = t('editorLabelRequired');
        labelInput.focus();
        return;
      }
      save.disabled = true;
      let { imageId } = draft;
      if (draft.pending) {
        // Simbolo cercato: salvato una sola volta sul dispositivo con fonte, autore e licenza
        if (draft.pending.record) await data.saveImage(draft.pending.record);
        imageId = draft.pending.imageId;
      } else if (draft.newImageBlob) {
        const image = await data.addImage({
          source: 'photo',
          author: '',
          license: t('editorPersonalLicense'),
          mime: draft.newImageBlob.type,
          blob: draft.newImageBlob,
          keywords: { [i18n.language]: [label] },
        });
        imageId = image.id;
      }
      const speak = speakInput.value.trim().slice(0, 80) || null;
      if (isNew && draft.kind === 'folder') {
        const { cell: folderCell } = await data.addFolder(pageId, label, slot);
        await data.updateCell(pageId, folderCell.id, {
          color: draft.color, imageId, hidden: draft.hidden, locked: draft.locked, silent: draft.silent,
        });
      } else if (isNew) {
        await data.addCell(pageId, {
          label, speak, wordType: draft.wordType, color: draft.color, imageId,
          hidden: draft.hidden, locked: draft.locked, ...(slot || {}),
        });
      } else {
        const changes = { label, color: draft.color, imageId, hidden: draft.hidden, locked: draft.locked };
        if (cell.kind !== 'folder') Object.assign(changes, { speak, wordType: draft.wordType });
        else changes.silent = draft.silent;
        await data.updateCell(pageId, cell.id, changes);
        // Spostata in un'altra cartella
        if (draft.placePageId && draft.placePageId !== pageId) {
          const moved = await data.moveCellToPage(pageId, cell.id, draft.placePageId);
          const target = data.page(draft.placePageId);
          if (moved && target) {
            const name = draft.placePageId === data.homePageId ? t('editorPlaceHome') : target.title;
            app.notice(t('editorPlaceMoved').replace('{name}', () => name));
          }
        }
        if (cell.kind === 'folder' && cell.targetPageId) {
          const target = data.page(cell.targetPageId);
          if (target) target.title = label;
        }
      }
      close();
      app.renderGrid();
    });

    dialog.oncancel = (event) => { event.preventDefault(); close(); };
    dialog.replaceChildren(form);
    dialog.showModal();
    labelInput.focus();
  }

  // ---------- Eliminazione (dal pulsante «Elimina» della modifica o dalla ✕ nell'angolo della tessera) ----------

  // «12 tessere e 2 cartelle»: quello che sparisce insieme a una cartella
  function contentsText({ tiles, folders }) {
    const parts = [];
    if (tiles) parts.push(tiles === 1 ? t('deleteTilesOne') : t('deleteTilesN').replace('{n}', () => String(tiles)));
    if (folders) parts.push(folders === 1 ? t('deleteFoldersOne') : t('deleteFoldersN').replace('{n}', () => String(folders)));
    return parts.join(` ${t('deleteAnd')} `);
  }

  /*
   * Chiede sempre conferma prima di eliminare; per una cartella dice quante tessere e sottocartelle si cancellano
   * con lei. Risolve true se la tessera è stata eliminata (la ✕ non compare sulle tessere bloccate, vedi app.js).
   */
  async function confirmDelete(pageId, cellId) {
    const page = data.page(pageId);
    const cell = page && page.cells.find((c) => c.id === cellId);
    if (!cell) return false;
    const isFolder = cell.kind === 'folder';
    const name = cell.label || (isFolder && data.page(cell.targetPageId) ? data.page(cell.targetPageId).title : '') || '';
    let title = name ? t('deleteTileTitle').replace('{name}', () => name) : t('editorDeleteConfirm');
    let help = t('deleteTileHelp');
    if (isFolder) {
      const contents = data.folderContents(pageId, cellId);
      const what = contentsText(contents);
      title = t('deleteFolderTitle').replace('{name}', () => name);
      const lines = [];
      if (what) lines.push(t('deleteFolderHelp').replace('{what}', () => what));
      else if (!contents.shared) lines.push(t('deleteFolderEmpty'));
      if (contents.shared) lines.push(t('deleteFolderShared'));
      help = lines.join(' ');
    }
    const ui = window.PicSpeak.settingsUi;
    const ok = ui
      ? await ui.runDialog({ title, help, primary: t('editorDelete'), secondary: t('cancel'), destructive: true })
      : window.confirm(`${title}\n${help}`); // eslint-disable-line no-alert
    // Nel frattempo le impostazioni potrebbero essersi richiuse: in modalità bambino non si cancella nulla
    if (!ok || app.mode !== 'adult') return false;
    await data.deleteCell(pageId, cellId);
    app.renderGrid();
    if (name) app.notice(t('deletedNotice').replace('{name}', () => name));
    return true;
  }

  window.PicSpeak.editor = {
    confirmDelete,
    edit(pageId, cellId) {
      const page = data.page(pageId);
      const cell = page && page.cells.find((c) => c.id === cellId);
      if (cell) openEditor({ pageId, cell, isNew: false });
    },
    // slot (facoltativo): casella della griglia fissa in cui mettere la tessera nuova
    add(pageId, slot) {
      openEditor({ pageId, cell: null, isNew: true, slot });
    },
    close,
  };
})();
