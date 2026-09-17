import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';
import * as driveBackend from './driveBackend.js';

const log = logger('db');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALMACÉN DE DATOS — dos drivers detrás de la misma API
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  json   → archivos en data/. Es el MODO EVENTO: corre en el portátil del
 *           salón, sin internet y sin depender de nadie. Escritura atómica.
 *
 *  drive  → Google Drive. Es el MODO NUBE (Vercel), donde no hay proceso vivo
 *           ni disco entre peticiones. No hay base de datos aparte: el registro
 *           de cada foto son las propiedades de su archivo en Drive.
 *           Ver driveBackend.js para el porqué.
 *
 *  Toda la API es async aunque json sea síncrono por dentro, para que el resto
 *  del código no sepa ni le importe dónde está corriendo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DRIVER = (process.env.KUVA_STORE || (process.env.VERCEL ? 'drive' : 'json')).toLowerCase();

/* ═══════════════════════════════ driver: json ════════════════════════════ */

class JsonFile {
  #file; #data; #writing = false; #dirty = false;

  constructor(name, initial) {
    this.#file = path.join(config.paths.data, `${name}.json`);
    fs.mkdirSync(config.paths.data, { recursive: true });
    try {
      this.#data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      this.#data = initial;
      fs.writeFileSync(this.#file, JSON.stringify(initial, null, 2));
    }
  }

  get data() { return this.#data; }

  save() {
    this.#dirty = true;
    if (this.#writing) return;
    this.#writing = true;
    queueMicrotask(async () => {
      try {
        while (this.#dirty) {
          this.#dirty = false;
          const tmp = `${this.#file}.tmp`;
          await fsp.writeFile(tmp, JSON.stringify(this.#data, null, 2));
          await fsp.rename(tmp, this.#file);
        }
      } catch (err) {
        log.error(`No se pudo guardar ${path.basename(this.#file)}: ${err.message}`);
      } finally {
        this.#writing = false;
      }
    });
  }
}

const json = DRIVER === 'json'
  ? { events: new JsonFile('events', { events: [] }), photos: new JsonFile('photos', { photos: [] }) }
  : null;

/* ═══════════════════════════════ API: eventos ════════════════════════════ */

export async function listEvents() {
  if (json) return json.events.data.events;
  return driveBackend.listEvents();
}

export async function getEvent(idOrSlug) {
  if (!idOrSlug) return null;
  if (json) return json.events.data.events.find((e) => e.id === idOrSlug || e.slug === idOrSlug) || null;
  return driveBackend.getEvent(idOrSlug);
}

export async function addEvent(ev) {
  if (json) {
    json.events.data.events.push(ev);
    json.events.save();
    return ev;
  }
  return driveBackend.addEvent(ev);
}

export async function updateEvent(id, patch) {
  if (json) {
    const ev = json.events.data.events.find((e) => e.id === id || e.slug === id);
    if (!ev) return null;
    Object.assign(ev, patch, { updatedAt: new Date().toISOString() });
    json.events.save();
    return ev;
  }
  return driveBackend.updateEvent(id, patch);
}

/* ════════════════════════════════ API: fotos ═════════════════════════════ */

export async function listPhotos(eventId, opts = {}) {
  if (json) {
    const { status, limit, since } = opts;
    let rows = json.photos.data.photos.filter((p) => p.eventId === eventId);
    if (status) rows = rows.filter((p) => (Array.isArray(status) ? status.includes(p.status) : p.status === status));
    if (since) rows = rows.filter((p) => p.createdAt > since);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return limit ? rows.slice(0, limit) : rows;
  }
  return driveBackend.listPhotos(eventId, opts);
}

export async function getPhoto(id) {
  if (json) return json.photos.data.photos.find((p) => p.id === id) || null;
  return driveBackend.getPhoto(id);
}

export async function addPhoto(photo) {
  if (json) {
    json.photos.data.photos.push(photo);
    json.photos.save();
    return photo;
  }
  return driveBackend.addPhoto(photo);
}

export async function updatePhoto(id, patch) {
  if (json) {
    const p = json.photos.data.photos.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    json.photos.save();
    return p;
  }
  return driveBackend.updatePhoto(id, patch);
}

/**
 * Elimina el registro de una foto.
 * En modo Drive no hay nada que hacer aquí: el registro ES el archivo, y ese lo
 * manda a la papelera la capa de archivos.
 */
export async function deletePhoto(id) {
  if (!json) return true;
  const i = json.photos.data.photos.findIndex((p) => p.id === id);
  if (i < 0) return false;
  json.photos.data.photos.splice(i, 1);
  json.photos.save();
  return true;
}

/**
 * Fotos con trabajo pendiente en la cola de Drive.
 * En modo nube la cola no existe: la foto ya nació en Drive.
 */
export async function pendingDrivePhotos(limit = 25) {
  if (!json) return [];
  return json.photos.data.photos.filter((p) => p.drive?.pendingOps?.length).slice(0, limit);
}

export async function countByStatus(eventId) {
  if (!json) return driveBackend.countByStatus(eventId);
  const out = { pending: 0, approved: 0, rejected: 0, error: 0, total: 0, printed: 0 };
  for (const p of json.photos.data.photos) {
    if (p.eventId !== eventId) continue;
    out.total++;
    out[p.status] = (out[p.status] || 0) + 1;
    if (p.printedAt) out.printed++;
  }
  return out;
}

/** El siguiente consecutivo visible del evento (#007). */
export async function nextSeq(eventId) {
  if (!json) return driveBackend.nextSeq(eventId);
  const rows = json.photos.data.photos.filter((p) => p.eventId === eventId);
  return rows.reduce((max, p) => Math.max(max, p.seq || 0), 0) + 1;
}

/** En json fuerza el guardado; en drive cada cambio ya se escribió. */
export function savePhotos() {
  if (json) json.photos.save();
}

export function driverInfo() {
  return {
    driver: DRIVER,
    ready: DRIVER === 'json' ? true : Boolean(process.env.GOOGLE_OAUTH_TOKEN_JSON || process.env.GOOGLE_OAUTH_CLIENT_ID),
  };
}
