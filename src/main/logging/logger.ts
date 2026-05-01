import { redact } from './redact';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  fatal(msg: string, fields?: Record<string, unknown>): void;
  /** Generic log with explicit level. */
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function makeLogger(
  emit: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void,
  base: Record<string, unknown>,
): Logger {
  const self: Logger = {
    trace(msg, fields) { emit('trace', msg, { ...base, ...fields }); },
    debug(msg, fields) { emit('debug', msg, { ...base, ...fields }); },
    info(msg, fields) { emit('info', msg, { ...base, ...fields }); },
    warn(msg, fields) { emit('warn', msg, { ...base, ...fields }); },
    error(msg, fields) { emit('error', msg, { ...base, ...fields }); },
    fatal(msg, fields) { emit('fatal', msg, { ...base, ...fields }); },
    log(level, msg, fields) { emit(level, msg, { ...base, ...fields }); },
    child(extra) { return makeLogger(emit, { ...base, ...extra }); },
  };
  return self;
}

/**
 * Walk a fields object and redact every string value. We only scrub strings
 * — numbers/booleans/null can't carry secrets in the redactor's lexicon.
 * Nested objects/arrays are recursed so a `{ headers: { authorization: 'Bearer …' } }`
 * payload doesn't slip past.
 */
function redactFields(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactFields);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactFields(v);
    }
    return out;
  }
  return value;
}

export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const minIdx = LEVEL_ORDER.indexOf(minLevel);
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVEL_ORDER.indexOf(level) < minIdx) return;
    const safe = redactFields({ ts: new Date().toISOString(), level, msg: redact(msg), ...(fields ?? {}) });
    const line = JSON.stringify(safe);
    // eslint-disable-next-line no-console
    console.log(line);
  };
  return makeLogger(emit, {});
}

export interface MemoryLogger extends Logger {
  entries: LogEntry[];
}

/** Create an in-memory logger that accumulates log entries for test inspection. */
export function createMemoryLogger(): MemoryLogger {
  const entries: LogEntry[] = [];
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    entries.push({ level, msg, fields: fields ?? {} });
  };
  const base = makeLogger(emit, {});
  return Object.assign(base, { entries });
}
