import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger('db');

/**
 * Almacén JSON minimalista con escritura atómica y serializada.
 * Suficiente y sobrado para un evento (cientos/miles de fotos); si algún día
 * KuvaConnect corre varios eventos concurrentes y grandes, se cambia esta capa
 * por SQLite sin tocar el resto del código.
 */
class JsonStore {
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

export const events = new JsonStore('events', { events: [] });
export const photos = new JsonStore('photos', { photos: [] });

/* ---------------------------------- eventos --------------------------------- */

export function listEvents() { return events.data.events; }
export function getEvent(id) { return events.data.events.find((e) => e.id === id || e.slug === id) || null; }
export function saveEvents() { events.save(); }

export function addEvent(ev) {
  events.data.events.push(ev);
  events.save();
  return ev;
}

export function updateEvent(id, patch) {
  const ev = getEvent(id);
  if (!ev) return null;
  Object.assign(ev, patch, { updatedAt: new Date().toISOString() });
  events.save();
  return ev;
}

/* ----------------------------------- fotos ---------------------------------- */

export function listPhotos(eventId, { status, limit, since } = {}) {
  let rows = photos.data.photos.filter((p) => p.eventId === eventId);
  if (status) rows = rows.filter((p) => (Array.isArray(status) ? status.includes(p.status) : p.status === status));
  if (since) rows = rows.filter((p) => p.createdAt > since);
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // más reciente primero
  return limit ? rows.slice(0, limit) : rows;
}

export function getPhoto(id) { return photos.data.photos.find((p) => p.id === id) || null; }

export function addPhoto(photo) {
  photos.data.photos.push(photo);
  photos.save();
  return photo;
}

export function updatePhoto(id, patch) {
  const p = getPhoto(id);
  if (!p) return null;
  Object.assign(p, patch, { updatedAt: new Date().toISOString() });
  photos.save();
  return p;
}

export function savePhotos() { photos.save(); }

export function countByStatus(eventId) {
  const out = { pending: 0, approved: 0, rejected: 0, total: 0, printed: 0 };
  for (const p of photos.data.photos) {
    if (p.eventId !== eventId) continue;
    out.total++;
    out[p.status] = (out[p.status] || 0) + 1;
    if (p.printedAt) out.printed++;
  }
  return out;
}
