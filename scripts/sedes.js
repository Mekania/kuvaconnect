/**
 * Crea (o revisa) las sedes del evento y reparte sus PIN.
 *
 *   npm run sedes                  → en producción (Drive), crea las que falten
 *   npm run sedes -- --reset-pins  → además genera PIN nuevos para todas
 *   npm run sedes -- --local       → lo mismo pero en el modo evento (portátil)
 *
 * Cada sede es un evento propio: su pantalla, su QR, su carpeta de Drive y su
 * PIN de moderación. Los PIN se guardan solo como hash, así que este script es
 * el ÚNICO momento en que se ven en claro: los imprime y además los deja en
 * credentials/pines-sedes.txt (esa carpeta no va a git).
 *
 * Los eventos viejos sin sede (el "Exprésate 24/7" de las pruebas) se archivan:
 * no se borran, pero dejan de aparecer en el login y en la raíz del sitio.
 *
 * Como en drive-selftest.js, todo se importa con await import() después de fijar
 * el entorno: los módulos leen el modo al cargarse.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCAL = process.argv.includes('--local');
const RESET = process.argv.includes('--reset-pins');
const BASE = (process.argv.find((a) => a.startsWith('--base='))?.slice(7)
  || (LOCAL ? '' : 'https://kuvaconnect.vercel.app')).replace(/\/+$/, '');

if (!LOCAL) {
  process.env.KUVA_STORE = 'drive';
  process.env.KUVA_MEDIA = 'drive';
  process.env.DRIVE_ENABLED = 'true';
}
if (BASE) process.env.PUBLIC_BASE_URL = BASE;

const SEDES = [
  { sede: 'Bogotá', slug: 'bogota' },
  { sede: 'Bucaramanga', slug: 'bucaramanga' },
  { sede: 'Barranquilla', slug: 'barranquilla' },
  { sede: 'Medellín', slug: 'medellin' },
];

const { config, ROOT } = await import('../src/config.js');
const { listEvents, getEvent, updateEvent } = await import('../src/lib/db.js');
const { createEvent } = await import('../src/lib/eventService.js');
const { hashPin } = await import('../src/lib/auth.js');
const { loadOverlayFrames } = await import('../src/lib/frames/index.js');
const { DEFAULTS } = await import('../src/lib/eventService.js');

// Sin esto el marco de OXXO no existe para este proceso (ver createEvent).
loadOverlayFrames();
const { uploadUrl } = await import('../src/routes/api.js');
const { baseUrl } = await import('../src/config.js');

/** PIN de 6 dígitos, distintos entre sí y distintos del maestro. */
const used = new Set([config.adminPin]);
function newPin() {
  let pin;
  do { pin = String(crypto.randomInt(100000, 1000000)); } while (used.has(pin));
  used.add(pin);
  return pin;
}

console.log(`\n  Sedes · ${LOCAL ? 'modo evento (local)' : 'producción (Drive)'}\n  ─────────────────────────────────────\n`);

const rows = [];
for (const s of SEDES) {
  let ev = await getEvent(s.slug);
  let pin = '(sin cambios)';

  if (!ev) {
    pin = newPin();
    ev = await createEvent({
      name: 'Exprésate 24/7',
      sede: s.sede,
      slug: s.slug,
      subtitle: 'Sube tu foto, sal en la pantalla y llévatela impresa',
      hashtag: 'OXXO · Así de fácil',
      fitMode: 'crop',
      pin,
    });
    console.log(`  ✓ creada ${s.sede}`);
  } else if (RESET || !ev.pinHash) {
    pin = newPin();
    ev = await updateEvent(ev.id, { pinHash: hashPin(ev.id, pin), archived: false });
    console.log(`  ✓ PIN nuevo para ${s.sede}`);
  } else {
    console.log(`  · ${s.sede} ya existía`);
  }

  // Revisión: toda sede tiene que llevar el marco oficial de la campaña.
  if (ev.frameId !== DEFAULTS.frameId || ev.fitMode !== 'crop') {
    ev = await updateEvent(ev.id, { frameId: DEFAULTS.frameId, fitMode: 'crop' });
    console.log(`  ✓ ${s.sede}: marco corregido a ${DEFAULTS.frameId}`);
  }

  rows.push({
    sede: s.sede,
    pin,
    pantalla: `${baseUrl()}/d/${ev.slug}`,
    subida: uploadUrl(ev),
  });
}

// Archivar lo que no es una sede (eventos de prueba anteriores).
const slugs = new Set(SEDES.map((s) => s.slug));
for (const ev of await listEvents()) {
  if (!slugs.has(ev.slug) && !ev.archived) {
    await updateEvent(ev.id, { archived: true, active: false });
    console.log(`  · archivado "${ev.name}" (${ev.slug}): ya no aparece en el login`);
  }
}

console.log('');
for (const r of rows) {
  console.log(`  ${r.sede.toUpperCase()}`);
  console.log(`    PIN       ${r.pin}`);
  console.log(`    Pantalla  ${r.pantalla}`);
  console.log(`    Subida    ${r.subida}\n`);
}
console.log(`  Panel (todas)  ${baseUrl()}/admin`);
console.log(`  PIN maestro    el de ADMIN_PIN (entra a cualquier sede y a los ajustes)\n`);

// Los PIN solo se ven aquí: los dejamos en un archivo fuera de git.
if (rows.some((r) => /^\d{6}$/.test(r.pin))) {
  const file = path.join(ROOT, 'credentials', LOCAL ? 'pines-sedes-local.txt' : 'pines-sedes.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const stamp = new Date().toLocaleString('es-CO');
  const block = rows
    .filter((r) => /^\d{6}$/.test(r.pin))
    .map((r) => `${r.sede.padEnd(14)} PIN ${r.pin}   ${r.pantalla}   ${r.subida}`)
    .join('\n');
  fs.writeFileSync(file, `${prev}# ${stamp}\n${block}\n\n`);
  console.log(`  PIN guardados en ${path.relative(ROOT, file)}\n`);
}
