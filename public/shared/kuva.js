/* Utilidades compartidas por la pantalla, el celular y el panel. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Slug del evento a partir de la URL (/d/<slug>, /u/<slug>) o del querystring. */
export function eventSlugFromUrl() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['d', 'u'].includes(parts[0])) return decodeURIComponent(parts[1]);
  return new URLSearchParams(location.search).get('event') || '';
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* respuesta vacía */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Error ${res.status}`), { status: res.status, data });
  return data;
}

/**
 * Suscripción SSE con reconexión automática.
 * En un evento el wifi parpadea; la pantalla tiene que volver sola.
 */
export function stream(url, handlers = {}) {
  let source = null;
  let closed = false;
  let retry = 1000;

  const connect = () => {
    if (closed) return;
    source = new EventSource(url, { withCredentials: true });

    source.addEventListener('open', () => {
      retry = 1000;
      handlers.onOpen?.();
    });

    for (const [type, fn] of Object.entries(handlers)) {
      if (type.startsWith('on')) continue;
      source.addEventListener(type, (e) => {
        try { fn(JSON.parse(e.data)); } catch { fn(e.data); }
      });
    }

    source.addEventListener('error', () => {
      handlers.onError?.();
      source.close();
      if (closed) return;
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.7, 15000);
    });
  };

  connect();
  return { close() { closed = true; source?.close(); } };
}

/* ────────────────────────────────── toasts ──────────────────────────────── */

let toastHost = null;
export function toast(message, kind = '', ms = 3200) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast ${kind ? `toast-${kind}` : ''}` }, message);
  toastHost.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 320);
  }, ms);
}

/* ──────────────────────────────── formato ──────────────────────────────── */

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

export function clock(iso) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

export function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Identificador del dispositivo: limita cuántas fotos sube una misma persona. */
let memoryDevice = null;
export function deviceId() {
  const KEY = 'kuva.device';
  const fresh = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 36);
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = fresh(); localStorage.setItem(KEY, id); }
    return id;
  } catch {
    // Navegación privada o cookies bloqueadas: el límite por dispositivo se
    // vuelve por sesión, que es mejor que romper la subida.
    return (memoryDevice ||= fresh());
  }
}
