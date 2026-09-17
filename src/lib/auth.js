import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Autenticación del panel: un PIN que conoce el logístico.
 *
 * No es un sistema de usuarios — es el candado de una herramienta que corre
 * durante un evento. Lo que sí cambió: la sesión ahora es un **token firmado**
 * en vez de una entrada en memoria. En serverless el proceso muere entre
 * peticiones, así que una sesión guardada en RAM se pierde en cada request.
 *
 * El token es `expiración.firma`, firmado con HMAC-SHA256 sobre una clave
 * secreta. El servidor no guarda nada: solo verifica la firma.
 */

const TTL_MS = 1000 * 60 * 60 * 18; // una jornada larga de evento
export const COOKIE = 'kuva_admin';

/**
 * Clave para firmar sesiones. En producción se define aparte del PIN para que
 * cambiar el PIN no obligue a nada más; si falta, se deriva del PIN, que sigue
 * siendo secreto pero hace que cambiar el PIN invalide las sesiones abiertas.
 */
function secret() {
  return process.env.SESSION_SECRET || `kuva:${config.adminPin}`;
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function login(pin) {
  if (!safeEqual(pin, config.adminPin)) return null;
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${sign(exp)}`;
}

export function valid(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(mac, sign(exp));
}

/** Sin estado que borrar: cerrar sesión es botar la cookie del navegador. */
export function logout() { /* no-op */ }

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

export function isAdmin(req) {
  return valid(tokenFrom(req));
}

export function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(401).json({ error: 'No autorizado. Inicia sesión en el panel.' });
}

/** `Secure` solo fuera de local: en la red del salón la pantalla va por http. */
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
