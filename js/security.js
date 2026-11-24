/*
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

  window.PicSpeak.security = {
    supported, isValidPin, hasPin, setPin, verifyPin, verifyRecovery,
  };
})();
