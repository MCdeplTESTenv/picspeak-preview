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

  async function hasPin() {
    const data = await storage.get('security');
    return Boolean(data && data.pinHash);
  }

  // Salva un nuovo PIN; con newRecovery crea anche un nuovo codice di recupero e lo restituisce
  async function setPin(pin, { newRecovery }) {
    const previous = (await storage.get('security')) || {};
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
    await storage.set('security', data);
    await storage.remove(OLD_ATTEMPTS_KEY);
    return recoveryCode;
  }

  // Confronta il segreto con l'impronta salvata. Si può riprovare subito, senza limiti.
  async function check(secret, saltKey, hashKey) {
    const data = await storage.get('security');
    if (!data || !data[hashKey]) return { ok: false };
    const hash = await derive(secret, data[saltKey], data.iterations || ITERATIONS);
    const ok = hash === data[hashKey];
    // Le versioni precedenti potevano aver salvato un'attesa: dopo un accesso riuscito non resta traccia
    if (ok) await storage.remove(OLD_ATTEMPTS_KEY);
    return { ok };
  }

  function verifyPin(pin) {
    return check(String(pin || ''), 'pinSalt', 'pinHash');
  }

  function verifyRecovery(code) {
    return check(normalizeCode(code), 'recoverySalt', 'recoveryHash');
  }

  // Toglie PIN e codice di recupero (quando l'adulto sceglie un'altra protezione)
  async function clearPin() {
    await storage.remove('security');
    await storage.remove(OLD_ATTEMPTS_KEY);
  }

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

  // Operazione da risolvere: somma semplice di due numeri di due cifre, senza riporto (es. 23 + 14): immediata per un
  // adulto, difficile per un bambino piccolo. Ogni volta diversa.
  function makeChallenge() {
    const a = randomInt(1, 5) * 10 + randomInt(1, 4);
    const b = randomInt(1, 4) * 10 + randomInt(1, 5);
    return { text: `${a} + ${b}`, answer: a + b };
  }

  function checkChallenge(challenge, value) {
    const typed = String(value || '').trim();
    return /^\d{1,4}$/.test(typed) && Number(typed) === challenge.answer;
  }

  window.PicSpeak.security = {
    supported, isValidPin, hasPin, setPin, verifyPin, verifyRecovery, clearPin,
    getLock, setLock, makeChallenge, checkChallenge, LOCK_MODES, HOLD_SECONDS,
  };
})();
