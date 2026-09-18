import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Autenticación del panel.
 *
 * Cada sede tiene su propio PIN, y la sesión que abre solo sirve para ESA sede:
 * el moderador de Bogotá no puede ver ni tocar las fotos de Medellín aunque
 * adivine la URL. El PIN maestro (ADMIN_PIN) abre todas las sedes y los ajustes.
 *
 * La sesión es un token firmado `expiración.alcance.firma` con HMAC-SHA256.
 * El servidor no guarda nada (en serverless no hay dónde): solo verifica la firma.
 * El alcance es el id del evento de la sede, o `*` para el maestro.
 */

const TTL_MS = 1000 * 60 * 60 * 18; // una jornada larga de evento
export const COOKIE = 'kuva_admin';
export const ALL = '*';

function secret() {
  return process.env.SESSION_SECRET || `kuva:${config.adminPin}`;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Hash del PIN de una sede. El id del evento hace de sal: dos sedes con el mismo
 * PIN no quedan con el mismo hash, y el PIN nunca se guarda en claro en Drive.
 */
export function hashPin(eventId, pin) {
  return crypto.createHash('sha256').update(`kuva-pin:${eventId}:${String(pin).trim()}`).digest('hex');
}

export function isMasterPin(pin) {
  return safeEqual(String(pin).trim(), config.adminPin);
}

/** Emite una sesión para un alcance (id de evento, o ALL). */
export function issue(scope) {
  const exp = String(Date.now() + TTL_MS);
  const body = `${exp}.${scope}`;
  return `${body}.${sign(body)}`;
}

/** Devuelve el alcance de un token válido, o null. */
export function scopeOf(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [exp, scope, mac] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  if (!/^[A-Za-z0-9*_-]+$/.test(scope)) return null;
  return safeEqual(mac, sign(`${exp}.${scope}`)) ? scope : null;
}

export function logout() { /* sin estado: cerrar sesión es botar la cookie */ }

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function tokenFrom(req) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  if (req.headers['x-kuva-token']) return String(req.headers['x-kuva-token']);
  return parseCookies(req.headers.cookie || '')[COOKIE];
}

export function sessionScope(req) {
  return scopeOf(tokenFrom(req));
}

export function isAdmin(req) {
  return Boolean(sessionScope(req));
}

/** ¿Esta sesión puede tocar este evento? */
export function canAccess(req, eventId) {
  const scope = sessionScope(req);
  return scope === ALL || (Boolean(scope) && scope === eventId);
}

export function requireAdmin(req, res, next) {
  const scope = sessionScope(req);
  if (!scope) return res.status(401).json({ error: 'No autorizado. Inicia sesión en el panel.' });
  req.scope = scope;
  next();
}

/** Solo el PIN maestro: ajustes, marcos, Drive, crear sedes. */
export function requireMaster(req, res, next) {
  if (req.scope === ALL) return next();
  return res.status(403).json({ error: 'Esto solo lo puede hacer el administrador general.' });
}

function cookieFlags() {
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags()}; Max-Age=${TTL_MS / 1000}`);
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags()}; Max-Age=0`);
}
