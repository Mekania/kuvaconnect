/**
 * Genera una hoja de contactos con cada marco en vertical y horizontal,
 * usando fotos de prueba con las proporciones típicas de celular.
 *
 *   npm run frames:preview        → escribe en data/previews/
 */
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { listFrames } from '../src/lib/frames/index.js';
import { composeFramed } from '../src/lib/compose.js';

const OUT = path.join(ROOT, 'data', 'previews');

const SHAPES = [
  { id: '9x16', w: 1080, h: 1920, label: 'Vertical 9:16 (celular)' },
  { id: '3x4', w: 1536, h: 2048, label: 'Vertical 3:4' },
  { id: '16x9', w: 1920, h: 1080, label: 'Horizontal 16:9' },
  { id: '4x3', w: 2048, h: 1536, label: 'Horizontal 4:3' },
];

async function testPhoto({ w, h, label }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0.5" y2="1">
        <stop offset="0%" stop-color="#22304F"/><stop offset="50%" stop-color="#7A5A86"/><stop offset="100%" stop-color="#E8A87C"/>
      </linearGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.74}" cy="${h * 0.18}" r="${Math.min(w, h) * 0.08}" fill="#FFE9B8"/>
    <ellipse cx="${w * 0.42}" cy="${h * 0.58}" rx="${Math.min(w, h) * 0.13}" ry="${Math.min(w, h) * 0.13}" fill="#151226" fill-opacity="0.6"/>
    <rect x="${w * 0.28}" y="${h * 0.70}" width="${w * 0.28}" height="${h * 0.30}" fill="#151226" fill-opacity="0.6"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#ff2d55" stroke-width="10" stroke-dasharray="40 20"/>
    <text x="${w / 2}" y="${h * 0.08}" font-family="Segoe UI, Arial" font-size="${Math.round(Math.min(w, h) * 0.05)}"
      fill="#fff" text-anchor="middle" font-weight="700">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

const meta = { title: 'Boda Ana & Luis', footer: '15 DE SEPTIEMBRE DE 2026   ·   #KUVACONNECT' };

await fs.mkdir(OUT, { recursive: true });
const rows = [];

for (const frame of listFrames()) {
  for (const shape of SHAPES) {
    const photo = await testPhoto(shape);
    const r = await composeFramed(photo, { frameId: frame.id, ...meta });
    const name = `${frame.id}__${shape.id}__${r.orientation}_${r.fitMode}.jpg`;
    await fs.writeFile(path.join(OUT, name), r.buffer);
    rows.push({ frame: frame.id, entrada: shape.id, marco: r.orientation, ajuste: r.fitMode, salida: `${r.width}x${r.height}` });
  }
}

console.table(rows);
console.log(`\n${rows.length} pruebas escritas en ${OUT}`);
