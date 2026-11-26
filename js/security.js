/*
 * Protezione delle impostazioni: pressione lunga sui tre puntini, poi (a scelta dell'adulto) niente, un'operazione
 * da risolvere oppure il PIN. Scelta e durata della pressione sono del dispositivo (chiave «adultLock»), fuori dal
 * backup come il PIN. Senza scelta salvata: PIN se ne esiste già uno (chi aveva il PIN lo tiene), altrimenti solo
 * la pressione lunga di 3 secondi.
 *
 * PIN dell'adulto e codice di recupero.
 * Il PIN non viene mai salvato: si conserva solo un'impronta (PBKDF2-SHA256 con sale casuale).
 * Nessun limite di tentativi e nessuna attesa: un bambino che prova più volte il PIN non deve mai bloccare
 * l'app, perché la comunicazione viene prima della riservatezza (vedi DECISIONI, 24/11/2026).
 * Limite: senza server la protezione ferma il bambino e l'adulto non autorizzato,
 * non chi ha competenze tecniche e il dispositivo in mano.
 */
(function () {
  'use strict';

  const { storage } = window.PicSpeak;

  const ITERATIONS = 150000;
  // Chiave delle vecchie versioni (contatore dei tentativi e attesa): non si usa più e si cancella
  const OLD_ATTEMPTS_KEY = 'securityAttempts';
  // Alfabeto senza caratteri ambigui (0/O, 1/I/L)
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  const supported = Boolean(window.crypto && window.crypto.subtle && window.TextEncoder);

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fromHex(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  function randomHex(length) {
    return toHex(crypto.getRandomValues(new Uint8Array(length)));
  }

  async function derive(secret, saltHex, iterations) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' }, key, 256,
    );
    return toHex(bits);
  }

  function normalizeCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function makeRecoveryCode() {
    const values = crypto.getRandomValues(new Uint8Array(12));
    const chars = Array.from(values, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  }

  function isValidPin(pin) {
    return /^\d{4,6}$/.test(String(pin || ''));
  }

  // Archivio di un PIN con il suo codice di recupero, sotto una chiave del dispositivo: «security» per il PIN delle
  // impostazioni, «predictionSecurity» per il PIN privacy (vedi sotto). Mai nei backup.
  function pinStore(key) {
    async function hasPin() {
      const data = await storage.get(key);
      return Boolean(data && data.pinHash);
    }

    // Salva un nuovo PIN; con newRecovery crea anche un nuovo codice di recupero e lo restituisce
    async function setPin(pin, { newRecovery }) {
      const previous = (await storage.get(key)) || {};
      const pinSalt = randomHex(16);
      const data = {
        ...previous,
        iterations: ITERATIONS,
        pinSalt,
        pinHash: await derive(pin, pinSalt, ITERATIONS),
      };
      let recoveryCode = null;
      if (newRecovery || !previous.recoveryHash) {
        recoveryCode = makeRecoveryCode();
        data.recoverySalt = randomHex(16);
        data.recoveryHash = await derive(normalizeCode(recoveryCode), data.recoverySalt, ITERATIONS);
      }
      await storage.set(key, data);
      await storage.remove(OLD_ATTEMPTS_KEY);
      return recoveryCode;
    }

    // Confronta il segreto con l'impronta salvata. Si può riprovare subito, senza limiti.
    async function check(secret, saltKey, hashKey) {
      const data = await storage.get(key);
      if (!data || !data[hashKey] || !data[saltKey]) return { ok: false };
      const hash = await derive(secret, data[saltKey], data.iterations || ITERATIONS);
      const ok = hash === data[hashKey];
      // Le versioni precedenti potevano aver salvato un'attesa: dopo un accesso riuscito non resta traccia
      if (ok) await storage.remove(OLD_ATTEMPTS_KEY);
      return { ok };
    }

    return {
      hasPin,
      setPin,
      verifyPin: (pin) => check(String(pin || ''), 'pinSalt', 'pinHash'),
      verifyRecovery: (code) => check(normalizeCode(code), 'recoverySalt', 'recoveryHash'),
      // Toglie PIN e codice di recupero (quando l'adulto sceglie un'altra protezione)
      async clearPin() {
        await storage.remove(key);
        await storage.remove(OLD_ATTEMPTS_KEY);
      },
    };
  }

  // PIN delle impostazioni
  const settingsPin = pinStore('security');
  const { hasPin, setPin, verifyPin, verifyRecovery, clearPin } = settingsPin;

  // ---------- Protezione scelta e durata della pressione ----------

  const LOCK_KEY = 'adultLock';
  const LOCK_MODES = ['hold', 'math', 'pin'];
  const HOLD_SECONDS = { min: 1, max: 10, def: 3 };

  // Legge la scelta salvata, controllando i valori (dati letti dal dispositivo: non affidabili)
  async function getLock() {
    const saved = await storage.get(LOCK_KEY);
    let mode = saved && LOCK_MODES.includes(saved.mode) ? saved.mode : null;
    // Nessuna scelta salvata: chi ha già un PIN continua a usarlo
    if (!mode) mode = (await hasPin()) ? 'pin' : 'hold';
    // Il PIN scelto ma non più presente (es. archivio cambiato a mano): resta solo la pressione
    if (mode === 'pin' && !(await hasPin())) mode = 'hold';
    const seconds = saved && Number.isInteger(saved.holdSeconds) ? saved.holdSeconds : HOLD_SECONDS.def;
    return { mode, holdSeconds: Math.min(HOLD_SECONDS.max, Math.max(HOLD_SECONDS.min, seconds)) };
  }

  async function setLock(changes) {
    const current = await getLock();
    const next = { ...current };
    if (changes && LOCK_MODES.includes(changes.mode)) next.mode = changes.mode;
    if (changes && Number.isInteger(changes.holdSeconds)) {
      next.holdSeconds = Math.min(HOLD_SECONDS.max, Math.max(HOLD_SECONDS.min, changes.holdSeconds));
    }
    await storage.set(LOCK_KEY, next);
    return next;
  }

  // Numero intero casuale tra min e max (compresi)
  function randomInt(min, max) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    return min + (value % (max - min + 1));
  }

  // Operazione da risolvere, immediata per un adulto e difficile per un bambino piccolo, ogni volta diversa:
  // addizione o sottrazione tra un numero di due cifre e uno di una cifra (es. 34 + 7, 52 − 6),
  // oppure moltiplicazione tra due numeri di una cifra (es. 7 × 8). Mai divisioni.
  function makeChallenge() {
    const kind = randomInt(0, 2);
    if (kind === 2) {
      const a = randomInt(2, 9);
      const b = randomInt(2, 9);
      return { text: `${a} × ${b}`, answer: a * b };
    }
    const b = randomInt(1, 9);
    if (kind === 1) {
      const a = randomInt(11, 99);
      return { text: `${a} − ${b}`, answer: a - b };
    }
    const a = randomInt(10, 90);
    return { text: `${a} + ${b}`, answer: a + b };
  }

  function checkChallenge(challenge, value) {
    const typed = String(value || '').trim();
    return /^\d{1,4}$/.test(typed) && Number(typed) === challenge.answer;
  }

  // ---------- PIN privacy (previsione e backup) ----------
  // Facoltativa e separata da quella delle impostazioni: nella previsione ci sono le abitudini del bambino (coppie di
  // parole, contesti), che chi entra nelle impostazioni (es. un terapista) potrebbe non dover vedere. Scelta del
  // dispositivo (chiave «predictionLock»): 'none' (nessuna, scelta normale) o 'pin' (PIN privacy, diverso da
  // quello delle impostazioni, che vale anche per il backup). Senza scelta salvata: nessuna protezione, e la prima
  // apertura della previsione chiede quale si vuole.
  const PRIVATE_LOCK_KEY = 'predictionLock';
  const PRIVATE_MODES = ['none', 'pin'];
  const privatePin = pinStore('predictionSecurity');

  async function getPrivateLock() {
    const saved = await storage.get(PRIVATE_LOCK_KEY);
    const chosen = Boolean(saved && PRIVATE_MODES.includes(saved.mode));
    let mode = chosen ? saved.mode : 'none';
    // Il PIN scelto ma non più presente (archivio cambiato a mano): non c'è nulla da chiedere
    if (mode === 'pin' && !(await privatePin.hasPin())) mode = 'none';
    return { mode, chosen };
  }

  async function setPrivateLock(mode) {
    if (!PRIVATE_MODES.includes(mode)) return getPrivateLock();
    await storage.set(PRIVATE_LOCK_KEY, { mode });
    return getPrivateLock();
  }

  window.PicSpeak.security = {
    supported, isValidPin, hasPin, setPin, verifyPin, verifyRecovery, clearPin,
    getLock, setLock, makeChallenge, checkChallenge, LOCK_MODES, HOLD_SECONDS,
    privatePin, getPrivateLock, setPrivateLock, PRIVATE_MODES,
  };
})();
