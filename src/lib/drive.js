import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { config, ROOT } from '../config.js';
import { logger } from './logger.js';

const log = logger('drive');

/**
 * Alcance de permisos.
 *
 * Por defecto pedimos `drive.file`: la app solo ve y toca los archivos y
 * carpetas que ella misma crea. Es todo lo que KuvaConnect necesita (crea la
 * carpeta del evento y sube ahí), y tiene dos ventajas grandes:
 *   · Google NO lo considera un permiso sensible, así que no hay pantalla de
 *     "app no verificada" ni proceso de verificación.
 *   · Si algún día se filtra el token, no da acceso al resto de tu Drive.
 *
 * Si necesitas colgar las fotos dentro de una carpeta que YA existe y que no
 * creó la app (DRIVE_ROOT_FOLDER_ID), pon DRIVE_FULL_ACCESS=true: ahí sí hace
 * falta el permiso completo. Si cambias esto, hay que volver a autorizar.
 */
const FULL = ['1', 'true', 'yes', 'si'].includes(String(process.env.DRIVE_FULL_ACCESS || '').toLowerCase());
export const SCOPES = [FULL
  ? 'https://www.googleapis.com/auth/drive'
  : 'https://www.googleapis.com/auth/drive.file'];
const TOKEN_FILE = path.join(ROOT, 'credentials', 'oauth-token.json');
const OAUTH_CLIENT_FILE = path.join(ROOT, 'credentials', 'oauth-client.json');

/* ────────────────────────────── autenticación ────────────────────────────── */

/**
 * Dos caminos, según qué tipo de Drive uses:
 *
 *  A) OAuth de usuario  → para un Drive personal (@gmail.com).
 *     Las fotos quedan en TU Drive, con tu cuota. Es lo normal para este caso.
 *     Config: credentials/oauth-client.json + `npm run drive:auth`.
 *
 *  B) Service Account   → solo sirve con Unidades compartidas (Workspace).
 *     Una service account no tiene cuota propia, así que no puede escribir en
 *     "Mi unidad": si la usas, el destino debe ser una Unidad compartida.
 *     Config: credentials/service-account.json + DRIVE_SHARED_DRIVE_ID.
 */
/**
 * En la nube no hay disco donde dejar credenciales, asi que todo puede venir
 * por variables de entorno. El token de OAuth guarda un refresh_token que NO
 * caduca ni rota, asi que vive bien dentro de una env var de Vercel.
 */
function hasFileToken() { return fs.existsSync(TOKEN_FILE); }
function hasEnvToken() { return Boolean(process.env.GOOGLE_OAUTH_TOKEN_JSON); }
function hasClient() {
  return fs.existsSync(OAUTH_CLIENT_FILE) || Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID);
}

export function authMode() {
  if ((hasEnvToken() || hasFileToken()) && hasClient()) return 'oauth';
  if (config.drive.credentialsJSON || fs.existsSync(config.drive.credentialsFile)) return 'service-account';
  return null;
}

function readToken() {
  if (hasEnvToken()) return JSON.parse(process.env.GOOGLE_OAUTH_TOKEN_JSON);
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

export function oauthClient() {
  let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  let redirect = process.env.GOOGLE_OAUTH_REDIRECT || 'http://localhost:53682/oauth2callback';

  if ((!clientId || !clientSecret) && fs.existsSync(OAUTH_CLIENT_FILE)) {
    const raw = JSON.parse(fs.readFileSync(OAUTH_CLIENT_FILE, 'utf8'));
    const c = raw.installed || raw.web || raw;
    clientId = clientId || c.client_id;
    clientSecret = clientSecret || c.client_secret;
    // Solo un cliente de tipo "web" trae una URI de redirección que sirva. Los
    // de escritorio traen "http://localhost" sin puerto, y Google acepta
    // cualquier puerto de loopback para ese tipo, así que usamos el nuestro.
    if (raw.web && c.redirect_uris?.length && !process.env.GOOGLE_OAUTH_REDIRECT) {
      redirect = c.redirect_uris.find((u) => u.includes('oauth2callback')) || c.redirect_uris[0];
    }
  }
  if (!clientId || !clientSecret) throw new Error('Falta el cliente OAuth (credentials/oauth-client.json)');
  return new google.auth.OAuth2(clientId, clientSecret, redirect);
}

export function saveToken(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

let cachedDrive = null;

export function getDrive() {
  if (cachedDrive) return cachedDrive;
  const mode = authMode();
  if (!mode) return null;

  let auth;
  if (mode === 'oauth') {
    auth = oauthClient();
    auth.setCredentials(readToken());
    auth.on('tokens', (t) => {
      // Google solo manda refresh_token la primera vez: conservamos el que ya
      // tenemos. En la nube no hay donde escribir, y tampoco hace falta: el
      // access_token se renueva en memoria en cada arranque de la funcion.
      if (hasEnvToken()) return;
      try {
        const prev = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        saveToken({ ...prev, ...t });
      } catch { /* sin disco de escritura: seguimos con el token en memoria */ }
    });
  } else {
    const creds = config.drive.credentialsJSON
      ? JSON.parse(config.drive.credentialsJSON)
      : JSON.parse(fs.readFileSync(config.drive.credentialsFile, 'utf8'));
    auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
  }

  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
}

export function isConfigured() {
  return config.drive.enabled && authMode() !== null;
}

export function resetClient() { cachedDrive = null; }

/* ──────────────────────────────── carpetas ───────────────────────────────── */

const shared = () => (config.drive.driveId
  ? { supportsAllDrives: true, includeItemsFromAllDrives: true, driveId: config.drive.driveId, corpora: 'drive' }
  : { supportsAllDrives: true, includeItemsFromAllDrives: true });

export async function findOrCreateFolder(name, parentId) {
  const drive = getDrive();
  const safe = name.replace(/'/g, "\\'");
  const q = [
    `name = '${safe}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean).join(' and ');

  const { data } = await drive.files.list({
    q,
    fields: 'files(id, name)',
    pageSize: 1,
    ...shared(),
  });
  if (data.files?.length) return data.files[0].id;

  const { data: created } = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  log.ok(`carpeta creada: ${name}`);
  return created.id;
}

/**
 * Estructura que ve el logístico en Drive:
 *
 *   KuvaConnect/
 *     <Nombre del evento>/
 *       01_Originales     ← todo lo que sube la gente, tal cual
 *       02_Para_imprimir  ← aprobadas y con marco: esta es la cola de impresión
 *       03_Rechazadas     ← lo que se bloqueó en moderación
 *       04_Impresas       ← ya salieron por la DNP
 */
export async function ensureEventFolders(event) {
  const rootId = config.drive.rootFolderId || await findOrCreateFolder('KuvaConnect', null);
  const eventFolder = await findOrCreateFolder(event.name, rootId);
  const [originals, toPrint, rejected, printed] = await Promise.all([
    findOrCreateFolder('01_Originales', eventFolder),
    findOrCreateFolder('02_Para_imprimir', eventFolder),
    findOrCreateFolder('03_Rechazadas', eventFolder),
    findOrCreateFolder('04_Impresas', eventFolder),
  ]);
  return { rootId, eventFolder, originals, toPrint, rejected, printed };
}

/* ───────────────────────────────── archivos ──────────────────────────────── */

export async function uploadBuffer({ folderId, name, buffer, mimeType = 'image/jpeg', description }) {
  const drive = getDrive();
  const { data } = await drive.files.create({
    requestBody: { name, parents: [folderId], ...(description ? { description } : {}) },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  });
  return data;
}

export async function moveFile(fileId, toFolderId) {
  const drive = getDrive();
  const { data: cur } = await drive.files.get({ fileId, fields: 'parents', supportsAllDrives: true });
  await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: (cur.parents || []).join(','),
    fields: 'id, parents',
    supportsAllDrives: true,
  });
}

export async function deleteFile(fileId) {
  const drive = getDrive();
  await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
}

export async function whoAmI() {
  const drive = getDrive();
  if (!drive) return null;
  const { data } = await drive.about.get({ fields: 'user(displayName,emailAddress), storageQuota(limit,usage)' });
  return data;
}

/* ─────────────────── piezas para usar Drive como almacén ─────────────────── */

/**
 * En el modo nube, Drive no es solo el archivo del cliente: es la base de datos.
 * El estado de cada foto vive en las `appProperties` de su archivo original, y
 * la configuración del evento en la `description` de su carpeta. Estas son las
 * operaciones que eso necesita y que la parte "archivo" no tenía.
 */

/** Lista archivos con una consulta de Drive. Devuelve también sus metadatos. */
export async function listFiles(q, { fields = 'files(id,name,description,appProperties,createdTime,mimeType,parents)', pageSize = 200, orderBy } = {}) {
  const drive = getDrive();
  const { data } = await drive.files.list({
    q,
    fields: `nextPageToken, ${fields}`,
    pageSize,
    ...(orderBy ? { orderBy } : {}),
    ...shared(),
  });
  return data.files || [];
}

export async function getFile(fileId, fields = 'id,name,description,appProperties,createdTime,parents') {
  const drive = getDrive();
  const { data } = await drive.files.get({ fileId, fields, supportsAllDrives: true });
  return data;
}

/** Descarga el contenido de un archivo como Buffer. */
export async function downloadFile(fileId) {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data);
}

/**
 * Actualiza metadatos. `appProperties` se fusiona con lo que ya había, así que
 * mandar `{ status: 'approved' }` no borra el resto; poner null en una clave sí
 * la elimina (es como lo define la API de Drive).
 */
export async function setMeta(fileId, { appProperties, description, name } = {}) {
  const drive = getDrive();
  const { data } = await drive.files.update({
    fileId,
    requestBody: {
      ...(appProperties ? { appProperties } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(name ? { name } : {}),
    },
    fields: 'id,name,description,appProperties',
    supportsAllDrives: true,
  });
  return data;
}
