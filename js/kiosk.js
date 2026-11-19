/*
 * App sempre aperta: schermo sempre acceso (Screen Wake Lock) e schermo intero (Fullscreen API).
 * Sono due preferenze del solo dispositivo (archivio "settings": 'keepScreenOn', 'autoFullscreen'):
 * non fanno parte delle schede; «Ripristina le impostazioni iniziali» le azzera. Nel futuro file di backup
 * (Tappa 5) vanno escluse, perché valgono per questo dispositivo.
 * Il blocco vero dentro l'app (Accesso guidato, Fissa app, chiosco) lo fa il sistema operativo:
 * qui ci sono solo il riconoscimento del sistema e le due opzioni che il browser consente.
 */
(function () {
  'use strict';

  const { storage } = window.PicSpeak;
  const listeners = new Set();

  let keepScreenOn = false;
  let autoFullscreen = false;
  let sentinel = null;

  function notify() {
    listeners.forEach((fn) => fn());
  }

  // Sistema operativo, per mostrare per prime le istruzioni giuste
  function osFamily() {
    const ua = navigator.userAgent;
    // iPadOS si presenta come Mac: lo riconosciamo dal tocco
    if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    return 'other';
  }

  // ---------- Schermo sempre acceso ----------

  function wakeLockSupported() {
    return 'wakeLock' in navigator && window.isSecureContext;
  }

  async function acquireWakeLock() {
    if (!keepScreenOn || sentinel || !wakeLockSupported() || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
        notify();
      });
    } catch (error) {
      // Rifiutato (risparmio energetico, batteria scarica, pagina non visibile): si riprova al prossimo tocco
      sentinel = null;
    }
    notify();
  }

  async function releaseWakeLock() {
    const current = sentinel;
    sentinel = null;
    if (current) {
      try { await current.release(); } catch (error) { /* già rilasciato dal sistema */ }
    }
    notify();
  }

  // ---------- Schermo intero ----------

  function fullscreenSupported() {
    return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }

  function isFullscreen() {
    return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  }

  // Il browser permette lo schermo intero solo subito dopo un tocco o un tasto
  function enterFullscreen() {
    if (!fullscreenSupported() || isFullscreen()) return;
    const root = document.documentElement;
    try {
      const result = root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (error) {
      // Non consentito in questo momento: si riproverà al prossimo tocco
    }
  }

  function exitFullscreen() {
    if (!isFullscreen()) return;
    try {
      const result = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (error) { /* niente da fare */ }
  }

  // Le impostazioni aperte sono il momento dell'adulto: lì non si forza lo schermo intero
  function settingsOpen() {
    return document.body.classList.contains('settings-open');
  }

  // A ogni tocco: rientra a schermo intero se si era usciti, riprende lo schermo acceso se il sistema l'aveva tolto
  function onUserGesture() {
    if (autoFullscreen && !settingsOpen()) enterFullscreen();
    if (keepScreenOn && !sentinel) acquireWakeLock();
  }

  document.addEventListener('pointerup', onUserGesture, true);
  document.addEventListener('keydown', onUserGesture, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquireWakeLock();
  });
  document.addEventListener('fullscreenchange', notify);
  document.addEventListener('webkitfullscreenchange', notify);

  // ---------- Preferenze ----------

  async function setKeepScreenOn(value) {
    keepScreenOn = Boolean(value);
    try { await storage.set('keepScreenOn', keepScreenOn); } catch (error) { /* archivio non disponibile: vale per questa sessione */ }
    if (keepScreenOn) await acquireWakeLock();
    else await releaseWakeLock();
  }

  // Chiamata dal tocco sul pulsante: è già un gesto, quindi si entra subito a schermo intero
  async function setAutoFullscreen(value) {
    autoFullscreen = Boolean(value);
    if (autoFullscreen) enterFullscreen();
    else exitFullscreen();
    try { await storage.set('autoFullscreen', autoFullscreen); } catch (error) { /* vale per questa sessione */ }
    notify();
  }

  async function restore() {
    try {
      keepScreenOn = (await storage.get('keepScreenOn')) === true;
      autoFullscreen = (await storage.get('autoFullscreen')) === true;
    } catch (error) {
      return; // archivio non leggibile: restano spente
    }
    acquireWakeLock();
  }

  restore();

  window.PicSpeak.kiosk = {
    osFamily,
    wakeLockSupported,
    fullscreenSupported,
    isFullscreen,
    isScreenKeptOn: () => Boolean(sentinel),
    keepScreenOn: () => keepScreenOn,
    autoFullscreen: () => autoFullscreen,
    setKeepScreenOn,
    setAutoFullscreen,
    enterFullscreen,
    onChange: (fn) => listeners.add(fn),
  };
})();
