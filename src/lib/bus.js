import { logger } from './logger.js';

const log = logger('bus');

/**
 * Bus de eventos en vivo por Server-Sent Events.
 * La pantalla y el panel de moderación se suscriben a /api/events/:eventId/stream
 * y reciben cada foto nueva o cambio de estado sin hacer polling.
 */
const channels = new Map(); // eventId -> Set<res>

export function subscribe(eventId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  if (!channels.has(eventId)) channels.set(eventId, new Set());
  const set = channels.get(eventId);
  set.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* cerrado */ }
  }, 20000);

  const close = () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) channels.delete(eventId);
  };
  res.on('close', close);
  res.on('error', close);

  return close;
}

export function publish(eventId, type, payload) {
  const set = channels.get(eventId);
  if (!set || set.size === 0) return 0;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  let sent = 0;
  for (const res of set) {
    try { res.write(frame); sent++; } catch (err) { log.warn(`cliente caído: ${err.message}`); set.delete(res); }
  }
  return sent;
}

export function clientCount(eventId) {
  return channels.get(eventId)?.size || 0;
}
