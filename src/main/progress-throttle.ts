import type { ProgressEventT } from '@shared/ipc-types';

/**
 * Coalesce progress events to at most one IPC roundtrip per `intervalMs`.
 * The 'done' and 'error' phases bypass the throttle so the UI never misses a
 * terminal event. Speed (bytes/sec) is computed from the last forwarded sample.
 *
 * Why throttle? On a slow disk a 100 MB extraction can call back ~10k times.
 * Forwarding each event hammers the renderer + over-renders the progress bar
 * (React reconciles the same DOM ~10k times). 30 Hz is more than smooth for
 * humans and an order of magnitude cheaper.
 */
export interface ProgressThrottle {
  emit(ev: ProgressEventT): void;
  flush(): void;
}

export interface ThrottleOpts {
  intervalMs?: number;
  forward: (ev: ProgressEventT) => void;
  now?: () => number;
}

export function createProgressThrottle(opts: ThrottleOpts): ProgressThrottle {
  const interval = opts.intervalMs ?? 33; // ~30 Hz
  const now = opts.now ?? (() => performance.now());
  let last: ProgressEventT | null = null;
  let lastForwardedAt = -Infinity;
  let lastDownloadedBytes = 0;
  let lastDownloadedAt = -Infinity;

  const forwardWithSpeed = (ev: ProgressEventT) => {
    let bytesPerSec = ev.bytesPerSec;
    if (
      ev.phase === 'download' &&
      ev.downloadedBytes !== undefined &&
      lastDownloadedAt !== -Infinity
    ) {
      const dtSec = (now() - lastDownloadedAt) / 1000;
      const dBytes = ev.downloadedBytes - lastDownloadedBytes;
      if (dtSec > 0 && dBytes >= 0) bytesPerSec = Math.round(dBytes / dtSec);
    }
    if (ev.phase === 'download' && ev.downloadedBytes !== undefined) {
      lastDownloadedBytes = ev.downloadedBytes;
      lastDownloadedAt = now();
    }
    opts.forward({ ...ev, bytesPerSec });
    lastForwardedAt = now();
    last = ev;
  };

  return {
    emit(ev) {
      if (ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'rollback') {
        forwardWithSpeed(ev);
        return;
      }
      const phaseTransition = !last || last.phase !== ev.phase;
      if (phaseTransition || now() - lastForwardedAt >= interval) {
        forwardWithSpeed(ev);
      } else {
        last = ev; // keep the latest in case flush() runs before next interval
      }
    },
    flush() {
      if (last && now() - lastForwardedAt >= 1) forwardWithSpeed(last);
    },
  };
}
