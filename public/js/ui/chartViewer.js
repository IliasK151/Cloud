import { apiFetch } from '../net.js';

// A trade's entry chart (the setup as the desk saw it), in a lightbox. The floor serves it
// only with the page's key, so it is fetched, not linked.
let box = null;

export async function openChart(url, title = 'The setup') {
  if (!box) {
    box = document.createElement('div');
    box.className = 'setup-box';
    box.hidden = true;
    box.innerHTML = '<figure><figcaption></figcaption><img alt=""><button class="btn" type="button">Close</button></figure>';
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.closest('button')) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });
    document.body.appendChild(box);
  }
  const img = box.querySelector('img');
  box.querySelector('figcaption').textContent = title;
  box.hidden = false;
  try {
    const res = await apiFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(await res.blob());
    img.alt = title;
  } catch (err) {
    box.querySelector('figcaption').textContent = `The chart isn't available (${err.message}).`;
  }
}

function close() {
  box.hidden = true;
}
