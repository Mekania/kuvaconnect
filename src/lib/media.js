import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as driveBackend from './driveBackend.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ARCHIVOS — dos drivers detrás de la misma API
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  disk   → data/media/. Modo evento: el disco del portátil es la fuente de
 *           verdad y no depende de nadie.
 *
 *  drive  → Google Drive. Modo nube. El original y la impresión van a las
 *           carpetas que ve el logístico; los derivados de pantalla viven en
 *           _sistema. Todo se sirve a través de /media, nunca por enlace
 *           público de Drive, para que la regla de acceso siga siendo nuestra.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DRIVER = (process.env.KUVA_MEDIA || (process.env.VERCEL ? 'drive' : 'disk')).toLowerCase();

export const KINDS = {
  orig: { dir: 'orig' },   // el archivo tal cual lo subió el invitado
  raw: { dir: 'raw' },     // original reducido, para moderar
  print: { dir: 'print' }, // con marco, 300dpi, listo para la DNP
  web: { dir: 'web' },     // con marco, para la pantalla
  thumb: { dir: 'thumb' }, // con marco, miniatura
};

/* ══════════════════════════════════ rutas ════════════════════════════════ */

export function eventDir(eventId) {
  return path.join(config.paths.media, eventId);
}

export function filePath(eventId, kind, photoId, ext = 'jpg') {
  return path.join(eventDir(eventId), KINDS[kind].dir, `${photoId}.${ext}`);
}

export async function ensureEventDirs(eventId) {
  if (DRIVER !== 'disk') return; // en Drive las carpetas las crea driveBackend
  await Promise.all(
    Object.values(KINDS).map((k) => fs.mkdir(path.join(eventDir(eventId), k.dir), { recursive: true })),
  );
}

/* ═════════════════════════════════ escribir ══════════════════════════════ */

/**
 * Devuelve el identificador del archivo escrito: una ruta en disco, o el id de
 * Drive. Quien llama guarda ese id en el registro de la foto, porque en modo
 * nube es la única forma de volver a encontrarlo.
 */
export async function write(eventId, kind, photoId, buffer, ext = 'jpg', meta = {}) {
  if (DRIVER === 'disk') {
    const p = filePath(eventId, kind, photoId, ext);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buffer);
    return p;
  }
  return driveBackend.writeFile(eventId, kind, photoId, buffer, { ext, ...meta });
}

/* ═══════════════════════════════════ leer ════════════════════════════════ */

export async function read(eventId, kind, photoId, ext = 'jpg', fileId = null) {
  if (DRIVER === 'disk') return fs.readFile(filePath(eventId, kind, photoId, ext));
  if (!fileId) throw new Error('en modo Drive hay que pasar el id del archivo');
  return driveBackend.readFileById(fileId);
}

/** Lee usando el registro de la foto, que ya sabe dónde está cada archivo. */
export async function readFor(photo, kind) {
  if (DRIVER === 'disk') {
    const ext = kind === 'orig' ? (photo.originalExt || 'jpg') : 'jpg';
    return fs.readFile(filePath(photo.eventId, kind, photo.id, ext));
  }
  const fileId = photo.files?.[kind];
  if (!fileId) throw new Error(`la foto ${photo.id} no tiene archivo ${kind}`);
  return driveBackend.readFileById(fileId);
}

export async function has(eventId, kind, photoId, ext = 'jpg') {
  if (DRIVER === 'disk') return fssync.existsSync(filePath(eventId, kind, photoId, ext));
  return true; // en Drive lo sabe el registro de la foto (photo.files)
}

export function exists(p) {
  return fssync.existsSync(p);
}

/* ══════════════════════════════════ borrar ═══════════════════════════════ */

/**
 * Borra solo lo que se sirve sin autenticación.
 * Al rechazar una foto no basta con bajarla de la pantalla: su URL seguiría
 * sirviendo el archivo a quien ya la tuviera.
 */
export async function removePublic(eventIdOrPhoto, photoId) {
  if (DRIVER === 'disk') {
    const eventId = typeof eventIdOrPhoto === 'string' ? eventIdOrPhoto : eventIdOrPhoto.eventId;
    const id = photoId || eventIdOrPhoto.id;
    await Promise.all([
      fs.rm(filePath(eventId, 'web', id), { force: true }),
      fs.rm(filePath(eventId, 'thumb', id), { force: true }),
    ]);
    return;
  }
  if (typeof eventIdOrPhoto === 'string') return; // en Drive necesitamos el registro
  await driveBackend.removePublicFiles(eventIdOrPhoto);
}

/* ══════════════════════════════════ URLs ═════════════════════════════════ */

/**
 * URL para el navegador. Siempre pasa por /media, en los dos modos: ahí es
 * donde decidimos quién puede ver qué. En modo Drive la URL lleva el id del
 * archivo, para no tener que buscar la foto en cada petición de imagen.
 */
export function urlFor(photo, kind) {
  if (DRIVER === 'disk') {
    const ext = kind === 'orig' ? (photo.originalExt || 'jpg') : 'jpg';
    return `/media/${photo.eventId}/${kind}/${photo.id}.${ext}`;
  }
  const fileId = photo.files?.[kind];
  if (!fileId) return '';
  return `/media/${photo.eventId}/${kind}/${fileId}.jpg`;
}

/**
 * Movimientos de archivo que dispara la moderación.
 * En disco no hay nada que mover (el estado vive en la base). En Drive sí: la
 * carpeta ES el estado, y el logístico tiene que ver la cola de impresión
 * correcta sin abrir la app.
 */
export async function onApproved(photo) {
  if (DRIVER === 'disk') return;
  await driveBackend.movePrint(photo, 'queue');
}

export async function onRejected(photo) {
  if (DRIVER === 'disk') return;
  await driveBackend.movePrint(photo, 'system');
}

export async function onPrinted(photo, printed) {
  if (DRIVER === 'disk') return;
  await driveBackend.movePrint(photo, printed ? 'printed' : 'queue');
}

/** Borra TODOS los archivos de una foto (original, impresión y derivados). */
export async function destroy(photo) {
  if (DRIVER === 'disk') {
    const ext = photo.originalExt || 'jpg';
    await Promise.all([
      fs.rm(filePath(photo.eventId, 'orig', photo.id, ext), { force: true }),
      fs.rm(filePath(photo.eventId, 'raw', photo.id), { force: true }),
      fs.rm(filePath(photo.eventId, 'print', photo.id), { force: true }),
      fs.rm(filePath(photo.eventId, 'web', photo.id), { force: true }),
      fs.rm(filePath(photo.eventId, 'thumb', photo.id), { force: true }),
    ]);
    return;
  }
  await driveBackend.deletePhoto(photo);
}

export const IS_DRIVE = DRIVER === 'drive';

export function extFromMime(mime) {
  return ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
  })[mime] || 'jpg';
}

/** Tamaño ocupado por un evento, para el panel de control. */
export async function diskUsage(eventId) {
  if (DRIVER !== 'disk') return 0; // en Drive lo reporta el propio Drive
  let bytes = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { bytes += (await fs.stat(p)).size; } catch { /* borrado en carrera */ } }
    }
  };
  await walk(eventDir(eventId));
  return bytes;
}

export function driverInfo() {
  return {
    driver: DRIVER,
    ready: DRIVER === 'disk' ? true : Boolean(process.env.GOOGLE_OAUTH_TOKEN_JSON || process.env.GOOGLE_OAUTH_CLIENT_ID),
  };
}
