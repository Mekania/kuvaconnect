import * as drive from './drive.js';
import { logger } from './logger.js';

const log = logger('drive-backend');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  DRIVE COMO ALMACÉN COMPLETO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  En el modo nube no hay base de datos aparte: Drive es las dos cosas.
 *
 *    · El REGISTRO de una foto son las `appProperties` de su archivo original.
 *    · Su ESTADO de moderación es la carpeta donde está ese original.
 *    · La CONFIGURACIÓN del evento es la `description` de su carpeta.
 *
 *  Esto evita guardar cada foto dos veces (una para la pantalla y otra para el
 *  cliente) y deja una sola integración que mantener. El precio: cada consulta
 *  es una llamada de red de ~300 ms, y las imágenes se sirven a través de una
 *  función en vez de un CDN. Para una pantalla y cientos de fotos por evento,
 *  sale a cuenta.
 *
 *  Estructura en Drive:
 *
 *    KuvaConnect/
 *      <Nombre del evento>/        ← description = JSON del evento
 *        01_Originales/            ← el original; sus appProperties = el registro
 *        02_Para_imprimir/         ← con marco a 300dpi, la cola de impresión
 *        03_Rechazadas/            ← originales bloqueados en moderación
 *        04_Impresas/              ← ya salieron por la impresora
 *        _sistema/                 ← derivados que solo usa la app
 * ─────────────────────────────────────────────────────────────────────────────
 */

const ROOT_NAME = 'KuvaConnect';
const SUB = {
  originals: '01_Originales',
  toPrint: '02_Para_imprimir',
  rejected: '03_Rechazadas',
  printed: '04_Impresas',
  system: '_sistema',
};

/**
 * Caché por instancia. Una función serverless vive segundos, así que esto solo
 * evita repetir la misma búsqueda de carpetas dentro de una misma petición.
 * Nunca cachea fotos: esas tienen que venir frescas siempre.
 */
const folderCache = new Map();

async function rootId() {
  if (folderCache.has('__root')) return folderCache.get('__root');
  const id = process.env.DRIVE_ROOT_FOLDER_ID || await drive.findOrCreateFolder(ROOT_NAME, null);
  folderCache.set('__root', id);
  return id;
}

/** Carpetas del evento, creándolas la primera vez. */
export async function folders(eventFolderId) {
  const key = `f:${eventFolderId}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const entries = await Promise.all(
    Object.entries(SUB).map(async ([k, name]) => [k, await drive.findOrCreateFolder(name, eventFolderId)]),
  );
  const out = Object.fromEntries(entries);
  out.event = eventFolderId;
  folderCache.set(key, out);
  return out;
}

/* ═════════════════════════════════ eventos ═══════════════════════════════ */

const esc = (s) => String(s).replace(/'/g, "\\'");

function folderToEvent(f) {
  if (!f?.description) return null;
  let cfg;
  try { cfg = JSON.parse(f.description); } catch { return null; }
  return { ...cfg, folderId: f.id, name: cfg.name || f.name };
}

export async function listEvents() {
  const root = await rootId();
  const files = await drive.listFiles(
    `'${root}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    { orderBy: 'createdTime' },
  );
  return files.map(folderToEvent).filter(Boolean);
}

export async function getEvent(idOrSlug) {
  if (!idOrSlug) return null;
  const all = await listEvents();
  return all.find((e) => e.id === idOrSlug || e.slug === idOrSlug) || null;
}

export async function addEvent(ev) {
  const root = await rootId();
  const folderId = await drive.findOrCreateFolder(drive.eventFolderName(ev), root);
  await drive.setMeta(folderId, {
    description: JSON.stringify(ev),
    appProperties: { kuvaEvent: '1', kid: ev.id, slug: ev.slug },
  });
  await folders(folderId); // deja las subcarpetas listas de una vez
  log.ok(`evento en Drive: ${ev.name}`);
  return { ...ev, folderId };
}

export async function updateEvent(id, patch) {
  const ev = await getEvent(id);
  if (!ev) return null;
  const next = { ...ev, ...patch, updatedAt: new Date().toISOString() };
  const { folderId, ...clean } = next;
  const newFolderName = drive.eventFolderName(next);
  await drive.setMeta(ev.folderId, {
    description: JSON.stringify(clean),
    ...(newFolderName !== drive.eventFolderName(ev) ? { name: newFolderName } : {}),
  });
  return next;
}

/* ══════════════════════════════════ fotos ════════════════════════════════ */

/**
 * Las claves van cortas a propósito: Drive limita cada par clave-valor de
 * appProperties a 124 bytes, y ahí tiene que caber todo el registro.
 * Lo que no cabe (nombre, mensaje) va en `description` como JSON.
 */
function fileToPhoto(f, eventId) {
  const a = f.appProperties || {};
  if (!a.kid) return null;
  let extra = {};
  try { extra = f.description ? JSON.parse(f.description) : {}; } catch { /* descripción editada a mano */ }
  return {
    id: a.kid,
    eventId: a.ev || eventId,
    seq: Number(a.seq) || 0,
    status: a.st || 'pending',
    orientation: a.or || 'portrait',
    fitMode: a.fit || 'crop',
    frameId: a.fr || '',
    originalExt: a.ext || 'jpg',
    flags: a.fl ? a.fl.split(',').filter(Boolean) : [],
    printedAt: a.pr || null,
    createdAt: f.createdTime,
    updatedAt: f.createdTime,
    approvedAt: a.ap || null,
    rejectedAt: a.rj || null,
    files: { orig: f.id, web: a.web || null, raw: a.raw || null, print: a.prn || null },
    drive: {
      state: 'synced', // en este modo la foto YA vive en Drive: no hay cola
      originalLink: `https://drive.google.com/file/d/${f.id}/view`,
      printLink: a.prn ? `https://drive.google.com/file/d/${a.prn}/view` : null,
    },
    ...extra,
  };
}

function photoToProps(p) {
  const props = {
    kid: p.id,
    ev: p.eventId,
    seq: String(p.seq ?? 0),
    st: p.status,
    or: p.orientation || '',
    fit: p.fitMode || '',
    fr: p.frameId || '',
    ext: p.originalExt || 'jpg',
    fl: (p.flags || []).join(','),
  };
  if (p.files?.web) props.web = p.files.web;
  if (p.files?.raw) props.raw = p.files.raw;
  if (p.files?.print) props.prn = p.files.print;
  if (p.printedAt) props.pr = p.printedAt;
  if (p.approvedAt) props.ap = p.approvedAt;
  if (p.rejectedAt) props.rj = p.rejectedAt;
  return props;
}

function photoToDescription(p) {
  return JSON.stringify({
    caption: p.caption || '',
    author: p.author || '',
    device: p.device || '',
    brightness: p.brightness ?? null,
    sourceWidth: p.sourceWidth ?? null,
    sourceHeight: p.sourceHeight ?? null,
    bytes: p.bytes ?? null,
    error: p.error || null,
    rejectedReason: p.rejectedReason || null,
    moderatedBy: p.moderatedBy || null,
  });
}

/** Las fotos viven en 01_Originales, y las rechazadas en 03_Rechazadas. */
async function photoScope(eventId) {
  const ev = await getEvent(eventId);
  if (!ev) throw new Error(`Evento ${eventId} no encontrado en Drive`);
  const f = await folders(ev.folderId);
  return { ev, f, parents: `('${f.originals}' in parents or '${f.rejected}' in parents)` };
}

export async function listPhotos(eventId, { status, limit } = {}) {
  const { f, parents } = await photoScope(eventId);
  let q = `${parents} and trashed = false`;
  // Un solo estado se filtra en Drive; varios se filtran aquí (la API no tiene OR de propiedades).
  if (typeof status === 'string') q += ` and appProperties has { key='st' and value='${esc(status)}' }`;
  const files = await drive.listFiles(q, { orderBy: 'createdTime desc', pageSize: Math.min(limit || 200, 1000) });
  let rows = files.map((x) => fileToPhoto(x, eventId)).filter(Boolean);
  if (Array.isArray(status)) rows = rows.filter((p) => status.includes(p.status));
  void f;
  return limit ? rows.slice(0, limit) : rows;
}

export async function getPhoto(id) {
  const files = await drive.listFiles(
    `appProperties has { key='kid' and value='${esc(id)}' } and trashed = false`,
    { pageSize: 5 },
  );
  const orig = files.find((f) => f.appProperties?.kid === id);
  return orig ? fileToPhoto(orig) : null;
}

/**
 * En Drive el original ya se subió antes (es el archivo), así que "crear el
 * registro" es colgarle los metadatos encima.
 */
export async function addPhoto(photo) {
  if (!photo.files?.orig) throw new Error('addPhoto en Drive necesita el id del archivo original');
  await drive.setMeta(photo.files.orig, {
    appProperties: photoToProps(photo),
    description: photoToDescription(photo),
  });
  return photo;
}

export async function updatePhoto(id, patch) {
  const prev = await getPhoto(id);
  if (!prev) return null;
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };

  // Un cambio de estado también mueve el original de carpeta: en Drive, el
  // estado ES la carpeta, y el logístico tiene que verlo sin abrir la app.
  if (patch.status && patch.status !== prev.status) {
    const { f } = await photoScope(prev.eventId);
    const to = patch.status === 'rejected' ? f.rejected : f.originals;
    try { await drive.moveFile(prev.files.orig, to); } catch (err) { log.warn(`mover ${id}: ${err.message}`); }
  }

  await drive.setMeta(prev.files.orig, {
    appProperties: photoToProps(next),
    description: photoToDescription(next),
  });
  return next;
}

export async function nextSeq(eventId) {
  const rows = await listPhotos(eventId, { limit: 1000 });
  return rows.reduce((max, p) => Math.max(max, p.seq || 0), 0) + 1;
}

export async function countByStatus(eventId) {
  const out = { pending: 0, approved: 0, rejected: 0, error: 0, total: 0, printed: 0 };
  for (const p of await listPhotos(eventId)) {
    out.total++;
    out[p.status] = (out[p.status] || 0) + 1;
    if (p.printedAt) out.printed++;
  }
  return out;
}

/* ═════════════════════════════════ archivos ══════════════════════════════ */

const PRINT_SUFFIX = (p) => (p.orientation === 'landscape' ? 'H' : 'V');

/**
 * Dónde vive cada tipo de archivo.
 * La impresión nace en _sistema y solo se muda a 02_Para_imprimir cuando la
 * foto se aprueba: así la cola de impresión del logístico nunca tiene fotos
 * que todavía no pasaron moderación.
 */
export async function writeFile(eventId, kind, photoId, buffer, { ext = 'jpg', seq = 0, orientation, mimeType } = {}) {
  const { ev, f } = await photoScope(eventId);
  const n = String(seq).padStart(4, '0');

  const plan = {
    orig: { folder: f.originals, name: `${n}_${photoId}_original.${ext}` },
    print: { folder: f.system, name: `${n}_${photoId}_${orientation === 'landscape' ? 'H' : 'V'}.jpg` },
    web: { folder: f.system, name: `${photoId}_web.jpg` },
    raw: { folder: f.system, name: `${photoId}_raw.jpg` },
    thumb: { folder: f.system, name: `${photoId}_thumb.jpg` },
  }[kind];
  if (!plan) throw new Error(`tipo de archivo desconocido: ${kind}`);

  const file = await drive.uploadBuffer({
    folderId: plan.folder,
    name: plan.name,
    buffer,
    mimeType: mimeType || (ext === 'png' ? 'image/png' : 'image/jpeg'),
    description: kind === 'orig' ? `KuvaConnect · ${ev.name}` : undefined,
  });
  return file.id;
}

export async function readFileById(fileId) {
  return drive.downloadFile(fileId);
}

/** Mueve la impresión a la cola del logístico (al aprobar). */
export async function movePrintToQueue(photo) {
  if (!photo.files?.print) return;
  const { f } = await photoScope(photo.eventId);
  await drive.moveFile(photo.files.print, f.toPrint);
}

/** La saca de la cola (al rechazar) o la archiva (al marcar impresa). */
export async function movePrint(photo, where) {
  if (!photo.files?.print) return;
  const { f } = await photoScope(photo.eventId);
  const target = { queue: f.toPrint, printed: f.printed, system: f.system }[where];
  if (target) await drive.moveFile(photo.files.print, target);
}

/**
 * Borra los derivados que se sirven sin autenticación.
 * Al rechazar una foto no basta con bajarla de la pantalla: hay que quitar el
 * archivo, porque su URL seguiría funcionando para quien ya la tuviera.
 */
export async function removePublicFiles(photo) {
  const ids = [photo.files?.web, photo.files?.thumb].filter(Boolean);
  await Promise.all(ids.map((id) => drive.deleteFile(id).catch(() => {})));
}

/**
 * Borra una foto por completo.
 * Va a la PAPELERA de Drive, no se destruye: si el moderador se equivoca, el
 * cliente puede recuperarla desde Drive durante 30 días.
 */
export async function deletePhoto(photo) {
  const ids = [photo.files?.orig, photo.files?.web, photo.files?.thumb, photo.files?.raw, photo.files?.print]
    .filter(Boolean);
  await Promise.all(ids.map((id) => drive.deleteFile(id).catch((err) => log.warn(`borrar ${id}: ${err.message}`))));
}

export function resetCache() {
  folderCache.clear();
}
