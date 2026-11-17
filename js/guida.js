/*
 * PicSpeak – ricerca nella guida all'uso.
 * Mostra solo le sezioni che contengono tutte le parole scritte. Lavora solo sul testo della pagina:
 * nessun dato esce dal dispositivo e nessun testo scritto viene inserito come HTML.
 * Senza JavaScript la casella resta nascosta e restano l'indice e l'indice delle parole.
 */
(() => {
  const box = document.getElementById('guide-search');
  const input = document.getElementById('guide-search-input');
  const status = document.getElementById('guide-search-status');
  if (!box || !input || !status) return;

  const sections = Array.from(document.querySelectorAll('section[data-search]'));
  const others = Array.from(document.querySelectorAll('[data-hide-on-search]'));

  // Minuscole e senza accenti: «perché» si trova anche scrivendo «perche»
  const normalize = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const texts = sections.map((s) => normalize(s.textContent));

  function apply() {
    const words = normalize(input.value).split(/\s+/).filter(Boolean);
    if (!words.length) {
      sections.forEach((s) => { s.hidden = false; });
      others.forEach((n) => { n.hidden = false; });
      status.textContent = '';
      return;
    }
    let found = 0;
    sections.forEach((s, i) => {
      const match = words.every((w) => texts[i].includes(w));
      s.hidden = !match;
      if (match) found += 1;
    });
    others.forEach((n) => { n.hidden = true; });
    status.textContent = found === 0
      ? 'Nessuna sezione trovata. Provate con un’altra parola, per esempio «stampa», «PIN» o «colori».'
      : `${found} ${found === 1 ? 'sezione trovata' : 'sezioni trovate'}. Cancellate la parola per rivedere tutta la guida.`;
  }

  input.addEventListener('input', apply);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { input.value = ''; apply(); }
  });
  // Un link interno durante la ricerca (es. «vedi Tocco») riporta la guida intera, così la sezione si vede
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#"]');
    if (link && input.value) { input.value = ''; apply(); }
  });
  box.hidden = false;
})();
