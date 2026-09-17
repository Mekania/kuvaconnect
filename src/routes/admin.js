import express from 'express';
import sharp from 'sharp';
import { config, baseUrl } from '../config.js';
import * as auth from '../lib/auth.js';
import { getEvent, getPhoto, listEvents, listPhotos, updateEvent, countByStatus } from '../lib/db.js';
import { createEvent, publicEvent, setActive, activeEvent, frameMeta } from '../lib/eventService.js';
import { listFrames, getFrame } from '../lib/frames/index.js';
import { composeFramed } from '../lib/compose.js';
import { approve, reject, markPrinted, recompose, queue, adminPhoto, adminChannel } from '../lib/photoService.js';
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

admin.post('/login', (req, res) => {
  const t = auth.login(String(req.body?.pin || ''));
  if (!t) return res.status(401).json({ error: 'PIN incorrecto' });
  auth.setCookie(res, t);
  res.json({ ok: true, token: t });
});

admin.post('/logout', (req, res) => {
  auth.logout(auth.tokenFrom(req));
  auth.clearCookie(res);
  res.json({ ok: true });
});

admin.get('/session', (req, res) => res.json({ authenticated: auth.isAdmin(req) }));

admin.use(auth.requireAdmin);

function withEvent(req, res, next) {
  const ev = getEvent(req.params.event);
  if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
  req.event = ev;
  next();
}

/* ─────────────────────────────── eventos ─────────────────────────────────── */

admin.get('/bootstrap', (req, res) => {
  const active = activeEvent();
  res.json({
    events: listEvents().map((e) => ({ ...publicEvent(e), active: e.active, counts: countByStatus(e.id) })),
    activeEventId: active?.id || null,
    frames: listFrames(),
    drive: driveSync.queueStats(),
    baseUrl: baseUrl(),
  });
});

admin.get('/events/:event', withEvent, async (req, res) => {
  res.json({
    event: { ...req.event, counts: countByStatus(req.event.id) },
    uploadUrl: uploadUrl(req.event),
    displayUrl: `${baseUrl()}/d/${req.event.slug}`,
    diskBytes: await media.diskUsage(req.event.id),
  });
});

admin.post('/events', async (req, res) => {
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

admin.patch('/events/:event', withEvent, (req, res) => {
  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) if (EDITABLE.has(k)) patch[k] = v;
  if (patch.frameId) patch.frameId = getFrame(patch.frameId).id;
  const ev = updateEvent(req.event.id, patch);
  if (patch.active === true) setActive(ev.id);
  res.json({ event: ev });
});

admin.post('/events/:event/activate', withEvent, (req, res) => {
  res.json({ event: setActive(req.event.id) });
});

/* ───────────────────────────── moderación ────────────────────────────────── */

admin.get('/events/:event/photos', withEvent, (req, res) => {
  const status = req.query.status && req.query.status !== 'all'
    ? String(req.query.status).split(',')
    : undefined;
  res.json({
    photos: queue(req.event.id, { status, limit: Math.min(Number(req.query.limit) || 300, 1000) }),
    counts: countByStatus(req.event.id),
    drive: driveSync.queueStats(),
  });
});

admin.get('/events/:event/stream', withEvent, (req, res) => {
  subscribe(adminChannel(req.event.id), res);
  res.write(`event: hello\ndata: ${JSON.stringify({ counts: countByStatus(req.event.id) })}\n\n`);
});

admin.post('/photos/:id/approve', async (req, res) => {
  const p = await approve(req.params.id);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ photo: adminPhoto(p) });
});

admin.post('/photos/:id/reject', (req, res) => {
  const p = reject(req.params.id, String(req.body?.reason || '').slice(0, 200));
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ photo: adminPhoto(p) });
});

admin.post('/photos/:id/printed', (req, res) => {
  const p = markPrinted(req.params.id, req.body?.printed !== false);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  res.json({ photo: adminPhoto(p) });
});

admin.post('/photos/:id/recompose', async (req, res) => {
  const p = getPhoto(req.params.id);
  if (!p) return res.status(404).json({ error: 'Foto no encontrada' });
  try {
    res.json({ photo: adminPhoto(await recompose(p, getEvent(p.eventId))) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Acciones masivas: aprobar todo lo pendiente cuando hay fila y la cosa está sana. */
admin.post('/events/:event/bulk', withEvent, async (req, res) => {
  const { action, ids } = req.body || {};
  const targets = Array.isArray(ids) && ids.length
    ? ids
    : listPhotos(req.event.id, { status: 'pending' }).map((p) => p.id);
  let n = 0;
  for (const id of targets) {
    if (action === 'approve') { await approve(id); n++; }
    else if (action === 'reject') { reject(id, 'Rechazo masivo'); n++; }
    else if (action === 'printed') { markPrinted(id, true); n++; }
  }
  res.json({ ok: true, affected: n });
});

/** Recompone todas las impresiones del evento — al cambiar de marco. */
admin.post('/events/:event/recompose-all', withEvent, async (req, res) => {
  const rows = listPhotos(req.event.id).filter((p) => p.status !== 'error');
  res.json({ ok: true, queued: rows.length });
  // Se responde ya y se procesa en segundo plano: son cientos de imágenes a 300dpi.
  (async () => {
    for (const p of rows) {
      try { await recompose(p, getEvent(req.event.id)); } catch (err) { log.warn(`recompose ${p.id}: ${err.message}`); }
    }
    log.ok(`marcos regenerados: ${rows.length}`);
  })();
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

admin.get('/frames/:id/preview.jpg', async (req, res) => {
  const orientation = req.query.orientation === 'landscape' ? 'landscape' : 'portrait';
  const ev = req.query.event ? getEvent(req.query.event) : activeEvent();
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

admin.get('/drive/status', async (req, res) => {
  const stats = driveSync.queueStats();
  let account = null;
  if (drive.isConfigured()) {
    try { account = await drive.whoAmI(); } catch (err) { stats.error = err.message; }
  }
  res.json({ ...stats, account, enabled: config.drive.enabled });
});

admin.post('/drive/sync', async (req, res) => {
  await driveSync.syncNow();
  res.json({ ok: true, ...driveSync.queueStats() });
});

admin.post('/drive/requeue', async (req, res) => {
  drive.resetClient();
  const n = driveSync.requeueAll();
  driveSync.syncNow();
  res.json({ ok: true, requeued: n });
});

admin.get('/drive/folders/:event', withEvent, async (req, res) => {
  if (!drive.isConfigured()) return res.status(400).json({ error: 'Drive no está configurado todavía.' });
  try {
    res.json({ folders: await drive.ensureEventFolders(req.event) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
