import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import { getFrame } from './frames/index.js';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger('compose');

sharp.cache({ files: 0, memory: 96 });
sharp.concurrency(Math.max(1, Math.min(4, os.cpus().length - 1)));

/**
 * Si al recortar "a llenar" perdemos más de este % del área de la foto,
 * pasamos a modo fondo-difuminado para no mutilar la imagen.
 * Un 9:16 de celular dentro del hueco vertical pierde ~28% (recorta cielo y piso):
 * eso todavía se ve bien impreso. Una panorámica pierde 60%+ y ahí sí conviene el fondo.
 */
const CROP_LOSS_LIMIT = 0.34;

/** Qué orientación de marco le corresponde a la foto. */
export function orientationOf(width, height, fallback = 'portrait') {
  if (width > height * 1.02) return 'landscape';
  if (height > width * 1.02) return 'portrait';
  return fallback; // cuadrada
}

function cropLoss(src, dst) {
  const scale = Math.max(dst.w / src.w, dst.h / src.h);
  const scaled = { w: src.w * scale, h: src.h * scale };
  return 1 - (dst.w * dst.h) / (scaled.w * scaled.h);
}

function roundedMask(w, h, r) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
}

/**
 * Ajusta la foto al hueco del marco.
 * - 'crop' : llena el hueco recortando, centrado por "atención" (sharp busca
 *            la zona con más información: normalmente las caras).
 * - 'fit'  : la foto completa sobre una versión de sí misma difuminada y oscurecida.
 * - 'auto' : decide según cuánto se perdería al recortar.
 */
async function fitIntoWindow(input, win, mode = 'auto') {
  const meta = await sharp(input).metadata();
  const src = { w: meta.width, h: meta.height };
  const dst = { w: Math.round(win.w), h: Math.round(win.h) };

  let chosen = mode;
  if (mode === 'auto') chosen = cropLoss(src, dst) > CROP_LOSS_LIMIT ? 'fit' : 'crop';

  let out;
  if (chosen === 'crop') {
    out = await sharp(input)
      .resize(dst.w, dst.h, { fit: 'cover', position: sharp.strategy.attention, withoutEnlargement: false })
      .toBuffer();
  } else {
    const backdrop = await sharp(input)
      .resize(dst.w, dst.h, { fit: 'cover', position: 'centre' })
      .blur(42)
      .modulate({ brightness: 0.62, saturation: 0.85 })
      .toBuffer();
    const inset = Math.round(Math.min(dst.w, dst.h) * 0.035);
    const fitted = await sharp(input)
      .resize(dst.w - inset * 2, dst.h - inset * 2, { fit: 'inside', withoutEnlargement: false })
      .toBuffer();
    const fm = await sharp(fitted).metadata();
    out = await sharp(backdrop)
      .composite([{
        input: fitted,
        left: Math.round((dst.w - fm.width) / 2),
        top: Math.round((dst.h - fm.height) / 2),
      }])
      .toBuffer();
  }

  if (win.radius > 0) {
    out = await sharp(out)
      .composite([{ input: roundedMask(dst.w, dst.h, win.radius), blend: 'dest-in' }])
      .png()
      .toBuffer();
  }

  return { buffer: out, mode: chosen, source: src };
}

/**
 * Genera la copia lista para imprimir: foto + marco, en lienzo 10x15 a 300dpi.
 * Devuelve el JPEG y los datos del proceso (orientación, modo de ajuste, medidas).
 */
export async function composeFramed(inputBuffer, { frameId, title, footer, fitMode = 'auto', forceOrientation } = {}) {
  const frame = getFrame(frameId);
  const base = sharp(inputBuffer).rotate(); // respeta la orientación EXIF del celular
  const meta = await base.metadata();
  const orientation = forceOrientation || orientationOf(meta.width, meta.height);
  const spec = frame[orientation];
  const { canvas, window: win } = spec;

  const normalized = await base.toBuffer();
  const { buffer: photo, mode, source } = await fitIntoWindow(normalized, win, fitMode);

  const layers = [{ input: photo, left: Math.round(win.x), top: Math.round(win.y) }];

  if (frame.type === 'overlay') {
    const png = await fs.readFile(spec.file);
    layers.push({
      input: await sharp(png).resize(canvas.w, canvas.h, { fit: 'fill' }).toBuffer(),
      left: 0,
      top: 0,
    });
  } else {
    const svg = frame.render({ canvas, window: win, meta: { title, footer } });
    layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  }

  const jpeg = await sharp({
    create: { width: canvas.w, height: canvas.h, channels: 3, background: frame.paper },
  })
    .composite(layers)
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true })
    .withMetadata({ density: config.print.dpi })
    .toBuffer();

  log.info(`compuesta ${orientation}/${mode} ${source.w}x${source.h} → ${canvas.w}x${canvas.h} (${frame.id})`);

  return {
    buffer: jpeg,
    orientation,
    fitMode: mode,
    frameId: frame.id,
    width: canvas.w,
    height: canvas.h,
    sourceWidth: source.w,
    sourceHeight: source.h,
  };
}

/** Derivados web: lo que ven la pantalla y el panel. Sin metadatos EXIF. */
export async function makeWebVersions(buffer) {
  const [web, thumb] = await Promise.all([
    sharp(buffer).resize(1000, 1000, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer(),
    sharp(buffer).resize(380, 380, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72, mozjpeg: true }).toBuffer(),
  ]);
  return { web, thumb };
}

/** Copia reducida del original, para que el moderador vea la foto real sin marco. */
export async function makeRawPreview(buffer) {
  return sharp(buffer).rotate().resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

/** Señales baratas para ayudar a priorizar la moderación (no reemplaza el ojo humano). */
export async function analyze(buffer) {
  try {
    const img = sharp(buffer).rotate();
    const { width, height } = await img.metadata();
    const stats = await img.stats();
    const mean = stats.channels.reduce((a, c) => a + c.mean, 0) / stats.channels.length;
    const entropy = stats.entropy ?? 0;
    const flags = [];
    if (mean < 26) flags.push('muy-oscura');
    if (mean > 236) flags.push('quemada');
    if (entropy < 3.2) flags.push('casi-vacia');
    if (Math.min(width, height) < 700) flags.push('baja-resolucion');
    return { width, height, brightness: Math.round(mean), entropy: Number(entropy.toFixed(2)), flags };
  } catch {
    return { flags: [] };
  }
}
