import fs from 'node:fs/promises';
import { config } from '../config.js';
import * as drive from './drive.js';
import * as media from './media.js';
import { getEvent, updateEvent, listEvents, getPhoto, photos as photoStore, savePhotos } from './db.js';
import { logger } from './logger.js';
import { publish } from './bus.js';

const log = logger('drive-sync');

/**
 * Cola de sincronización con Drive.
 *
 * Idea central: el evento NUNCA espera a Drive. Todo se guarda primero en disco
 * y aquí se van drenando las operaciones pendientes. Si no hay credenciales,
 * si se cae el wifi o si Google devuelve 500, las fotos se quedan en cola y
 * suben solas cuando vuelve la conexión. Nada se pierde.
 */

export const OPS = {
  UPLOAD_ORIGINAL: 'uploadOriginal',
  UPLOAD_PRINT: 'uploadPrint',
  MOVE_REJECTED: 'moveRejected',
  MOVE_PRINTED: 'movePrinted',
  DELETE_PRINT: 'deletePrint',
};

const MAX_ATTEMPTS = 6;
let timer = null;
let running = false;

export function queueOp(photoId, op) {
  const p = getPhoto(photoId);
  if (!p) return;
  p.drive ||= { state: 'pending', pendingOps: [], attempts: 0 };
  if (!p.drive.pendingOps.includes(op)) p.drive.pendingOps.push(op);
  p.drive.state = 'pending';
  p.drive.attempts = 0;
  p.drive.nextTryAt = null;
  savePhotos();
}

/** Carpetas del evento en Drive, creándolas la primera vez. */
async function foldersFor(event) {
  if (event.drive?.folders?.toPrint) return event.drive.folders;
  const folders = await drive.ensureEventFolders(event);
  updateEvent(event.id, { drive: { ...(event.drive || {}), folders, linkedAt: new Date().toISOString() } });
  log.ok(`carpetas de Drive listas para "${event.name}"`);
  return folders;
}

function printName(event, photo) {
  const n = String(photo.seq).padStart(4, '0');
  return `${n}_${photo.id}_${photo.orientation === 'landscape' ? 'H' : 'V'}.jpg`;
}

async function runOp(event, photo, op, folders) {
  switch (op) {
    case OPS.UPLOAD_ORIGINAL: {
      if (photo.drive?.originalId) return;
      const ext = photo.originalExt || 'jpg';
      const buf = await fs.readFile(media.filePath(event.id, 'orig', photo.id, ext));
      const file = await drive.uploadBuffer({
        folderId: folders.originals,
        name: `${String(photo.seq).padStart(4, '0')}_${photo.id}_original.${ext}`,
        buffer: buf,
        mimeType: photo.mimeType || 'image/jpeg',
        description: `KuvaConnect · ${event.name} · subida ${photo.createdAt}${photo.caption ? ` · "${photo.caption}"` : ''}`,
      });
      photo.drive.originalId = file.id;
      photo.drive.originalLink = file.webViewLink;
      break;
    }

    case OPS.UPLOAD_PRINT: {
      if (photo.drive?.printId) return;
      const buf = await fs.readFile(media.filePath(event.id, 'print', photo.id));
      const file = await drive.uploadBuffer({
        folderId: folders.toPrint,
        name: printName(event, photo),
        buffer: buf,
        description: `Listo para imprimir · 10x15 · ${photo.orientation === 'landscape' ? 'horizontal' : 'vertical'} · marco ${photo.frameId}`,
      });
      photo.drive.printId = file.id;
      photo.drive.printLink = file.webViewLink;
      break;
    }

    case OPS.DELETE_PRINT: {
      if (!photo.drive?.printId) return;
      await drive.deleteFile(photo.drive.printId);
      photo.drive.printId = null;
      photo.drive.printLink = null;
      break;
    }

    case OPS.MOVE_REJECTED: {
      if (photo.drive?.originalId) await drive.moveFile(photo.drive.originalId, folders.rejected);
      if (photo.drive?.printId) {
        await drive.deleteFile(photo.drive.printId);
        photo.drive.printId = null;
        photo.drive.printLink = null;
      }
      break;
    }

    case OPS.MOVE_PRINTED: {
      if (photo.drive?.printId) await drive.moveFile(photo.drive.printId, folders.printed);
      break;
    }

    default:
      log.warn(`operación desconocida: ${op}`);
  }
}

async function tick() {
  if (running || !drive.isConfigured()) return;
  running = true;
  try {
    const now = Date.now();
    const pending = photoStore.data.photos.filter(
      (p) => p.drive?.pendingOps?.length && (!p.drive.nextTryAt || p.drive.nextTryAt <= now),
    );
    if (!pending.length) return;

    const byEvent = new Map();
    for (const p of pending) {
      if (!byEvent.has(p.eventId)) byEvent.set(p.eventId, []);
      byEvent.get(p.eventId).push(p);
    }

    for (const [eventId, rows] of byEvent) {
      const event = getEvent(eventId);
      if (!event) continue;
      let folders;
      try {
        folders = await foldersFor(event);
      } catch (err) {
        log.error(`no se pudieron preparar las carpetas de "${event.name}": ${err.message}`);
        continue;
      }

      for (const photo of rows.slice(0, 8)) { // de a pocas, para no saturar la subida durante el evento
        const ops = [...photo.drive.pendingOps];
        try {
          for (const op of ops) {
            await runOp(event, photo, op, folders);
            photo.drive.pendingOps = photo.drive.pendingOps.filter((o) => o !== op);
          }
          photo.drive.state = photo.drive.pendingOps.length ? 'pending' : 'synced';
          photo.drive.attempts = 0;
          photo.drive.lastError = null;
          photo.drive.lastSyncAt = new Date().toISOString();
          savePhotos();
          // Al canal del panel, no al público: aquí solo viaja estado de Drive.
          publish(`${eventId}:admin`, 'photo:updated', drivePatch(photo));
        } catch (err) {
          photo.drive.attempts = (photo.drive.attempts || 0) + 1;
          photo.drive.lastError = err.message;
          photo.drive.state = photo.drive.attempts >= MAX_ATTEMPTS ? 'error' : 'pending';
          // backoff exponencial: 15s, 30s, 1m, 2m, 4m…
          photo.drive.nextTryAt = now + Math.min(15000 * 2 ** photo.drive.attempts, 300000);
          savePhotos();
          log.warn(`falló ${photo.id} (intento ${photo.drive.attempts}): ${err.message}`);
        }
      }
    }
  } catch (err) {
    log.error(`ciclo de sincronización: ${err.message}`);
  } finally {
    running = false;
  }
}

/** Parche mínimo para que el panel actualice los indicadores de Drive. */
function drivePatch(p) {
  return {
    id: p.id,
    drive: { state: p.drive?.state, printLink: p.drive?.printLink, originalLink: p.drive?.originalLink },
  };
}

export function start() {
  if (timer) return;
  timer = setInterval(tick, config.drive.syncIntervalMs);
  timer.unref?.();
  if (drive.isConfigured()) {
    log.ok(`sincronización activa (cada ${config.drive.syncIntervalMs / 1000}s, modo ${drive.authMode()})`);
  } else {
    log.warn('Drive sin configurar: las fotos se guardan en disco y quedan en cola para subir después.');
  }
  setTimeout(tick, 2000).unref?.();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function syncNow() { return tick(); }

export function queueStats() {
  let pending = 0; let errored = 0; let synced = 0;
  for (const p of photoStore.data.photos) {
    if (p.drive?.pendingOps?.length) pending++;
    else if (p.drive?.state === 'error') errored++;
    else if (p.drive?.state === 'synced') synced++;
  }
  return { pending, errored, synced, configured: drive.isConfigured(), mode: drive.authMode() };
}

/** Reencola todo lo que quedó a medias — útil cuando por fin se conectan las credenciales. */
export function requeueAll() {
  let n = 0;
  for (const ev of listEvents()) {
    for (const p of photoStore.data.photos.filter((x) => x.eventId === ev.id)) {
      const ops = [];
      if (!p.drive?.originalId) ops.push(OPS.UPLOAD_ORIGINAL);
      if (p.status === 'approved' && !p.drive?.printId) ops.push(OPS.UPLOAD_PRINT);
      if (p.status === 'rejected') ops.push(OPS.MOVE_REJECTED);
      if (!ops.length) continue;
      p.drive ||= { state: 'pending', pendingOps: [], attempts: 0 };
      p.drive.pendingOps = [...new Set([...(p.drive.pendingOps || []), ...ops])];
      p.drive.state = 'pending';
      p.drive.attempts = 0;
      p.drive.nextTryAt = null;
      n++;
    }
  }
  savePhotos();
  log.info(`${n} fotos reencoladas para Drive`);
  return n;
}
