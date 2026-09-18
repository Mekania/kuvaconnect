import { $, $$, el, api, stream, toast, timeAgo, clock, bytes } from '/shared/kuva.js';

/**
 * Panel del logístico.
 * Está pensado para moderar rápido con una mano: la grilla de pendientes tiene
 * atajos de teclado y los botones son grandes porque esto se usa de pie,
 * al lado de la impresora, con poca luz.
 */

/**
 * El panel es para moderar, no para configurar.
 * Los ajustes del evento y el estado de Drive quedan detrás de ?avanzado=1
 * para que quien modera no pueda cambiar el marco ni cerrar las subidas por
 * accidente en pleno evento.
 */
const ADVANCED = new URLSearchParams(location.search).has('avanzado');

const state = {
  printFilter: 'todo',   // qué se ve en la cola de impresión
  eventId: null,
  event: null,
  frames: [],
  photos: new Map(),   // id -> foto
  view: 'moderate',
  cursor: 0,           // índice seleccionado en la vista de moderación
  lightbox: null,
  sse: null,
  live: 'sse',
  pollTimer: null,
};

/* ─────────────────────────────── sesión ─────────────────────────────────── */

const SEDE_KEY = 'kuva.sede';
const label = (e) => e.sede || e.name;

/** Llena el selector de sede del login y recuerda la última elegida. */
async function loadSedes() {
  const sel = $('#sedeSel');
  try {
    const { sedes } = await api('/api/sedes');
    let last = '';
    try { last = localStorage.getItem(SEDE_KEY) || ''; } catch { /* sin almacenamiento */ }
    sel.replaceChildren(
      el('option', { value: '' }, 'Elige tu sede'),
      ...sedes.map((s) => el('option', { value: s.id, ...(s.id === last ? { selected: 'selected' } : {}) }, label(s))),
    );
    (sel.value ? $('#pin') : sel).focus();
  } catch {
    sel.replaceChildren(el('option', { value: '' }, 'No se pudieron cargar las sedes'));
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const event = $('#sedeSel').value;
  if (!event) { toast('Elige tu sede', 'error'); $('#sedeSel').focus(); return; }
  try {
    await api('/api/admin/login', { method: 'POST', body: { event, pin: $('#pin').value } });
    try { localStorage.setItem(SEDE_KEY, event); } catch { /* sin almacenamiento */ }
    start(event);
  } catch {
    toast('PIN incorrecto', 'error');
    $('#pin').value = '';
    $('#pin').focus();
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

/* ──────────────────────────── navegación de vistas ──────────────────────── */

if (!ADVANCED) {
  $$('nav.tabs button').forEach((b) => {
    if (b.dataset.view === 'settings' || b.dataset.view === 'system') b.remove();
  });
}

$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

function switchView(view) {
  state.view = view;
  $$('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === `v${view[0].toUpperCase()}${view.slice(1)}`));
  render();
  if (view === 'system') refreshDrive();
}

/* ───────────────────────────── datos y render ───────────────────────────── */

function photosByStatus(...statuses) {
  return [...state.photos.values()]
    .filter((p) => statuses.includes(p.status))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function statusPill(p) {
  const map = {
    pending: ['pill-pending', 'Pendiente'],
    approved: ['pill-approved', 'Aprobada'],
    rejected: ['pill-rejected', 'Rechazada'],
    error: ['pill-error', 'Error'],
  };
  const [cls, label] = map[p.status] || ['', p.status];
  return el('span', { class: `pill ${cls}` }, label);
}

function driveDot(p) {
  const s = p.drive?.state;
  if (s === 'synced') return el('span', { class: 'pill', title: 'Copia en Drive lista' }, '☁ Drive');
  if (s === 'error') return el('span', { class: 'pill pill-rejected', title: 'Falló la subida a Drive' }, '☁ Error');
  return el('span', { class: 'pill', title: 'En cola para subir a Drive' }, '☁ …');
}

function card(p, { mode }) {
  const node = el('article', { class: 'shot', dataset: { id: p.id } },
    el('div', {
      class: `thumb ${mode === 'print' ? 'whole' : ''}`,
      onclick: () => openLightbox(p.id),
    },
      el('img', {
        src: mode === 'print' ? p.urls.web : (p.urls.raw || p.urls.web),
        alt: p.caption || `Foto ${p.seq}`,
        loading: 'lazy',
      }),
      el('div', { class: 'badges' },
        statusPill(p),
        ...(p.flags || []).map((f) => el('span', { class: 'pill' }, f)),
        p.printedAt ? el('span', { class: 'pill pill-gold' }, 'Impresa') : null,
      ),
      el('div', { class: 'seq' }, `#${String(p.seq).padStart(3, '0')}`),
    ),
    el('div', { class: 'info' },
      (p.author || p.caption)
        ? el('div', { class: 'cap' },
          p.author ? el('em', {}, `${p.author} `) : null,
          p.caption || '')
        : null,
      el('div', { class: 'line' },
        el('span', {}, `${clock(p.createdAt)} · ${p.orientation === 'landscape' ? 'horizontal' : 'vertical'}`),
        driveDot(p),
      ),
    ),
  );

  const ops = el('div', { class: 'ops' });
  if (mode === 'moderate') {
    ops.append(
      el('button', { class: 'btn btn-green', onclick: () => act(p.id, 'approve') }, 'Aprobar'),
      el('button', { class: 'btn btn-red', onclick: () => act(p.id, 'reject') }, 'Rechazar'),
    );
  } else if (mode === 'print') {
    ops.append(
      el('button', { class: 'btn btn-brand', onclick: () => printPhoto(p) }, '🖨 Imprimir'),
      el('button', { class: 'btn', onclick: () => act(p.id, 'printed') }, p.printedAt ? 'Sin imprimir' : 'Impresa'),
      el('a', {
        class: 'btn btn-icon',
        href: `${p.urls.print}?download=1`,
        download: `kuva_${String(p.seq).padStart(4, '0')}.jpg`,
        title: 'Descargar el archivo',
      }, '⤓'),
    );
  } else {
    if (p.status !== 'approved') ops.append(el('button', { class: 'btn btn-sm btn-green', onclick: () => act(p.id, 'approve') }, 'Aprobar'));
    if (p.status !== 'rejected') ops.append(el('button', { class: 'btn btn-sm btn-red', onclick: () => act(p.id, 'reject') }, 'Rechazar'));
    ops.append(el('button', { class: 'btn btn-sm btn-icon', onclick: () => removePhoto(p), title: 'Borrar definitivamente' }, '🗑'));
  }
  if (ops.children.length) node.append(ops);
  return node;
}

/* ──────────────────────────── impresión directa ─────────────────────────── */

let printFrame = null;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  IMPRESIÓN
 * ─────────────────────────────────────────────────────────────────────────────
 *  El diálogo de impresión se conserva (es donde el operador controla la
 *  impresora), pero se le entrega SIEMPRE el mismo trabajo:
 *
 *    · una hoja 4x6 pulgadas VERTICAL, sin márgenes,
 *    · con la foto llenándola completa.
 *
 *  Las fotos horizontales se giran 90° antes de mandarlas. El papel de la DNP
 *  es el mismo 4x6 en los dos casos y el resultado físico es idéntico (la foto
 *  sale girada en la hoja, igual que si el driver la girara), pero así el
 *  diálogo nunca cambia de orientación ni de tamaño entre una foto y la otra:
 *  se configura una vez y sirve para todas.
 *
 *  Se pide 4x6 PULGADAS y no 10x15 cm porque así declaran ese papel los drivers
 *  de las impresoras de foto; Chrome solo respeta el tamaño pedido cuando el
 *  driver tiene uno que coincida. Misma proporción 2:3, el marco no se deforma.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PRINT_GUIDE_KEY = 'kuva.printGuide.hidden';

function printDocument(src, title = 'Kuva') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>
      @page { size: 4in 6in; margin: 0; }
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #fff; }
      body { display: flex; align-items: center; justify-content: center; overflow: hidden; }
      img { display: block; width: 100%; height: 100%; object-fit: contain; }
    </style></head><body><img src="${src}"></body></html>`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar el archivo de impresión.'));
    img.src = src;
  });
}

/**
 * Devuelve la imagen lista para una hoja vertical: tal cual si ya es vertical,
 * girada 90° si es horizontal. El giro se hace aquí, en el navegador, sobre el
 * archivo de 300 dpi, sin pasar por el servidor.
 */
async function printableImage(p) {
  const img = await loadImage(p.urls.print);
  if (img.naturalWidth <= img.naturalHeight) return { src: p.urls.print, revoke: null };

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalHeight;
  canvas.height = img.naturalWidth;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.97));
  const url = URL.createObjectURL(blob);
  return { src: url, revoke: () => URL.revokeObjectURL(url) };
}

/** Abre el diálogo del sistema con la hoja ya preparada. */
async function sendToPrinter(p) {
  let prepared;
  try {
    prepared = await printableImage(p);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  if (!printFrame) {
    printFrame = el('iframe', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px;width:0;height:0;border:0' });
    document.body.append(printFrame);
  }

  const doc = printFrame.contentWindow.document;
  doc.open();
  doc.write(printDocument(prepared.src, `Kuva ${String(p.seq).padStart(3, '0')}`));
  doc.close();

  const img = doc.querySelector('img');
  const go = () => {
    const win = printFrame.contentWindow;
    win.focus();
    win.onafterprint = () => {
      prepared.revoke?.();
      // No hay forma de saber si salió bien o si la cancelaron: se pregunta.
      if (!p.printedAt && confirm(`¿Salió bien? ¿Marcar la foto #${String(p.seq).padStart(3, '0')} como impresa?`)) {
        act(p.id, 'printed');
      }
    };
    win.print();
  };
  if (img.complete) go();
  else img.onload = go;
}

/**
 * Antes del diálogo del sistema, una guía con la vista previa de la hoja y los
 * cuatro ajustes que hay que revisar. Se puede ocultar cuando el operador ya
 * la aprendió (y volver a mostrar desde la cola de impresión).
 */
let pendingPrint = null;

function hidePrintGuide() {
  try { return localStorage.getItem(PRINT_GUIDE_KEY) === '1'; } catch { return false; }
}

async function printPhoto(p) {
  if (hidePrintGuide()) return sendToPrinter(p);

  pendingPrint = p;
  const landscape = p.orientation === 'landscape';
  $('#ppSeq').textContent = `#${String(p.seq).padStart(3, '0')}`;
  $('#ppNote').textContent = landscape
    ? 'Esta foto es horizontal: sale girada en la hoja 4×6. Es normal, el papel es el mismo.'
    : 'Esta foto es vertical: sale derecha en la hoja 4×6.';
  $('#ppSheet').className = `pp-sheet ${landscape ? 'is-landscape' : ''}`;
  $('#ppImg').src = p.urls.web;
  $('#ppHide').checked = false;
  $('#printPrep').classList.add('on');
}

function closePrintGuide() {
  $('#printPrep').classList.remove('on');
  pendingPrint = null;
}

$('#ppGo').addEventListener('click', () => {
  const p = pendingPrint;
  if ($('#ppHide').checked) { try { localStorage.setItem(PRINT_GUIDE_KEY, '1'); } catch { /* nada */ } }
  closePrintGuide();
  if (p) sendToPrinter(p);
});
$('#ppCancel').addEventListener('click', closePrintGuide);
$('#printPrep').addEventListener('click', (e) => { if (e.target.id === 'printPrep') closePrintGuide(); });
$('#showPrintGuide').addEventListener('click', () => {
  try { localStorage.removeItem(PRINT_GUIDE_KEY); } catch { /* nada */ }
  toast('La guía de impresión se mostrará otra vez antes de imprimir.', 'ok');
});

async function removePhoto(p) {
  const n = `#${String(p.seq).padStart(3, '0')}`;
  if (!confirm(`¿Borrar la foto ${n}?\n\nSale de la pantalla y del panel. Los archivos van a la papelera de Drive, así que se pueden recuperar allí.`)) return;
  try {
    await api(`/api/admin/photos/${p.id}`, { method: 'DELETE' });
    state.photos.delete(p.id);
    if (state.lightbox === p.id) closeLightbox();
    render();
    toast(`Foto ${n} borrada`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function emptyState(icon, big, small) {
  return el('div', { class: 'empty-state' },
    el('div', { style: 'font-size:2.4rem' }, icon),
    el('div', { class: 'big' }, big),
    el('div', {}, small),
  );
}

function render() {
  const pending = photosByStatus('pending');
  const approved = photosByStatus('approved');
  const printQueue = approved.filter((p) => !p.printedAt);

  $('#bPending').textContent = pending.length;
  $('#bPending').dataset.n = pending.length;
  $('#bPrint').textContent = printQueue.length;
  $('#bPrint').dataset.n = printQueue.length;

  renderCounts();

  if (state.view === 'moderate') {
    const g = $('#gModerate');
    g.replaceChildren(...(pending.length
      ? pending.map((p) => card(p, { mode: 'moderate' }))
      : [emptyState('✨', 'Todo al día', 'No hay fotos esperando revisión.')]));
    highlightCursor();
  }

  if (state.view === 'print') {
    // Marcar una foto como impresa ya no la hace desaparecer: cambia de filtro.
    const rows = state.printFilter === 'impresas'
      ? approved.filter((p) => p.printedAt)
      : (state.printFilter === 'pendientes' ? printQueue : approved);
    $('#gPrint').replaceChildren(...(rows.length
      ? rows.map((p) => card(p, { mode: 'print' }))
      : [emptyState('🖨️', 'Nada por aquí', 'Cuando apruebes fotos aparecerán listas para imprimir.')]));
    $('#printCount').textContent = `${printQueue.length} por imprimir · ${approved.length - printQueue.length} impresas`;
  }

  if (state.view === 'all') {
    const f = $('#filterStatus').value;
    const rows = f === 'all'
      ? [...state.photos.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      : photosByStatus(f);
    $('#gAll').replaceChildren(...(rows.length
      ? rows.map((p) => card(p, { mode: 'all' }))
      : [emptyState('📭', 'Nada por aquí', 'Todavía no han llegado fotos con ese filtro.')]));
  }
}

function renderCounts() {
  const c = { pending: 0, approved: 0, rejected: 0, printed: 0 };
  for (const p of state.photos.values()) {
    c[p.status] = (c[p.status] || 0) + 1;
    if (p.printedAt) c.printed++;
  }
  $('#counts').replaceChildren(
    el('span', { class: 'pill pill-pending' }, `${c.pending} pendientes`),
    el('span', { class: 'pill pill-approved' }, `${c.approved} en pantalla`),
    el('span', { class: 'pill pill-gold' }, `${c.printed} impresas`),
  );
}

/* ─────────────────────────────── acciones ──────────────────────────────── */

async function act(id, action) {
  const path = { approve: 'approve', reject: 'reject', printed: 'printed' }[action];
  const p = state.photos.get(id);
  const body = action === 'printed' ? { printed: !p?.printedAt } : undefined;
  try {
    const { photo } = await api(`/api/admin/photos/${id}/${path}`, { method: 'POST', body });
    state.photos.set(photo.id, photo);
    render();
    if (state.lightbox === id) closeLightbox();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#approveAll').addEventListener('click', async () => {
  const n = photosByStatus('pending').length;
  if (!n) return toast('No hay pendientes.');
  if (!confirm(`¿Aprobar las ${n} fotos pendientes? Van a salir todas en la pantalla.`)) return;
  try {
    const r = await api(`/api/admin/events/${state.eventId}/bulk`, { method: 'POST', body: { action: 'approve' } });
    toast(`${r.affected} fotos aprobadas`, 'ok');
    await loadPhotos();
  } catch (err) { toast(err.message, 'error'); }
});

$('#printFilter')?.addEventListener('change', (e) => { state.printFilter = e.target.value; render(); });
$('#filterStatus').addEventListener('change', render);
$('#refreshAll').addEventListener('click', () => loadPhotos());

/* ─────────────────────────────── lightbox ──────────────────────────────── */

function openLightbox(id) {
  const p = state.photos.get(id);
  if (!p) return;
  state.lightbox = id;
  $('#lbSeq').textContent = `#${String(p.seq).padStart(3, '0')}`;
  $('#lbStatus').replaceChildren(statusPill(p));
  $('#lbMeta').textContent = [
    p.author && `por ${p.author}`,
    p.caption && `"${p.caption}"`,
    `${p.orientation === 'landscape' ? 'horizontal' : 'vertical'} · ajuste ${p.fitMode}`,
    timeAgo(p.createdAt),
    (p.flags || []).join(' · '),
  ].filter(Boolean).join('  ·  ');
  $('#lbRaw').src = p.urls.raw || p.urls.web;
  $('#lbPrint').src = p.urls.web;
  $('#lbDownload').href = `${p.urls.print}?download=1`;
  $('#lbDownload').download = `kuva_${String(p.seq).padStart(4, '0')}.jpg`;
  const drive = $('#lbDrive');
  drive.href = p.drive?.printLink || p.drive?.originalLink || '#';
  drive.style.display = (p.drive?.printLink || p.drive?.originalLink) ? '' : 'none';
  $('#lbApprove').style.display = p.status === 'approved' ? 'none' : '';
  $('#lbReject').style.display = p.status === 'rejected' ? 'none' : '';
  $('#lbPrint').style.display = p.status === 'approved' ? '' : 'none';
  $('#lbDownload').style.display = p.status === 'approved' ? '' : 'none';
  $('#lb').classList.add('on');
}

function closeLightbox() {
  state.lightbox = null;
  $('#lb').classList.remove('on');
}

$('#lbClose').addEventListener('click', closeLightbox);
$('#lb').addEventListener('click', (e) => { if (e.target.id === 'lb') closeLightbox(); });
$('#lbApprove').addEventListener('click', () => state.lightbox && act(state.lightbox, 'approve'));
$('#lbReject').addEventListener('click', () => state.lightbox && act(state.lightbox, 'reject'));
$('#lbPrint').addEventListener('click', () => {
  const p = state.photos.get(state.lightbox);
  if (p) printPhoto(p);
});
$('#lbDelete').addEventListener('click', () => {
  const p = state.photos.get(state.lightbox);
  if (p) removePhoto(p);
});

/* ──────────────────────── moderación con el teclado ─────────────────────── */

function highlightCursor() {
  const cards = $$('#gModerate .shot');
  if (!cards.length) return;
  state.cursor = Math.max(0, Math.min(state.cursor, cards.length - 1));
  cards.forEach((c, i) => c.classList.toggle('sel', i === state.cursor));
  cards[state.cursor]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#printPrep').classList.contains('on')) return closePrintGuide();
  if (e.target.matches('input, textarea, select')) return;

  if (e.key === 'Escape' && state.lightbox) return closeLightbox();

  if (state.lightbox) {
    const p = state.photos.get(state.lightbox);
    if (!p) return;
    if (e.key.toLowerCase() === 'a') { e.preventDefault(); act(p.id, 'approve'); }
    if (e.key.toLowerCase() === 'r') { e.preventDefault(); act(p.id, 'reject'); }
    return;
  }

  if (state.view !== 'moderate') return;
  const pending = photosByStatus('pending');
  if (!pending.length) return;

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); state.cursor++; highlightCursor(); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); state.cursor--; highlightCursor(); }
  if (e.key === 'Enter') { e.preventDefault(); openLightbox(pending[state.cursor]?.id); }
  if (e.key.toLowerCase() === 'a') { e.preventDefault(); act(pending[state.cursor]?.id, 'approve'); }
  if (e.key.toLowerCase() === 'r') { e.preventDefault(); act(pending[state.cursor]?.id, 'reject'); }
});

/* ──────────────────────────────── ajustes ──────────────────────────────── */

function fillSettings(ev) {
  $('#fName').value = ev.name || '';
  $('#fSubtitle').value = ev.subtitle || '';
  $('#fDate').value = ev.date || '';
  $('#fHashtag').value = ev.hashtag || '';
  $('#fFrameTitle').value = ev.frameTitle || '';
  $('#fFrameFooter').value = ev.frameFooter || '';
  $('#fModeration').value = ev.moderation || 'pre';
  $('#fFit').value = ev.fitMode || 'auto';
  $('#fMaxPer').value = ev.maxPerDevice ?? 12;
  $('#fCols').value = ev.displayColumns ?? 5;
  $('#fUploads').checked = !!ev.uploadEnabled;
  $('#fCaption').checked = !!ev.allowCaption;
  renderFrames(ev.frameId);
}

async function patchEvent(patch, message = 'Guardado') {
  try {
    const { event } = await api(`/api/admin/events/${state.eventId}`, { method: 'PATCH', body: patch });
    state.event = event;
    fillSettings(event);
    renderLinks();
    toast(message, 'ok');
  } catch (err) { toast(err.message, 'error'); }
}

$('#saveEvent').addEventListener('click', () => patchEvent({
  name: $('#fName').value.trim(),
  subtitle: $('#fSubtitle').value.trim(),
  date: $('#fDate').value,
  hashtag: $('#fHashtag').value.trim(),
  frameTitle: $('#fFrameTitle').value.trim(),
  frameFooter: $('#fFrameFooter').value.trim(),
}, 'Datos del evento guardados'));

$('#saveOps').addEventListener('click', () => patchEvent({
  moderation: $('#fModeration').value,
  fitMode: $('#fFit').value,
  maxPerDevice: Number($('#fMaxPer').value) || 0,
  displayColumns: Number($('#fCols').value) || 5,
  uploadEnabled: $('#fUploads').checked,
  allowCaption: $('#fCaption').checked,
}, 'Configuración guardada'));

function renderFrames(activeId) {
  const v = Date.now();
  // Cada marco tiene SIEMPRE dos versiones, vertical y horizontal: la app elige
  // según venga la foto. Se muestran las dos para que no parezca que falta una.
  const shot = (f, orientation) => el('img', {
    class: `pv pv-${orientation}`,
    src: `/api/admin/frames/${f.id}/preview.jpg?orientation=${orientation}&event=${state.eventId}&v=${v}`,
    alt: `${f.name} ${orientation === 'landscape' ? 'horizontal' : 'vertical'}`,
    loading: 'lazy',
  });
  $('#frames').replaceChildren(...state.frames.map((f) => el('button', {
    class: `frame-opt ${f.id === activeId ? 'on' : ''}`,
    onclick: () => patchEvent({ frameId: f.id }, `Marco cambiado a ${f.name}`),
  },
    el('div', { class: 'pair' }, shot(f, 'portrait'), shot(f, 'landscape')),
    el('div', { class: 'nm' }, f.name),
    el('div', { class: 'ds' }, f.description),
  )));
}

$('#recomposeAll').addEventListener('click', async () => {
  if (!confirm('Se van a regenerar todas las impresiones con el marco actual. Puede tardar un momento. ¿Seguir?')) return;
  try {
    const r = await api(`/api/admin/events/${state.eventId}/recompose-all`, { method: 'POST' });
    toast(`Regenerando ${r.queued} impresiones…`, 'ok', 5000);
  } catch (err) { toast(err.message, 'error'); }
});

function renderLinks() {
  const base = state.base || location.origin;
  const rows = [
    ['Pantalla del evento', `${base}/d/${state.event.slug}`],
    ['Link del QR', state.uploadUrl],
    ['Panel (este)', `${base}/admin`],
  ];
  $('#links').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('b', {}, k), el('code', {}, v))));
}

$('#copyUpload').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.uploadUrl); toast('Link copiado', 'ok'); }
  catch { toast('Cópialo a mano desde la lista de arriba.', 'error'); }
});

$('#downloadQR').addEventListener('click', () => {
  const a = el('a', { href: `/api/event/${state.eventId}/qr.png?size=1600`, download: `qr-${state.event.slug}.png` });
  document.body.append(a); a.click(); a.remove();
});

$('#openDisplay').addEventListener('click', () => window.open(`/d/${state.event.slug}`, '_blank'));

$('#newEvent').addEventListener('click', async () => {
  const name = prompt('Nombre del nuevo evento:');
  if (!name) return;
  try {
    const { event } = await api('/api/admin/events', { method: 'POST', body: { name } });
    toast(`Evento "${event.name}" creado`, 'ok');
    await bootstrap(event.id);
  } catch (err) { toast(err.message, 'error'); }
});

$('#eventSel').addEventListener('change', (e) => bootstrap(e.target.value));

/* ──────────────────────────────── sistema ─────────────────────────────── */

async function refreshDrive() {
  try {
    const d = await api('/api/admin/drive/status');
    const rows = [
      ['Estado', d.configured ? `Conectado (${d.mode})` : 'Sin conectar'],
      ['Cuenta', d.account?.user?.emailAddress || '—'],
      ['En cola', String(d.pending)],
      ['Sincronizadas', String(d.synced)],
      ['Con error', String(d.errored)],
    ];
    $('#driveKv').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('b', {}, k), el('code', {}, v))));
    $('#driveHint').textContent = d.configured
      ? 'Los originales van a 01_Originales y las aprobadas con marco a 02_Para_imprimir.'
      : 'Falta conectar Drive. Mira la sección "Conectar Google Drive" del README: son unos cinco minutos.';
  } catch (err) { toast(err.message, 'error'); }

  try {
    const h = await fetch('/health').then((r) => r.json());
    const rows = [
      ['Servidor', `activo hace ${Math.round(h.uptime / 60)} min`],
      ['Fotos guardadas', String(state.photos.size)],
      ['Espacio en disco', bytes(state.diskBytes || 0)],
      ['HEIC del iPhone', h.heic ? 'soportado' : 'se convierte en el celular'],
    ];
    $('#sysKv').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('b', {}, k), el('code', {}, v))));
  } catch { /* health no es crítico */ }
}

$('#driveSync').addEventListener('click', async () => {
  try { await api('/api/admin/drive/sync', { method: 'POST' }); toast('Sincronización lanzada', 'ok'); refreshDrive(); }
  catch (err) { toast(err.message, 'error'); }
});

$('#driveRequeue').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/drive/requeue', { method: 'POST' });
    toast(`${r.requeued} fotos reencoladas`, 'ok');
    refreshDrive();
  } catch (err) { toast(err.message, 'error'); }
});

/* ──────────────────────────────── arranque ─────────────────────────────── */

async function loadPhotos() {
  const { photos } = await api(`/api/admin/events/${state.eventId}/photos?status=all&limit=1000`);
  state.photos = new Map(photos.map((p) => [p.id, p]));
  render();
}

/**
 * En serverless no hay SSE: el panel sondea. 4 s es imperceptible moderando y
 * no castiga el numero de invocaciones de la funcion.
 */
function connectPolling() {
  const dot = $('#dot');
  const tick = async () => {
    try {
      await loadPhotos();
      dot.className = 'dot dot-live';
      $('#liveLabel').textContent = 'En vivo';
    } catch {
      dot.className = 'dot dot-off';
      $('#liveLabel').textContent = 'Reconectando';
    }
    state.pollTimer = setTimeout(tick, 4000);
  };
  clearTimeout(state.pollTimer);
  tick();
}

function connect() {
  if (state.live === 'poll') return connectPolling();
  state.sse?.close();
  state.sse = stream(`/api/admin/events/${state.eventId}/stream`, {
    onOpen: () => { $('#dot').className = 'dot dot-live'; $('#liveLabel').textContent = 'En vivo'; },
    onError: () => { $('#dot').className = 'dot dot-off'; $('#liveLabel').textContent = 'Reconectando'; },
    'photo:new': (photo) => {
      state.photos.set(photo.id, photo);
      render();
      if (photo.status === 'pending') toast(`Nueva foto para revisar · #${photo.seq}`);
    },
    'photo:updated': (photo) => {
      const prev = state.photos.get(photo.id);
      state.photos.set(photo.id, { ...prev, ...photo });
      render();
    },
    'photo:deleted': ({ id }) => {
      state.photos.delete(id);
      render();
    },
  });
}

async function bootstrap(preferEventId) {
  const boot = await api('/api/admin/bootstrap');
  state.frames = boot.frames;
  state.base = boot.baseUrl;
  state.master = boot.master;

  const allowed = boot.events.map((e) => e.id);
  const eventId = (allowed.includes(preferEventId) && preferEventId) || boot.activeEventId || allowed[0];
  if (!eventId) return toast('No hay sedes configuradas.', 'error');
  state.eventId = eventId;

  // Un moderador de sede solo ve su sede: sin selector, con su nombre fijo.
  // El maestro puede saltar entre sedes.
  const current = boot.events.find((e) => e.id === eventId);
  $('#sedeBadge').textContent = `📍 ${current ? label(current) : ''}`;
  $('#sedeBadge').hidden = boot.master;
  $('#eventSel').hidden = !boot.master;
  $('#eventSel').replaceChildren(...boot.events.map((e) => el('option', {
    value: e.id, ...(e.id === eventId ? { selected: 'selected' } : {}),
  }, label(e))));

  // Ajustes y Drive son del maestro, aunque alguien escriba ?avanzado=1.
  if (!boot.master) {
    $$('nav.tabs button').forEach((b) => {
      if (b.dataset.view === 'settings' || b.dataset.view === 'system') b.remove();
    });
  }

  // El transporte en vivo lo dicta el servidor (SSE en local, sondeo en la nube).
  state.live = (await api(`/api/event/${eventId}`).catch(() => ({}))).live || 'sse';

  const detail = await api(`/api/admin/events/${eventId}`);
  state.event = detail.event;
  state.uploadUrl = detail.uploadUrl;
  state.diskBytes = detail.diskBytes;

  if (boot.master) {
    fillSettings(state.event);
    renderLinks();
  }
  await loadPhotos();
  connect();
  if (boot.master) refreshDrive();
}

async function start(preferEventId) {
  $('#gate').style.display = 'none';
  $('#app').classList.add('on');
  let prefer = preferEventId;
  if (!prefer) { try { prefer = localStorage.getItem(SEDE_KEY) || undefined; } catch { /* nada */ } }
  await bootstrap(prefer);
}

(async function init() {
  const { authenticated } = await api('/api/admin/session').catch(() => ({ authenticated: false }));
  if (authenticated) start();
  else loadSedes();
})();
