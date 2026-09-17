import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger('media');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ARCHIVOS — dos drivers detrás de la misma API
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  disk      → data/media/. Modo evento: el disco del portátil es la fuente de
 *              verdad y no depende de nadie.
 *
 *  supabase  → Storage. Modo nube, donde no hay disco que sobreviva.
 *              Dos buckets con criterios distintos:
 *                kuva-public  → web/ y thumb/  (ya moderadas; se sirven por CDN)
 *                kuva-private → orig/, raw/, print/ (solo el panel, por URL firmada)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DRIVER = (process.env.KUVA_MEDIA || (process.env.VERCEL ? 'supabase' : 'disk')).toLowerCase();

export const KINDS = {
  orig: { dir: 'orig', public: false },   // el archivo tal cual lo subió el invitado
  raw: { dir: 'raw', public: false },     // original reducido, para moderar
  print: { dir: 'print', public: false }, // con marco, 300dpi, listo para la DNP
  web: { dir: 'web', public: true },      // con marco, para la pantalla
  thumb: { dir: 'thumb', public: true },  // con marco, miniatura
};

const PUBLIC_BUCKET = process.env.SUPABASE_PUBLIC_BUCKET || 'kuva-public';
const PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'kuva-private';

const bucketFor = (kind) => (KINDS[kind].public ? PUBLIC_BUCKET : PRIVATE_BUCKET);
const objectKey = (eventId, kind, photoId, ext = 'jpg') => `${eventId}/${KINDS[kind].dir}/${photoId}.${ext}`;

/* ════════════════════════════════ supabase ═══════════════════════════════ */

let sb = null;
async function storage() {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
  const { createClient } = await import('@supabase/supabase-js');
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return sb;
}

/* ══════════════════════════════════ rutas ════════════════════════════════ */

export function eventDir(eventId) {
  return path.join(config.paths.media, eventId);
}

export function filePath(eventId, kind, photoId, ext = 'jpg') {
  return path.join(eventDir(eventId), KINDS[kind].dir, `${photoId}.${ext}`);
}

export async function ensureEventDirs(eventId) {
  if (DRIVER !== 'disk') return; // en Storage las "carpetas" son solo prefijos
  await Promise.all(
    Object.values(KINDS).map((k) => fs.mkdir(path.join(eventDir(eventId), k.dir), { recursive: true })),
  );
}

/* ═════════════════════════════════ escribir ══════════════════════════════ */

export async function write(eventId, kind, photoId, buffer, ext = 'jpg') {
  if (DRIVER === 'disk') {
    const p = filePath(eventId, kind, photoId, ext);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buffer);
    return p;
  }
  const client = await storage();
  const key = objectKey(eventId, kind, photoId, ext);
  const { error } = await client.storage.from(bucketFor(kind)).upload(key, buffer, {
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    upsert: true,
  });
  if (error) throw new Error(`subir ${kind}/${photoId}: ${error.message}`);
  return key;
}

/* ═══════════════════════════════════ leer ════════════════════════════════ */

export async function read(eventId, kind, photoId, ext = 'jpg') {
  if (DRIVER === 'disk') return fs.readFile(filePath(eventId, kind, photoId, ext));
  const client = await storage();
  const { data, error } = await client.storage.from(bucketFor(kind)).download(objectKey(eventId, kind, photoId, ext));
  if (error) throw new Error(`leer ${kind}/${photoId}: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function has(eventId, kind, photoId, ext = 'jpg') {
  if (DRIVER === 'disk') return fssync.existsSync(filePath(eventId, kind, photoId, ext));
  try {
    const client = await storage();
    const { data } = await client.storage.from(bucketFor(kind))
      .list(`${eventId}/${KINDS[kind].dir}`, { search: `${photoId}.${ext}`, limit: 1 });
    return Boolean(data?.length);
  } catch {
    return false;
  }
}

export function exists(p) {
  return fssync.existsSync(p);
}

/* ══════════════════════════════════ borrar ═══════════════════════════════ */

/**
 * Borra solo lo que se sirve sin autenticación.
 * Se usa al rechazar una foto: deja de ser accesible por URL, pero el original
 * y la copia de impresión se conservan para el panel.
 */
export async function removePublic(eventId, photoId) {
  if (DRIVER === 'disk') {
    await Promise.all([
      fs.rm(filePath(eventId, 'web', photoId), { force: true }),
      fs.rm(filePath(eventId, 'thumb', photoId), { force: true }),
    ]);
    return;
  }
  const client = await storage();
  const { error } = await client.storage.from(PUBLIC_BUCKET).remove([
    objectKey(eventId, 'web', photoId),
    objectKey(eventId, 'thumb', photoId),
  ]);
  if (error) log.warn(`limpiando públicos de ${photoId}: ${error.message}`);
}

export async function remove(eventId, photo) {
  const ext = photo.originalExt || 'jpg';
  if (DRIVER === 'disk') {
    await Promise.all([
      fs.rm(filePath(eventId, 'orig', photo.id, ext), { force: true }),
      fs.rm(filePath(eventId, 'raw', photo.id), { force: true }),
      fs.rm(filePath(eventId, 'print', photo.id), { force: true }),
      fs.rm(filePath(eventId, 'web', photo.id), { force: true }),
      fs.rm(filePath(eventId, 'thumb', photo.id), { force: true }),
    ]);
    return;
  }
  const client = await storage();
  await client.storage.from(PUBLIC_BUCKET).remove([
    objectKey(eventId, 'web', photo.id), objectKey(eventId, 'thumb', photo.id),
  ]);
  await client.storage.from(PRIVATE_BUCKET).remove([
    objectKey(eventId, 'orig', photo.id, ext),
    objectKey(eventId, 'raw', photo.id),
    objectKey(eventId, 'print', photo.id),
  ]);
}

/* ══════════════════════════════════ URLs ═════════════════════════════════ */

/**
 * URL para el navegador.
 * En disco todo pasa por /media (donde el servidor aplica la regla de acceso).
 * En Storage, lo público va directo al CDN y lo privado se sigue sirviendo por
 * /media para que la autorización siga siendo nuestra y no de una URL firmada
 * que alguien pueda reenviar.
 */
export function publicUrl(eventId, kind, photoId, ext = 'jpg') {
  if (DRIVER === 'disk' || !KINDS[kind].public) {
    return `/media/${eventId}/${kind}/${photoId}.${ext}`;
  }
  const base = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${PUBLIC_BUCKET}/${objectKey(eventId, kind, photoId, ext)}`;
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

/** Tamaño ocupado por un evento, para el panel de control. */
export async function diskUsage(eventId) {
  if (DRIVER !== 'disk') return 0; // en Storage lo reporta el dashboard de Supabase
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
    ready: DRIVER === 'disk' ? true : Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
