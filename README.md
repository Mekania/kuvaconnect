# KuvaConnect

Pantalla de evento con QR + subida desde el celular + moderación + impresión con
marco. Producto de **Kuva** (cabinas de fotos).

La gente escanea un QR en la pantalla, sube una foto desde su celular, y la foto
aparece en vivo en el álbum de la pantalla. En paralelo, el logístico de Kuva la
modera desde un panel y se lleva el archivo listo para imprimir en 10×15 cm con
el marco del evento. Todo queda respaldado en Google Drive.

---

## Arrancar en 60 segundos

```bash
npm install
npm start
```

La terminal imprime los tres enlaces que necesitas:

```
  KUVACONNECT · Evento Demo Kuva

  Pantalla (proyector / cabina)   http://192.168.1.6:3000/d/evento-demo-kuva
  Panel de moderación             http://192.168.1.6:3000/admin
  Link del QR (celulares)         http://192.168.1.6:3000/u/evento-demo-kuva?t=...

  PIN del panel: 2468
```

Abre la **pantalla** en el monitor del evento (F11 para pantalla completa) y el
**panel** en el portátil del logístico. Los celulares tienen que estar en la
misma red Wi-Fi que este equipo; el QR ya apunta a la IP correcta.

> El PIN por defecto es `2468`. **Cámbialo antes de un evento real**: copia
> `.env.example` a `.env` y edita `ADMIN_PIN`.

---

## Cómo funciona, de punta a punta

```
  Celular del invitado
        │  elige foto  →  el navegador la reescala a 3000px y la manda como JPEG
        ▼
  POST /api/event/:id/upload
        │
        ├─ guarda el ORIGINAL en disco                      data/media/<evento>/orig/
        ├─ analiza (brillo, resolución, entropía → flags)
        ├─ COMPONE la copia impresa: foto + marco, 1200×1800 @300dpi
        ├─ genera derivados web (pantalla, panel, miniatura)
        ├─ registra la foto como "pendiente" (o "aprobada" si la moderación es post)
        └─ encola las subidas a Drive
        │
        ▼
  Panel de moderación  ──aprobar──►  la foto sale en la PANTALLA (evento SSE en vivo)
                                     y entra a la COLA DE IMPRESIÓN
                       ──rechazar─►  desaparece de la pantalla y el original se
                                     mueve a 03_Rechazadas en Drive
```

Nada de esto espera a Google Drive. **Primero disco, después la nube.** Si el
wifi del salón se cae, el evento sigue funcionando y las fotos suben solas
cuando vuelve la conexión.

---

## Las tres pantallas

### 1. La pantalla del evento — `/d/<slug>`

QR grande arriba, álbum que va creciendo abajo. Cada foto nueva aparece en
grande unos segundos ("celebración") y luego se acomoda en el mosaico.

- Funciona en horizontal (proyector, TV) y en vertical (cabina espejada, tótem).
- El número de columnas se ajusta solo: con pocas fotos las muestra grandes y
  centradas, y va abriendo el mosaico a medida que llega gente.
- Se reconecta sola si se cae la red, y pide `wakeLock` para que el monitor no
  se apague.
- **Solo muestra fotos aprobadas.** Las pendientes ni siquiera viajan por este
  canal.

### 2. El celular del invitado — `/u/<slug>`

Elegir foto → revisar → nombre y mensaje (opcionales) → enviar → confirmación
con la foto ya enmarcada.

La foto se reescala en el navegador antes de subir. Esto resuelve tres cosas de
una: el wifi del salón no se satura, el HEIC del iPhone queda convertido a JPEG,
y 3000 px sobra para imprimir a 10×15 (el lienzo final son 1800 px).

Si la foto quedó en revisión, el celular avisa solo cuando el moderador la
aprueba.

### 3. El panel del logístico — `/admin`

- **Moderar** — las pendientes, con el original sin marco. Se opera con teclado:
  `←` `→` para moverse, `A` aprobar, `R` rechazar, `Enter` para ampliar.
  En la ampliación se ve lado a lado el original y cómo va a salir impreso.
- **Cola de impresión** — las aprobadas que faltan por imprimir, con botón de
  descarga del JPEG a 300 dpi y "marcar como impresa".
- **Todas** — histórico con filtros por estado.
- **Ajustes del evento** — nombre, fecha, hashtag, marco, modo de moderación,
  límite de fotos por celular, abrir/cerrar subidas, enlaces y QR descargable.
- **Drive y sistema** — estado de la conexión, cola pendiente, sincronizar ahora.

---

## Los marcos

Vienen tres marcos listos, dibujados por código (no hacen falta archivos):

| id | Cuándo usarlo |
|---|---|
| `kuva-classic` | Passepartout marfil con filete dorado. Neutro, combina con cualquier marca. |
| `kuva-noir` | Fondo tinta con borde dorado. Eventos de noche, galas, lanzamientos. |
| `kuva-polaroid` | Borde blanco ancho abajo, estilo instantánea. Fácil de firmar con marcador. |

Se ven en **Panel → Ajustes del evento → Marco de impresión**, con vista previa
sobre una foto de muestra.

Para ver los doce casos (3 marcos × 4 proporciones de entrada) generados como
archivos:

```bash
npm run frames:preview     # escribe en data/previews/
```

### Cuando llegue el marco real del cliente

No hay que tocar código. Instrucciones completas en
[`assets/frames/LEEME.md`](assets/frames/LEEME.md). Resumen: dos PNG con el
hueco transparente (1200×1800 y 1800×1200), un `frame.json` con las coordenadas
del hueco, y reiniciar.

### Cómo se adapta una foto de celular al formato postal

El lienzo de impresión es **1200×1800 px** = 4×6 pulgadas a 300 dpi, que es el
"10×15" que imprime una DNP. Horizontal es 1800×1200.

- Si la foto es vertical usa el marco vertical; si es horizontal, el horizontal.
  Lo decide sola con la orientación EXIF ya aplicada.
- Para meterla en el hueco hay dos modos, y por defecto (`auto`) elige el mejor:
  - **recortar a llenar** — centrado por "atención" (sharp busca la zona con más
    información, normalmente las caras). Es lo que se usa casi siempre.
  - **foto completa con fondo difuminado** — se activa sola cuando recortar
    perdería más del 34% de la imagen (panorámicas, formatos raros).

Un 9:16 de celular pierde ~28% al recortar: se ve bien impreso, así que se
recorta. Una panorámica 3:1 perdería 60% y ahí entra el fondo difuminado.

Los dos modos se pueden forzar desde **Ajustes → Cómo encajar la foto**.

---

## Conectar Google Drive

**Esto es lo único que falta por hacer.** Mientras tanto el sistema funciona
completo: todo se guarda en `data/media/` y queda encolado. En cuanto conectes
Drive, sube solo — incluidas las fotos de prueba que ya están.

Hay dos caminos. **Para un Drive personal (@gmail.com) usa el A.**

### A. OAuth con tu propia cuenta — recomendado

1. Entra a <https://console.cloud.google.com/apis/credentials>
2. Crea un proyecto (o usa uno existente).
3. Habilita la **Google Drive API**.
4. Credenciales → *Crear credenciales* → **ID de cliente de OAuth** → tipo
   **Aplicación de escritorio**.
5. Descarga el JSON y guárdalo como `credentials/oauth-client.json`.
6. Corre:

   ```bash
   npm run drive:auth
   ```

   Te da un link, autorizas con la cuenta de Drive donde quieres las fotos, y el
   token queda guardado. Es una sola vez por computador.

7. En `.env` pon `DRIVE_ENABLED=true` y reinicia.
8. Verifica:

   ```bash
   npm run drive:check
   ```

### B. Service Account — solo con Unidad compartida de Workspace

Una service account **no tiene cuota de almacenamiento propia**, así que no
puede escribir en "Mi unidad" aunque le compartas la carpeta: Google responde
`Service Accounts do not have storage quota`. Solo sirve si el destino es una
**Unidad compartida**.

1. Crea la service account, descarga su JSON como
   `credentials/service-account.json`.
2. Comparte la Unidad compartida con el email de la service account, como Editor.
3. En `.env`: `DRIVE_ENABLED=true` y `DRIVE_SHARED_DRIVE_ID=<id de la unidad>`.

### Qué estructura se crea en Drive

```
KuvaConnect/
└── <Nombre del evento>/
    ├── 01_Originales       ← todo lo que sube la gente, tal cual llegó
    ├── 02_Para_imprimir    ← aprobadas y con marco: esta es la cola de impresión
    ├── 03_Rechazadas       ← lo que se bloqueó en moderación
    └── 04_Impresas         ← ya salieron por la DNP
```

Los nombres llevan el consecutivo del evento por delante (`0007_A3KD9XQ2_V.jpg`),
así que la carpeta se ordena sola y el número coincide con el `#007` que muestra
el panel. La `V` o `H` al final dice si es vertical u horizontal, para que quien
imprime sepa cómo cargar el papel sin abrir el archivo.

Si prefieres colgar todo de una carpeta que ya tienes, pon su ID en
`DRIVE_ROOT_FOLDER_ID`.

---

## Que los celulares lleguen al servidor

Por defecto el QR apunta a la IP de tu red local (ej. `192.168.1.6:3000`), lo
cual funciona si los invitados están en el mismo wifi.

Si necesitas que funcione desde datos móviles o si la red del salón aísla los
dispositivos entre sí (muchos hoteles lo hacen), levanta un túnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Copia la URL `https://…trycloudflare.com` en `.env` como `PUBLIC_BASE_URL` y
reinicia. El QR se regenera apuntando ahí.

**Pruébalo antes del evento, no el mismo día.**

---

## Checklist de montaje

- [ ] `.env` con `ADMIN_PIN` propio (no el 2468 de fábrica).
- [ ] Evento creado con su nombre, fecha y hashtag reales (Panel → Ajustes).
- [ ] Marco elegido y revisado en la vista previa.
- [ ] Drive conectado y `npm run drive:check` en verde.
- [ ] Prueba real: subir desde un celular ajeno conectado al wifi del salón.
- [ ] Imprimir una foto de prueba en la DNP y revisar márgenes.
- [ ] Pantalla en modo pantalla completa (F11) y equipo con la suspensión desactivada.
- [ ] Decidir el modo de moderación: `pre` (revisar antes) o `post` (sale de una).

---

## Configuración (`.env`)

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor. |
| `ADMIN_PIN` | `2468` | PIN del panel. **Cámbialo.** |
| `PUBLIC_BASE_URL` | *(vacío)* | URL que va en el QR. Vacío = IP de la LAN. |
| `MAX_UPLOAD_MB` | `25` | Tamaño máximo por foto. |
| `MAX_PER_DEVICE` | `12` | Fotos por celular (también se edita por evento). |
| `DRIVE_ENABLED` | `false` | Enciende la sincronización con Drive. |
| `DRIVE_ROOT_FOLDER_ID` | *(vacío)* | Carpeta raíz existente en Drive. |
| `DRIVE_SHARED_DRIVE_ID` | *(vacío)* | Solo para Unidades compartidas. |
| `DRIVE_SYNC_INTERVAL_MS` | `15000` | Cada cuánto drena la cola. |
| `PRINT_DPI` | `300` | Densidad que se marca en el JPEG de impresión. |

---

## Estructura del proyecto

```
src/
  server.js              arranque, rutas de páginas, servidor de archivos
  config.js              configuración y detección de IP local
  routes/
    api.js               API pública: evento, feed, QR, subida, SSE
    admin.js             API del panel: moderación, ajustes, marcos, Drive
  lib/
    photoService.js      el pipeline de una foto y sus cambios de estado
    compose.js           motor de imagen: encaje en el marco y derivados
    frames/index.js      registro de marcos (generados y por PNG)
    drive.js             cliente de Google Drive (OAuth y service account)
    driveSync.js         cola de sincronización con reintentos
    eventService.js      eventos: crear, activar, metadatos del marco
    media.js             archivos en disco
    db.js                almacén JSON con escritura atómica
    bus.js               eventos en vivo (SSE)
    auth.js              candado del panel
public/
  display/  upload/  admin/  shared/
scripts/
  drive-auth.js          conectar Drive (una vez)
  drive-check.js         diagnóstico de Drive
  preview-frames.js      generar pruebas de los marcos
data/                    fotos, base de datos y logs (no se versiona)
assets/frames/           aquí va el arte final del cliente
```

---

## Notas y límites conocidos

- **La sesión del panel vive en memoria.** Si reinicias el servidor hay que
  volver a poner el PIN. Toma dos segundos, pero que no te sorprenda.
- **La base de datos es JSON.** Sobra para un evento (cientos o miles de fotos).
  Si algún día KuvaConnect corre varios eventos grandes en simultáneo, se cambia
  `lib/db.js` por SQLite sin tocar el resto.
- **La "original" que llega a Drive es la reescalada a 3000 px**, no el archivo
  crudo del celular. Es intencional: el wifi de un evento no aguanta 8 MB por
  foto y 3000 px sobra para imprimir. Si algún cliente pide el archivo íntegro,
  se sube `MAX_EDGE` en `public/upload/upload.js`.
- **La moderación es humana.** Hay señales automáticas (muy oscura, quemada,
  casi vacía, baja resolución) que se muestran como etiquetas para priorizar,
  pero nada bloquea solo. Para un evento con público abierto conviene dejar la
  moderación en `pre`.
- **Un solo evento activo a la vez** en la práctica, aunque el modelo de datos ya
  soporta varios y el panel permite crearlos y cambiar entre ellos.
