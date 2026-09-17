import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MARCOS DE KUVACONNECT
 * ─────────────────────────────────────────────────────────────────────────────
 *  Lienzo de impresión: 4x6 pulgadas @300dpi = 1200x1800 px  (el "10x15 cm"
 *  clásico de las DNP / Citizen). Horizontal = 1800x1200.
 *
 *  Un marco define, para cada orientación:
 *    - canvas   : tamaño final en píxeles
 *    - window   : el hueco donde entra la foto {x, y, w, h, radius}
 *    - paper    : color de fondo del papel
 *    - render   : SVG generado (type 'generated') o PNG (type 'overlay')
 *
 *  Para usar el marco real del diseñador cuando llegue:
 *    1. Exportarlo en PNG con transparencia en el hueco de la foto,
 *       a 1200x1800 (vertical) y 1800x1200 (horizontal).
 *    2. Guardarlo en  assets/frames/<id>/portrait.png  y  landscape.png
 *    3. Crear  assets/frames/<id>/frame.json  con las coordenadas del hueco.
 *  No hay que tocar nada más del sistema.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const PORTRAIT = { w: 1200, h: 1800 };
const LANDSCAPE = { w: 1800, h: 1200 };

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const SCRIPT = "'Segoe Script', 'Bradley Hand', 'Brush Script MT', cursive";

/**
 * Línea de texto centrada con tracking.
 * letter-spacing añade espacio también DESPUÉS de la última letra, así que con
 * text-anchor="middle" el bloque queda corrido media letra a la derecha:
 * lo compensamos moviendo el ancla.
 */
function line(text, { x, y, size, spacing = 0, fill, family = SANS, weight = 400, opacity = 1 }) {
  if (!text) return '';
  x -= spacing / 2;
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" `
    + `fill="${fill}" fill-opacity="${opacity}" letter-spacing="${spacing}" text-anchor="middle">${esc(text)}</text>`;
}

function corner(x, y, sx, sy, color) {
  const L = 34;
  return `<path d="M ${x} ${y + sy * L} L ${x} ${y} L ${x + sx * L} ${y}" fill="none" `
    + `stroke="${color}" stroke-opacity="0.75" stroke-width="2.5" stroke-linecap="square"/>`;
}

/* ═════════════════════════════ 1. KUVA CLASSIC ═══════════════════════════════ */

function classicOverlay({ canvas, window: win, meta }) {
  const { w, h } = canvas;
  const ink = '#1B1A17';
  const gold = '#C8A24A';
  const bandTop = win.y + win.h;
  const bandH = h - bandTop;
  const cx = w / 2;
  const titleSize = Math.round(bandH * 0.20);
  const footSize = Math.round(bandH * 0.085);
  const ruleW = Math.min(win.w * 0.42, 420);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="goldRule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${gold}" stop-opacity="0"/>
      <stop offset="50%" stop-color="${gold}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${gold}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="${win.x - 16}" y="${win.y - 16}" width="${win.w + 32}" height="${win.h + 32}"
        rx="${win.radius + 8}" fill="none" stroke="rgba(27,26,23,0.16)" stroke-width="1.5"/>
  <rect x="${win.x - 1.5}" y="${win.y - 1.5}" width="${win.w + 3}" height="${win.h + 3}"
        rx="${win.radius}" fill="none" stroke="rgba(27,26,23,0.32)" stroke-width="3"/>
  ${corner(win.x - 30, win.y - 30, 1, 1, gold)}
  ${corner(win.x + win.w + 30, win.y - 30, -1, 1, gold)}
  ${corner(win.x - 30, win.y + win.h + 30, 1, -1, gold)}
  ${corner(win.x + win.w + 30, win.y + win.h + 30, -1, -1, gold)}
  ${line(meta.title, { x: cx, y: bandTop + bandH * 0.44, size: titleSize, spacing: titleSize * 0.09, fill: ink, family: SERIF })}
  <rect x="${cx - ruleW / 2}" y="${bandTop + bandH * 0.575}" width="${ruleW}" height="2" fill="url(#goldRule)"/>
  ${line(meta.footer, { x: cx, y: bandTop + bandH * 0.795, size: footSize, spacing: footSize * 0.32, fill: ink, family: SANS, weight: 600, opacity: 0.6 })}
</svg>`;
}

/* ═════════════════════════════ 2. KUVA NOIR ══════════════════════════════════ */

function noirOverlay({ canvas, window: win, meta }) {
  const { w, h } = canvas;
  const bandTop = win.y + win.h;
  const bandH = h - bandTop;
  const cx = w / 2;
  const titleSize = Math.round(bandH * 0.21);
  const footSize = Math.round(bandH * 0.082);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="0.65" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="45%" stop-color="#ffffff" stop-opacity="0.012"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.05"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${w}" height="${h}" fill="url(#sheen)"/>
  <rect x="${win.x - 3}" y="${win.y - 3}" width="${win.w + 6}" height="${win.h + 6}"
        rx="${win.radius + 2}" fill="none" stroke="#C8A24A" stroke-opacity="0.85" stroke-width="3"/>
  <rect x="${win.x - 18}" y="${win.y - 18}" width="${win.w + 36}" height="${win.h + 36}"
        rx="${win.radius + 12}" fill="none" stroke="#C8A24A" stroke-opacity="0.2" stroke-width="1.5"/>
  ${line(meta.title, { x: cx, y: bandTop + bandH * 0.45, size: titleSize, spacing: titleSize * 0.15, fill: '#F6F1E6', family: SERIF })}
  ${line(meta.footer, { x: cx, y: bandTop + bandH * 0.745, size: footSize, spacing: footSize * 0.34, fill: '#C8A24A', family: SANS, weight: 600, opacity: 0.9 })}
</svg>`;
}

/* ═════════════════════════════ 3. KUVA POLAROID ══════════════════════════════ */

function polaroidOverlay({ canvas, window: win, meta }) {
  const { w, h } = canvas;
  const bandTop = win.y + win.h;
  const bandH = h - bandTop;
  const cx = w / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect x="${win.x - 2}" y="${win.y - 2}" width="${win.w + 4}" height="${win.h + 4}"
        rx="${win.radius}" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="3"/>
  <text x="${cx}" y="${bandTop + bandH * 0.47}" font-family="${SCRIPT}" font-size="${Math.round(bandH * 0.29)}"
        fill="#23201C" text-anchor="middle">${esc(meta.title)}</text>
  ${line(meta.footer, { x: cx, y: bandTop + bandH * 0.745, size: Math.round(bandH * 0.10), spacing: Math.round(bandH * 0.03), fill: '#23201C', family: SANS, weight: 600, opacity: 0.45 })}
</svg>`;
}

/* ═══════════════════════════════ REGISTRO ════════════════════════════════════ */

function layout(canvas, { side, band, radius }) {
  return {
    canvas,
    window: { x: side, y: side, w: canvas.w - side * 2, h: canvas.h - side - band, radius },
  };
}

export const FRAMES = {
  'kuva-classic': {
    id: 'kuva-classic',
    name: 'Kuva Classic',
    description: 'Passepartout marfil, filete dorado y serif. Neutro y elegante, combina con cualquier marca.',
    type: 'generated',
    paper: '#FAF7F2',
    portrait: layout(PORTRAIT, { side: 76, band: 340, radius: 6 }),
    landscape: layout(LANDSCAPE, { side: 76, band: 226, radius: 6 }),
    render: classicOverlay,
  },

  'kuva-noir': {
    id: 'kuva-noir',
    name: 'Kuva Noir',
    description: 'Fondo tinta profunda con borde dorado. Para eventos de noche, galas y lanzamientos.',
    type: 'generated',
    paper: '#14151C',
    portrait: layout(PORTRAIT, { side: 70, band: 320, radius: 4 }),
    landscape: layout(LANDSCAPE, { side: 70, band: 212, radius: 4 }),
    render: noirOverlay,
  },

  'kuva-polaroid': {
    id: 'kuva-polaroid',
    name: 'Kuva Polaroid',
    description: 'Borde blanco ancho abajo, estilo instantánea. Muy fotografiable y fácil de firmar con marcador.',
    type: 'generated',
    paper: '#FFFFFF',
    portrait: layout(PORTRAIT, { side: 64, band: 380, radius: 2 }),
    landscape: layout(LANDSCAPE, { side: 64, band: 250, radius: 2 }),
    render: polaroidOverlay,
  },
};

/**
 * Marcos por overlay PNG: se autodetectan desde assets/frames/<id>/frame.json.
 * Así se enchufa el arte final del cliente sin escribir código.
 */
export function loadOverlayFrames() {
  const dir = path.join(config.paths.assets, 'frames');
  if (!fs.existsSync(dir)) return [];
  const loaded = [];
  for (const id of fs.readdirSync(dir)) {
    const specFile = path.join(dir, id, 'frame.json');
    if (!fs.existsSync(specFile)) continue;
    try {
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
      const portraitFile = path.join(dir, id, spec.portrait?.file || 'portrait.png');
      const landscapeFile = path.join(dir, id, spec.landscape?.file || 'landscape.png');
      // Sin los PNG no registramos el marco: mejor que no aparezca a que reviente al imprimir.
      if (!fs.existsSync(portraitFile) || !fs.existsSync(landscapeFile)) continue;
      FRAMES[id] = {
        id,
        name: spec.name || id,
        description: spec.description || 'Marco personalizado del cliente.',
        type: 'overlay',
        paper: spec.paper || '#FFFFFF',
        portrait: { canvas: spec.portrait.canvas || PORTRAIT, window: spec.portrait.window, file: portraitFile },
        landscape: { canvas: spec.landscape.canvas || LANDSCAPE, window: spec.landscape.window, file: landscapeFile },
      };
      loaded.push(id);
    } catch { /* spec inválido: se ignora para no tumbar el servidor en pleno evento */ }
  }
  return loaded;
}

export function getFrame(id) {
  return FRAMES[id] || FRAMES['kuva-classic'];
}

export function listFrames() {
  return Object.values(FRAMES).map(({ id, name, description, type, paper }) => ({ id, name, description, type, paper }));
}
