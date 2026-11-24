/*
 * Service worker di PicSpeak.
 * Strategia "prima la rete": online si riceve sempre l'ultima versione,
 * offline si usa la copia salvata. Cambiare CACHE_VERSION quando si aggiungono file.
 */
const CACHE_VERSION = 'picspeak-anteprima-v59';
// I pacchetti di simboli scaricati dall'adulto (Mulberry, OpenMoji) e gli indici delle fonti online (Twemoji)
// stanno in cache separate ("picspeak-pack-…"), mai cancellate dagli aggiornamenti

const APP_FILES = [
  'css/anteprima.css',
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  // Guida all'uso per gli adulti (aperta dal menu dei tre puntini)
  'guida.html',
  'css/guida.css',
  'js/guida.js',
  // Immagini della guida (schermate con dati di prova)
  'guida/barra-adulto.webp',
  'guida/cerca-simbolo.webp',
  'guida/colori-parole.webp',
  'guida/contesti.webp',
  'guida/disposizione.webp',
  'guida/fonti-simboli.webp',
  'guida/impostazioni-previsione.webp',
  'guida/impostazioni-pulsanti-rapidi.webp',
  'guida/impostazioni-tocco.webp',
  'guida/impostazioni.webp',
  'guida/menu.webp',
  'guida/modelli.webp',
  'guida/modifica-tessera.webp',
  'guida/open-board.webp',
  'guida/pin.webp',
  'guida/previsione.webp',
  'guida/solo-suggerite.webp',
  'guida/frase-grande.webp',
  'guida/sfumato-trasparenza.webp',
  'guida/profili.webp',
  'guida/pulsanti-rapidi.webp',
  'guida/schede-pronte.webp',
  'guida/schermo.webp',
  'guida/stampa.webp',
  'guida/stili-pronti.webp',
  'guida/telefono-impostazioni.webp',
  'guida/telefono-sbloccato.webp',
  'guida/telefono.webp',
  'guida/tre-puntini.webp',
  'guida/usa-scheda.webp',
  'js/i18n.js',
  'js/storage.js',
  'js/security.js',
  'js/install.js',
  'js/kiosk.js',
  'js/sample-data.js',
  'js/data.js',
  'js/symbols.js',
  'js/speech.js',
  'js/app.js',
  'js/adult.js',
  'js/symbol-search.js',
  'js/editor.js',
  'js/reorder.js',
  'js/lexicon.js',
  'js/prediction-base.js',
  'js/predict.js',
  'js/templates.js',
  'js/settings-boards.js',
  'js/settings-contexts.js',
  'js/zip.js',
  'js/obf.js',
  'js/communication.js',
  'js/backup.js',
  'js/settings-backup.js',
  'js/profiles.js',
  'js/print.js',
  // Schede pronte (i pittogrammi si scaricano una sola volta quando si usa un modello)
  'templates/index.json',
  'templates/primi-passi-9.json',
  'templates/primi-passi-16.json',
  'templates/base-36.json',
  'templates/base-60.json',
  'templates/base-36-alto.json',
  'templates/base-60-alto.json',
  // Dizionario italiano → inglese per la ricerca dei simboli (funziona anche offline)
  'symbols/it-en.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  // Pittogrammi ARASAAC inclusi (simboli di prova)
  'symbols/arasaac/10192.png',
  'symbols/arasaac/11476.png',
  'symbols/arasaac/11959.png',
  'symbols/arasaac/21820.png',
  'symbols/arasaac/2248.png',
  'symbols/arasaac/2367.png',
  'symbols/arasaac/2430.png',
  'symbols/arasaac/2432.png',
  'symbols/arasaac/2439.png',
  'symbols/arasaac/2445.png',
  'symbols/arasaac/2462.png',
  'symbols/arasaac/24795.png',
  'symbols/arasaac/2494.png',
  'symbols/arasaac/25191.png',
  'symbols/arasaac/2527.png',
  'symbols/arasaac/2530.png',
  'symbols/arasaac/2608.png',
  'symbols/arasaac/2617.png',
  'symbols/arasaac/28099.png',
  'symbols/arasaac/28429.png',
  'symbols/arasaac/28641.png',
  'symbols/arasaac/29716.png',
  'symbols/arasaac/31925.png',
  'symbols/arasaac/3241.png',
  'symbols/arasaac/32648.png',
  'symbols/arasaac/35571.png',
  'symbols/arasaac/37162.png',
  'symbols/arasaac/37758.png',
  'symbols/arasaac/4610.png',
  'symbols/arasaac/4935.png',
  'symbols/arasaac/5441.png',
  'symbols/arasaac/5525.png',
  'symbols/arasaac/5526.png',
  'symbols/arasaac/5584.png',
  'symbols/arasaac/8088.png',
  'symbols/arasaac/8289.png',
  'symbols/arasaac/8312.png',
  'symbols/arasaac/8652.png',
  'symbols/arasaac/9813.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Elimina solo le copie delle versioni precedenti di questa app: sullo stesso dominio possono esserci
  // altre copie del tool (es. la versione di prova) con cache proprie, che non vanno toccate
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE_VERSION && /^picspeak-anteprima-v\d+$/.test(k))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Solo file dell'app: le richieste ad altri siti (es. ricerca simboli) passano senza cache
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Pacchetti di simboli: prima la copia scaricata (offline), altrimenti la rete senza salvarla qui
  // (lo scaricamento completo lo gestisce js/symbols.js nella cache del pacchetto)
  const path = new URL(request.url).pathname;
  // Indici delle fonti online: li salva js/symbols.js nella cache della fonte solo se è attiva
  if (path.includes('/symbols/sources/')) {
    event.respondWith(fetch(request).catch(() => caches.match(request).then((c) => c || Response.error())));
    return;
  }
  if (path.includes('/symbols/packs/')) {
    // L'indice si chiede prima alla rete (così un nuovo scaricamento prende la versione aggiornata)
    if (path.endsWith('/index.json')) {
      event.respondWith(fetch(request).catch(() => caches.match(request).then((c) => c || Response.error())));
    } else {
      event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
    }
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('index.html');
        return Response.error();
      }),
  );
});
