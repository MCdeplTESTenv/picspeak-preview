/*
 * Sintesi vocale con la Web Speech API del browser.
 * Nessun servizio esterno e nessun file da scaricare: si usano le voci del dispositivo.
 * La qualità dipende dalle voci installate; il tool sceglie la migliore disponibile,
 * oppure quella scelta dall'adulto nelle impostazioni (voce, velocità, tono).
 */
(function () {
  'use strict';

  const synth = window.speechSynthesis;
  let voices = [];
  const listeners = new Set();

  // Preferenze dell'adulto: nome della voce per lingua, velocità e tono
  const prefs = { voiceByLang: {}, rate: 0.9, pitch: 1 };

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    listeners.forEach((fn) => fn());
  }

  // Le voci arrivano in modo asincrono su Chrome/Edge
  if (synth) {
    loadVoices();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', loadVoices);
    } else {
      synth.onvoiceschanged = loadVoices;
    }
  }

  function normalizeLang(voice) {
    return (voice.lang || '').replace('_', '-').toLowerCase();
  }

  // Voci adatte a una lingua (es. 'it-IT' → tutte le voci italiane)
  function voicesFor(locale) {
    if (!voices.length) loadVoices();
    const lang = locale.split('-')[0].toLowerCase();
    return voices.filter((v) => normalizeLang(v).startsWith(lang));
  }

  // Punteggio di qualità: le voci "migliorate/naturali" suonano molto meno metalliche
  function score(voice, locale) {
    let points = 0;
    const name = voice.name || '';
    if (/premium|enhanced|migliorat|neural|natural|naturale/i.test(name)) points += 4;
    if (/google/i.test(name)) points += 3; // voci Google di Chrome: buone, ma solo online
    if (/siri/i.test(name)) points += 3;
    if (/online/i.test(name)) points += 2; // voci "Online (Natural)" di Edge
    if (/compact|eloquence|espeak/i.test(name)) points -= 3; // voci robotiche
    if (normalizeLang(voice) === locale.toLowerCase()) points += 1;
    // Senza connessione servono le voci installate sul dispositivo
    if (voice.localService) points += navigator.onLine ? 0 : 6;
    else if (!navigator.onLine) points -= 10;
    return points;
  }

  function bestVoice(locale) {
    const pool = voicesFor(locale);
    const lang = locale.split('-')[0];
    const chosen = prefs.voiceByLang[lang];
    if (chosen) {
      const voice = pool.find((v) => v.name === chosen);
      // La voce scelta si usa se disponibile (offline, una voce online non funzionerebbe)
      if (voice && (voice.localService || navigator.onLine)) return voice;
    }
    return pool.slice().sort((a, b) => score(b, locale) - score(a, locale))[0] || null;
  }

  /*
   * Coda delle parole. Le parole delle tessere toccate di seguito si leggono una dopo l'altra, senza
   * tagliare quella in corso. La coda è gestita qui (una sola frase alla volta passata al browser)
   * invece che con la coda interna di speechSynthesis, che su Safari/iOS e Chrome a volte si blocca.
   * Le letture «importanti» (frase intera, frasi rapide, prova della voce) interrompono e svuotano la coda.
   */
  const MAX_WAITING = 3; // parole in attesa al massimo: con tocchi a raffica si saltano le più vecchie
  const queue = []; // { text, locale, options } in attesa
  let current = null; // lettura in corso: { queued, utterance, done, finish }
  let watchdog = 0;

  function buildUtterance(text, locale) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    const voice = bestVoice(locale);
    if (voice) utterance.voice = voice;
    utterance.rate = prefs.rate;
    utterance.pitch = prefs.pitch;
    utterance.volume = 1;
    return utterance;
  }

  function notifyEnd(job) {
    if (job.options && typeof job.options.onEnd === 'function') job.options.onEnd();
  }

  // Avvia una lettura; quando finisce (o va in errore) passa alla parola successiva della coda
  function start(job, queued) {
    const utterance = buildUtterance(job.text, job.locale);
    // Il riferimento all'utterance resta in «current»: su Safari, se si perde, l'evento di fine può non arrivare
    const entry = { queued, utterance, done: false, late: false };
    entry.finish = () => {
      if (entry.done) return;
      entry.done = true;
      notifyEnd(job);
      // Solo la lettura ancora attiva fa partire la successiva (una lettura interrotta no)
      if (current === entry) {
        current = null;
        clearTimeout(watchdog);
        next();
      }
    };
    utterance.addEventListener('end', entry.finish);
    utterance.addEventListener('error', entry.finish);
    current = entry;
    // Rete di sicurezza: se il browser non avvisa della fine (capita su Safari), si va avanti lo stesso
    clearTimeout(watchdog);
    const expected = 2500 + (job.text.length * 180) / (prefs.rate || 1);
    const check = () => {
      if (current !== entry) return;
      // Se il browser sta ancora parlando si concede altro tempo, una volta sola
      if (synth.speaking && !entry.late) { entry.late = true; watchdog = setTimeout(check, 4000); return; }
      entry.finish();
    };
    watchdog = setTimeout(check, expected);
    synth.speak(utterance);
  }

  function next() {
    const job = queue.shift();
    if (job) start(job, true);
  }

  // Interrompe la lettura in corso e svuota la coda (chi aspettava la fine viene comunque avvisato)
  function stop() {
    if (!synth) return;
    const interrupted = current;
    const waiting = queue.splice(0);
    current = null;
    clearTimeout(watchdog);
    synth.cancel();
    if (interrupted) interrupted.finish();
    waiting.forEach(notifyEnd);
  }

  /*
   * options.onEnd: chiamata quando la lettura finisce (o viene interrotta).
   * options.queue: true = parola di una tessera: si mette in coda dopo le altre parole senza tagliarle.
   * Senza queue (frase intera, frasi rapide, prova della voce) la lettura interrompe tutto, come prima.
   */
  function speak(text, locale, options = {}) {
    if (!synth || !text) return false;
    const job = { text, locale, options };
    // Si accoda solo dietro ad altre parole: una frase intera in corso si interrompe come prima
    if (options.queue && current && current.queued) {
      queue.push(job);
      // Tocchi a raffica: si tengono le parole più recenti, così la voce non resta indietro
      while (queue.length > MAX_WAITING) notifyEnd(queue.shift());
      return true;
    }
    stop();
    start(job, Boolean(options.queue));
    return true;
  }

  function setPrefs(next) {
    if (!next) return;
    if (next.voiceByLang) prefs.voiceByLang = { ...next.voiceByLang };
    if (typeof next.rate === 'number') prefs.rate = next.rate;
    if (typeof next.pitch === 'number') prefs.pitch = next.pitch;
  }

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.speech = {
    speak,
    stop,
    voicesFor,
    bestVoice,
    setPrefs,
    getPrefs: () => ({ ...prefs, voiceByLang: { ...prefs.voiceByLang } }),
    onVoicesChanged: (fn) => listeners.add(fn),
    get supported() { return Boolean(synth); },
  };
})();
