/**
 * Diagnóstico de la conexión con Drive.
 *
 *   npm run drive:check
 *
 * Verifica credenciales, crea (o encuentra) las carpetas del evento activo
 * y sube un archivo de prueba para confirmar que hay permisos de escritura.
 */
import { config } from '../src/config.js';
import * as drive from '../src/lib/drive.js';
import { ensureDefaultEvent } from '../src/lib/eventService.js';
import { queueStats } from '../src/lib/driveSync.js';

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

console.log('\n  Diagnóstico de Google Drive\n  ───────────────────────────\n');

const mode = drive.authMode();
if (!mode) {
  bad('No hay credenciales.');
  info('Para un Drive personal:   npm run drive:auth');
  info('Para una Unidad compartida: pon credentials/service-account.json y DRIVE_SHARED_DRIVE_ID');
  process.exit(1);
}
ok(`Credenciales encontradas (modo ${mode})`);

if (!config.drive.enabled) {
  bad('DRIVE_ENABLED no está en true: el servidor no va a sincronizar.');
  info('Edita .env y pon  DRIVE_ENABLED=true');
} else {
  ok('DRIVE_ENABLED=true');
}

if (mode === 'service-account' && !config.drive.driveId && !config.drive.rootFolderId) {
  bad('Usas service account sin Unidad compartida ni carpeta raíz.');
  info('Una service account no tiene cuota propia: no puede escribir en "Mi unidad".');
  info('Configura DRIVE_SHARED_DRIVE_ID, o mejor usa  npm run drive:auth');
}

try {
  const about = await drive.whoAmI();
  ok(`Cuenta: ${about.user.displayName} <${about.user.emailAddress}>`);
  if (about.storageQuota?.limit) {
    const used = Number(about.storageQuota.usage) / 1e9;
    const limit = Number(about.storageQuota.limit) / 1e9;
    info(`Espacio: ${used.toFixed(1)} GB de ${limit.toFixed(0)} GB`);
  }
} catch (err) {
  bad(`No se pudo consultar la cuenta: ${err.message}`);
  process.exit(1);
}

const event = await ensureDefaultEvent();
info(`Evento de prueba: ${event.name}`);

try {
  const folders = await drive.ensureEventFolders(event);
  ok('Carpetas listas en Drive:');
  info(`  01_Originales      ${folders.originals}`);
  info(`  02_Para_imprimir   ${folders.toPrint}`);
  info(`  03_Rechazadas      ${folders.rejected}`);
  info(`  04_Impresas        ${folders.printed}`);

  const file = await drive.uploadBuffer({
    folderId: folders.originals,
    name: `_kuvaconnect_prueba_${Date.now()}.txt`,
    buffer: Buffer.from('Prueba de escritura de KuvaConnect. Puedes borrar este archivo.'),
    mimeType: 'text/plain',
  });
  ok(`Escritura confirmada — archivo de prueba: ${file.webViewLink}`);
  await drive.deleteFile(file.id);
  ok('Archivo de prueba enviado a la papelera. Todo funciona.');
} catch (err) {
  bad(`Falló la escritura: ${err.message}`);
  if (/storage quota/i.test(err.message)) {
    info('Es el error clásico de service account sin Unidad compartida.');
    info('Solución rápida:  npm run drive:auth  (usa tu cuenta personal).');
  }
  process.exit(1);
}

console.log('\n ', queueStats(), '\n');
