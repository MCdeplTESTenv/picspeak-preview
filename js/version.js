/*
 * Versione pubblica di PicSpeak, mostrata all'adulto nel menu dei tre puntini, nelle Impostazioni (Generale) e
 * scritta dentro ogni backup.
 *
 * Schema a due numeri «principale.minore»: il primo cambia con una revisione principale, il secondo con una
 * revisione minore senza cambi strutturali (es. 1.0, 2.11, 14.3).
 * La decide SOLO lo Sviluppatore: non segue i commit né le pull request e non si cambia in automatico.
 * È un'altra cosa rispetto a CACHE_VERSION di sw.js (numero tecnico degli aggiornamenti, mai mostrato).
 */
(function () {
  'use strict';

  const APP_VERSION = '1.0';

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.version = Object.freeze({
    number: APP_VERSION,
    label: `PicSpeak v${APP_VERSION}`,
  });
})();
