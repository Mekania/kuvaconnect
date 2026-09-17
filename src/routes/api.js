import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { config, baseUrl } from '../config.js';
import { getEvent, getPhoto, countByStatus, listPhotos } from '../lib/db.js';
import { publicEvent } from '../lib/eventService.js';
import { ingest, feed, publicPhoto, HEIF_SUPPORTED } from '../lib/photoService.js';
import { subscribe, clientCount } from '../lib/bus.js';
import { urlFor } from '../lib/media.js';
import { logger } from '../lib/logger.js';

const log = logger('api');
export const api = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 1, fields: 8 },
});

/** Resuelve :event por id o por slug y lo deja en req.event. */
async function withEvent(req, res, next) {
  try {
    const ev = await getEvent(req.params.event);
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' });
    req.event = ev;
    next();
  } catch (err) {
    log.error(`buscando evento: ${err.message}`);
    res.status(500).json({ error: 'No se pudo leer el evento' });
  }
}

export function uploadUrl(ev) {
  return `${baseUrl()}/u/${ev.slug}?t=${ev.uploadToken}`;
}

/* ─────────────────────────────── evento y feed ───────────────────────────── */

api.get('/event/:event', withEvent, async (req, res) => {
  res.json({
    event: publicEvent(req.event),
    counts: await countByStatus(req.event.id),
    uploadUrl: uploadUrl(req.event),
    viewers: clientCount(req.event.id),
    // La pantalla usa SSE donde hay proceso vivo y sondeo en serverless.
    live: process.env.VERCEL ? 'poll' : 'sse',
  });
});

api.get('/event/:event/feed', withEvent, async (req, res) => {
  const limit = Math.min(Number.parseInt(req.query.limit, 10) || 200, 500);
  res.json({
    photos: await feed(req.event.id, { limit }),
    counts: await countByStatus(req.event.id),
  });
});

/** Stream público: solo viajan fotos ya aprobadas. */
api.get('/event/:event/stream', withEvent, async (req, res) => {
  const counts = await countByStatus(req.event.id);
  subscribe(req.event.id, res);
  res.write(`event: hello\ndata: ${JSON.stringify({ event: publicEvent(req.event), counts })}\n\n`);
});

/* ────────────────────────────────── QR ───────────────────────────────────── */

api.get('/event/:event/qr.png', withEvent, async (req, res) => {
  const size = Math.min(Math.max(Number.parseInt(req.query.size, 10) || 900, 200), 2000);
  const dark = req.query.dark || '#0B0B0F';
  const light = req.query.light || '#FFFFFF';
  try {
    const png = await QRCode.toBuffer(uploadUrl(req.event), {
      type: 'png',
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark, light },
    });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'no-store').send(png);
  } catch (err) {
    log.error(`QR: ${err.message}`);
    res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

api.get('/event/:event/qr.svg', withEvent, async (req, res) => {
  const svg = await QRCode.toString(uploadUrl(req.event), {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    color: { dark: req.query.dark || '#0B0B0F', light: req.query.light || '#FFFFFF' },
  });
  res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

/* ──────────────────────────────── subida ────────────────────────────────── */

api.post('/event/:event/upload', withEvent, (req, res) => {
  upload.single('photo')(req, res, async (err) => {
    const ev = req.event;

    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `La foto pesa más de ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB. Intenta con otra.`
        : 'No pudimos recibir el archivo.';
      return res.status(400).json({ error: msg });
    }

    if (!ev.uploadEnabled) {
      return res.status(403).json({ error: 'Las subidas están cerradas por ahora.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No llegó ninguna foto.' });
    }

    const mime = req.file.mimetype;
    if (!config.upload.allowedMime.includes(mime)) {
      return res.status(415).json({ error: 'Ese formato no sirve. Sube una foto JPG o PNG.' });
    }
    if (/heic|heif/.test(mime) && !HEIF_SUPPORTED) {
      return res.status(415).json({
        error: 'Tu foto viene en formato HEIC. En el celular elige "Más compatible" o toma una captura de pantalla y súbela.',
      });
    }

    const device = String(req.body.device || '').slice(0, 40) || 'anon';
    if (ev.maxPerDevice > 0) {
      const mine = (await listPhotos(ev.id)).filter((p) => p.device === device && p.status !== 'rejected').length;
      if (mine >= ev.maxPerDevice) {
        return res.status(429).json({ error: `Ya subiste ${mine} fotos. ¡Deja espacio para los demás!` });
      }
    }

    try {
      const photo = await ingest(ev, {
        buffer: req.file.buffer,
        mimeType: mime,
        device,
        ip: req.ip,
        caption: req.body.caption,
        author: req.body.author,
      });
      res.status(201).json({
        ok: true,
        photo: publicPhoto(photo),
        moderated: photo.status === 'pending',
        message: photo.status === 'pending'
          ? '¡Listo! Tu foto está en revisión y saldrá en pantalla en un momento.'
          : '¡Listo! Búscala en la pantalla.',
      });
    } catch (e) {
      log.error(`subida fallida: ${e.message}`);
      res.status(422).json({ error: e.message || 'No pudimos procesar la foto.' });
    }
  });
});

/** Estado de una foto, para que el celular avise "ya saliste en pantalla". */
api.get('/photo/:id/status', async (req, res) => {
  const p = await getPhoto(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrada' });
  res.json({
    status: p.status,
    seq: p.seq,
    url: p.status === 'approved' ? urlFor(p, 'web') : null,
  });
});
