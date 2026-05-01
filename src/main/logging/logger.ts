export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const order: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
  const minIdx = order.indexOf(minLevel);
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (order.indexOf(level) < minIdx) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    // eslint-disable-next-line no-console
    console.log(line);
  };
  const make = (base: Record<string, unknown>): Logger => ({
    log(level, msg, fields) {
      emit(level, msg, { ...base, ...fields });
    },
    child(extra) {
      return make({ ...base, ...extra });
    },
  });
  return make({});
}
