/*
 * Colori per tipo di parola scelti dall'adulto (Impostazioni › Schede › «Colori per tipo di parola»).
 * Si parte dai colori della chiave di Fitzgerald modificata; l'adulto può dare a ogni tipo un altro colore.
 * Valgono per il profilo in uso (chiave «typeColors») e finiscono nel backup con l'aspetto.
 * Formato salvato: { verb: '#rrggbb', … } solo per i tipi cambiati; un tipo che manca ha il colore di Fitzgerald
 * (così i dati e i backup di prima, che non hanno la chiave, restano validi).
 * I colori si applicano con proprietà CSS su <html> (--user-<tipo>…): le regole di css/style.css le usano al posto
 * dei colori predefiniti. Le tessere con un colore scelto a mano tengono il loro.
 */
(function () {
  'use strict';

  const { storage, data } = window.PicSpeak;
  const KEY = 'typeColors';
  const HEX = /^#[0-9a-f]{6}$/i;

  // Colori di Fitzgerald di ogni tipo (gli stessi della modalità «colore pieno»)
  const DEFAULTS = {
    pronoun: '#e0ac00',
    verb: '#2e9a47',
    noun: '#e57a12',
    adjective: '#2a6fd6',
    social: '#d0468f',
    negation: '#cf3439',
    question: '#7a4fc9',
    connector: '#8a8f98',
  };

  // Tavolozza proposta: colori ben distinguibili tra loro (nome per i lettori di schermo)
  const PALETTE = [
    ['#e0ac00', 'yellow'], ['#e57a12', 'orange'], ['#cf3439', 'red'], ['#d0468f', 'pink'],
    ['#7a4fc9', 'purple'], ['#2a6fd6', 'blue'], ['#0e9aa7', 'teal'], ['#2e9a47', 'green'],
    ['#7cb518', 'lime'], ['#8b5a2b', 'brown'], ['#8a8f98', 'gray'], ['#1f2430', 'black'],
  ];

  let colors = {};

  // Solo tipi conosciuti e colori #RRGGBB: un valore diverso (es. da un backup rovinato) viene ignorato
  function clean(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    data.WORD_TYPES.forEach((type) => {
      const color = value[type];
      if (typeof color === 'string' && HEX.test(color) && color.toLowerCase() !== DEFAULTS[type]) {
        out[type] = color.toLowerCase();
      }
    });
    return out;
  }

  function apply() {
    const style = document.documentElement.style;
    data.WORD_TYPES.forEach((type) => {
      const color = colors[type];
      if (color) {
        // Sfumature chiare come quelle dei colori di Fitzgerald: tinta (colore pieno), fondo e bordo (scheda)
        style.setProperty(`--user-${type}`, color);
        style.setProperty(`--user-${type}-tint`, `color-mix(in srgb, ${color} 25%, white)`);
        style.setProperty(`--user-${type}-fill`, `color-mix(in srgb, ${color} 14%, white)`);
        style.setProperty(`--user-${type}-line`, `color-mix(in srgb, ${color} 55%, white)`);
      } else {
        ['', '-tint', '-fill', '-line'].forEach((part) => style.removeProperty(`--user-${type}${part}`));
      }
    });
  }

  async function load() {
    colors = clean(await storage.get(KEY));
    apply();
  }

  async function save() {
    if (Object.keys(colors).length) await storage.set(KEY, { ...colors });
    else await storage.remove(KEY);
    apply();
  }

  // Colore in uso per un tipo (scelto dall'adulto oppure di Fitzgerald)
  function colorOf(type) {
    return colors[type] || DEFAULTS[type] || null;
  }

  function isCustom(type) {
    return Boolean(colors[type]);
  }

  function hasCustom() {
    return Object.keys(colors).length > 0;
  }

  // Nuovo colore per un tipo; il colore di Fitzgerald dello stesso tipo equivale a «nessuna scelta»
  async function setColor(type, color) {
    if (!data.WORD_TYPES.includes(type) || typeof color !== 'string' || !HEX.test(color)) return;
    const value = color.toLowerCase();
    if (value === DEFAULTS[type]) delete colors[type];
    else colors[type] = value;
    await save();
  }

  // «Ripristina colori Fitzgerald»: tutti i tipi tornano ai colori del metodo
  async function reset() {
    colors = {};
    await save();
  }

  const ready = load().catch(() => {});

  window.PicSpeak.typeColors = {
    KEY, DEFAULTS, PALETTE, ready, load, colorOf, isCustom, hasCustom, setColor, reset, clean,
    current: () => ({ ...colors }),
  };
})();
