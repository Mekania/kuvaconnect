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

  // Nunca más columnas que fotos: con una sola foto y cuatro columnas, la foto
  // se queda en la celda de la izquierda y la pantalla se ve rota.
  const cols = Math.min(best.cols, Math.max(1, n));
  const rows = Math.max(1, Math.min(best.rows, Math.ceil(n / cols)));
  document.documentElement.style.setProperty('--cols', cols);

  // El tamaño máximo de cada foto va en píxeles, no en porcentaje: un
  // max-height en % contra una altura indefinida no limita nada, y la foto se
  // desbordaba por abajo. Aquí ya conocemos la celda exacta.
  const cellW = Math.floor((availW - gap * (cols - 1)) / cols);
  const cellH = Math.floor((availH - gap * (rows - 1)) / rows);
  const root = document.documentElement.style;
  root.setProperty('--cell-w', `${cellW}px`);
  root.setProperty('--cell-h', `${cellH}px`);

  const capacity = cols * best.rows;
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

/**
 * Retira una pantalla cuyo evento se archivó.
 * Una pestaña vieja abierta en un proyector seguiría mostrando un QR que manda
 * las fotos a un evento que nadie modera. Se quita el QR y se deja un aviso.
 */
function retire() {
  $('.qr-card')?.remove();
  $('#title').textContent = 'Pantalla inactiva';
  $('#subtitle').textContent = 'Esta pantalla ya no está en uso. Abre el link de la pantalla de tu sede.';
  document.querySelector('.steps')?.remove();
  document.querySelector('.meta')?.remove();
  album.replaceChildren();
  window.__kuvaRetired = true; // el ciclo de sondeo lo lee y se detiene
}

/** Deja la celebración justo debajo de la franja del QR (ver .hero en el CSS). */
function placeHero() {
  const stage = document.querySelector('.stage');
  if (!stage) return;
  const top = Math.round(stage.getBoundingClientRect().bottom);
  const root = document.documentElement.style;
  root.setProperty('--hero-top', `${top}px`);
  root.setProperty('--hero-h', `${Math.max(200, window.innerHeight - top)}px`);
}

function applyTheme(ev) {
  document.title = `${ev.sede ? `${ev.sede} · ` : ''}${ev.name} · KuvaConnect`;
  if (ev.sede) {
    $('#sedeName').textContent = ev.sede;
    $('#sede').hidden = false;
  }
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
  if (info.event.archived) { retire(); return; }
  applyTheme(info.event);
  placeHero();
  // Las fuentes y el QR cambian la altura de la franja al terminar de cargar.
  $('#qr').addEventListener('load', placeHero);
  document.fonts?.ready?.then(placeHero);
  setCount(info.counts.approved);
  $('#qr').src = `/api/event/${eventId}/qr.png?size=1000`;

  const { photos } = await api(`/api/event/${eventId}/feed?limit=${MAX_TILES}`);
  if (!photos.length) showEmpty();
  else for (const p of [...photos].reverse()) addPhoto(p, { fresh: false });

  const onNew = (photo) => {
    addPhoto(photo);
    setCount(total + 1);
    celebrate(photo);
  };
  const onRemoved = (id) => {
    // Rechazar algo que estaba pendiente también manda este evento, y esa foto
    // nunca llegó a contarse: solo descontamos si de verdad estaba en pantalla.
    if (removePhoto(id)) setCount(Math.max(0, total - 1));
  };

  if (info.live === 'poll') {
    pollLoop(onNew, onRemoved);
  } else {
    stream(`/api/event/${eventId}/stream`, {
      onOpen: () => setOnline(true),
      onError: () => setOnline(false),
      hello: (d) => setCount(d.counts.approved),
      'photo:new': onNew,
      'photo:removed': ({ id }) => onRemoved(id),
    });

    // Red de seguridad: si algún evento SSE se perdió, resincronizamos cada 2 min.
    setInterval(() => resync(onNew, onRemoved, { celebrate: false }), 120000);
  }
}

/**
 * Sondeo, para cuando corremos en serverless y no hay SSE posible.
 * Compara el feed con lo que ya está en pantalla y sintetiza los mismos eventos,
 * así el resto de la pantalla no sabe por cuál transporte llegó la foto.
 */
const POLL_MS = 3000;

async function resync(onNew, onRemoved, { celebrate: doCelebrate = true } = {}) {
  const { photos, counts, archived } = await api(`/api/event/${eventId}/feed?limit=${MAX_TILES}`);
  if (archived) { retire(); return; }
  setOnline(true);
  const live = new Set(photos.map((p) => p.id));

  for (const id of [...seen]) if (!live.has(id)) onRemoved(id);

  // De viejas a nuevas, para que el orden de entrada sea el real.
  const incoming = [...photos].reverse().filter((p) => !seen.has(p.id));
  for (const p of incoming) {
    if (doCelebrate) onNew(p);
    else addPhoto(p, { fresh: false });
  }
  setCount(counts.approved);
}

function pollLoop(onNew, onRemoved) {
  let first = true;
  const tick = async () => {
    try {
      await resync(onNew, onRemoved, { celebrate: !first });
      first = false;
    } catch {
      setOnline(false);
    }
    if (!window.__kuvaRetired) setTimeout(tick, POLL_MS);
  };
  tick();
}

boot();

// Si cambian el proyector de resolución o rotan el tótem, recalculamos.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { placeHero(); layoutAlbum(); }, 200);
});

// La pantalla no debe apagarse a mitad del evento.
if ('wakeLock' in navigator) {
  const keepAwake = async () => {
    try { await navigator.wakeLock.request('screen'); } catch { /* el navegador puede negarlo */ }
  };
  keepAwake();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
}
