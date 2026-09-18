import express from 'express';
import sharp from 'sharp';
import { config, baseUrl } from '../config.js';
import * as auth from '../lib/auth.js';
import { getEvent, getPhoto, listEvents, listPhotos, updateEvent, countByStatus } from '../lib/db.js';
import { createEvent, publicEvent, adminEvent, setActive, activeEvent, frameMeta, listSedes, checkSedePin } from '../lib/eventService.js';
import { listFrames, getFrame } from '../lib/frames/index.js';
import { composeFramed } from '../lib/compose.js';
import { approve, reject, markPrinted, recompose, destroy, queue, adminPhoto, adminChannel } from '../lib/photoService.js';
import { subscribe } from '../lib/bus.js';
import * as driveSync from '../lib/driveSync.js';
import * as drive from '../lib/drive.js';
import * as media from '../lib/media.js';
import { uploadUrl } from './api.js';
import { logger } from '../lib/logger.js';

const log = logger('admin');
export const admin = express.Router();

admin.use(express.json({ limit: '256kb' }));

/* ─────────────────────────────── sesión ──────────────────────────────────── */

/**
 * Entrar al panel: se elige la sede y se pone su PIN.
 * El PIN maestro entra a cualquier sede (y a los ajustes) sin importar cuál se
 * haya elegido.
 */
admin.post('/login', async (req, res) => {
  const pin = String(req.body?.pin || '');
  const eventId = String(req.body?.event || '');

  if (auth.isMasterPin(pin)) {
    const t = auth.issue(auth.ALL);
    auth.setCookie(res, t);
    return res.json({ ok: true, token: t, scope: auth.ALL });
  }

  const ev = eventId ? await getEvent(eventId) : null;
  if (!ev || ev.archived || !checkSedePin(ev, pin)) {
    return res.status(401).json({ error: 'PIN incorrecto para esa sede' });
  }
  const t = auth.issue(ev.id);
  auth.setCookie(res, t);
  res.json({ ok: true, token: t, scope: ev.id });
});

admin.post('/logout', (req, res) => {
  auth.logout(auth.tokenFrom(req));
  auth.clearCookie(res);
  res.json({ ok: true });
});

admin.get('/session', (req, res) => {
  const scope = auth.sessionScope(req);
  res.json({ authenticated: Boolean(scope), scope, master: scope === auth.ALL });
});

admin.use(auth.requireAdmin);
const master = auth.requireMaster;

/** Carga el evento y verifica que la sesión sea de esa sede. */
async function withEvent(req, res, next) {
  try {
    const ev = await getEvent(req.params.event);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    if (!auth.canAccess(req, ev.id)) return res.status(403).json({ error: 'Esta sesión es de otra sede.' });
    req.event = ev;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** Igual para las acciones sobre una foto: la foto tiene que ser de tu sede. */
admin.use('/photos/:id', async (req, res, next) => {
  try {
    const p = await getPhoto(req.params.id);
    if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
    if (!auth.canAccess(req, p.eventId)) return res.status(403).json({ error: 'Esa foto es de otra sede.' });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────── eventos ─────────────────────────────────── */

admin.get('/bootstrap', async (req, res) => {
  const isMaster = req.scope === auth.ALL;
  const [active, all] = await Promise.all([activeEvent(), listSedes()]);
  const events = isMaster ? all : all.filter((e) => e.id === req.scope);
  const withCounts = await Promise.all(events.map(async (e) => ({
    ...publicEvent(e), active: e.active, counts: await countByStatus(e.id),
  })));
  res.json({
    scope: req.scope,
    master: isMaster,
    events: withCounts,
    activeEventId: isMaster ? (active?.id || null) : req.scope,
    frames: listFrames(),
    drive: await driveSync.queueStats(),
    baseUrl: baseUrl(),
  });
});

admin.get('/events/:event', withEvent, async (req, res) => {
  res.json({
    event: { ...adminEvent(req.event), counts: await countByStatus(req.event.id) },
    uploadUrl: uploadUrl(req.event),
    displayUrl: `${baseUrl()}/d/${req.event.slug}`,
    diskBytes: await media.diskUsage(req.event.id),
  });
});

admin.post('/events', master, async (req, res) => {
  try {
    const ev = await createEvent(req.body || {});
    res.status(201).json({ event: ev });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const EDITABLE = new Set([
  'name', 'subtitle', 'date', 'hashtag', 'frameId', 'frameTitle', 'frameFooter',
  'fitMode', 'moderation', 'uploadEnabled', 'maxPerDevice', 'allowCaption',
  'displayColumns', 'theme', 'active',
]);

admin.patch('/events/:event', master, withEvent, async (req, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) if (EDITABLE.has(k)) patch[k] = v;
  if (patch.frameId) patch.frameId = getFrame(patch.frameId).id;
  let ev = await updateEvent(req.event.id, patch);
  if (patch.active === true) ev = await setActive(ev.id);
  res.json({ event: ev });
});

admin.post('/events/:event/activate', master, withEvent, async (req, res) => {
  res.json({ event: await setActive(req.event.id) });
});

/* ───────────────────────────── moderación ────────────────────────────────── */

admin.get('/events/:event/photos', withEvent, async (req, res) => {
  const status = req.query.status && req.query.status !== 'all'
    ? String(req.query.status).split(',')
    : undefined;
  res.json({
    photos: await queue(req.event.id, { status, limit: Math.min(Number(req.query.limit) || 300, 1000) }),
    counts: await countByStatus(req.event.id),
    drive: await driveSync.queueStats(),
  });
});

admin.get('/events/:event/stream', withEvent, async (req, res) => {
  const counts = await countByStatus(req.event.id);
  subscribe(adminChannel(req.event.id), res);
  res.write(`event: hello\ndata: ${JSON.stringify({ counts })}\n\n`);
});

admin.post('/photos/:id/approve', async (req, res) => {
  const p = await approve(req.params.id);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ photo: adminPhoto(p) });
});

admin.post('/photos/:id/reject', async (req, res) => {
  const p = await reject(req.params.id, String(req.body?.reason || '').slice(0, 200));
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ photo: adminPhoto(p) });
});

admin.post('/photos/:id/printed', async (req, res) => {
  const p = await markPrinted(req.params.id, req.body?.printed !== false);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ photo: adminPhoto(p) });
});

admin.delete('/photos/:id', async (req, res) => {
  const p = await destroy(req.params.id);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ ok: true, id: p.id });
});

admin.post('/photos/:id/recompose', master, async (req, res) => {
  const p = await getPhoto(req.params.id);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  try {
    res.json({ photo: adminPhoto(await recompose(p, await getEvent(p.eventId))) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Acciones masivas: aprobar todo lo pendiente cuando hay fila y la cosa está sana. */
admin.post('/events/:event/bulk', withEvent, async (req, res) => {
  const { action, ids } = req.body || {};
  const targets = Array.isArray(ids) && ids.length
    ? ids
    : (await listPhotos(req.event.id, { status: 'pending' })).map((p) => p.id);
  let n = 0;
  for (const id of targets) {
    if (action === 'approve') { await approve(id); n++; }
    else if (action === 'reject') { await reject(id, 'Rechazo masivo'); n++; }
    else if (action === 'printed') { await markPrinted(id, true); n++; }
  }
  res.json({ ok: true, affected: n });
});

/** Recompone todas las impresiones del evento — al cambiar de marco. */
admin.post('/events/:event/recompose-all', master, withEvent, async (req, res) => {
  const rows = (await listPhotos(req.event.id)).filter((p) => p.status !== 'error');
  // En serverless la funcion muere al responder, asi que aqui si esperamos.
  for (const p of rows) {
    try { await recompose(p, req.event); } catch (err) { log.warn(`recompose ${p.id}: ${err.message}`); }
  }
  log.ok(`marcos regenerados: ${rows.length}`);
  res.json({ ok: true, queued: rows.length });
});

/* ───────────────────────────── marcos y vista previa ─────────────────────── */

admin.get('/frames', (req, res) => res.json({ frames: listFrames() }));

/** Foto de muestra sintética, para ver cómo queda un marco sin subir nada. */
async function sampleShot(orientation) {
  const [w, h] = orientation === 'landscape' ? [1600, 1200] : [1200, 1600];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stop-color="#2E3A5C"/><stop offset="55%" stop-color="#7C5C8A"/><stop offset="100%" stop-color="#E0A07A"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sky)"/>
    <circle cx="${w * 0.72}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.09}" fill="#FFE9B8" fill-opacity="0.9"/>
    <ellipse cx="${w * 0.5}" cy="${h * 0.62}" rx="${w * 0.15}" ry="${h * 0.15}" fill="#1B1A2E" fill-opacity="0.55"/>
    <rect x="0" y="${h * 0.8}" width="${w}" height="${h * 0.2}" fill="#14121F" fill-opacity="0.75"/>
    <text x="${w / 2}" y="${h * 0.92}" font-family="Segoe UI, Arial" font-size="${Math.round(h * 0.045)}"
      fill="#ffffff" fill-opacity="0.8" text-anchor="middle">FOTO DE MUESTRA ${orientation === 'landscape' ? 'HORIZONTAL' : 'VERTICAL'}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

admin.get('/frames/:id/preview.jpg', master, async (req, res) => {
  const orientation = req.query.orientation === 'landscape' ? 'landscape' : 'portrait';
  const ev = req.query.event ? await getEvent(req.query.event) : await activeEvent();
  try {
    const sample = await sampleShot(orientation);
    const framed = await composeFramed(sample, {
      frameId: req.params.id,
      fitMode: req.query.fit || 'auto',
      ...(ev ? frameMeta(ev) : { title: 'Evento Kuva', footer: 'KUVACONNECT' }),
    });
    const jpg = await sharp(framed.buffer).resize(700, 700, { fit: 'inside' }).jpeg({ quality: 84 }).toBuffer();
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'no-store').send(jpg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ──────────────────────────────── Drive ──────────────────────────────────── */

admin.get('/drive/status', master, async (req, res) => {
  const stats = await driveSync.queueStats();
  let account = null;
  if (drive.isConfigured()) {
    try { account = await drive.whoAmI(); } catch (err) { stats.error = err.message; }
  }
  res.json({ ...stats, account, enabled: config.drive.enabled });
});

admin.post('/drive/sync', master, async (req, res) => {
  await driveSync.syncNow();
  res.json({ ok: true, ...(await driveSync.queueStats()) });
});

admin.post('/drive/requeue', master, async (req, res) => {
  drive.resetClient();
  const n = await driveSync.requeueAll();
  await driveSync.syncNow();
  res.json({ ok: true, requeued: n });
});

admin.get('/drive/folders/:event', master, withEvent, async (req, res) => {
  if (!drive.isConfigured()) return res.status(400).json({ error: 'Drive no está configurado todavía.' });
  try {
    res.json({ folders: await drive.ensureEventFolders(req.event) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
