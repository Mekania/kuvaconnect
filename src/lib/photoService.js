import sharp from 'sharp';
import { addPhoto, getEvent, getPhoto, listPhotos, updatePhoto, nextSeq } from './db.js';
import { composeFramed, makeWebVersions, makeRawPreview, analyze } from './compose.js';
import * as media from './media.js';
import { frameMeta } from './eventService.js';
import { queueOp, OPS } from './driveSync.js';
import { publish } from './bus.js';
import { shortId } from './ids.js';
import { logger } from './logger.js';

const log = logger('fotos');

/** Canal privado del panel de moderación: ahí sí viajan las fotos pendientes. */
export const adminChannel = (eventId) => `${eventId}:admin`;

export const HEIF_SUPPORTED = Boolean(sharp.format.heif?.input?.buffer);

/** Lo que se expone por la API. Nunca salen rutas de disco ni IDs internos de Drive. */
export function publicPhoto(p) {
  return {
    id: p.id,
    seq: p.seq,
    status: p.status,
    orientation: p.orientation,
    fitMode: p.fitMode,
    frameId: p.frameId,
    caption: p.caption || '',
    author: p.author || '',
    createdAt: p.createdAt,
    printedAt: p.printedAt || null,
    flags: p.flags || [],
    urls: {
      thumb: media.urlFor(p, 'thumb'),
      web: media.urlFor(p, 'web'),
    },
    drive: {
      state: p.drive?.state || 'idle',
      printLink: p.drive?.printLink || null,
      originalLink: p.drive?.originalLink || null,
    },
  };
}

/** Vista de moderación: agrega el original sin marco y el enlace de impresión. */
export function adminPhoto(p) {
  return {
    ...publicPhoto(p),
    urls: {
      ...publicPhoto(p).urls,
      raw: media.urlFor(p, 'raw'),
      print: media.urlFor(p, 'print'),
      original: media.urlFor(p, 'orig'),
    },
    device: p.device,
    ip: p.ip,
    error: p.error || null,
    driveDetail: p.drive || null,
  };
}

/**
 * Pipeline completo de una foto que entra desde el celular:
 *   original a disco → análisis → composición con marco (300dpi) → derivados web
 *   → registro → cola de Drive → aviso en vivo a pantalla y panel.
 */
export async function ingest(event, { buffer, mimeType, device, ip, caption, author }) {
  const id = shortId(8);
  const ext = media.extFromMime(mimeType);
  const started = Date.now();

  await media.ensureEventDirs(event.id);
  // El consecutivo se calcula antes de escribir porque en Drive va en el nombre
  // del archivo, que es lo que ordena la carpeta del logístico.
  const seq = await nextSeq(event.id);
  const files = {};
  files.orig = await media.write(event.id, 'orig', id, buffer, ext, { seq, mimeType });

  const info = await analyze(buffer);

  let framed;
  try {
    framed = await composeFramed(buffer, {
      frameId: event.frameId,
      fitMode: event.fitMode,
      ...frameMeta(event),
    });
  } catch (err) {
    log.error(`no se pudo componer ${id}: ${err.message}`);
    const broken = await addPhoto({
      id,
      eventId: event.id,
      seq,
      files,
      status: 'error',
      error: err.message,
      mimeType,
      originalExt: ext,
      device,
      ip,
      caption: caption || '',
      author: author || '',
      createdAt: new Date().toISOString(),
      drive: { state: 'pending', pendingOps: [], attempts: 0 },
    });
    await queueOp(id, OPS.UPLOAD_ORIGINAL); // el original se guarda igual: no se pierde la foto del invitado
    publish(adminChannel(event.id), 'photo:new', adminPhoto(broken));
    throw Object.assign(new Error('No pudimos procesar esa imagen. Intenta con otra foto.'), { code: 'COMPOSE_FAILED' });
  }

  const [{ web, thumb }, raw] = await Promise.all([
    makeWebVersions(framed.buffer),
    makeRawPreview(buffer),
  ]);

  const meta = { seq, orientation: framed.orientation };
  const [printId, webId, thumbId, rawId] = await Promise.all([
    media.write(event.id, 'print', id, framed.buffer, 'jpg', meta),
    media.write(event.id, 'web', id, web, 'jpg', meta),
    media.write(event.id, 'thumb', id, thumb, 'jpg', meta),
    media.write(event.id, 'raw', id, raw, 'jpg', meta),
  ]);
  Object.assign(files, { print: printId, web: webId, thumb: thumbId, raw: rawId });

  const autoApprove = event.moderation === 'post';
  const photo = await addPhoto({
    id,
    eventId: event.id,
    seq,
    files,
    status: autoApprove ? 'approved' : 'pending',
    orientation: framed.orientation,
    fitMode: framed.fitMode,
    frameId: framed.frameId,
    mimeType,
    originalExt: ext,
    bytes: buffer.length,
    sourceWidth: framed.sourceWidth,
    sourceHeight: framed.sourceHeight,
    flags: info.flags,
    brightness: info.brightness,
    caption: (caption || '').slice(0, 120),
    author: (author || '').slice(0, 40),
    device,
    ip,
    createdAt: new Date().toISOString(),
    approvedAt: autoApprove ? new Date().toISOString() : null,
    printedAt: null,
    drive: { state: 'pending', pendingOps: [], attempts: 0 },
  });

  await queueOp(id, OPS.UPLOAD_ORIGINAL);
  if (autoApprove) {
    await queueOp(id, OPS.UPLOAD_PRINT);
    await media.onApproved(photo);
  }

  publish(adminChannel(event.id), 'photo:new', adminPhoto(photo));
  if (autoApprove) publish(event.id, 'photo:new', publicPhoto(photo));

  log.ok(`#${photo.seq} ${id} · ${framed.orientation}/${framed.fitMode} · ${Date.now() - started}ms · ${autoApprove ? 'en pantalla' : 'esperando moderación'}`);
  return photo;
}

/* ─────────────────────────────── moderación ──────────────────────────────── */

export async function approve(photoId, by = 'panel') {
  const p = await getPhoto(photoId);
  if (!p || p.status === 'approved') return p;
  const was = p.status;

  // Si venía de un rechazo, sus derivados públicos fueron borrados: hay que
  // volver a generarlos antes de anunciarla en la pantalla.
  const webMissing = media.IS_DRIVE ? !p.files?.web : !(await media.has(p.eventId, 'web', p.id));
  if (was === 'rejected' && webMissing) {
    try {
      await recompose(p, await getEvent(p.eventId));
    } catch (err) {
      log.error(`no se pudo rehacer ${photoId} al aprobar: ${err.message}`);
      return p;
    }
  }

  const updated = await updatePhoto(photoId, {
    status: 'approved', approvedAt: new Date().toISOString(), moderatedBy: by, rejectedReason: null,
  });
  await queueOp(photoId, OPS.UPLOAD_PRINT);
  if (was === 'rejected') {
    await queueOp(photoId, OPS.UPLOAD_ORIGINAL);
    await queueOp(photoId, OPS.MOVE_APPROVED); // devolverlo a 01_Originales
  }
  await media.onApproved(updated).catch((err) => log.warn(`mover impresión: ${err.message}`));
  publish(p.eventId, 'photo:new', publicPhoto(updated));
  publish(adminChannel(p.eventId), 'photo:updated', adminPhoto(updated));
  log.info(`aprobada #${updated.seq} (${photoId})`);
  return updated;
}

export async function reject(photoId, reason = '', by = 'panel') {
  const p = await getPhoto(photoId);
  if (!p) return null;
  const updated = await updatePhoto(photoId, {
    status: 'rejected', rejectedAt: new Date().toISOString(), rejectedReason: reason, moderatedBy: by,
  });
  await queueOp(photoId, OPS.MOVE_REJECTED);

  // Las versiones web/miniatura se sirven sin autenticación: si alguien subió
  // algo que no debía, no basta con sacarlo de la pantalla — hay que quitarlo
  // del disco público. El original y la copia de impresión se conservan (solo
  // los ve el panel) por si el rechazo fue un error.
  await media.onRejected(updated).catch((err) => log.warn(`sacar de la cola: ${err.message}`));
  await media.removePublic(updated).catch((err) => log.warn(`limpiando ${photoId}: ${err.message}`));

  publish(p.eventId, 'photo:removed', { id: p.id });
  publish(adminChannel(p.eventId), 'photo:updated', adminPhoto(updated));
  log.info(`rechazada #${updated.seq} (${photoId})${reason ? ` · ${reason}` : ''}`);
  return updated;
}

export async function markPrinted(photoId, printed = true) {
  const p = await getPhoto(photoId);
  if (!p) return null;
  const updated = await updatePhoto(photoId, { printedAt: printed ? new Date().toISOString() : null });
  await queueOp(photoId, printed ? OPS.MOVE_PRINTED : OPS.MOVE_UNPRINTED);
  await media.onPrinted(updated, printed).catch((err) => log.warn(`archivar impresión: ${err.message}`));
  publish(adminChannel(p.eventId), 'photo:updated', adminPhoto(updated));
  return updated;
}

/** Recompone la impresión: útil si se cambia el marco a mitad de evento. */
export async function recompose(photo, event) {
  const original = await media.readFor(photo, 'orig');
  const framed = await composeFramed(original, {
    frameId: event.frameId,
    fitMode: event.fitMode,
    ...frameMeta(event),
  });
  const { web, thumb } = await makeWebVersions(framed.buffer);
  const meta = { seq: photo.seq, orientation: framed.orientation };
  const [printId, webId, thumbId] = await Promise.all([
    media.write(event.id, 'print', photo.id, framed.buffer, 'jpg', meta),
    media.write(event.id, 'web', photo.id, web, 'jpg', meta),
    media.write(event.id, 'thumb', photo.id, thumb, 'jpg', meta),
  ]);
  const updated = await updatePhoto(photo.id, {
    frameId: framed.frameId,
    orientation: framed.orientation,
    fitMode: framed.fitMode,
    files: { ...(photo.files || {}), print: printId, web: webId, thumb: thumbId },
  });

  // La copia vieja de Drive ya no sirve: se reemplaza.
  if (photo.drive?.printId) {
    await queueOp(photo.id, OPS.DELETE_PRINT);
    if (photo.status === 'approved') await queueOp(photo.id, OPS.UPLOAD_PRINT);
  }
  publish(adminChannel(event.id), 'photo:updated', adminPhoto(updated));
  return updated;
}

export async function feed(eventId, { limit = 200 } = {}) {
  return (await listPhotos(eventId, { status: 'approved', limit })).map(publicPhoto);
}

export async function queue(eventId, { status, limit = 300 } = {}) {
  return (await listPhotos(eventId, { status, limit })).map(adminPhoto);
}
