import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, baseUrl, lanIP } from './config.js';
import { api, uploadUrl } from './routes/api.js';
import { admin } from './routes/admin.js';
import { canAccess } from './lib/auth.js';
import { getEvent, driverInfo as dbDriver } from './lib/db.js';
import { ensureDefaultEvent, activeEvent } from './lib/eventService.js';
import { loadOverlayFrames, listFrames } from './lib/frames/index.js';
import * as driveSync from './lib/driveSync.js';
import * as drive from './lib/drive.js';
import * as media from './lib/media.js';
const { KINDS } = media;
import { HEIF_SUPPORTED } from './lib/photoService.js';
import { logger } from './lib/logger.js';

const log = logger('server');
const app = express();

app.set('trust proxy', true);
app.disable('x-powered-by');

/* ──────────────────────────────── archivos ───────────────────────────────── */

/**
 * Las versiones web/thumb son públicas (ya pasaron moderación y son las que se
 * ven en pantalla). El original, la vista de moderación y el archivo de
 * impresión solo los ve el panel: ahí es donde puede haber algo que no debió subirse.
 */
const PROTECTED_KINDS = new Set(['orig', 'raw', 'print']);

app.get('/media/:event/:kind/:file', async (req, res) => {
  const { event, kind, file } = req.params;
  if (!KINDS[kind]) return res.status(404).end();
  // Lo privado solo lo ve una sesión de ESA sede (o el maestro).
  if (PROTECTED_KINDS.has(kind) && !canAccess(req, event)) return res.status(403).end();
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.includes('..')) return res.status(400).end();

  try {
    if (!(await getEvent(event))) return res.status(404).end();
  } catch {
    return res.status(500).end();
  }

  const isPublicKind = kind === 'thumb' || kind === 'web';
  res.set('Cache-Control', isPublicKind ? 'public, max-age=31536000, immutable' : 'private, no-store');
  // Solo forzamos la descarga cuando se pide explicitamente: el boton de
  // imprimir del panel carga este mismo archivo dentro de un <img>, y con
  // Content-Disposition: attachment el navegador no lo renderiza.
  if (kind === 'print' && req.query.download) {
    res.set('Content-Disposition', `attachment; filename="kuva_${file}"`);
  }

  const dot = file.lastIndexOf('.');
  const photoId = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot + 1) : 'jpg';

  if (media.DRIVER === 'disk') {
    const abs = path.join(media.eventDir(event), KINDS[kind].dir, file);
    if (!fs.existsSync(abs)) return res.status(404).end();
    return res.sendFile(abs);
  }

  // En la nube el archivo vive en Drive y la URL trae su id directamente, para
  // no tener que buscar la foto en cada peticion de imagen. Lo servimos
  // nosotros en vez de dar un enlace publico de Drive, para que la regla de
  // acceso siga siendo nuestra y no un enlace reenviable.
  try {
    const buf = await media.read(event, kind, photoId, ext, photoId);
    res.type(ext === 'png' ? 'image/png' : 'image/jpeg').send(buf);
  } catch {
    res.status(404).end();
  }
});

/* ──────────────────────────────── rutas API ──────────────────────────────── */

app.use('/api', api);
app.use('/api/admin', admin);

/* ──────────────────────────────── páginas ────────────────────────────────── */

/**
 * La UI se sirve sin caché. Durante un evento la pantalla lleva horas abierta y
 * un ajuste de último minuto tiene que verse con solo recargar (F5), sin que
 * nadie tenga que acordarse de vaciar la caché del navegador.
 * Las fotos sí llevan caché larga: se sirven desde /media con sus propios headers.
 */
app.use(express.static(config.paths.public, {
  index: false,
  etag: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

const page = (dir) => path.join(config.paths.public, dir, 'index.html');
const sendPage = (res, dir) => res.set('Cache-Control', 'no-store').sendFile(page(dir));

/** Pantalla grande del evento. */
app.get('/d/:slug?', (req, res) => sendPage(res, 'display'));
/** Flujo del invitado en el celular. */
app.get('/u/:slug?', (req, res) => sendPage(res, 'upload'));
/** Panel del logístico. */
app.get('/admin', (req, res) => sendPage(res, 'admin'));

app.get('/', async (req, res) => {
  const ev = await activeEvent();
  res.redirect(ev ? `/d/${ev.slug}` : '/admin');
});

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    store: dbDriver(),
    media: media.driverInfo(),
    drive: await driveSync.queueStats().catch(() => ({ configured: false })),
    heic: HEIF_SUPPORTED,
  });
});

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

app.use((err, req, res, _next) => {
  log.error(`error no controlado: ${err.stack || err.message}`);
  res.status(500).json({ error: 'Error interno' });
});

/* ──────────────────────────────── arranque ───────────────────────────────── */

function banner(ev) {
  const B = '\x1b[1m'; const D = '\x1b[90m'; const G = '\x1b[32m'; const Y = '\x1b[33m'; const R = '\x1b[0m';
  const rows = [
    ['Pantalla (proyector / cabina)', `${baseUrl()}/d/${ev.slug}`],
    ['Panel de moderación', `${baseUrl()}/admin`],
    ['Link del QR (celulares)', uploadUrl(ev)],
  ];
  console.log(`\n${B}  KUVACONNECT${R} ${D}· ${ev.name}${R}\n`);
  for (const [label, url] of rows) console.log(`  ${D}${label.padEnd(30)}${R} ${G}${url}${R}`);
  console.log(`\n  ${D}PIN del panel:${R} ${B}${config.adminPin}${R}   ${D}Marcos:${R} ${listFrames().map((f) => f.id).join(', ')}`);
  if (!drive.isConfigured()) {
    console.log(`  ${Y}Drive sin conectar${R} ${D}— todo se guarda local y sube solo cuando pongas las credenciales (ver README).${R}`);
  }
  if (!HEIF_SUPPORTED) {
    console.log(`  ${D}HEIC no soportado por esta build de sharp: los iPhone deben subir en "Más compatible".${R}`);
  }
  console.log(`\n  ${D}El celular debe estar en la misma red Wi-Fi. IP detectada: ${lanIP()}${R}\n`);
}

/**
 * Carga los marcos por PNG. En serverless esto corre en cada arranque en frio
 * de la funcion, que es barato (leer dos archivos del bundle).
 */
export function bootstrapFrames() {
  const overlays = loadOverlayFrames();
  if (overlays.length) log.ok(`marcos personalizados cargados: ${overlays.join(', ')}`);
}

export { app };

/** Arranque como servidor de verdad (modo evento, en el portatil). */
async function main() {
  fs.mkdirSync(config.paths.data, { recursive: true });
  bootstrapFrames();

  const ev = await ensureDefaultEvent();
  driveSync.start();

  app.listen(config.port, config.host, () => banner(ev));
}

// En Vercel no arrancamos un listener: api/index.js importa `app` y ya.
if (!process.env.VERCEL) {
  main().catch((err) => {
    log.error(`no se pudo arrancar: ${err.stack}`);
    process.exit(1);
  });
}
