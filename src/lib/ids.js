import crypto from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin 0/O/1/I para códigos legibles

/** ID corto legible, útil para nombres de archivo y para dictar por radio en el evento. */
export function shortId(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function slugify(str) {
  return String(str)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'evento';
}

export function token(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
