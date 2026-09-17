# Publicar KuvaConnect

KuvaConnect corre en dos modos con **el mismo código**. Lo eligen dos variables:

| | `KUVA_STORE` | `KUVA_MEDIA` | Cuándo |
|---|---|---|---|
| **Modo evento** | `json` | `disk` | En el portátil del salón. No necesita internet. |
| **Modo nube** | `drive` | `drive` | En Vercel, con URL pública fija. |

En Vercel se activa solo (detecta la variable `VERCEL`). En tu máquina corre el
modo evento por defecto con `npm start`.

**No hay base de datos.** En el modo nube, Google Drive es el almacén *y* el
registro. Eso es todo lo que hay que conectar.

---

## Cómo Drive hace de base de datos

```
KuvaConnect/
  <Nombre del evento>/          ← la descripción de la carpeta es la config del evento
    01_Originales/              ← el original; sus propiedades son el registro de la foto
    02_Para_imprimir/           ← con marco a 300 dpi: la cola de impresión
    03_Rechazadas/              ← originales bloqueados en moderación
    04_Impresas/                ← ya salieron por la impresora
    _sistema/                   ← derivados que solo usa la app
```

Tres ideas sostienen esto:

- **El estado de moderación es la carpeta.** Aprobar mueve la impresión a
  `02_Para_imprimir`; rechazar mueve el original a `03_Rechazadas`. El logístico
  ve el estado correcto en Drive sin abrir la app.
- **El registro de la foto son las `appProperties` de su archivo**: estado,
  consecutivo, orientación, marco, y los ids de sus derivados. Lo que no cabe
  ahí (nombre y mensaje) va en la descripción del archivo.
- **Cada foto es un archivo independiente**, así que dos personas moderando a la
  vez no se pisan. No hay un JSON central que se corrompa.

El feed de la pantalla es un solo `files.list` sobre la carpeta del evento.

---

## Lo que falta (necesita tus manos)

### 1. Conectar Drive

Ver la sección *Conectar Google Drive* del [README](README.md). Resumen:
cliente OAuth tipo **Aplicación de escritorio** (ese tipo no pide URIs de
redirección, es normal) → `npm run drive:auth`.

### 2. Probar el modo nube contra tu Drive real

```bash
npm run drive:selftest
```

Crea un evento de prueba, sube una foto, la compone con el marco, la aprueba,
la rechaza, la vuelve a aprobar, la marca como impresa, comprueba que los
archivos quedaron en la carpeta correcta y **borra todo al terminar**.

Si esto pasa, el modo nube funciona. Si falla, no despliegues todavía.

### 3. Publicar el repo

```bash
gh repo create kuvaconnect --public --source=. --remote=origin --push
```

> El repo incluye el arte de la campaña de OXXO (`assets/frames/oxxo-expresate/`)
> y el logo. Si el cliente no autorizó publicarlo, cambia `--public` por
> `--private`.

### 4. Vercel desde ese repo

```bash
vercel link
vercel git connect
```

### 5. Variables de entorno en Vercel

**Project → Settings → Environment Variables** (Production y Preview):

| Variable | Valor | De dónde sale |
|---|---|---|
| `ADMIN_PIN` | el PIN del panel | tú lo eliges. **No dejes el 2468** |
| `SESSION_SECRET` | cadena larga al azar | `openssl rand -base64 32` |
| `PUBLIC_BASE_URL` | `https://<tu-dominio>.vercel.app` | la URL que te dé Vercel |
| `DRIVE_ENABLED` | `true` | |
| `GOOGLE_OAUTH_CLIENT_ID` | del `oauth-client.json` | |
| `GOOGLE_OAUTH_CLIENT_SECRET` | del `oauth-client.json` | |
| `GOOGLE_OAUTH_TOKEN_JSON` | el contenido completo de `credentials/oauth-token.json`, en una línea | lo genera `drive:auth` |

`PUBLIC_BASE_URL` importa: es lo que se codifica en el QR. Si queda vacío, el QR
apuntaría a una IP local que desde un celular no existe.

El `refresh_token` de Google no rota, así que vive bien dentro de una variable
de entorno. Autorizas una vez en tu máquina y pegas el JSON en Vercel.

### 6. Desplegar y comprobar

```bash
vercel --prod
curl https://<tu-dominio>.vercel.app/health
```

Debe responder `store.driver: "drive"`, `media.driver: "drive"` y `ready: true`.

---

## Lo que cambia al correr en la nube

No son ajustes de configuración: son consecuencias de que no haya proceso vivo
ni disco entre peticiones.

- **No hay SSE.** La pantalla y el panel sondean cada 3–4 segundos. No se nota,
  pero ya no es instantáneo.
- **Las imágenes las sirve una función**, no un CDN. La primera carga de la
  pantalla tarda más (unos 400–800 ms por foto); después el navegador las
  cachea y no vuelve a pedirlas.
- **Drive pasa a ser crítico para la pantalla**, no solo para el archivo. Si
  Drive se pone lento, la pantalla se pone lenta. En modo evento eso no pasa.
- **La foto del celular va a 2400 px**, no 3000: el límite de tamaño de petición
  de Vercel es 4,5 MB y no se puede subir. Para imprimir sobra, el hueco del
  marco son 1060×1237 px.
- **`Regenerar todas las impresiones`** espera a terminar antes de responder,
  porque la función muere al responder. Con muchas fotos puede acercarse al
  límite de 60 s.

## Lo que no cambia

El **modo evento** sigue intacto. Si el día del evento prefieres no depender del
internet del salón, `npm start` en el portátil corre todo en local, con SSE
instantáneo y la cola de Drive en segundo plano. Misma base de código, mismo
marco, mismo panel.
