import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const bool = (v, def = false) => (v === undefined ? def : ['1', 'true', 'yes', 'si', 'sí'].includes(String(v).toLowerCase()));
const int = (v, def) => (v === undefined || v === '' ? def : Number.parseInt(v, 10));

/** Primera IP IPv4 de la LAN — sirve para armar el QR sin configurar nada. */
export function lanIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Preferimos Wi-Fi/Ethernet por encima de adaptadores virtuales (VirtualBox, WSL, Hyper-V…)
      const virtual = /virtual|vethernet|vmware|loopback|wsl|hyper-v|docker/i.test(name);
      candidates.push({ ip: a.address, virtual, private: /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) });
    }
  }
  candidates.sort((a, b) => (a.virtual - b.virtual) || (b.private - a.private));
  return candidates[0]?.ip || '127.0.0.1';
}

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  /** URL pública que se codifica en el QR. Si no se define, se usa http://<IP LAN>:<port>. */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  adminPin: process.env.ADMIN_PIN || '2468',

  paths: {
    data: path.join(ROOT, 'data'),
    media: path.join(ROOT, 'data', 'media'),
    assets: path.join(ROOT, 'assets'),
    public: path.join(ROOT, 'public'),
  },

  upload: {
    maxBytes: int(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
    maxPerDevice: int(process.env.MAX_PER_DEVICE, 12),
    allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif'],
  },

  drive: {
    enabled: bool(process.env.DRIVE_ENABLED, false),
    // Ruta al JSON de la service account, o el JSON completo en la variable.
    credentialsFile: process.env.GOOGLE_CREDENTIALS_FILE || path.join(ROOT, 'credentials', 'service-account.json'),
    credentialsJSON: process.env.GOOGLE_CREDENTIALS_JSON || '',
    // Carpeta raíz en Drive (ID). Debe estar compartida con el email de la service account como Editor.
    rootFolderId: process.env.DRIVE_ROOT_FOLDER_ID || '',
    // Para Shared Drives (Unidades compartidas)
    driveId: process.env.DRIVE_SHARED_DRIVE_ID || '',
    syncIntervalMs: int(process.env.DRIVE_SYNC_INTERVAL_MS, 15000),
  },

  print: {
    dpi: int(process.env.PRINT_DPI, 300),
    widthCm: 10,
    heightCm: 15,
  },
};

export function baseUrl() {
  return config.publicBaseUrl || `http://${lanIP()}:${config.port}`;
}
