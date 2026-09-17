const COLORS = { info: '\x1b[36m', ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', dim: '\x1b[90m' };
const RESET = '\x1b[0m';

function stamp() {
  return new Date().toLocaleTimeString('es-CO', { hour12: false });
}

function emit(level, scope, msg, extra) {
  const color = COLORS[level] || '';
  const line = `${COLORS.dim}${stamp()}${RESET} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${COLORS.dim}[${scope}]${RESET} ${msg}`;
  const stream = level === 'error' ? console.error : console.log;
  extra === undefined ? stream(line) : stream(line, extra);
}

export function logger(scope) {
  return {
    info: (m, e) => emit('info', scope, m, e),
    ok: (m, e) => emit('ok', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}
