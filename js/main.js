// Entry point.
import { boot } from './app.js';

boot().catch((err) => {
  console.error(err);
  const main = document.getElementById('main');
  if (main) {
    main.textContent = '';
    const p = document.createElement('p');
    p.className = 'lm-container lm-page';
    p.textContent = 'Lumina could not start. Please refresh the page.';
    main.append(p);
  }
});
