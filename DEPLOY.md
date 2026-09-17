# Publicar KuvaConnect

KuvaConnect corre en dos modos con **el mismo código**. Lo eligen dos variables:

| | `KUVA_STORE` | `KUVA_MEDIA` | Cuándo |
|---|---|---|---|
| **Modo evento** | `json` | `disk` | En el portátil del salón. No necesita internet. |
| **Modo nube** | `supabase` | `supabase` | En Vercel, con URL pública fija. |

En Vercel se activa solo (detecta la variable `VERCEL`). En tu máquina, el
modo evento es el que corre por defecto con `npm start`.

---

## Lo que ya está hecho

- Esquema `kuva` creado en el proyecto Supabase **ops-hub** (`oycannpqooiqomfudyna`),
  con las tablas `events` y `photos` y sus índices.
- Buckets de Storage creados:
  - `kuva-public` — las versiones web y miniatura, que ya pasaron moderación.
    Público, para que la pantalla las sirva por CDN sin invocar una función.
  - `kuva-private` — original, vista de moderación y archivo de impresión.
    Privado; el panel los recibe a través de `/media`, donde la regla de acceso
    la aplicamos nosotros.
- `api/index.js` y `vercel.json` listos.
- Repo git local con dos commits, sin credenciales ni fotos.

## Lo que falta (necesita tus manos)

### 1. Publicar el repo

```bash
gh repo create kuvaconnect --public --source=. --remote=origin --push
```

> El repo incluye el arte de la campaña de OXXO (`assets/frames/oxxo-expresate/`)
> y el logo. Si el cliente no autorizó publicarlo, hazlo privado cambiando
> `--public` por `--private`, o sácalo del repo antes de publicar.

### 2. Crear el proyecto en Vercel desde ese repo

```bash
vercel link
```

Y luego conecta el repo para que cada push despliegue solo:

```bash
vercel git connect
```

### 3. Variables de entorno en Vercel

En **Project → Settings → Environment Variables** (Production y Preview):

| Variable | Valor | De dónde sale |
|---|---|---|
| `SUPABASE_URL` | `https://oycannpqooiqomfudyna.supabase.co` | ya lo sabes |
| `SUPABASE_SERVICE_ROLE_KEY` | *(secreto)* | Supabase → Project Settings → API Keys → `service_role` |
| `ADMIN_PIN` | el PIN del panel | tú lo eliges. **No dejes el 2468** |
| `SESSION_SECRET` | cadena larga al azar | `openssl rand -base64 32` |
| `PUBLIC_BASE_URL` | `https://<tu-dominio>.vercel.app` | la URL que te dé Vercel |

`PUBLIC_BASE_URL` importa: es lo que se codifica en el QR. Si queda vacío, el
QR apuntaría a una IP local que desde un celular no existe.

Para Drive, además:

| Variable | Valor |
|---|---|
| `DRIVE_ENABLED` | `true` |
| `GOOGLE_OAUTH_CLIENT_ID` | del `oauth-client.json` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | del `oauth-client.json` |
| `GOOGLE_OAUTH_TOKEN_JSON` | el contenido completo de `credentials/oauth-token.json`, en una línea |

El `refresh_token` de Google no rota, así que vive bien dentro de una variable
de entorno. Autorizas una vez en tu máquina con `npm run drive:auth` y pegas el
JSON resultante en Vercel.

### 4. Desplegar

```bash
vercel --prod
```

### 5. Comprobar

```bash
curl https://<tu-dominio>.vercel.app/health
```

Debe responder con `store.driver: "supabase"`, `media.driver: "supabase"` y
`ready: true` en ambos.

---

## Lo que cambia al correr en la nube

Estas no son limitaciones de Vercel que se puedan configurar: son consecuencias
de que no haya un proceso vivo ni disco entre peticiones.

- **No hay SSE.** La pantalla y el panel sondean el servidor cada 3–4 segundos.
  En la práctica no se nota, pero ya no es instantáneo.
- **La cola de Drive no corre sola.** Se drena cuando apruebas una foto y con el
  botón *Sincronizar ahora* del panel. En modo evento sí hay un ciclo de fondo
  cada 15 s.
- **La foto que sube el celular va a 2400 px**, no 3000. El límite de tamaño de
  petición de Vercel es 4,5 MB y no se puede subir. Para imprimir sobra: el
  hueco del marco son 1060×1237 px.
- **`Regenerar todas las impresiones`** ahora espera a terminar antes de
  responder, porque la función muere al responder. Con muchas fotos puede
  acercarse al límite de 60 s.

## Lo que sigue siendo cierto

El **modo evento** no desapareció. Si el día del evento prefieres no depender del
internet del salón, `npm start` en el portátil sigue corriendo todo en local con
SSE instantáneo y cola de Drive en segundo plano. Es la misma base de código.
