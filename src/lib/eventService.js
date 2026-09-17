import { addEvent, getEvent, listEvents, updateEvent } from './db.js';
import { ensureEventDirs } from './media.js';
import { shortId, slugify, token } from './ids.js';
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

  const ev = {
    id: shortId(6),
    slug,
    name,
    subtitle: input.subtitle || 'Sube tu foto y verla en pantalla',
    date: input.date || new Date().toISOString().slice(0, 10),
    hashtag: input.hashtag || '',
    frameId: getFrame(input.frameId || DEFAULTS.frameId).id,
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

  await addEvent(ev);
  await ensureEventDirs(ev.id);
  log.ok(`evento creado: ${ev.name} (${ev.slug})`);
  return ev;
}

/** Al arrancar siempre debe existir al menos un evento, para que la pantalla no quede en blanco. */
export async function ensureDefaultEvent() {
  const existing = await listEvents();
  if (existing.length) {
    await Promise.all(existing.map((e) => ensureEventDirs(e.id)));
    return existing.find((e) => e.active) || existing[0];
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
  const all = await listEvents();
  return all.find((e) => e.active) || all[0] || null;
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
