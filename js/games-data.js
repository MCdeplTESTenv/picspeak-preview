/*
 * Dati dei giochi (Impostazioni › Giochi): parole attraenti per i bambini, nomi delle lettere,
 * versi degli animali e storie pronte. Solo dati costanti, nessuna logica.
 *
 * Immagini: pittogrammi ARASAAC (autore Sergio Palao, proprietà Governo di Aragona, CC BY-NC-SA 4.0).
 * Alcuni sono già inclusi nel tool (symbols/arasaac), gli altri si scaricano una sola volta dalle
 * impostazioni dei giochi; finché mancano si vede l'emoji indicata.
 */
(function () {
  'use strict';

  // cat: animal | toy | food. sound: verso o rumore (Indovina il suono), facoltativo
  const words = [
    { key: 'cane', arasaac: 2517, emoji: '🐶', cat: 'animal', label: { it: 'cane', en: 'dog' }, sound: { it: 'bau bau', en: 'woof woof' } },
    { key: 'gatto', arasaac: 2406, emoji: '🐱', cat: 'animal', label: { it: 'gatto', en: 'cat' }, sound: { it: 'miao miao', en: 'meow meow' } },
    { key: 'mucca', arasaac: 2609, emoji: '🐮', cat: 'animal', label: { it: 'mucca', en: 'cow' }, sound: { it: 'muuu', en: 'moo' } },
    { key: 'maiale', arasaac: 2327, emoji: '🐷', cat: 'animal', label: { it: 'maiale', en: 'pig' }, sound: { it: 'oinc oinc', en: 'oink oink' } },
    { key: 'gallina', arasaac: 2403, emoji: '🐔', cat: 'animal', label: { it: 'gallina', en: 'hen' }, sound: { it: 'coccodè', en: 'cluck cluck' } },
    { key: 'uccello', arasaac: 2490, emoji: '🐦', cat: 'animal', label: { it: 'uccello', en: 'bird' }, sound: { it: 'cip cip', en: 'tweet tweet' } },
    { key: 'cavallo', arasaac: 2294, emoji: '🐴', cat: 'animal', label: { it: 'cavallo', en: 'horse' }, sound: { it: 'iiiih', en: 'neigh' } },
    { key: 'leone', arasaac: 2449, emoji: '🦁', cat: 'animal', label: { it: 'leone', en: 'lion' }, sound: { it: 'roarrr', en: 'roar' } },
    { key: 'elefante', arasaac: 2372, emoji: '🐘', cat: 'animal', label: { it: 'elefante', en: 'elephant' } },
    { key: 'coniglio', arasaac: 2351, emoji: '🐰', cat: 'animal', label: { it: 'coniglio', en: 'rabbit' } },
    { key: 'pesce', arasaac: 2520, emoji: '🐟', cat: 'animal', label: { it: 'pesce', en: 'fish' } },
    { key: 'farfalla', arasaac: 2465, emoji: '🦋', cat: 'animal', label: { it: 'farfalla', en: 'butterfly' } },
    { key: 'palla', arasaac: 3241, emoji: '⚽', cat: 'toy', label: { it: 'palla', en: 'ball' } },
    { key: 'bambola', arasaac: 2482, emoji: '🪆', cat: 'toy', label: { it: 'bambola', en: 'doll' } },
    { key: 'macchinina', arasaac: 2340, emoji: '🚗', cat: 'toy', label: { it: 'macchinina', en: 'toy car' }, sound: { it: 'brum brum', en: 'vroom vroom' } },
    { key: 'bolle', arasaac: 6945, emoji: '🫧', cat: 'toy', label: { it: 'bolle', en: 'bubbles' } },
    { key: 'altalena', arasaac: 4608, emoji: '🎠', cat: 'toy', label: { it: 'altalena', en: 'swing' } },
    { key: 'scivolo', arasaac: 4759, emoji: '🛝', cat: 'toy', label: { it: 'scivolo', en: 'slide' } },
    { key: 'costruzioni', arasaac: 4935, emoji: '🧱', cat: 'toy', label: { it: 'costruzioni', en: 'blocks' } },
    { key: 'libro', arasaac: 25191, emoji: '📖', cat: 'toy', label: { it: 'libro', en: 'book' } },
    { key: 'puzzle', arasaac: 2540, emoji: '🧩', cat: 'toy', label: { it: 'puzzle', en: 'puzzle' } },
    { key: 'musica', arasaac: 24795, emoji: '🎵', cat: 'toy', label: { it: 'musica', en: 'music' } },
    { key: 'gelato', arasaac: 3348, emoji: '🍦', cat: 'food', label: { it: 'gelato', en: 'ice cream' } },
    { key: 'pizza', arasaac: 2527, emoji: '🍕', cat: 'food', label: { it: 'pizza', en: 'pizza' } },
    { key: 'torta', arasaac: 2579, emoji: '🎂', cat: 'food', label: { it: 'torta', en: 'cake' } },
    { key: 'banana', arasaac: 2530, emoji: '🍌', cat: 'food', label: { it: 'banana', en: 'banana' } },
    { key: 'mela', arasaac: 2462, emoji: '🍎', cat: 'food', label: { it: 'mela', en: 'apple' } },
    { key: 'biscotto', arasaac: 8312, emoji: '🍪', cat: 'food', label: { it: 'biscotto', en: 'cookie' } },
    { key: 'cioccolato', arasaac: 2334, emoji: '🍫', cat: 'food', label: { it: 'cioccolato', en: 'chocolate' } },
    { key: 'patatine', arasaac: 2505, emoji: '🍟', cat: 'food', label: { it: 'patatine', en: 'chips' } },
  ];

  /*
   * Nomi delle lettere scritti per esteso: la sintesi vocale legge male una lettera da sola
   * (per esempio «h» muta o «a» come articolo), mentre legge bene «acca» o «bi».
   */
  const letterNames = {
    it: {
      a: 'a', b: 'bi', c: 'ci', d: 'di', e: 'e', f: 'effe', g: 'gi', h: 'acca', i: 'i', j: 'i lunga', k: 'cappa',
      l: 'elle', m: 'emme', n: 'enne', o: 'o', p: 'pi', q: 'cu', r: 'erre', s: 'esse', t: 'ti', u: 'u', v: 'vu',
      w: 'doppia vu', x: 'ics', y: 'ipsilon', z: 'zeta',
    },
    en: {
      a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'ef', g: 'jee', h: 'aitch', i: 'eye', j: 'jay', k: 'kay',
      l: 'el', m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar', s: 'ess', t: 'tee', u: 'you', v: 'vee',
      w: 'double you', x: 'ex', y: 'why', z: 'zee',
    },
  };

  /*
   * Storie pronte. Ogni parola deve corrispondere a una tessera delle schede del bambino: il gioco la cerca
   * (anche dentro le cartelle) e la «tocca» da solo. Le parole sono quelle delle schede di prova e delle
   * schede pronte; se una manca, la storia risulta «incompleta» nelle impostazioni e non si propone al bambino.
   * Livello 1: 2-3 frasi brevi; livello 2: 4-5 frasi; livello 3: 6-8 frasi più lunghe.
   */
  const stories = [
    {
      key: 'merenda', level: 1, cover: 'banana',
      title: { it: 'La merenda', en: 'Snack time' },
      sentences: {
        it: [['voglio', 'mangiare'], ['voglio', 'banana'], ['finito']],
        en: [['want', 'eat'], ['want', 'banana'], ['finished']],
      },
    },
    {
      key: 'sete', level: 1, cover: 'acqua',
      title: { it: 'Ho sete', en: 'I am thirsty' },
      sentences: {
        it: [['voglio', 'bere'], ['acqua'], ['ancora', 'acqua']],
        en: [['want', 'drink'], ['water'], ['more', 'water']],
      },
    },
    {
      key: 'palla', level: 1, cover: 'palla',
      title: { it: 'La palla', en: 'The ball' },
      sentences: {
        it: [['voglio', 'giocare'], ['palla'], ['mi piace', 'palla']],
        en: [['want', 'play'], ['ball'], ['I like', 'ball']],
      },
    },
    {
      key: 'pizza', level: 2, cover: 'pizza',
      title: { it: 'La pizza', en: 'Pizza time' },
      sentences: {
        it: [['io', 'voglio', 'mangiare'], ['pizza'], ['mi piace', 'pizza'], ['ancora', 'pizza'], ['basta', 'finito']],
        en: [['I', 'want', 'eat'], ['pizza'], ['I like', 'pizza'], ['more', 'pizza'], ['stop', 'finished']],
      },
    },
    {
      key: 'costruzioni', level: 2, cover: 'costruzioni',
      title: { it: 'Giochiamo insieme', en: 'Let’s play' },
      sentences: {
        it: [['io', 'voglio', 'giocare'], ['costruzioni'], ['io', 'felice'], ['ancora', 'giocare'], ['finito']],
        en: [['I', 'want', 'play'], ['blocks'], ['I', 'happy'], ['more', 'play'], ['finished']],
      },
    },
    {
      key: 'libro', level: 2, cover: 'libro',
      title: { it: 'Un libro', en: 'A book' },
      sentences: {
        it: [['io', 'voglio', 'libro'], ['mi piace', 'libro'], ['ancora', 'libro'], ['io', 'stanco']],
        en: [['I', 'want', 'book'], ['I like', 'book'], ['more', 'book'], ['I', 'tired']],
      },
    },
    {
      key: 'giornata', level: 3, cover: 'felice',
      title: { it: 'La mia giornata', en: 'My day' },
      sentences: {
        it: [['io', 'voglio', 'mangiare', 'pane'], ['io', 'voglio', 'bere', 'latte'], ['io', 'voglio', 'giocare', 'palla'],
          ['mi piace', 'giocare'], ['io', 'felice'], ['io', 'stanco'], ['finito']],
        en: [['I', 'want', 'eat', 'bread'], ['I', 'want', 'drink', 'milk'], ['I', 'want', 'play', 'ball'],
          ['I like', 'play'], ['I', 'happy'], ['I', 'tired'], ['finished']],
      },
    },
    {
      key: 'festa', level: 3, cover: 'biscotto',
      title: { it: 'La festa', en: 'The party' },
      sentences: {
        it: [['io', 'voglio', 'musica'], ['mi piace', 'musica'], ['io', 'voglio', 'mangiare', 'biscotto'], ['ancora', 'biscotto'],
          ['io', 'voglio', 'bere', 'acqua'], ['io', 'voglio', 'disegnare'], ['io', 'felice'], ['basta', 'finito']],
        en: [['I', 'want', 'music'], ['I like', 'music'], ['I', 'want', 'eat', 'cookie'], ['more', 'cookie'],
          ['I', 'want', 'drink', 'water'], ['I', 'want', 'draw'], ['I', 'happy'], ['stop', 'finished']],
      },
    },
    {
      key: 'parco', level: 3, cover: 'cane',
      title: { it: 'Al parco', en: 'At the park' },
      sentences: {
        it: [['io', 'voglio', 'andare', 'parco'], ['io', 'guardare', 'cane'], ['cane', 'grande'], ['io', 'voglio', 'altalena'],
          ['io', 'giocare', 'palla'], ['io', 'felice'], ['io', 'stanco'], ['finito']],
        en: [['I', 'want', 'go', 'park'], ['I', 'look', 'dog'], ['dog', 'big'], ['I', 'want', 'swing'],
          ['I', 'play', 'ball'], ['I', 'happy'], ['I', 'tired'], ['finished']],
      },
    },
  ];

  window.PicSpeak = window.PicSpeak || {};
  window.PicSpeak.gamesData = { words, letterNames, stories };
})();
