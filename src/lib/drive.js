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
export function authMode() {
  if (fs.existsSync(TOKEN_FILE) && (fs.existsSync(OAUTH_CLIENT_FILE) || process.env.GOOGLE_OAUTH_CLIENT_ID)) return 'oauth';
  if (config.drive.credentialsJSON || fs.existsSync(config.drive.credentialsFile)) return 'service-account';
  return null;
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
    if (c.redirect_uris?.length && !process.env.GOOGLE_OAUTH_REDIRECT) redirect = c.redirect_uris[0];
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
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')));
    auth.on('tokens', (t) => {
      // Google solo manda refresh_token la primera vez: conservamos el que ya tenemos.
      const prev = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      saveToken({ ...prev, ...t });
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
