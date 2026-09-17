/**
 * Punto de entrada en Vercel.
 *
 * Aquí solo llegan /api/* y /media/*: las páginas y los archivos estáticos los
 * sirve Vercel directo desde public/ por CDN (ver vercel.json), sin invocar
 * ninguna función.
 *
 * Una función serverless arranca en frío, atiende y muere. Por eso:
 *   · los marcos PNG se cargan en cada arranque (leer dos archivos del bundle),
 *   · el evento por defecto se asegura una sola vez por instancia,
 *   · no hay timers ni estado en memoria que sobreviva entre peticiones.
 */
import { app, bootstrapFrames } from '../src/server.js';
import { ensureDefaultEvent } from '../src/lib/eventService.js';
import { logger } from '../src/lib/logger.js';

const log = logger('vercel');

let ready = null;

function init() {
  ready ||= (async () => {
    bootstrapFrames();
    try {
      const ev = await ensureDefaultEvent();
      log.ok(`instancia lista · evento activo: ${ev.name}`);
    } catch (err) {
      // No tumbamos la función: /health tiene que poder explicar qué falta.
      log.error(`no se pudo preparar el evento: ${err.message}`);
    }
  })();
  return ready;
}

export default async function handler(req, res) {
  await init();
  return app(req, res);
}
