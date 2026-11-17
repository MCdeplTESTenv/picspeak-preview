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

  // options.onEnd: chiamata quando la lettura finisce (o viene interrotta)
  function speak(text, locale, options = {}) {
    if (!synth || !text) return false;
    // Interrompe la frase precedente: il tocco più recente ha la priorità
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    const voice = bestVoice(locale);
    if (voice) utterance.voice = voice;
    utterance.rate = prefs.rate;
    utterance.pitch = prefs.pitch;
    utterance.volume = 1;
    if (typeof options.onEnd === 'function') {
      let called = false;
      const end = () => { if (!called) { called = true; options.onEnd(); } };
      utterance.addEventListener('end', end);
      utterance.addEventListener('error', end);
    }
    synth.speak(utterance);
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
    voicesFor,
    bestVoice,
    setPrefs,
    getPrefs: () => ({ ...prefs, voiceByLang: { ...prefs.voiceByLang } }),
    onVoicesChanged: (fn) => listeners.add(fn),
    get supported() { return Boolean(synth); },
  };
})();
