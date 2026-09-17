import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger('db');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALMACÉN DE DATOS — dos drivers detrás de la misma API
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  json      → archivos en data/. Es el modo evento: corre en el portátil del
 *              salón, sin internet, sin dependencias. Escritura atómica.
 *
 *  supabase  → Postgres. Es el modo nube (Vercel), donde el proceso muere entre
 *              peticiones y el disco es efímero, así que no hay dónde guardar.
 *
 *  Toda la API es async aunque el driver json sea síncrono por dentro: así el
 *  resto del código no sabe ni le importa dónde está corriendo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DRIVER = (process.env.KUVA_STORE || (process.env.VERCEL ? 'supabase' : 'json')).toLowerCase();

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

/* ═════════════════════════════ driver: supabase ══════════════════════════ */

let sb = null;
async function supabase() {
  if (sb) return sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en las variables de entorno.');
  }
  const { createClient } = await import('@supabase/supabase-js');
  sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'kuva' },
  });
  return sb;
}

/** snake_case de Postgres ⇄ camelCase de la app. */
const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function rowToObj(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out;
}

function objToRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[toSnake(k)] = v;
  }
  return out;
}

async function sbSelect(table, build) {
  const client = await supabase();
  const { data, error } = await build(client.from(table).select('*'));
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data || []).map(rowToObj);
}

/* ═══════════════════════════════ API: eventos ════════════════════════════ */

export async function listEvents() {
  if (json) return json.events.data.events;
  return sbSelect('events', (q) => q.order('created_at', { ascending: true }));
}

export async function getEvent(idOrSlug) {
  if (!idOrSlug) return null;
  if (json) return json.events.data.events.find((e) => e.id === idOrSlug || e.slug === idOrSlug) || null;
  const rows = await sbSelect('events', (q) => q.or(`id.eq.${idOrSlug},slug.eq.${idOrSlug}`).limit(1));
  return rows[0] || null;
}

export async function addEvent(ev) {
  if (json) {
    json.events.data.events.push(ev);
    json.events.save();
    return ev;
  }
  const client = await supabase();
  const { data, error } = await client.from('events').insert(objToRow(ev)).select().single();
  if (error) throw new Error(`crear evento: ${error.message}`);
  return rowToObj(data);
}

export async function updateEvent(id, patch) {
  const now = new Date().toISOString();
  if (json) {
    const ev = json.events.data.events.find((e) => e.id === id || e.slug === id);
    if (!ev) return null;
    Object.assign(ev, patch, { updatedAt: now });
    json.events.save();
    return ev;
  }
  const client = await supabase();
  const { data, error } = await client.from('events')
    .update({ ...objToRow(patch), updated_at: now })
    .eq('id', id).select().single();
  if (error) throw new Error(`actualizar evento: ${error.message}`);
  return rowToObj(data);
}

/* ════════════════════════════════ API: fotos ═════════════════════════════ */

export async function listPhotos(eventId, { status, limit, since } = {}) {
  if (json) {
    let rows = json.photos.data.photos.filter((p) => p.eventId === eventId);
    if (status) rows = rows.filter((p) => (Array.isArray(status) ? status.includes(p.status) : p.status === status));
    if (since) rows = rows.filter((p) => p.createdAt > since);
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return limit ? rows.slice(0, limit) : rows;
  }
  return sbSelect('photos', (q) => {
    let b = q.eq('event_id', eventId).order('created_at', { ascending: false });
    if (status) b = Array.isArray(status) ? b.in('status', status) : b.eq('status', status);
    if (since) b = b.gt('created_at', since);
    if (limit) b = b.limit(limit);
    return b;
  });
}

export async function getPhoto(id) {
  if (json) return json.photos.data.photos.find((p) => p.id === id) || null;
  const rows = await sbSelect('photos', (q) => q.eq('id', id).limit(1));
  return rows[0] || null;
}

export async function addPhoto(photo) {
  if (json) {
    json.photos.data.photos.push(photo);
    json.photos.save();
    return photo;
  }
  const client = await supabase();
  const { data, error } = await client.from('photos').insert(objToRow(photo)).select().single();
  if (error) throw new Error(`crear foto: ${error.message}`);
  return rowToObj(data);
}

export async function updatePhoto(id, patch) {
  const now = new Date().toISOString();
  if (json) {
    const p = json.photos.data.photos.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: now });
    json.photos.save();
    return p;
  }
  const client = await supabase();
  const { data, error } = await client.from('photos')
    .update({ ...objToRow(patch), updated_at: now })
    .eq('id', id).select().single();
  if (error) throw new Error(`actualizar foto: ${error.message}`);
  return rowToObj(data);
}

/** Fotos con trabajo pendiente en la cola de Drive. */
export async function pendingDrivePhotos(limit = 25) {
  if (json) {
    return json.photos.data.photos.filter((p) => p.drive?.pendingOps?.length).slice(0, limit);
  }
  const rows = await sbSelect('photos', (q) => q.eq('drive->>state', 'pending').order('created_at').limit(limit));
  return rows.filter((p) => p.drive?.pendingOps?.length);
}

export async function countByStatus(eventId) {
  const out = { pending: 0, approved: 0, rejected: 0, error: 0, total: 0, printed: 0 };
  const rows = json
    ? json.photos.data.photos.filter((p) => p.eventId === eventId)
    : await sbSelect('photos', (q) => q.eq('event_id', eventId));
  for (const p of rows) {
    out.total++;
    out[p.status] = (out[p.status] || 0) + 1;
    if (p.printedAt) out.printed++;
  }
  return out;
}

/** El siguiente consecutivo visible del evento (#007). */
export async function nextSeq(eventId) {
  if (json) {
    const rows = json.photos.data.photos.filter((p) => p.eventId === eventId);
    return rows.reduce((max, p) => Math.max(max, p.seq || 0), 0) + 1;
  }
  const client = await supabase();
  const { data, error } = await client.from('photos')
    .select('seq').eq('event_id', eventId).order('seq', { ascending: false }).limit(1);
  if (error) throw new Error(`consecutivo: ${error.message}`);
  return (data?.[0]?.seq || 0) + 1;
}

/** En json fuerza el guardado; en supabase no hace falta (cada update ya escribió). */
export function savePhotos() {
  if (json) json.photos.save();
}

export function driverInfo() {
  return {
    driver: DRIVER,
    ready: DRIVER === 'json' ? true : Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}
