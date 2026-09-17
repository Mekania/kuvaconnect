import crypto from 'node:crypto';
import { config } from '../config.js';
import { token } from './ids.js';

/**
 * Autenticación del panel: un PIN que conoce el logístico.
 * No es un sistema de usuarios — es el candado de una herramienta que corre en
 * la red del evento durante seis horas. Cuando KuvaConnect pase a estar en
 * internet abierto, esto se reemplaza por cuentas de verdad.
 */

const sessions = new Map(); // token -> { createdAt, label }
const TTL_MS = 1000 * 60 * 60 * 18; // una jornada larga de evento

export const COOKIE = 'kuva_admin';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function login(pin, label = 'panel') {
  if (!safeEqual(pin, config.adminPin)) return null;
  const t = token(24);
  sessions.set(t, { createdAt: Date.now(), label });
  return t;
}

export function logout(t) { sessions.delete(t); }

export function valid(t) {
  if (!t) return false;
  const s = sessions.get(t);
  if (!s) return false;
  if (Date.now() - s.createdAt > TTL_MS) { sessions.delete(t); return false; }
  return true;
}

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

export function setCookie(res, t) {
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}`);
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
