import { $, el, api, stream, eventSlugFromUrl } from '/shared/kuva.js';

/**
 * Pantalla del evento.
 * Corre horas sin que nadie la toque, así que todo lo importante es defensivo:
 * reconecta sola, limita el DOM y nunca muestra fotos sin aprobar.
 */

const MAX_TILES = 40;          // tope de lo que pedimos al servidor; la grilla recorta al alto real
const HERO_MS = 5200;          // cuánto dura la celebración de una foto nueva
const HERO_COOLDOWN_MS = 1400; // si entran muchas seguidas, no atropellar

const slug = eventSlugFromUrl();
const album = $('#album');
const hero = $('#hero');
const seen = new Set();
let eventId = null;
let total = 0;
let heroQueue = [];
let heroBusy = false;

/* ─────────────────────────────── render ─────────────────────────────────── */

/** Inclinación estable por foto (derivada del id, no aleatoria en cada render). */
function tiltOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return (((h % 9) - 4) * 0.45).toFixed(2); // entre -1.8 y 1.8 grados
}

function tile(photo) {
  const label = [photo.author, photo.caption].filter(Boolean);
  return el('figure', {
    class: 'shot fresh',
    dataset: { id: photo.id },
    style: `--tilt:${tiltOf(photo.id)}deg`,
  },
    el('img', {
      // Sin lazy: el álbum va con overflow:hidden y una imagen "fuera de vista"
      // se quedaría en blanco justo cuando el mosaico se reacomoda. Son archivos
      // locales de ~100 KB, cargarlas todas no cuesta nada.
      src: photo.urls.web,
      alt: photo.caption || 'Foto del evento',
      decoding: 'async',
    }),
    label.length
      ? el('figcaption', { class: 'who' },
        photo.author ? el('em', {}, photo.author) : null,
        photo.caption || '')
      : null,
  );
}

function showEmpty() {
  album.replaceChildren(el('div', { class: 'empty' },
    el('div', { class: 'ring' }, '💖'),
    el('div', { class: 'big' }, 'Esto empieza con tu foto'),
    el('div', {}, 'Escanea el QR de arriba y sé el primero en salir'),
  ));
}

function addPhoto(photo, { fresh = true } = {}) {
  if (seen.has(photo.id)) return;
  seen.add(photo.id);

  const empty = album.querySelector('.empty');
  if (empty) empty.remove();

  const node = tile(photo);
  if (!fresh) node.classList.remove('fresh');
  album.prepend(node);
  if (fresh) setTimeout(() => node.classList.remove('fresh'), 6000);

  layoutAlbum();
}

function removePhoto(id) {
  const was = seen.has(id);
  const node = album.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) {
    node.style.transition = 'opacity .4s, transform .4s';
    node.style.opacity = '0';
    node.style.transform = 'scale(.9)';
    setTimeout(() => node.remove(), 420);
  }
  seen.delete(id);
  if (!album.children.length) showEmpty();
  else layoutAlbum();
  return was;
}

function setCount(n) {
  total = n;
  $('#count').textContent = n;
}

/**
 * Calcula la grilla del álbum y recorta lo que no cabe.
 *
 * La pantalla no hace scroll: lo que no entra completo, no se muestra. Así que
 * probamos cada número de columnas y nos quedamos con el que deja las fotos más
 * grandes, contando las filas que caben de verdad. Las fotos que sobran salen
 * del DOM (siempre las más viejas); el contador de arriba sigue mostrando el
 * total real del evento.
 */
const PRINT_RATIO = 1182 / 1772; // ancho/alto de una impresión vertical

function layoutAlbum() {
  const tiles = [...album.querySelectorAll('.shot')];
  const n = tiles.length;
  if (!n) return;

  const cs = getComputedStyle(album);
  const pad = parseFloat(cs.paddingLeft) || 0;
  const gap = parseFloat(cs.gap) || 16;
  const availW = album.clientWidth - pad * 2;
  const availH = album.clientHeight - pad * 2;
  if (availW <= 0 || availH <= 0) return;

  const maxCols = Number(getComputedStyle(document.documentElement).getPropertyValue('--cols-max')) || 5;

  let best = { cols: 1, rows: 1, size: 0 };
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.max(1, Math.ceil(Math.min(n, cols * 4) / cols)); // 4 filas es el tope razonable
    const cellW = (availW - gap * (cols - 1)) / cols;
    const cellH = (availH - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    // Qué tan grande queda una impresión vertical dentro de la celda.
    const size = Math.min(cellW, cellH * PRINT_RATIO);
    // A igualdad de tamaño preferimos mostrar más fotos.
    if (size > best.size * 1.02 || (size > best.size * 0.9 && cols * rows > best.cols * best.rows)) {
      best = { cols, rows, size };
    }
  }

  document.documentElement.style.setProperty('--cols', best.cols);

  const capacity = best.cols * best.rows;
  for (let i = capacity; i < tiles.length; i++) {
    seen.delete(tiles[i].dataset.id);
    tiles[i].remove();
  }
}

/* ───────────────────────── celebración de foto nueva ────────────────────── */

function celebrate(photo) {
  heroQueue.push(photo);
  drainHero();
}

function drainHero() {
  if (heroBusy || !heroQueue.length) return;
  heroBusy = true;
  // Si se acumuló una ráfaga, celebramos solo la última: es la que acaba de llegar.
  const photo = heroQueue.pop();
  heroQueue = [];

  burstConfetti();
  $('#heroImg').src = photo.urls.web;
  $('#heroCap').textContent = photo.caption || '¡Ya estás en el álbum!';
  $('#heroBy').textContent = photo.author ? `por ${photo.author}` : '';
  hero.classList.add('on');

  setTimeout(() => {
    hero.classList.remove('on');
    setTimeout(() => { heroBusy = false; drainHero(); }, HERO_COOLDOWN_MS);
  }, HERO_MS);
}

const CONFETTI = ['💖', '💘', '✨', '💗', '🌸', '💕'];

/** Lluvia breve de corazones cuando entra una foto nueva. */
function burstConfetti(n = 26) {
  const host = $('#confetti');
  for (let i = 0; i < n; i++) {
    const bit = el('i', {
      style: `left:${Math.random() * 100}%;`
        + `--sz:${(1.4 + Math.random() * 2.2).toFixed(2)}rem;`
        + `--dur:${(2.6 + Math.random() * 2).toFixed(2)}s;`
        + `--del:${(Math.random() * 0.9).toFixed(2)}s;`
        + `--rot:${Math.round(180 + Math.random() * 540)}deg;`,
    }, CONFETTI[Math.floor(Math.random() * CONFETTI.length)]);
    host.append(bit);
    setTimeout(() => bit.remove(), 6000);
  }
}

/* ──────────────────────────────── arranque ──────────────────────────────── */

function applyTheme(ev) {
  document.title = `${ev.name} · KuvaConnect`;
  $('#title').textContent = ev.name;
  $('#subtitle').textContent = ev.subtitle || '';
  if (ev.hashtag) $('#eyebrow').textContent = ev.hashtag;

  const root = document.documentElement.style;
  if (ev.theme?.brand) root.setProperty('--brand', ev.theme.brand);
  if (ev.theme?.hot) root.setProperty('--hot', ev.theme.hot);
  if (ev.theme?.accent) root.setProperty('--gold', ev.theme.accent);
  if (ev.theme?.paper) root.setProperty('--paper', ev.theme.paper);

  // El logo del cliente es opcional: si no hay archivo, se esconde el hueco.
  const logo = $('#brandLogo');
  if (ev.theme?.logo) logo.src = ev.theme.logo;
  logo.addEventListener('error', () => { logo.closest('.brandmark').style.display = 'none'; });

  if (ev.displayColumns) {
    root.setProperty('--cols-max', ev.displayColumns);
    layoutAlbum();
  }
}

function setOnline(ok) {
  document.body.classList.toggle('offline', !ok);
  $('#dot').className = `dot ${ok ? 'dot-live' : 'dot-off'}`;
  $('#liveLabel').textContent = ok ? 'En vivo' : 'Sin conexión';
}

async function boot() {
  let info;
  try {
    info = await api(`/api/event/${encodeURIComponent(slug || 'x')}`);
  } catch {
    // Sin slug válido en la URL: caemos al evento activo que reporta el panel.
    $('#title').textContent = 'Evento no encontrado';
    $('#subtitle').textContent = 'Revisa el enlace de la pantalla en el panel de control.';
    return;
  }

  eventId = info.event.id;
  applyTheme(info.event);
  setCount(info.counts.approved);
  $('#qr').src = `/api/event/${eventId}/qr.png?size=1000`;

  const { photos } = await api(`/api/event/${eventId}/feed?limit=${MAX_TILES}`);
  if (!photos.length) showEmpty();
  else for (const p of [...photos].reverse()) addPhoto(p, { fresh: false });

  stream(`/api/event/${eventId}/stream`, {
    onOpen: () => setOnline(true),
    onError: () => setOnline(false),
    hello: (d) => setCount(d.counts.approved),
    'photo:new': (photo) => {
      addPhoto(photo);
      setCount(total + 1);
      celebrate(photo);
    },
    'photo:removed': ({ id }) => {
      // Rechazar algo que estaba pendiente también manda este evento, y esa foto
      // nunca llegó a contarse: solo descontamos si de verdad estaba en pantalla.
      if (removePhoto(id)) setCount(Math.max(0, total - 1));
    },
  });

  // Red de seguridad: si algún evento SSE se perdió, resincronizamos cada 2 min.
  setInterval(async () => {
    try {
      const { photos: fresh, counts } = await api(`/api/event/${eventId}/feed?limit=${MAX_TILES}`);
      setCount(counts.approved);
      for (const p of [...fresh].reverse()) if (!seen.has(p.id)) addPhoto(p, { fresh: false });
    } catch { /* ya lo reintentará */ }
  }, 120000);
}

boot();

// Si cambian el proyector de resolución o rotan el tótem, recalculamos.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutAlbum, 200);
});

// La pantalla no debe apagarse a mitad del evento.
if ('wakeLock' in navigator) {
  const keepAwake = async () => {
    try { await navigator.wakeLock.request('screen'); } catch { /* el navegador puede negarlo */ }
  };
  keepAwake();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
}
