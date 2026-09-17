/**
 * Prueba de punta a punta del MODO NUBE contra tu Drive real.
 *
 *   npm run drive:selftest
 *
 * Crea un evento de prueba, sube una foto, la compone con el marco, la modera
 * (aprobar → rechazar → aprobar → impresa) y comprueba que los archivos
 * terminaron en la carpeta correcta de Drive. Al final borra todo lo que creó.
 *
 * Esto es lo que valida que el modo nube funciona. Córrelo DESPUÉS de conectar
 * Drive con `npm run drive:auth` y ANTES de desplegar a Vercel.
 *
 * ── Por qué todo se importa con await import() ──────────────────────────────
 * En un módulo ES, TODOS los `import` se evalúan antes que la primera línea del
 * cuerpo. Los módulos de la app leen KUVA_STORE/KUVA_MEDIA al cargarse, así que
 * si los importáramos arriba con `import ... from`, se inicializarían en modo
 * disco y esta prueba mediría el modo equivocado sin avisar. (Pasó: la primera
 * versión de este archivo daba todo en verde corriendo en local.)
 */
process.env.KUVA_STORE = 'drive';
process.env.KUVA_MEDIA = 'drive';
process.env.DRIVE_ENABLED = 'true';

const sharp = (await import('sharp')).default;
const drive = await import('../src/lib/drive.js');
const driveBackend = await import('../src/lib/driveBackend.js');
const { loadOverlayFrames } = await import('../src/lib/frames/index.js');
const { createEvent } = await import('../src/lib/eventService.js');
const { ingest, approve, reject, markPrinted, feed, queue } = await import('../src/lib/photoService.js');
const { getPhoto, listEvents, DRIVER: STORE_DRIVER } = await import('../src/lib/db.js');
const { DRIVER: MEDIA_DRIVER } = await import('../src/lib/media.js');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

console.log('\n  Prueba del modo nube (Vercel + Drive)\n  ─────────────────────────────────────\n');

if (!drive.authMode()) {
  bad('No hay credenciales de Drive. Corre primero:  npm run drive:auth');
  process.exit(1);
}

// Sin esto la prueba no vale nada: confirmamos que de verdad estamos en modo nube.
if (STORE_DRIVER !== 'drive' || MEDIA_DRIVER !== 'drive') {
  bad(`La prueba no está en modo nube (store=${STORE_DRIVER}, media=${MEDIA_DRIVER}).`);
  process.exit(1);
}
ok(`modo nube activo · store=${STORE_DRIVER} media=${MEDIA_DRIVER} auth=${drive.authMode()}`);

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

const isDriveId = (v) => typeof v === 'string' && v.length > 20 && !v.includes('\\') && !v.includes('/');

/** Cuenta archivos en cada carpeta del evento, que es donde vive el estado. */
async function census(event) {
  const f = await driveBackend.folders(event.folderId);
  const out = {};
  for (const key of ['originals', 'toPrint', 'rejected', 'printed']) {
    const files = await drive.listFiles(`'${f[key]}' in parents and trashed = false`, { fields: 'files(id)' });
    out[key] = files.length;
  }
  return out;
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

let event;

try {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '');
  event = await createEvent({ name: `_PRUEBA KuvaConnect ${stamp}`, moderation: 'pre', fitMode: 'crop' });
  expect(event.folderId, 'el evento no quedó con carpeta de Drive');
  ok(`evento creado en Drive: ${event.name}`);

  const found = (await listEvents()).find((e) => e.id === event.id);
  expect(found, 'el evento no se pudo leer de vuelta desde Drive');
  ok('el evento se lee de vuelta (la carpeta ES el registro)');

  const photo = await ingest(event, {
    buffer: await testPhoto(),
    mimeType: 'image/jpeg',
    device: 'selftest',
    caption: 'Prueba automática',
    author: 'KuvaConnect',
  });
  ok(`foto procesada · #${photo.seq} · ${photo.orientation}/${photo.fitMode} · marco ${photo.frameId}`);

  // Que los archivos sean ids de Drive y no rutas de disco es justo lo que
  // se coló la primera vez que se escribió esta prueba.
  for (const [kind, id] of Object.entries(photo.files)) {
    expect(isDriveId(id), `el archivo ${kind} no es un id de Drive: ${id}`);
  }
  ok('los cinco archivos son ids de Drive, no rutas de disco');

  const back = await getPhoto(photo.id);
  expect(back, 'la foto no se pudo leer de vuelta');
  expect(back.status === 'pending', `estado esperado pending, llegó ${back.status}`);
  expect(back.caption === 'Prueba automática', 'el mensaje no sobrevivió el viaje');
  expect(back.author === 'KuvaConnect', 'el nombre no sobrevivió el viaje');
  expect(back.seq === photo.seq, 'el consecutivo no coincide');
  ok('se lee de vuelta con estado, consecutivo, nombre y mensaje');

  expect((await queue(event.id, { status: 'pending' })).length === 1, 'no aparece en la cola de moderación');
  ok('aparece en la cola de moderación');

  await approve(photo.id);
  expect((await getPhoto(photo.id)).status === 'approved', 'no quedó aprobada');
  let c = await census(event);
  expect(c.originals === 1 && c.toPrint === 1 && c.rejected === 0,
    `tras aprobar: ${JSON.stringify(c)}`);
  expect((await feed(event.id)).some((p) => p.id === photo.id), 'no salió en el feed de la pantalla');
  ok('aprobada · original en 01, impresión en 02, y sale en pantalla');

  await reject(photo.id, 'prueba');
  expect((await getPhoto(photo.id)).status === 'rejected', 'no quedó rechazada');
  c = await census(event);
  expect(c.originals === 0 && c.rejected === 1 && c.toPrint === 0,
    `tras rechazar: ${JSON.stringify(c)}`);
  expect(!(await feed(event.id)).some((p) => p.id === photo.id), 'sigue en el feed tras rechazarla');
  ok('rechazada · original a 03, fuera de la cola de impresión y de la pantalla');

  await approve(photo.id);
  expect((await getPhoto(photo.id)).status === 'approved', 'no se pudo volver a aprobar');
  c = await census(event);
  expect(c.originals === 1 && c.toPrint === 1 && c.rejected === 0,
    `tras re-aprobar: ${JSON.stringify(c)}`);
  ok('re-aprobada · todo vuelve a su sitio');

  await markPrinted(photo.id, true);
  expect((await getPhoto(photo.id)).printedAt, 'no quedó marcada como impresa');
  c = await census(event);
  expect(c.printed === 1 && c.toPrint === 0, `tras marcar impresa: ${JSON.stringify(c)}`);
  ok('marcada como impresa · el archivo pasó a 04_Impresas');

  const img = await driveBackend.readFileById((await getPhoto(photo.id)).files.web);
  const meta = await sharp(img).metadata();
  expect(meta.width > 0, 'la imagen descargada de Drive no es válida');
  ok(`la imagen se descarga de Drive y es válida (${meta.width}x${meta.height})`);

  console.log('\n  \x1b[32mTODO BIEN.\x1b[0m El modo nube funciona contra tu Drive.\n');
} catch (err) {
  bad(err.message);
  if (process.env.DEBUG) console.error(err.stack);
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
