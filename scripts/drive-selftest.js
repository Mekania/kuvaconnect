/**
 * Prueba de punta a punta del MODO NUBE contra tu Drive real.
 *
 *   npm run drive:selftest
 *
 * Crea un evento de prueba, sube una foto, la compone con el marco, la modera
 * (aprobar → rechazar → aprobar) y comprueba que los archivos terminaron en la
 * carpeta correcta. Al final borra todo lo que creó.
 *
 * Esto es lo que valida que el modo nube funciona. Córrelo DESPUÉS de conectar
 * Drive con `npm run drive:auth` y ANTES de desplegar a Vercel.
 */
process.env.KUVA_STORE = 'drive';
process.env.KUVA_MEDIA = 'drive';
process.env.DRIVE_ENABLED = 'true';

import sharp from 'sharp';
import * as drive from '../src/lib/drive.js';
import * as driveBackend from '../src/lib/driveBackend.js';
import { loadOverlayFrames } from '../src/lib/frames/index.js';
import { createEvent } from '../src/lib/eventService.js';
import { ingest, approve, reject, markPrinted, feed, queue } from '../src/lib/photoService.js';
import { getPhoto, listEvents } from '../src/lib/db.js';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

console.log('\n  Prueba del modo nube (Vercel + Drive)\n  ─────────────────────────────────────\n');

if (!drive.authMode()) {
  bad('No hay credenciales de Drive. Corre primero:  npm run drive:auth');
  process.exit(1);
}
ok(`credenciales listas (modo ${drive.authMode()})`);

loadOverlayFrames();

/** Una foto de prueba 9:16, como la que subiría un celular. */
async function testPhoto() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <rect width="1080" height="1920" fill="#2E3A5C"/>
    <circle cx="540" cy="760" r="180" fill="#F2D3B8"/>
    <text x="540" y="200" font-family="Arial" font-size="80" fill="#fff" text-anchor="middle">PRUEBA</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}

let event;
let photo;

try {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  event = await createEvent({ name: `_PRUEBA KuvaConnect ${stamp}`, moderation: 'pre', fitMode: 'crop' });
  ok(`evento creado en Drive: ${event.name}`);

  const found = (await listEvents()).find((e) => e.id === event.id);
  if (!found) throw new Error('el evento no se pudo leer de vuelta');
  ok('el evento se lee de vuelta desde Drive (la carpeta es el registro)');

  photo = await ingest(event, {
    buffer: await testPhoto(),
    mimeType: 'image/jpeg',
    device: 'selftest',
    caption: 'Prueba automática',
    author: 'KuvaConnect',
  });
  ok(`foto procesada · #${photo.seq} · ${photo.orientation}/${photo.fitMode} · marco ${photo.frameId}`);
  info(`archivos: ${Object.entries(photo.files).map(([k, v]) => `${k}=${String(v).slice(0, 8)}…`).join(' ')}`);

  const back = await getPhoto(photo.id);
  if (!back) throw new Error('la foto no se pudo leer de vuelta');
  if (back.status !== 'pending') throw new Error(`estado esperado pending, llegó ${back.status}`);
  if (back.caption !== 'Prueba automática') throw new Error('el mensaje no sobrevivió el viaje');
  ok('la foto se lee de vuelta con su estado y su mensaje');

  const pending = await queue(event.id, { status: 'pending' });
  if (!pending.length) throw new Error('la foto no aparece en la cola de moderación');
  ok('aparece en la cola de moderación');

  await approve(photo.id);
  const approved = await getPhoto(photo.id);
  if (approved.status !== 'approved') throw new Error('no quedó aprobada');
  ok('aprobada · la impresión se movió a 02_Para_imprimir');

  const shown = await feed(event.id);
  if (!shown.find((p) => p.id === photo.id)) throw new Error('no salió en el feed de la pantalla');
  ok('sale en el feed de la pantalla');

  await reject(photo.id, 'prueba');
  const rejected = await getPhoto(photo.id);
  if (rejected.status !== 'rejected') throw new Error('no quedó rechazada');
  if ((await feed(event.id)).find((p) => p.id === photo.id)) throw new Error('sigue en el feed tras rechazarla');
  ok('rechazada · el original se movió a 03_Rechazadas y salió de la pantalla');

  await approve(photo.id);
  if ((await getPhoto(photo.id)).status !== 'approved') throw new Error('no se pudo volver a aprobar');
  ok('re-aprobada · vuelve a 01_Originales');

  await markPrinted(photo.id, true);
  if (!(await getPhoto(photo.id)).printedAt) throw new Error('no quedó marcada como impresa');
  ok('marcada como impresa · el archivo se movió a 04_Impresas');

  const img = await driveBackend.readFileById((await getPhoto(photo.id)).files.web);
  const meta = await sharp(img).metadata();
  ok(`la imagen se descarga de Drive y es válida (${meta.width}x${meta.height})`);

  console.log('\n  \x1b[32mTODO BIEN.\x1b[0m El modo nube funciona contra tu Drive.\n');
} catch (err) {
  bad(err.message);
  console.error(`\n  Detalle: ${err.stack}\n`);
  process.exitCode = 1;
} finally {
  // Dejar el Drive del cliente como estaba.
  if (event?.folderId) {
    try {
      await drive.deleteFile(event.folderId);
      info('carpeta de prueba enviada a la papelera de tu Drive');
    } catch (err) {
      info(`no se pudo limpiar la carpeta de prueba: ${err.message}`);
    }
  }
}
