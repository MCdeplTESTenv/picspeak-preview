/*
 * Giochi per imparare il tool (facoltativi, spenti all'inizio: Impostazioni › Giochi).
 * Il centro di PicSpeak resta la comunicazione: i giochi servono solo a prendere confidenza con le tessere.
 *
 * - Casella «Giochi» nella barra di navigazione, accanto ai tre puntini: apre la schermata dei giochi.
 * - La schermata ha sempre in alto il pulsante grande «Home» che riporta subito alle tessere
 *   (e il pulsante «Aiuto», se attivo nei pulsanti rapidi): il bambino può dover dire qualcosa di urgente.
 * - Giochi nella loro schermata: Parole e lettere, Memory, Indovina il suono, Scegli tu.
 * - Giochi sulle schede vere: Storie (il tool tocca da solo le tessere e compone le frasi) e Trova la tessera.
 *   Una fascia con il pulsante grande «Basta» resta sempre visibile; nelle Storie basta toccare lo schermo
 *   per fermare tutto e usare subito le tessere.
 * - Nulla di quello che succede nei giochi entra nelle abitudini della previsione.
 * - Fasce orarie senza giochi (per esempio a scuola): la casella non compare e un gioco aperto si chiude.
 *
 * Dati salvati sul dispositivo: «games» (scelte delle impostazioni) e «gameStories» (storie dell'adulto),
 * formato in docs/FORMATO-DATI.md. Tutto il testo entra nel DOM con textContent/createElement.
 */
(function () {
  'use strict';

  const { i18n, storage, speech, data, app, gamesData, predict } = window.PicSpeak;
  const t = i18n.t;

  const SETTINGS_KEY = 'games';
  const STORIES_KEY = 'gameStories';
  const FORMAT_VERSION = 1;
  const INACTIVITY_MS = 3 * 60 * 1000; // senza tocchi per 3 minuti si torna da soli alle tessere
  const ARASAAC_PREFIX = 'img_ar_';

  // Giochi disponibili, nell'ordine della schermata. board = si gioca sulle schede vere
  const GAMES = [
    { id: 'words', icon: '🔤', nameKey: 'gameWords', descKey: 'gameWordsDesc' },
    { id: 'stories', icon: '📖', nameKey: 'gameStories', descKey: 'gameStoriesDesc', board: true },
    { id: 'find', icon: '🔍', nameKey: 'gameFind', descKey: 'gameFindDesc', board: true },
    { id: 'memory', icon: '🃏', nameKey: 'gameMemory', descKey: 'gameMemoryDesc' },
    { id: 'sounds', icon: '👂', nameKey: 'gameSounds', descKey: 'gameSoundsDesc' },
    { id: 'choice', icon: '✋', nameKey: 'gameChoice', descKey: 'gameChoiceDesc' },
  ];
  const SPEEDS = { slow: 1900, normal: 1250, fast: 800 }; // pausa prima di ogni «tocco» nelle Storie (ms)

  const DEFAULTS = {
    version: FORMAT_VERSION,
    enabled: false,
    games: Object.fromEntries(GAMES.map((g) => [g.id, true])),
    quiet: [], // fasce senza giochi: { days: [1-7], from: 0-23, to: 1-24 } (come le regole settimanali dei contesti)
    storySpeed: 'normal',
    letterMode: 'sounds', // Parole e lettere: 'sounds' = suoni delle lettere, 'names' = nomi delle lettere
    disabledBuiltIns: [], // storie pronte spente dall'adulto
    hiddenBuiltIns: [], // storie pronte tolte dall'elenco (si recuperano con «Ripristina le storie pronte»)
  };
  let settings = structuredCloneSafe(DEFAULTS);
  let userStories = []; // storie create, modificate o importate dall'adulto
  const listeners = new Set();

  function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // ---------- Elementi ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function format(key, values) {
    return t(key).replace(/\{(\w+)\}/g, (match, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : match));
  }

  const ui = {
    button: document.getElementById('btn-games'),
    screen: document.getElementById('games-screen'),
    body: document.getElementById('games-body'),
    title: document.getElementById('games-title'),
    home: document.getElementById('btn-games-home'),
    back: document.getElementById('btn-games-back'),
    help: document.getElementById('btn-games-help'),
    banner: document.getElementById('game-banner'),
  };

  // ---------- Validazione dei dati (letti dal dispositivo o da un file) ----------

  function cleanText(value, max) {
    // Caratteri di controllo e invisibili o di direzione (\p{Cf}) tolti, come per i contesti
    return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  }

  function cleanQuiet(list) {
    if (!Array.isArray(list)) return [];
    // Stesse regole delle fasce settimanali dei contesti (predict.cleanRule), una fascia per voce
    return list.slice(0, 8).map((slot) => {
      const rule = predict.cleanRule({ type: 'weekly', slots: [slot || {}] });
      return rule && rule.slots && rule.slots[0] ? rule.slots[0] : null;
    }).filter(Boolean).map(({ days, from, to }) => ({ days, from, to }));
  }

  function cleanSettings(raw) {
    const next = structuredCloneSafe(DEFAULTS);
    if (!raw || typeof raw !== 'object') return next;
    if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled;
    if (raw.games && typeof raw.games === 'object') {
      GAMES.forEach((g) => { if (typeof raw.games[g.id] === 'boolean') next.games[g.id] = raw.games[g.id]; });
    }
    next.quiet = cleanQuiet(raw.quiet);
    if (Object.prototype.hasOwnProperty.call(SPEEDS, raw.storySpeed)) next.storySpeed = raw.storySpeed;
    if (['sounds', 'names'].includes(raw.letterMode)) next.letterMode = raw.letterMode;
    const keys = new Set(gamesData.stories.map((s) => s.key));
    ['disabledBuiltIns', 'hiddenBuiltIns'].forEach((k) => {
      if (Array.isArray(raw[k])) next[k] = [...new Set(raw[k].filter((v) => keys.has(v)))];
    });
    return next;
  }

  const LIMITS = { stories: 60, sentences: 12, words: 12, label: 40, title: 60 };

  // Storia valida o null. Le parole sono testi (con l'id della tessera da cui sono state prese, se c'è)
  function cleanStory(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = cleanText(raw.title, LIMITS.title);
    if (!title) return null;
    const level = [1, 2, 3].includes(raw.level) ? raw.level : 1;
    if (!Array.isArray(raw.sentences)) return null;
    const sentences = raw.sentences.slice(0, LIMITS.sentences).map((sentence) => {
      if (!Array.isArray(sentence)) return [];
      return sentence.slice(0, LIMITS.words).map((word) => {
        const label = cleanText(typeof word === 'string' ? word : word && word.label, LIMITS.label);
        if (!label) return null;
        const cellId = word && typeof word.cellId === 'string' && /^c_[0-9a-f]{16}$/.test(word.cellId) ? word.cellId : null;
        return cellId ? { label, cellId } : { label };
      }).filter(Boolean);
    }).filter((s) => s.length);
    if (!sentences.length) return null;
    const keys = new Set(gamesData.stories.map((s) => s.key));
    return {
      id: typeof raw.id === 'string' && /^st_[0-9a-f]{16}$/.test(raw.id) ? raw.id : data.newId('st'),
      title,
      level,
      lang: i18n.supported.includes(raw.lang) ? raw.lang : i18n.language,
      sentences,
      enabled: raw.enabled !== false,
      from: keys.has(raw.from) ? raw.from : null,
    };
  }

  // ---------- Salvataggio ----------

  async function load() {
    settings = cleanSettings(await storage.get(SETTINGS_KEY));
    const saved = await storage.get(STORIES_KEY);
    userStories = saved && Array.isArray(saved.stories) ? saved.stories.map(cleanStory).filter(Boolean).slice(0, LIMITS.stories) : [];
    refreshButton();
  }

  async function saveSettings(changes) {
    settings = cleanSettings({ ...settings, ...changes });
    await storage.set(SETTINGS_KEY, settings);
    refreshButton();
    notify();
  }

  async function saveStories(list) {
    userStories = list.map(cleanStory).filter(Boolean).slice(0, LIMITS.stories);
    await storage.set(STORIES_KEY, { version: FORMAT_VERSION, stories: userStories });
    notify();
  }

  function notify() {
    listeners.forEach((fn) => { try { fn(); } catch (error) { /* nulla */ } });
  }

  // ---------- Storie ----------

  // Storia pronta nella lingua attuale (con l'altra lingua come riserva, se le schede sono nell'altra lingua)
  function builtInStory(def) {
    const lang = i18n.language;
    const other = i18n.supported.find((l) => l !== lang) || lang;
    const toWords = (list) => (list || []).map((s) => s.map((label) => ({ label })));
    return {
      id: `b:${def.key}`,
      builtIn: def.key,
      title: def.title[lang] || def.title.it,
      level: def.level,
      sentences: toWords(def.sentences[lang] || def.sentences.it),
      alt: toWords(def.sentences[other]),
      coverWord: (gamesData.words.find((w) => w.key === def.cover) || {}).label,
      coverKey: def.cover,
      enabled: !settings.disabledBuiltIns.includes(def.key),
    };
  }

  // Tutte le storie dell'elenco: le pronte (tranne quelle tolte o sostituite da una copia modificata) e quelle dell'adulto
  function allStories() {
    const replaced = new Set(userStories.map((s) => s.from).filter(Boolean));
    const builtIns = gamesData.stories
      .filter((def) => !settings.hiddenBuiltIns.includes(def.key) && !replaced.has(def.key))
      .map(builtInStory);
    const own = userStories.map((s) => ({ ...s, builtIn: null, alt: null }));
    return [...builtIns, ...own].sort((a, b) => a.level - b.level);
  }

  const wordKey = (text) => (predict && predict.wordKey ? predict.wordKey(text) : String(text || '').trim().toLowerCase());

  /*
   * Dove si trova una parola nelle schede del bambino: pagina, tessera e percorso di cartelle dalla Home.
   * Prima la tessera da cui la parola è stata presa (storie create nel tool), poi la ricerca per parola:
   * pagina per pagina dalla Home (la strada più corta), solo tra le tessere e le cartelle visibili.
   */
  function locateWord(word) {
    if (!word || !data.homePageId) return null;
    const home = data.homePageId;
    const key = wordKey(word.label);
    const queue = [{ pageId: home, path: [home] }];
    const seen = new Set([home]);
    let byId = null;
    let byLabel = null;
    while (queue.length) {
      const { pageId, path } = queue.shift();
      const page = data.page(pageId);
      if (!page) continue;
      const cells = data.orderedCells(page).filter((c) => c.kind !== 'empty');
      if (word.cellId && !byId) {
        const hit = cells.find((c) => c.id === word.cellId && c.kind !== 'folder');
        if (hit) byId = { pageId, cellId: hit.id, path };
      }
      if (!byLabel) {
        const hit = cells.find((c) => c.kind !== 'folder' && wordKey(c.label) === key);
        if (hit) byLabel = { pageId, cellId: hit.id, path };
      }
      if (byId || (byLabel && !word.cellId)) break;
      cells.filter((c) => c.kind === 'folder' && c.targetPageId && !seen.has(c.targetPageId)).forEach((c) => {
        seen.add(c.targetPageId);
        queue.push({ pageId: c.targetPageId, path: [...path, c.targetPageId] });
      });
    }
    return byId || byLabel;
  }

  // Controlla una serie di frasi: parole trovate e parole senza tessera
  function resolveSentences(sentences) {
    const missing = [];
    const steps = sentences.map((sentence) => sentence.map((word) => {
      const where = locateWord(word);
      if (!where) missing.push(word.label);
      return { word, where };
    }));
    return { steps, missing: [...new Set(missing)] };
  }

  // Storia pronta da giocare? (tutte le parole hanno una tessera; per le pronte vale anche l'altra lingua)
  function resolveStory(story) {
    const main = resolveSentences(story.sentences);
    if (main.missing.length && story.alt && story.alt.length) {
      const alt = resolveSentences(story.alt);
      if (!alt.missing.length) return { ...alt, complete: true };
    }
    return { ...main, complete: main.missing.length === 0 };
  }

  // ---------- Immagini ----------

  const BUNDLED = new Set(Object.values(window.PicSpeak.sampleData.symbols).concat(Object.values(window.PicSpeak.sampleData.folders))
    .map((item) => String(item.arasaac)).filter(Boolean));

  // Pittogramma di una parola del gioco: già sul dispositivo, incluso nel tool, oppure null (si usa l'emoji)
  function wordImage(word) {
    const id = String(word.arasaac);
    if (data.image && data.image(ARASAAC_PREFIX + id)) return data.imageUrl(ARASAAC_PREFIX + id);
    if (BUNDLED.has(id)) return `symbols/arasaac/${id}.png`;
    return null;
  }

  function missingPictograms() {
    return gamesData.words.filter((w) => !wordImage(w));
  }

  // Scarica i pittogrammi mancanti dei giochi (una sola volta; restano sul dispositivo come gli altri simboli)
  async function downloadPictograms(onProgress) {
    // Difesa in più: con internet spento per i simboli non si scarica nulla, chiunque chiami
    const network = window.PicSpeak.network;
    if (!network || network.onlineSearchStatus() === 'blocked') return { total: 0, failed: 0, blocked: true };
    const list = missingPictograms();
    let done = 0;
    let failed = 0;
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const word = queue.shift();
        const id = String(word.arasaac);
        try {
          const blob = await window.PicSpeak.symbols.downloadImage(`https://static.arasaac.org/pictograms/${id}/${id}_300.png`);
          await data.saveImage({
            id: ARASAAC_PREFIX + id,
            source: 'arasaac',
            sourceId: id,
            author: 'Sergio Palao',
            owner: 'Gobierno de Aragón',
            license: 'CC BY-NC-SA 4.0',
            licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
            keywords: { it: [word.label.it], en: [word.label.en] },
            mime: blob.type,
            blob,
          });
        } catch (error) {
          failed += 1;
        }
        done += 1;
        if (onProgress) onProgress(done, list.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return { total: list.length, failed };
  }

  // Tessera grande dei giochi: pittogramma (o emoji) e parola
  function gameTile(word, className) {
    const node = el('button', `game-tile ${className || ''}`.trim());
    node.type = 'button';
    node.append(tileFace(word));
    node.setAttribute('aria-label', labelOf(word));
    return node;
  }

  function labelOf(word) {
    return word.label[i18n.language] || word.label.it;
  }

  function tileFace(word) {
    const fragment = document.createDocumentFragment();
    const image = el('span', 'game-image');
    image.setAttribute('aria-hidden', 'true');
    const src = word.src !== undefined ? word.src : wordImage(word);
    if (src) {
      const img = el('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      img.addEventListener('error', () => { img.replaceWith(el('span', 'game-emoji', word.emoji || '')); }, { once: true });
      image.append(img);
    } else {
      image.append(el('span', 'game-emoji', word.emoji || ''));
    }
    fragment.append(image, el('span', 'game-label', word.text || labelOf(word)));
    return fragment;
  }

  // ---------- Voce ----------

  // Legge e aspetta la fine (con un tempo massimo: alcuni browser non avvisano sempre)
  function sayAndWait(text, run) {
    return new Promise((resolve) => {
      if (!text || !isCurrent(run)) { resolve(); return; }
      let finished = false;
      const end = () => { if (!finished) { finished = true; clearTimeout(cap); resolve(); } };
      const cap = setTimeout(end, 2500 + text.length * 160);
      if (!speech.speak(text, i18n.speechLocale, { onEnd: end })) { clearTimeout(cap); setTimeout(end, 700); }
    });
  }

  function say(text) {
    speech.speak(text, i18n.speechLocale);
  }

  // ---------- Turni di gioco: ogni gioco nuovo (o l'uscita) annulla attese e letture del precedente ----------

  let runId = 0;
  const timers = new Set();

  function newRun() {
    runId += 1;
    timers.forEach(clearTimeout);
    timers.clear();
    return runId;
  }

  function isCurrent(run) {
    return run === runId;
  }

  function wait(ms, run) {
    return new Promise((resolve) => {
      const id = setTimeout(() => { timers.delete(id); resolve(isCurrent(run)); }, ms);
      timers.add(id);
    });
  }

  function later(fn, ms, run) {
    const id = setTimeout(() => { timers.delete(id); if (isCurrent(run)) fn(); }, ms);
    timers.add(id);
  }

  function shuffle(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // ---------- Quando si può giocare ----------

  function slotMatches(slot, when) {
    const hour = when.getHours();
    const iso = ((when.getDay() + 6) % 7) + 1; // lunedì = 1 … domenica = 7
    const prevIso = ((iso + 5) % 7) + 1;
    if (slot.from < slot.to) return slot.days.includes(iso) && hour >= slot.from && hour < slot.to;
    // Fascia che passa la mezzanotte: appartiene al giorno in cui comincia
    return (slot.days.includes(iso) && hour >= slot.from) || (slot.days.includes(prevIso) && hour < slot.to);
  }

  function quietNow(when = new Date()) {
    return settings.quiet.some((slot) => slotMatches(slot, when));
  }

  function enabledGames() {
    return GAMES.filter((g) => settings.games[g.id]);
  }

  function allowedNow() {
    return settings.enabled && enabledGames().length > 0 && !quietNow();
  }

  function refreshButton() {
    if (!ui.button) return;
    ui.button.hidden = !allowedNow();
    if (app.layoutGrid) app.layoutGrid();
    // Fuori orario un gioco aperto del bambino si chiude da solo e si torna alle tessere
    // (non la composizione o la prova di una storia fatte dall'adulto con le impostazioni sbloccate)
    const adult = document.body.classList.contains('mode-adult');
    if (!allowedNow() && !adult && (isOpen() || boardGame)) exitAll();
  }

  // ---------- Schermata dei giochi ----------

  let current = null; // gioco aperto nella schermata (null = elenco dei giochi)
  let inactivityTimer = null;

  function isOpen() {
    return !ui.screen.hidden;
  }

  function touchActivity() {
    clearTimeout(inactivityTimer);
    if (!isOpen() && !boardGame) return;
    inactivityTimer = setTimeout(() => { if (!composer) exitAll(); }, INACTIVITY_MS);
  }

  function setHeader(title, withBack) {
    ui.title.textContent = title;
    ui.back.hidden = !withBack;
    const quickHelp = document.getElementById('btn-help');
    ui.help.hidden = !quickHelp || quickHelp.hidden;
  }

  function openScreen() {
    if (!app.ready || !allowedNow()) return;
    stopBoardGame();
    ui.screen.hidden = false;
    document.body.classList.add('games-open');
    showDashboard();
    touchActivity();
    ui.home.focus();
  }

  // Uscita immediata: si torna alle tessere, la voce si zittisce
  function exitScreen() {
    newRun();
    speech.stop();
    current = null;
    ui.screen.hidden = true;
    ui.body.replaceChildren();
    document.body.classList.remove('games-open');
    clearTimeout(inactivityTimer);
    if (app.layoutGrid) app.layoutGrid();
  }

  function exitAll() {
    if (composer) { cancelComposer(); return; }
    stopBoardGame();
    exitScreen();
  }

  function showDashboard() {
    newRun();
    speech.stop();
    current = null;
    setHeader(t('gamesTitle'), false);
    const grid = el('div', 'games-dashboard');
    enabledGames().forEach((game) => {
      const card = el('button', 'game-card');
      card.type = 'button';
      card.append(el('span', 'game-card-icon', game.icon), el('span', 'game-card-name', t(game.nameKey)));
      card.addEventListener('click', () => startGame(game.id));
      grid.append(card);
    });
    ui.body.replaceChildren(grid);
  }

  function startGame(id) {
    const game = GAMES.find((g) => g.id === id);
    if (!game) return;
    say(t(game.nameKey));
    current = id;
    if (id === 'words') wordsGame();
    else if (id === 'stories') storiesList();
    else if (id === 'find') startFind();
    else if (id === 'memory') memoryGame();
    else if (id === 'sounds') soundsGame();
    else if (id === 'choice') choiceGame();
  }

  function pickWords(n, filter) {
    return shuffle(gamesData.words.filter(filter || (() => true))).slice(0, n);
  }

  function actions(...buttons) {
    const row = el('div', 'game-actions');
    row.append(...buttons);
    return row;
  }

  function actionButton(icon, labelKey, onClick, primary) {
    const btn = el('button', `game-action${primary ? ' is-primary' : ''}`);
    btn.type = 'button';
    btn.append(el('span', 'game-action-icon', icon), el('span', null, t(labelKey)));
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ---------- Parole e lettere ----------

  function displayCase(text) {
    const mode = document.documentElement.dataset.labelCase;
    if (mode === 'upper') return text.toLocaleUpperCase(i18n.language);
    if (mode === 'lower') return text.toLocaleLowerCase(i18n.language);
    return text;
  }

  function letterName(char) {
    const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const names = gamesData.letterNames[i18n.language] || gamesData.letterNames.it;
    if (names[base]) return names[base];
    if (/^\d$/.test(base)) return base;
    return '';
  }

  // Nomi delle lettere: una lettera alla volta («bi», «acca»…)
  function nameUnits(chars) {
    return chars.map((char, i) => ({ indexes: [i], speak: letterName(char) })).filter((u) => !/\s/.test(chars[u.indexes[0]]));
  }

  /*
   * Suoni delle lettere (come chiede la logopedia), adattati alla voce del browser, che non sa dire una consonante
   * da sola: le consonanti che si possono allungare si leggono allungate («mmm», «sss»); le altre si leggono unite
   * alla vocale che segue, come sillaba («ca» di cane). I gruppi gn, gli, sc, ch, gh, ci/gi e qu valgono un suono
   * solo; le doppie si leggono una volta; la h non si sente. Il risultato è approssimato, non perfetto.
   */
  const CONTINUANTS = { f: 'fff', l: 'lll', m: 'mmm', n: 'nnn', r: 'rrr', s: 'sss', v: 'vvv', z: 'zzz' };
  const EN_VOWELS = { a: 'ah', e: 'eh', i: 'ih', o: 'oh', u: 'uh', y: 'ee' };

  function soundUnits(chars, lang) {
    const base = chars.map((c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
    const isVowel = (i) => i < base.length && 'aeiou'.includes(base[i]);
    const units = [];
    let i = 0;
    const take = (n, speak) => {
      units.push({ indexes: range(i, i + n), speak });
      i += n;
    };
    // Parte del gruppo che finisce con la vocale (es. «ca», «tto» → «to»)
    const syllable = (from, to) => base.slice(from, to).join('').replace(/(.)\1/g, '$1');
    while (i < base.length) {
      const c = base[i];
      const next = base[i + 1] || '';
      const after = base[i + 2] || '';
      if (/\s/.test(c) || !/[a-z0-9]/.test(c)) { i += 1; continue; }
      if (/\d/.test(c)) { take(1, c); continue; }
      if (isVowel(i)) { take(1, lang === 'en' ? EN_VOWELS[c] : c); continue; }
      if (lang === 'en') {
        const pair = c + next;
        if (pair === 'sh') { take(2, 'shhh'); continue; }
        if (pair === 'th') { take(2, 'thh'); continue; }
        if (pair === 'ch' || pair === 'ph') {
          if (isVowel(i + 2)) { take(3, pair === 'ph' ? `f${EN_VOWELS[after] || after}` : `ch${EN_VOWELS[after] || after}`); continue; }
          take(2, pair === 'ph' ? 'fff' : 'ch');
          continue;
        }
      } else {
        // Gruppi dell'italiano
        if (c === 'g' && next === 'l' && after === 'i') {
          const n = isVowel(i + 3) ? 4 : 3;
          take(n, syllable(i, i + n));
          continue;
        }
        if (c === 'g' && next === 'n') { const n = isVowel(i + 2) ? 3 : 2; take(n, n === 3 ? syllable(i, i + 3) : 'gn'); continue; }
        if (c === 's' && next === 'c' && (after === 'e' || after === 'i')) {
          const n = after === 'i' && isVowel(i + 3) ? 4 : 3;
          take(n, syllable(i, i + n));
          continue;
        }
        if (c === 'h') { take(1, ''); continue; } // la h non si sente
      }
      if (CONTINUANTS[c] && !(c === 's' && lang !== 'en' && next === 'c')) {
        const n = next === c ? 2 : 1; // doppia: un suono solo
        take(n, CONTINUANTS[c]);
        continue;
      }
      // Consonante che non si allunga: insieme alla vocale (e alla h o alla i che la addolciscono)
      let j = i + 1;
      while (j < base.length && base[j] === c) j += 1; // doppie
      if (base[j] === 'h' && (c === 'c' || c === 'g')) j += 1;
      if (c === 'c' && base[j] === 'q') j += 1; // «cq» di acqua: un suono solo con «qu»
      if ((c === 'q' || base[j - 1] === 'q') && base[j] === 'u') j += 1;
      if ((c === 'c' || c === 'g') && base[j] === 'i' && isVowel(j + 1) && lang !== 'en') j += 1;
      if (isVowel(j)) {
        const piece = syllable(i, j + 1);
        take(j + 1 - i, lang === 'en' ? piece.slice(0, -1) + (EN_VOWELS[base[j]] || base[j]) : piece);
        continue;
      }
      // Consonante senza vocale dopo: in inglese con una «uh» breve (come nella fonetica inglese),
      // in italiano si legge il suo nome (meglio di nulla)
      take(j - i, lang === 'en' ? `${c}uh` : letterName(chars[i]));
    }
    return units;
  }

  const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

  function wordsGame() {
    const run = newRun();
    setHeader(t('gameWords'), true);
    const grid = el('div', 'game-grid game-grid-6');
    pickWords(6).forEach((word) => {
      const tile = gameTile(word);
      tile.addEventListener('click', () => spellWord(word));
      grid.append(tile);
    });
    ui.body.replaceChildren(grid, actions(actionButton('🔀', 'gameMoreWords', () => wordsGame())));
    void run;
  }

  async function spellWord(word) {
    const run = newRun();
    speech.stop();
    const text = labelOf(word);
    const view = el('div', 'spell-view');
    const big = gameTile(word, 'game-tile-big');
    big.addEventListener('click', () => spellWord(word));
    const letter = el('div', 'spell-letter');
    letter.setAttribute('aria-hidden', 'true');
    const row = el('div', 'spell-row');
    row.setAttribute('aria-hidden', 'true');
    const tools = actions(
      actionButton('🔁', 'gameAgain', () => spellWord(word)),
      actionButton('🔤', 'gameOtherWords', () => wordsGame(), true),
    );
    tools.hidden = true;
    view.append(big, letter, row, tools);
    ui.body.replaceChildren(view);

    await sayAndWait(text, run);
    if (!(await wait(450, run))) return;
    const chars = [...displayCase(text)];
    const units = settings.letterMode === 'names' ? nameUnits(chars) : soundUnits(chars, i18n.language);
    const boxes = chars.map((char) => (/\s/.test(char) ? el('span', 'spell-gap') : el('span', 'spell-box', char)));
    for (const unit of units) {
      if (!isCurrent(run)) return;
      row.querySelectorAll('.is-current').forEach((n) => n.classList.remove('is-current'));
      unit.indexes.forEach((i) => {
        if (!boxes[i].isConnected) row.append(boxes[i]);
        boxes[i].classList.add('is-current');
        if (!unit.speak) boxes[i].classList.add('is-silent');
      });
      letter.textContent = unit.indexes.map((i) => chars[i]).join('');
      if (unit.speak) await sayAndWait(unit.speak, run);
      if (!(await wait(unit.speak ? 280 : 500, run))) return;
    }
    boxes.forEach((b) => { if (!b.isConnected) row.append(b); });
    row.querySelectorAll('.is-current').forEach((n) => n.classList.remove('is-current'));
    letter.textContent = '';
    row.classList.add('is-whole');
    await sayAndWait(text, run);
    if (isCurrent(run)) tools.hidden = false;
  }

  // ---------- Memory ----------

  let memoryPairs = 3;

  function memoryGame() {
    const run = newRun();
    setHeader(t('gameMemory'), true);
    const words = pickWords(memoryPairs);
    const cards = shuffle([...words, ...words]).map((word) => ({ word, open: false, done: false }));
    const grid = el('div', `game-grid memory-grid memory-${cards.length}`);
    let first = null;
    let busy = false;
    const draw = (card) => {
      card.node.replaceChildren();
      card.node.classList.toggle('is-open', card.open || card.done);
      card.node.classList.toggle('is-done', card.done);
      if (card.open || card.done) card.node.append(tileFace(card.word));
      else card.node.append(el('span', 'memory-back', '?'));
      card.node.setAttribute('aria-label', card.open || card.done ? labelOf(card.word) : t('gameMemoryHidden'));
    };
    cards.forEach((card) => {
      card.node = el('button', 'game-tile memory-card');
      card.node.type = 'button';
      draw(card);
      card.node.addEventListener('click', () => {
        if (busy || card.open || card.done || !isCurrent(run)) return;
        card.open = true;
        draw(card);
        say(labelOf(card.word));
        if (!first) { first = card; return; }
        const a = first;
        first = null;
        busy = true;
        if (a.word.key === card.word.key) {
          a.done = true; card.done = true; a.open = false; card.open = false;
          later(() => {
            draw(a); draw(card); busy = false;
            if (cards.every((c) => c.done)) finish();
          }, 600, run);
        } else {
          later(() => { a.open = false; card.open = false; draw(a); draw(card); busy = false; }, 1400, run);
        }
      });
      grid.append(card.node);
    });
    const more = actionButton('➕', memoryPairs >= 6 ? 'gameMemoryFewer' : 'gameMemoryMore', () => {
      memoryPairs = memoryPairs >= 6 ? 3 : memoryPairs + (memoryPairs === 4 ? 2 : 1);
      memoryGame();
    });
    const finish = () => {
      say(t('gameWellDone'));
      ui.body.append(el('p', 'game-cheer', t('gameWellDone')));
      tools.replaceChildren(actionButton('🔁', 'gameAgain', () => memoryGame(), true), more);
    };
    const tools = actions(more);
    ui.body.replaceChildren(grid, tools);
  }

  // ---------- Indovina il suono ----------

  function soundsGame() {
    const run = newRun();
    setHeader(t('gameSounds'), true);
    const pool = gamesData.words.filter((w) => w.sound);
    const choices = shuffle(pool).slice(0, 3);
    const target = choices[crypto.getRandomValues(new Uint32Array(1))[0] % choices.length];
    const sound = target.sound[i18n.language] || target.sound.it;
    const ask = () => say(format('gameSoundAsk', { sound }));
    const prompt = el('button', 'game-prompt');
    prompt.type = 'button';
    prompt.append(el('span', 'game-action-icon', '🔊'), el('span', null, format('gameSoundAsk', { sound })));
    prompt.addEventListener('click', ask);
    const grid = el('div', 'game-grid game-grid-3');
    let solved = false;
    choices.forEach((word) => {
      const tile = gameTile(word);
      tile.addEventListener('click', () => {
        if (solved || !isCurrent(run)) return;
        if (word.key === target.key) {
          solved = true;
          tile.classList.add('is-right');
          say(format('gameSoundRight', { word: labelOf(word), sound }));
          later(() => soundsGame(), 3200, run);
        } else {
          tile.classList.add('is-wrong');
          const own = word.sound ? word.sound[i18n.language] || word.sound.it : '';
          say(own ? format('gameSoundWrong', { word: labelOf(word), sound: own }) : labelOf(word));
          later(() => tile.classList.remove('is-wrong'), 1200, run);
        }
      });
      grid.append(tile);
    });
    ui.body.replaceChildren(prompt, grid, actions(actionButton('🔀', 'gameNext', () => soundsGame())));
    later(ask, 700, run);
  }

  // ---------- Scegli tu ----------

  function choiceGame() {
    const run = newRun();
    setHeader(t('gameChoice'), true);
    // Due cose dello stesso tipo (due cibi, due giochi…): una scelta vera, non un indovinello
    const cats = shuffle(['animal', 'toy', 'food']);
    const pair = pickWords(2, (w) => w.cat === cats[0]);
    const question = format('gameChoiceAsk', { a: labelOf(pair[0]), b: labelOf(pair[1]) });
    const prompt = el('button', 'game-prompt');
    prompt.type = 'button';
    prompt.append(el('span', 'game-action-icon', '🔊'), el('span', null, question));
    prompt.addEventListener('click', () => say(question));
    const grid = el('div', 'game-grid game-grid-2');
    let chosen = false;
    pair.forEach((word) => {
      const tile = gameTile(word, 'game-tile-choice');
      tile.addEventListener('click', () => {
        if (!isCurrent(run)) return;
        chosen = true;
        grid.querySelectorAll('.game-tile').forEach((n) => n.classList.toggle('is-dimmed', n !== tile));
        tile.classList.add('is-right');
        say(labelOf(word));
        void chosen;
      });
      grid.append(tile);
    });
    ui.body.replaceChildren(prompt, grid, actions(actionButton('🔀', 'gameNext', () => choiceGame(), true)));
    later(() => say(question), 600, run);
  }

  // ---------- Storie: elenco ----------

  // Immagine della copertina: la tessera della parola scelta nelle schede, poi il pittogramma del gioco
  function storyCover(story) {
    const coverText = story.coverWord ? story.coverWord[i18n.language] || story.coverWord.it : null;
    const candidates = [];
    if (coverText) candidates.push({ label: coverText });
    // Storia dell'adulto: la prima parola che ha un'immagine
    story.sentences.flat().forEach((w) => candidates.push(w));
    for (const word of candidates) {
      const where = locateWord(word);
      if (!where) continue;
      const item = (data.page(where.pageId) || { cells: [] }).cells.find((c) => c.id === where.cellId);
      const src = item && data.imageUrl(item.imageId);
      if (src) return { src, emoji: '' };
    }
    const fallback = gamesData.words.find((w) => w.key === story.coverKey);
    if (fallback) return { src: wordImage(fallback), emoji: fallback.emoji };
    return { src: null, emoji: '📖' };
  }

  function playableStories() {
    return allStories().filter((s) => s.enabled && resolveStory(s).complete);
  }

  function storiesList() {
    newRun();
    setHeader(t('gameStories'), true);
    const list = playableStories();
    if (!list.length) {
      ui.body.replaceChildren(el('p', 'game-empty', t('gameStoriesNone')));
      return;
    }
    const grid = el('div', 'game-grid story-grid');
    list.forEach((story) => {
      const cover = storyCover(story);
      const tile = gameTile({ text: story.title, src: cover.src, emoji: cover.emoji, label: { it: story.title } }, 'story-tile');
      const dots = el('span', 'story-level', '●'.repeat(story.level) + '○'.repeat(3 - story.level));
      dots.setAttribute('aria-label', format('storyLevelN', { n: story.level }));
      tile.append(dots);
      tile.addEventListener('click', () => playStory(story));
      grid.append(tile);
    });
    ui.body.replaceChildren(grid);
  }

  // ---------- Giochi sulle schede vere: fascia con «Basta» ----------

  let boardGame = null; // { kind: 'story' | 'find' | 'compose', … }

  function bannerButton(icon, labelKey, onClick, className) {
    const btn = el('button', `banner-btn ${className || ''}`.trim());
    btn.type = 'button';
    btn.append(el('span', 'banner-btn-icon', icon), el('span', 'banner-btn-text', t(labelKey)));
    btn.setAttribute('aria-label', t(labelKey));
    btn.addEventListener('click', onClick);
    return btn;
  }

  function stopButton() {
    return bannerButton('■', 'gameStop', () => { stopBoardGame(); app.goToPage(data.homePageId); }, 'banner-stop');
  }

  function showBanner(...children) {
    ui.banner.replaceChildren(...children);
    if (ui.banner.hidden) {
      ui.banner.hidden = false;
      app.layoutGrid();
    }
  }

  function hideBanner() {
    if (ui.banner.hidden) return;
    ui.banner.hidden = true;
    ui.banner.replaceChildren();
    app.layoutGrid();
  }

  // Ferma il gioco sulle schede: le tessere tornano subito alla comunicazione normale
  function stopBoardGame(options = {}) {
    if (!boardGame) return;
    const wasStory = boardGame.kind === 'story';
    boardGame = null;
    newRun();
    speech.stop();
    app.highlight(null);
    app.setGame(null);
    if (wasStory) app.setSentence([]);
    // Fermata da un tocco sullo schermo: la fascia sparisce dopo il tocco, così le tessere non si spostano
    // sotto il dito e il tocco vale per la tessera scelta
    if (options.deferBanner) {
      ui.banner.replaceChildren();
      const done = () => { clearTimeout(timer); document.removeEventListener('click', done, true); setTimeout(() => { if (!boardGame) hideBanner(); }, 0); };
      const timer = setTimeout(done, 1500);
      document.addEventListener('click', done, true);
    } else {
      hideBanner();
    }
    clearTimeout(inactivityTimer);
  }

  function beginBoardGame(kind, onTap) {
    exitScreen();
    boardGame = { kind };
    app.setGame({ kind, onTap });
    app.setSentence([]);
    app.goToPage(data.homePageId);
    touchActivity();
  }

  // ---------- Storie: il tool compone la frase toccando le tessere ----------

  function homeButtonNode() { return document.getElementById('btn-home'); }
  function speakButtonNode() { return document.getElementById('btn-speak'); }
  function clearButtonNode() { return document.getElementById('btn-clear'); }

  async function tapNode(node, step, run) {
    app.highlight(node);
    if (!(await wait(step, run))) return false;
    if (node) app.flash(node);
    return true;
  }

  async function playStory(story) {
    const plan = resolveStory(story);
    if (!plan.complete) return;
    beginBoardGame('story', null);
    const run = runId;
    const step = SPEEDS[settings.storySpeed] || SPEEDS.normal;
    showBanner(stopButton(), el('span', 'banner-title', story.title));
    if (!(await wait(500, run))) return;
    await sayAndWait(story.title, run);
    for (const sentence of plan.steps) {
      for (const { where } of sentence) {
        if (!isCurrent(run)) return;
        // Se la tessera non è nella pagina mostrata, si riparte dalla Home come farebbe il bambino
        if (app.pageId !== where.pageId && app.pageId !== data.homePageId) {
          if (!(await tapNode(homeButtonNode(), step * 0.7, run))) return;
          app.goToPage(data.homePageId);
        }
        // Cartelle da aprire per arrivare alla tessera
        const start = Math.max(0, where.path.indexOf(app.pageId));
        for (let i = start; i < where.path.length - 1; i += 1) {
          const parent = data.page(where.path[i]);
          const folder = parent && data.orderedCells(parent).find((c) => c.kind === 'folder' && c.targetPageId === where.path[i + 1]);
          if (!folder) break;
          if (!(await tapNode(app.cellNode(folder.id), step, run))) return;
          if (!folder.silent) app.sayWord(folder.speak || folder.label);
          app.openFolder(folder.targetPageId);
          if (!(await wait(step * 0.4, run))) return;
        }
        const page = data.page(where.pageId);
        const item = page && page.cells.find((c) => c.id === where.cellId);
        if (!item) continue;
        if (!(await tapNode(app.cellNode(item.id), step, run))) return;
        app.pushWord(item);
        await sayAndWait(item.speak || item.label, run);
        if (!(await wait(step * 0.25, run))) return;
      }
      // Frase completa: si tocca «Leggi la frase», poi la frase si cancella per la successiva
      if (!(await tapNode(speakButtonNode(), step, run))) return;
      await new Promise((resolve) => {
        const cap = setTimeout(resolve, 9000);
        if (!app.speakSentence(() => { clearTimeout(cap); resolve(); })) { clearTimeout(cap); resolve(); }
      });
      if (!(await wait(step, run))) return;
      if (!(await tapNode(clearButtonNode(), step * 0.5, run))) return;
      app.setSentence([]);
      app.highlight(null);
      if (!(await wait(step * 0.4, run))) return;
    }
    if (!isCurrent(run)) return;
    app.highlight(null);
    if (app.pageId !== data.homePageId) app.goToPage(data.homePageId);
    say(t('storyEnd'));
    showBanner(
      stopButton(),
      el('span', 'banner-title', t('storyEnd')),
      bannerButton('🔁', 'gameAgain', () => playStory(story)),
      bannerButton('📖', 'storyOthers', () => { stopBoardGame(); openScreen(); startGame('stories'); }),
    );
  }

  // Nelle Storie basta toccare lo schermo per fermare tutto: il tocco poi vale come sempre (es. una tessera)
  document.addEventListener('pointerdown', (event) => {
    if (boardGame && boardGame.kind === 'story' && !ui.banner.contains(event.target)) stopBoardGame({ deferBanner: true });
  }, true);

  // ---------- Trova la tessera ----------

  const FIND_ROUNDS = 5;

  // Tessere visibili raggiungibili dalla Home, con il loro percorso (prima quelle della Home)
  function reachableTiles() {
    const out = [];
    const home = data.homePageId;
    const queue = [{ pageId: home, path: [home] }];
    const seen = new Set([home]);
    while (queue.length) {
      const { pageId, path } = queue.shift();
      const page = data.page(pageId);
      if (!page) continue;
      data.orderedCells(page).forEach((c) => {
        if (c.kind === 'folder' && c.targetPageId && !seen.has(c.targetPageId)) {
          seen.add(c.targetPageId);
          queue.push({ pageId: c.targetPageId, path: [...path, c.targetPageId] });
        } else if (c.kind === 'symbol' && c.label) {
          out.push({ item: c, pageId, path });
        }
      });
    }
    return out;
  }

  function startFind() {
    const tiles = reachableTiles();
    if (!tiles.length) return;
    const found = new Set();
    let round = 0;
    let target = null;
    let wrong = 0;
    let hintTimer = null;
    let run = 0;

    const ask = () => { if (target) say(format('gameFindAsk', { word: target.item.speak || target.item.label })); };

    const hint = () => {
      if (!target || !boardGame) return;
      const pageId = app.pageId;
      if (pageId === target.pageId) { app.highlight(app.cellNode(target.item.id)); return; }
      const at = target.path.indexOf(pageId);
      if (at >= 0) {
        const page = data.page(pageId);
        const folder = page && data.orderedCells(page).find((c) => c.kind === 'folder' && c.targetPageId === target.path[at + 1]);
        if (folder) { app.highlight(app.cellNode(folder.id)); return; }
      }
      app.highlight(homeButtonNode());
    };

    const armHint = () => {
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => { if (isCurrent(run)) hint(); }, 15000);
    };

    const next = () => {
      if (!isCurrent(run)) return;
      app.highlight(null);
      round += 1;
      if (round > FIND_ROUNDS) {
        clearTimeout(hintTimer);
        say(t('gameWellDone'));
        showBanner(stopButton(), el('span', 'banner-title', t('gameWellDone')), bannerButton('🔁', 'gameAgain', () => startFind()));
        target = null;
        return;
      }
      // I primi turni nella Home, poi anche dentro le cartelle
      const inHome = tiles.filter((x) => x.path.length === 1 && !found.has(x.item.id));
      const deeper = tiles.filter((x) => x.path.length > 1 && !found.has(x.item.id));
      // Meglio le cose (nomi con un'immagine): sono le più facili da riconoscere
      const withImage = (list) => {
        const img = list.filter((x) => x.item.imageId);
        const nouns = img.filter((x) => x.item.wordType === 'noun');
        return nouns.length ? nouns : img.length ? img : list;
      };
      let pool = round <= 2 ? inHome : (deeper.length ? deeper : inHome);
      if (!pool.length) pool = tiles;
      pool = withImage(pool);
      target = pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length];
      wrong = 0;
      if (app.pageId !== data.homePageId) app.goToPage(data.homePageId);
      const picture = el('span', 'banner-target');
      const src = data.imageUrl(target.item.imageId);
      if (src) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        picture.append(img);
      }
      picture.append(el('span', 'banner-target-word', target.item.label));
      showBanner(stopButton(), el('span', 'banner-title', t('gameFindTitle')), picture, bannerButton('🔊', 'gameListen', ask));
      ask();
      armHint();
    };

    const onTap = (item, cell) => {
      if (!target) return true;
      touchActivity();
      if (item.kind === 'folder') { armHint(); return false; } // la cartella si apre come sempre
      if (item.id === target.item.id || wordKey(item.label) === wordKey(target.item.label)) {
        found.add(target.item.id);
        app.highlight(cell);
        clearTimeout(hintTimer);
        say(format('gameFindRight', { word: item.speak || item.label }));
        target = null;
        later(next, 2200, run);
        return true;
      }
      // Tessera diversa: si sente la sua parola, poi la domanda di nuovo; dopo due errori un aiuto
      wrong += 1;
      app.sayWord(item.speak || item.label);
      later(() => { ask(); if (wrong >= 2) hint(); }, 1300, run);
      armHint();
      return true;
    };

    beginBoardGame('find', onTap);
    run = runId;
    next();
  }

  // ---------- Composizione di una storia (dalle impostazioni, con il PIN) ----------

  let composer = null; // { onDone, onCancel }

  function entryFor(word) {
    const where = locateWord(word);
    const item = where && (data.page(where.pageId) || { cells: [] }).cells.find((c) => c.id === where.cellId);
    if (item) return { cellId: item.id, label: item.label, speak: item.speak, kind: item.kind, wordType: item.wordType, color: item.color, imageId: item.imageId };
    return { cellId: null, label: word.label, speak: null, kind: 'symbol', wordType: 'noun', color: null, imageId: null };
  }

  /*
   * L'adulto compone una frase toccando le tessere vere (anche dentro le cartelle), come il bambino:
   * così ogni parola ha per forza la sua tessera. «Fatto» la salva nella storia, «Annulla» la lascia com'era.
   */
  function startComposer({ words, onDone, onCancel }) {
    const ui2 = window.PicSpeak.settingsUi;
    if (ui2) ui2.closeSettings();
    composer = { onDone, onCancel };
    boardGame = { kind: 'compose' };
    app.setGame({
      kind: 'compose',
      onTap(item) {
        if (item.kind === 'folder') return false;
        if (app.pushWord(item)) app.sayWord(item.speak || item.label);
        return true;
      },
    });
    app.goToPage(data.homePageId);
    app.setSentence((words || []).map(entryFor));
    const done = bannerButton('✓', 'storyComposeDone', () => finishComposer(true), 'banner-done');
    const cancel = bannerButton('✕', 'cancel', () => finishComposer(false));
    showBanner(el('span', 'banner-title banner-help', t('storyComposeHelp')), cancel, done);
  }

  function finishComposer(save) {
    if (!composer) return;
    const { onDone, onCancel } = composer;
    const words = app.sentence().map((e) => (e.cellId ? { label: e.label, cellId: e.cellId } : { label: e.label }));
    composer = null;
    boardGame = null;
    app.setGame(null);
    app.setSentence([]);
    hideBanner();
    if (save && words.length) onDone(words); else if (onCancel) onCancel();
  }

  function cancelComposer() {
    finishComposer(false);
  }

  // ---------- Collegamenti ----------

  function bind() {
    ui.button.addEventListener('click', () => { app.flash(ui.button); openScreen(); });
    ui.home.addEventListener('click', () => exitAll());
    ui.back.addEventListener('click', () => showDashboard());
    ui.help.addEventListener('click', () => {
      const quickHelp = document.getElementById('btn-help');
      if (quickHelp) quickHelp.click();
      app.flash(ui.help);
    });
    ['pointerdown', 'keydown'].forEach((name) => document.addEventListener(name, () => { if (isOpen() || boardGame) touchActivity(); }, true));
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (isOpen()) exitAll();
      else if (boardGame && boardGame.kind !== 'compose') { stopBoardGame(); }
    });
    // Entrando nelle impostazioni (o uscendone) i giochi si fermano; la composizione vale solo con il PIN
    let wasAdult = document.body.classList.contains('mode-adult');
    new MutationObserver(() => {
      const adult = document.body.classList.contains('mode-adult');
      if (adult === wasAdult) return;
      wasAdult = adult;
      if (composer) cancelComposer();
      else if (boardGame) stopBoardGame();
      if (isOpen()) exitScreen();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Le fasce orarie si controllano ogni mezzo minuto
    setInterval(refreshButton, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshButton(); });
  }

  bind();
  load();

  window.PicSpeak.games = {
    GAMES,
    SPEEDS,
    LIMITS,
    FORMAT_VERSION,
    get settings() { return structuredCloneSafe(settings); },
    get userStories() { return structuredCloneSafe(userStories); },
    saveSettings,
    saveStories,
    cleanStory,
    allStories,
    resolveStory,
    playStory,
    startComposer,
    missingPictograms,
    downloadPictograms,
    quietNow,
    allowedNow,
    onChange: (fn) => listeners.add(fn),
    exit: exitAll,
  };
})();
