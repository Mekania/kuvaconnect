import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Almacenamiento local de archivos. Es la fuente de verdad durante el evento:
 * el internet de un salón de eventos se cae, y la pantalla no se puede caer con él.
 * Google Drive es un espejo que se sincroniza aparte (ver drive.js).
 */

export const KINDS = {
  orig: { dir: 'orig' },   // el archivo tal cual lo subió el invitado
  raw: { dir: 'raw' },     // original reducido, para moderar
  print: { dir: 'print' }, // con marco, 300dpi, listo para la DNP
  web: { dir: 'web' },     // con marco, para la pantalla
  thumb: { dir: 'thumb' }, // con marco, miniatura
};

export function eventDir(eventId) {
  return path.join(config.paths.media, eventId);
}

export function filePath(eventId, kind, photoId, ext = 'jpg') {
  return path.join(eventDir(eventId), KINDS[kind].dir, `${photoId}.${ext}`);
}

export async function ensureEventDirs(eventId) {
  await Promise.all(
    Object.values(KINDS).map((k) => fs.mkdir(path.join(eventDir(eventId), k.dir), { recursive: true })),
  );
}

export async function write(eventId, kind, photoId, buffer, ext = 'jpg') {
  const p = filePath(eventId, kind, photoId, ext);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, buffer);
  return p;
}

export function exists(p) {
  return fssync.existsSync(p);
}

export async function read(eventId, kind, photoId, ext = 'jpg') {
  return fs.readFile(filePath(eventId, kind, photoId, ext));
}

export async function remove(eventId, photo) {
  const targets = [
    filePath(eventId, 'orig', photo.id, photo.originalExt || 'jpg'),
    filePath(eventId, 'raw', photo.id),
    filePath(eventId, 'print', photo.id),
    filePath(eventId, 'web', photo.id),
    filePath(eventId, 'thumb', photo.id),
  ];
  await Promise.all(targets.map((t) => fs.rm(t, { force: true })));
}

/**
 * Borra únicamente las versiones que se sirven sin autenticación.
 * Se usa al rechazar una foto: deja de ser accesible por URL, pero el original
 * y la copia de impresión se conservan para el panel.
 */
export async function removePublic(eventId, photoId) {
  await Promise.all([
    fs.rm(filePath(eventId, 'web', photoId), { force: true }),
    fs.rm(filePath(eventId, 'thumb', photoId), { force: true }),
  ]);
}

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

/** Tamaño total en disco de un evento, para el panel de control. */
export async function diskUsage(eventId) {
  let bytes = 0;
  const dir = eventDir(eventId);
  const walk = async (d) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { bytes += (await fs.stat(p)).size; } catch { /* borrado en carrera */ } }
    }
  };
  await walk(dir);
  return bytes;
}
