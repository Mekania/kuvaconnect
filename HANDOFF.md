# HANDOFF — KuvaConnect (17-sep-2026, actualizado)

## Qué es
Producto de Kuva (cabinas de fotos). Pantalla con QR + álbum en vivo → invitados suben foto desde el celular → logístico modera en panel → foto se compone con marco 10x15 (1200x1800 @300dpi) para imprimir en DNP → original + enmarcada a Google Drive.
Leer primero: `README.md` (completo) y `assets/frames/LEEME.md`.

## Stack
Node 24 + Express (ESM), sharp, qrcode, googleapis, multer 2. Frontend vanilla sin build. Todo en español.

**Dos modos con el mismo código** (ver `DEPLOY.md`):
- *evento*: `KUVA_STORE=json` + `KUVA_MEDIA=disk`, SSE, cola de Drive en background. Offline.
- *nube*: `KUVA_STORE=drive` + `KUVA_MEDIA=drive` (se activa solo en Vercel), sondeo.

**No hay base de datos.** En modo nube, Drive es almacén y registro a la vez: el estado
de una foto es su carpeta, y su registro son las `appProperties` de su archivo. Ver
`src/lib/driveBackend.js`.

Supabase quedó descartado. En el proyecto **ops-hub** (`oycannpqooiqomfudyna`) hay un
esquema `kuva` y dos buckets `kuva-*` vacíos, creados por error y pendientes de borrar
en cuanto el modo Drive esté probado:
`drop schema kuva cascade;` + borrar los buckets `kuva-public` y `kuva-private`.

## EN PRODUCCIÓN (17-sep-2026)
- Repo: https://github.com/Mekania/kuvaconnect (público, auto-despliega en cada push)
- App:  https://kuvaconnect.vercel.app
  - Pantalla `/d/expresate-24-7` · Celular `/u/expresate-24-7?t=...` · Panel `/admin`
  - PIN de producción distinto al local (está en las variables de entorno de Vercel).
- Drive conectado como info@mekaniads.com, alcance `drive.file`.
- Supabase descartado; el esquema `kuva` de ops-hub ya se eliminó. Quedan dos
  buckets `kuva-public` / `kuva-private` VACÍOS que hay que borrar a mano desde
  el dashboard (Supabase no deja borrarlos por SQL).

**OJO — los dos modos NO comparten fotos.** La configuración del evento sí viaja
por Drive (va en la descripción de la carpeta), pero el registro de las fotos
vive en la base JSON local en modo evento y en las propiedades de los archivos
de Drive en modo nube. Hay que elegir UN modo por evento, no mezclarlos.

## Correr
`npm install && npm start` → consola muestra enlaces. PIN panel `2468` (cambiar en `.env`).
- Pantalla `/d/expresate-24-7` · Celular `/u/<slug>?t=token` · Panel `/admin`
- `npm run frames:preview` → pruebas de los marcos en `data/previews/`

## Estado: MVP COMPLETO y probado E2E
✅ Subida móvil (reescala a 2400px en navegador) · composición con marco (auto crop por atención / fondo difuminado si pierde >34%) · moderación con teclado (A/R/flechas) · cola de impresión · celebración de foto nueva en pantalla · columnas adaptativas · rechazar borra versiones públicas web/thumb · cola Drive con reintentos y backoff (local primero, nube después) · 3 marcos generados por código (classic, noir, polaroid) · soporte marcos PNG del cliente vía `assets/frames/<id>/frame.json`.

## PENDIENTE (depende del usuario)
1. **Publicar repo**: `gh repo create kuvaconnect --public --source=. --remote=origin --push`
2. **Vercel**: `vercel link` + `vercel git connect` + variables de entorno (tabla en `DEPLOY.md`), luego `vercel --prod`.
3. **Probar el modo nube**: `npm run drive:selftest` (después de conectar Drive). Está escrito pero NO ejecutado: no hubo credenciales en la sesión.
4. **Conectar Drive**: cliente OAuth tipo *Aplicación de escritorio* (no pide URIs de redirección, es normal) → `npm run drive:auth` → `DRIVE_ENABLED=true` → `npm run drive:check`. El alcance es `drive.file`, así que NO hay pantalla de "app no verificada".

## YA HECHO en esta sesión
- Marcos reales de OXXO instalados (`assets/frames/oxxo-expresate/`), hueco detectado por canal alfa: vertical `x=63 y=258 1060x1237`, horizontal `x=70 y=121 1627x846`.
- Las tres páginas rediseñadas con la identidad de la campaña.
- Backend refactorizado a async con drivers intercambiables.

## Ideas siguientes (no hechas)
- Probar el modo nube de punta a punta: falta el `SUPABASE_SERVICE_ROLE_KEY`, así que el driver supabase está escrito pero NO ejecutado todavía.
- Probar con celular real en la red del salón.
- Borrar/ocultar evento, impresión directa a DNP, moderación automática (IA).
- Marcos generados (classic/noir/polaroid) siguen disponibles como respaldo.

## Mapa de código
`src/lib/photoService.js` pipeline y estados · `compose.js` imagen · `frames/index.js` marcos · `drive.js` + `driveSync.js` Drive · `routes/api.js` público · `routes/admin.js` panel · `public/{display,upload,admin}` UI.

## Preferencias del usuario
Español, autonomía alta: decidir, documentar el porqué y entregar funcionando en vez de preguntar.
