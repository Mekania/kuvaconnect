import { $, api, toast, eventSlugFromUrl, deviceId } from '/shared/kuva.js';

/**
 * Flujo del invitado en el celular: elegir → revisar → enviar → confirmación.
 *
 * La foto se reescala en el navegador antes de subirla. Tres razones:
 *  1. El wifi de un salón de eventos no aguanta 60 personas subiendo 8 MB.
 *  2. Al pasar por <canvas> el HEIC del iPhone sale convertido a JPEG,
 *     que es lo que sharp puede procesar en el servidor.
 *  3. 3000 px de lado largo sobra para imprimir a 10x15 (el lienzo es 1800 px).
 */

/**
 * Vercel corta cualquier cuerpo de peticion por encima de ~4.5 MB, y ese limite
 * no se puede subir. Con 2400 px de lado largo y calidad 0.85 una foto de
 * celular queda entre 400 KB y 1.2 MB: sobra para imprimir (el hueco del marco
 * son 1060x1237 px) y entra con margen de sobra.
 */
const MAX_EDGE = 2400;
const JPEG_QUALITY = 0.85;

const slug = eventSlugFromUrl();
const step = (id) => {
  document.querySelectorAll('.step').forEach((s) => s.classList.toggle('on', s.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

let event = null;
let pending = null; // { blob, url }

/* ───────────────────────── reescalado en el navegador ───────────────────── */

async function prepare(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, resized: false }; // formato raro: que lo intente el servidor

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  if (!blob) return { blob: file, resized: false };
  return { blob, resized: scale < 1, width: w, height: h };
}

/* ─────────────────────────────── subida ─────────────────────────────────── */

function send(blob) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('photo', blob, 'foto.jpg');
    form.append('device', deviceId());
    form.append('author', $('#author').value.trim());
    form.append('caption', $('#caption').value.trim());

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/event/${event.id}/upload`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) $('#bar').style.width = `${Math.round((e.loaded / e.total) * 92)}%`;
    });
    xhr.addEventListener('load', () => {
      $('#bar').style.width = '100%';
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* respuesta no-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'No pudimos enviar la foto. Intenta otra vez.'));
    });
    xhr.addEventListener('error', () => reject(new Error('Se perdió la conexión. Revisa el wifi e intenta de nuevo.')));
    xhr.addEventListener('abort', () => reject(new Error('Envío cancelado.')));
    xhr.send(form);
  });
}

/* ───────────────────────────── interacciones ────────────────────────────── */

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ''; // permite volver a elegir la misma foto
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    toast('Eso no es una foto. Elige una imagen.', 'error');
    return;
  }

  toast('Preparando tu foto…');
  try {
    const prepared = await prepare(file);
    if (pending?.url) URL.revokeObjectURL(pending.url);
    pending = { blob: prepared.blob, url: URL.createObjectURL(prepared.blob) };
    $('#previewImg').src = pending.url;
    step('stepReview');
  } catch (err) {
    toast('No pudimos leer esa foto. Intenta con otra.', 'error');
  }
});

$('#another').addEventListener('click', () => {
  step('stepPick');
  $('#file').click();
});

$('#send').addEventListener('click', async () => {
  if (!pending) return step('stepPick');
  $('#bar').style.width = '0%';
  step('stepUploading');
  try {
    const res = await send(pending.blob);
    $('#doneTitle').textContent = res.moderated ? 'Recibida' : '¡Ya estás en pantalla!';
    $('#doneMsg').textContent = res.message || '';
    if (res.photo?.urls?.web && !res.moderated) {
      $('#resultImg').src = res.photo.urls.web;
      $('#resultBox').hidden = false;
      $('#doneHint').textContent = 'Así se va a imprimir tu foto.';
    } else {
      $('#resultBox').hidden = true;
      $('#doneHint').textContent = 'Mira la pantalla del evento en un par de minutos.';
      if (res.photo?.id) watchStatus(res.photo.id);
    }
    step('stepDone');
  } catch (err) {
    toast(err.message, 'error', 5000);
    step('stepReview');
  }
});

$('#again').addEventListener('click', () => {
  if (pending?.url) URL.revokeObjectURL(pending.url);
  pending = null;
  $('#caption').value = '';
  $('#resultBox').hidden = true;
  step('stepPick');
});

/** Si la foto quedó en moderación, avisamos en el celular cuando salga aprobada. */
function watchStatus(photoId) {
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    if (tries > 40) return clearInterval(poll); // ~3 minutos y soltamos
    try {
      const { status, url } = await api(`/api/photo/${photoId}/status`);
      if (status === 'approved') {
        clearInterval(poll);
        $('#doneTitle').textContent = '¡Ya estás en pantalla!';
        $('#doneMsg').textContent = 'Tu foto pasó la revisión y ya está en el álbum del evento.';
        $('#doneHint').textContent = 'Así se va a imprimir tu foto.';
        if (url) { $('#resultImg').src = url; $('#resultBox').hidden = false; }
        toast('¡Tu foto ya está en la pantalla!', 'ok');
      } else if (status === 'rejected') {
        clearInterval(poll);
        $('#doneMsg').textContent = 'Esta foto no pudo publicarse. Puedes intentar con otra.';
      }
    } catch { /* seguimos intentando */ }
  }, 4500);
}

/* ──────────────────────────────── arranque ──────────────────────────────── */

async function boot() {
  try {
    const info = await api(`/api/event/${encodeURIComponent(slug || 'x')}`);
    event = info.event;
  } catch {
    $('#title').textContent = 'Evento no encontrado';
    $('#subtitle').textContent = 'Vuelve a escanear el QR de la pantalla.';
    document.querySelectorAll('.step').forEach((s) => s.classList.remove('on'));
    return;
  }

  document.title = `${event.name} · Sube tu foto`;
  $('#title').textContent = event.name;
  $('#subtitle').textContent = event.subtitle || '';
  if (event.hashtag) $('#eyebrow').textContent = event.hashtag;

  const root = document.documentElement.style;
  if (event.theme?.brand) root.setProperty('--brand', event.theme.brand);
  if (event.theme?.hot) root.setProperty('--hot', event.theme.hot);
  if (event.theme?.accent) root.setProperty('--gold', event.theme.accent);
  if (event.theme?.paper) root.setProperty('--paper', event.theme.paper);

  const logo = $('#brandLogo');
  if (event.theme?.logo) logo.src = event.theme.logo;
  logo.addEventListener('error', () => { logo.style.display = 'none'; });

  if (!event.allowCaption) {
    $('#captionField').hidden = true;
    $('#authorField').hidden = true;
  }
  $('#tipModeration').innerHTML = event.moderation === 'pre'
    ? '<i>👀</i> Un moderador la revisa antes de que salga en pantalla.'
    : '<i>⚡</i> Tu foto sale en la pantalla en cuestión de segundos.';

  if (!event.uploadEnabled) step('stepClosed');
}

boot();
