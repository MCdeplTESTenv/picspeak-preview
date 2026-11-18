/*
 * PicSpeak – script della guida all'uso: ricerca nella pagina e stampa su fogli A4.
 * Lavora solo sul testo e sulle immagini della pagina: nessun dato esce dal dispositivo
 * e nessun testo scritto viene inserito come HTML.
 * Senza JavaScript ricerca e pulsante restano nascosti; restano indice, indice delle parole e Ctrl+P.
 */
(() => {
  const box = document.getElementById('guide-search');
  const input = document.getElementById('guide-search-input');
  const status = document.getElementById('guide-search-status');
  const printButton = document.getElementById('guide-print');

  const sections = Array.from(document.querySelectorAll('section[data-search]'));
  const others = Array.from(document.querySelectorAll('[data-hide-on-search]'));

  // Minuscole e senza accenti: «perché» si trova anche scrivendo «perche»
  const normalize = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const texts = sections.map((s) => normalize(s.textContent));

  // ---------- Ricerca ----------
  function apply() {
    const words = input ? normalize(input.value).split(/\s+/).filter(Boolean) : [];
    if (!words.length) {
      sections.forEach((s) => { s.hidden = false; });
      others.forEach((n) => { n.hidden = false; });
      if (status) status.textContent = '';
      return;
    }
    let found = 0;
    sections.forEach((s, i) => {
      const match = words.every((w) => texts[i].includes(w));
      s.hidden = !match;
      if (match) found += 1;
    });
    others.forEach((n) => { n.hidden = true; });
    if (status) status.textContent = found === 0
      ? 'Nessuna sezione trovata. Provate con un’altra parola, per esempio «stampa», «PIN» o «colori».'
      : `${found} ${found === 1 ? 'sezione trovata' : 'sezioni trovate'}. Cancellate la parola per rivedere tutta la guida.`;
  }

  function clearSearch() {
    if (input && input.value) { input.value = ''; apply(); }
  }

  if (box && input && status) {
    input.addEventListener('input', apply);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') clearSearch();
    });
    // Un link interno durante la ricerca (es. «vedi Tocco») riporta la guida intera, così la sezione si vede
    document.addEventListener('click', (event) => {
      if (event.target.closest('a[href^="#"]')) clearSearch();
    });
    box.hidden = false;
  }

  // ---------- Stampa ----------
  // Prima di stampare: guida intera (niente filtro della ricerca) e tutte le immagini caricate,
  // anche quelle più in basso che il browser non ha ancora scaricato.
  function loadAllImages() {
    const images = Array.from(document.images);
    images.forEach((img) => { img.loading = 'eager'; });
    return Promise.all(images.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => {}))));
  }

  window.addEventListener('beforeprint', () => { clearSearch(); loadAllImages(); });

  if (printButton && typeof window.print === 'function') {
    printButton.addEventListener('click', async () => {
      clearSearch();
      printButton.disabled = true;
      try {
        // Al massimo 5 secondi di attesa per le immagini, poi si stampa comunque
        await Promise.race([loadAllImages(), new Promise((resolve) => { setTimeout(resolve, 5000); })]);
      } finally {
        printButton.disabled = false;
      }
      window.print();
    });
    printButton.hidden = false;
  }
})();
