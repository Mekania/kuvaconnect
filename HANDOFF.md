# HANDOFF — KuvaConnect (17-sep-2026)

## Qué es
Producto de Kuva (cabinas de fotos). Pantalla con QR + álbum en vivo → invitados suben foto desde el celular → logístico modera en panel → foto se compone con marco 10x15 (1200x1800 @300dpi) para imprimir en DNP → original + enmarcada a Google Drive.
Leer primero: `README.md` (completo) y `assets/frames/LEEME.md`.

## Stack
Node 24 + Express (ESM), sharp (composición, HEIC OK), qrcode, googleapis, multer 2. Frontend vanilla sin build. BD = JSON (`data/*.json`). Live = SSE. Todo en español.

## Correr
`npm install && npm start` → consola muestra enlaces. PIN panel `2468` (cambiar en `.env`).
- Pantalla `/d/evento-demo-kuva` · Celular `/u/<slug>?t=token` · Panel `/admin`
- `npm run frames:preview` → 12 pruebas en `data/previews/`

## Estado: MVP COMPLETO y probado E2E
✅ Subida móvil (reescala a 3000px en navegador) · composición con marco (auto crop por atención / fondo difuminado si pierde >34%) · moderación con teclado (A/R/flechas) · cola de impresión · celebración de foto nueva en pantalla · columnas adaptativas · rechazar borra versiones públicas web/thumb · cola Drive con reintentos y backoff (local primero, nube después) · 3 marcos generados por código (classic, noir, polaroid) · soporte marcos PNG del cliente vía `assets/frames/<id>/frame.json`.

## PENDIENTE (depende del usuario)
1. **Conectar Drive**: guardar `credentials/oauth-client.json` (OAuth app de escritorio, Drive API habilitada) → `npm run drive:auth` → `.env DRIVE_ENABLED=true` → `npm run drive:check`. NO usar service account en Drive personal (sin cuota).
2. **Marco real** del diseñador: PNG 1200x1800 y 1800x1200 con hueco transparente.

## Ideas siguientes (no hechas)
- Sesiones del panel persistentes (hoy en memoria, se pierden al reiniciar).
- Probar con celular real en la red del salón; túnel `npx cloudflared tunnel --url http://localhost:3000` + `PUBLIC_BASE_URL`.
- Borrar/ocultar evento, impresión directa a DNP, moderación automática (IA).
- No hay git inicializado todavía.

## Mapa de código
`src/lib/photoService.js` pipeline y estados · `compose.js` imagen · `frames/index.js` marcos · `drive.js` + `driveSync.js` Drive · `routes/api.js` público · `routes/admin.js` panel · `public/{display,upload,admin}` UI.

## Preferencias del usuario
Español, autonomía alta: decidir, documentar el porqué y entregar funcionando en vez de preguntar.
