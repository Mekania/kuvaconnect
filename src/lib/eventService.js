import { addEvent, getEvent, listEvents, updateEvent } from './db.js';
import { ensureEventDirs } from './media.js';
import { shortId, slugify, token } from './ids.js';
import { hashPin, safeEqual } from './auth.js';
import { getFrame } from './frames/index.js';
import { logger } from './logger.js';

const log = logger('eventos');

export const DEFAULTS = {
  frameId: 'oxxo-expresate',
  fitMode: 'auto',
  moderation: 'pre',        // 'pre' = aprobar antes de mostrar · 'post' = sale y se baja si molesta
  uploadEnabled: true,
  maxPerDevice: 12,
  allowCaption: true,
  displayColumns: 5,
  /**
   * Paleta de la campaña OXXO "Exprésate 24/7", tomada del marco impreso para
   * que pantalla, celular y foto se vean de la misma familia.
   * Cambiar estos cuatro valores reskinea las tres páginas.
   */
  theme: {
    brand: '#C41D5D',
    hot: '#E8447F',
    accent: '#E9B62B',
    paper: '#FFF7FA',
    logo: '/shared/brand/oxxo.webp',
  },
};

export function formatEventDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
}

/** Lo que se imprime en la banda inferior del marco. */
export function frameMeta(event) {
  return {
    title: event.frameTitle || event.name,
    footer: event.frameFooter || [formatEventDate(event.date), event.hashtag].filter(Boolean).join('   ·   ') || 'KUVA',
  };
}

export async function createEvent(input = {}) {
  const name = (input.name || 'Evento Kuva').trim();
  const base = slugify(input.slug || name);
  const taken = new Set((await listEvents()).map((e) => e.slug));
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;

  // Si el marco pedido no existe, getFrame cae al genérico sin avisar. Al crear
  // un evento eso es un error de configuración (pasó: los marcos PNG no estaban
  // cargados y las cuatro sedes quedaron con el marco equivocado), así que aquí
  // se falla fuerte en vez de imprimir cientos de fotos con otro marco.
  const wantedFrame = input.frameId || DEFAULTS.frameId;
  if (getFrame(wantedFrame).id !== wantedFrame) {
    throw new Error(`El marco "${wantedFrame}" no está cargado. ¿Se llamó loadOverlayFrames() antes?`);
  }

  const id = shortId(6);
  const ev = {
    id,
    slug,
    name,
    // Sede: el mismo evento corre en varias ciudades a la vez, cada una con su
    // pantalla, su QR, su carpeta de Drive y su PIN de moderación.
    sede: input.sede || '',
    pinHash: input.pin ? hashPin(id, input.pin) : '',
    archived: false,
    subtitle: input.subtitle || 'Sube tu foto y verla en pantalla',
    date: input.date || new Date().toISOString().slice(0, 10),
    hashtag: input.hashtag || '',
    frameId: wantedFrame,
    frameTitle: input.frameTitle || '',
    frameFooter: input.frameFooter || '',
    fitMode: input.fitMode || DEFAULTS.fitMode,
    moderation: input.moderation || DEFAULTS.moderation,
    uploadEnabled: input.uploadEnabled ?? DEFAULTS.uploadEnabled,
    maxPerDevice: input.maxPerDevice ?? DEFAULTS.maxPerDevice,
    allowCaption: input.allowCaption ?? DEFAULTS.allowCaption,
    displayColumns: input.displayColumns ?? DEFAULTS.displayColumns,
    theme: { ...DEFAULTS.theme, ...(input.theme || {}) },
    uploadToken: token(9),  // va dentro del QR; permite rotar el link si alguien lo comparte fuera del evento
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    drive: {},
  };

  // Devolvemos lo que responde el almacén, no el objeto que armamos: en modo
  // Drive viene con el folderId, que es lo que luego localiza todo el evento.
  const saved = await addEvent(ev);
  await ensureEventDirs(ev.id);
  log.ok(`evento creado: ${saved.name} (${saved.slug})`);
  return saved;
}

/** Al arrancar siempre debe existir al menos un evento, para que la pantalla no quede en blanco. */
export async function ensureDefaultEvent() {
  const existing = await listEvents();
  if (existing.length) {
    await Promise.all(existing.map((e) => ensureEventDirs(e.id)));
    const visible = existing.filter((e) => !e.archived);
    return visible.find((e) => e.active) || visible[0] || existing[0];
  }
  return createEvent({
    name: 'Exprésate 24/7',
    subtitle: 'Sube tu foto, sal en la pantalla y llévatela impresa',
    hashtag: 'OXXO · Así de fácil',
    /**
     * El hueco del marco de OXXO es casi cuadrado (1060x1237). En automático,
     * una selfie 9:16 se pasa por poco del límite y saldría con fondo
     * difuminado; en una cabina de fotos la gente espera su cara llenando el
     * marco, así que para este evento forzamos el recorte.
     */
    fitMode: 'crop',
  });
}

export async function activeEvent() {
  const all = (await listEvents()).filter((e) => !e.archived);
  return all.find((e) => e.active) || all[0] || null;
}

/** Sedes visibles para el panel y las pantallas (las archivadas no aparecen). */
export async function listSedes() {
  return (await listEvents()).filter((e) => !e.archived);
}

export function checkSedePin(ev, pin) {
  return Boolean(ev?.pinHash) && safeEqual(ev.pinHash, hashPin(ev.id, pin));
}

/** Lo que el panel puede ver de un evento: todo menos el hash del PIN. */
export function adminEvent(ev) {
  if (!ev) return null;
  const { pinHash, ...rest } = ev;
  return { ...rest, hasPin: Boolean(pinHash) };
}

export async function setActive(eventId) {
  const all = await listEvents();
  await Promise.all(all.map((e) => updateEvent(e.id, { active: e.id === eventId })));
  return getEvent(eventId);
}

/** Vista pública del evento: sin tokens ni IDs de Drive. */
export function publicEvent(ev) {
  if (!ev) return null;
  return {
    id: ev.id,
    slug: ev.slug,
    name: ev.name,
    sede: ev.sede || '',
    subtitle: ev.subtitle,
    date: ev.date,
    hashtag: ev.hashtag,
    theme: ev.theme,
    uploadEnabled: ev.uploadEnabled,
    allowCaption: ev.allowCaption,
    moderation: ev.moderation,
    displayColumns: ev.displayColumns,
    maxPerDevice: ev.maxPerDevice,
  };
}
