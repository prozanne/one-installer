import { describe, it, expect } from 'vitest';
import { createProgressThrottle } from '@main/progress-throttle';
import type { ProgressEventT } from '@shared/ipc-types';

describe('createProgressThrottle', () => {
  it('forwards the first event of a phase immediately', () => {
    const out: ProgressEventT[] = [];
    const t = 0;
    const tr = createProgressThrottle({
      intervalMs: 33,
      forward: (e) => out.push(e),
      now: () => t,
    });
    tr.emit({ phase: 'download', message: 'go', downloadedBytes: 0 });
    expect(out.length).toBe(1);
  });

  it('coalesces rapid in-phase events to ~one per interval', () => {
    const out: ProgressEventT[] = [];
    let t = 0;
    const tr = createProgressThrottle({
      intervalMs: 33,
      forward: (e) => out.push(e),
      now: () => t,
    });
    tr.emit({ phase: 'download', message: '0', downloadedBytes: 0 });
    for (let i = 1; i <= 100; i++) {
      t += 1; // 1 ms per emit, far below the throttle interval
      tr.emit({ phase: 'download', message: String(i), downloadedBytes: i * 1024 });
    }
    // 100ms / 33ms ≈ 3 forwarded after the first.
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('always forwards terminal phases (done / error / rollback)', () => {
    const out: ProgressEventT[] = [];
    let t = 0;
    const tr = createProgressThrottle({
      intervalMs: 1000, // huge interval — would suppress non-terminal
      forward: (e) => out.push(e),
      now: () => t,
    });
    tr.emit({ phase: 'extract', message: 'x' });
    tr.emit({ phase: 'extract', message: 'y' });
    t += 1;
    tr.emit({ phase: 'done', message: 'ok', percent: 100 });
    expect(out.map((e) => e.phase)).toEqual(['extract', 'done']);
  });

  it('computes bytesPerSec between forwarded download samples', () => {
    const out: ProgressEventT[] = [];
    let t = 0;
    const tr = createProgressThrottle({
      intervalMs: 100,
      forward: (e) => out.push(e),
      now: () => t,
    });
    tr.emit({ phase: 'download', message: 'a', downloadedBytes: 0 });
    t += 100;
    tr.emit({ phase: 'download', message: 'b', downloadedBytes: 100_000 });
    expect(out.length).toBe(2);
    // 100k bytes in 100ms → 1,000,000 B/s
    expect(out[1]!.bytesPerSec).toBe(1_000_000);
  });

  it('flush() emits the latest suppressed event', () => {
    const out: ProgressEventT[] = [];
    let t = 0;
    const tr = createProgressThrottle({
      intervalMs: 1000,
      forward: (e) => out.push(e),
      now: () => t,
    });
    tr.emit({ phase: 'extract', message: '0' });
    tr.emit({ phase: 'extract', message: '1' });
    tr.emit({ phase: 'extract', message: '2' });
    expect(out.length).toBe(1);
    t += 5;
    tr.flush();
    expect(out.length).toBe(2);
    expect(out[1]!.message).toBe('2');
  });
});
