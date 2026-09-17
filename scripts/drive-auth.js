/**
 * Conecta KuvaConnect con TU Google Drive (cuenta personal o de Workspace).
 *
 *   npm run drive:auth
 *
 * Qué hace: levanta un servidor local, te da un link de Google, y cuando
 * autorizas guarda el token en credentials/oauth-token.json.
 * Solo se hace una vez por computador.
 *
 * Antes necesitas credentials/oauth-client.json — el README explica cómo
 * sacarlo de Google Cloud Console en cinco minutos.
 */
import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { oauthClient, saveToken, SCOPES, resetClient, getDrive } from '../src/lib/drive.js';

const CLIENT_FILE = path.join(ROOT, 'credentials', 'oauth-client.json');

if (!fs.existsSync(CLIENT_FILE) && !process.env.GOOGLE_OAUTH_CLIENT_ID) {
  console.error(`
  Falta el archivo de cliente OAuth.

  1. Entra a  https://console.cloud.google.com/apis/credentials
  2. Crea un proyecto (o usa uno que ya tengas).
  3. Habilita la "Google Drive API".
  4. Crea credenciales → "ID de cliente de OAuth" → tipo "Aplicación de escritorio".
  5. Descarga el JSON y guárdalo como:
       ${CLIENT_FILE}

  Después vuelve a correr:  npm run drive:auth
`);
  process.exit(1);
}

const client = oauthClient();
const redirect = new URL(client.redirectUri || 'http://localhost:53682/oauth2callback');
const port = Number(redirect.port || 53682);

const authUrl = client.generateAuthUrl({
  access_type: 'offline',      // necesitamos refresh_token para que no caduque a mitad de evento
  prompt: 'consent',
  scope: SCOPES,
});

console.log(`
  ─────────────────────────────────────────────────────────────
   Conectar KuvaConnect con Google Drive
  ─────────────────────────────────────────────────────────────

   1. Abre este link en tu navegador (inicia sesión con la cuenta
      de Drive donde quieres que queden las fotos):

${authUrl}

   2. Acepta los permisos.
   3. Esta ventana se cierra sola cuando termine.

  Esperando autorización en ${redirect.origin}…
`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirect.origin);
  if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  const page = (title, body, color) => `<!doctype html><meta charset="utf-8">
    <body style="font-family:system-ui;background:#0B0B0F;color:#F6F1E6;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
      <div><h1 style="color:${color};font-weight:400">${title}</h1><p style="opacity:.7">${body}</p></div>`;

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('No se autorizó', error || 'No llegó el código de Google.', '#E0574F'));
    console.error(`\n  Autorización cancelada: ${error || 'sin código'}\n`);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await client.getToken(code);
    saveToken(tokens);
    resetClient();

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('¡Drive conectado!', 'Ya puedes cerrar esta pestaña y volver a la terminal.', '#C8A24A'));

    const drive = getDrive();
    const { data } = await drive.about.get({ fields: 'user(displayName,emailAddress)' });
    console.log(`
  ✓ Conectado como ${data.user.displayName} <${data.user.emailAddress}>
    Token guardado en credentials/oauth-token.json

  Último paso: en el archivo .env pon
      DRIVE_ENABLED=true

  Y reinicia el servidor. Las fotos que ya estén guardadas suben solas.
`);
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Algo falló', err.message, '#E0574F'));
    console.error(`\n  Error al canjear el código: ${err.message}\n`);
    server.close();
    process.exit(1);
  }
});

server.listen(port);
