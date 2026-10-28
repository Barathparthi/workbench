import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AuditSink, LocalAuditEvent } from './sources.js';

export interface LocalAuditOptions {
  /** `~/.qe-workspace/audit.log`. */
  readonly path: string;
  /** At this size the log moves to `<path>.1` (replacing the previous one) and starts again. */
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

/**
 * The embedded broker's audit trail on the user's machine (09_LOCAL_AND_WEB_PARITY §3.4 `LocalAuditLog`): one JSON
 * object per line, readable only by the user. Events carry names and outcomes, never file contents, keys,
 * passphrases or terminal bytes. A write that fails does not stop the user's work: it is the user's own machine and
 * the log is for them.
 */
export function localAuditLog(options: LocalAuditOptions): AuditSink {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const now = options.now ?? (() => new Date());
  let queue = Promise.resolve();

  const write = async (event: LocalAuditEvent) => {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const size = await stat(options.path).then(
      (s) => s.size,
      () => 0,
    );
    if (size >= maxBytes) await rename(options.path, `${options.path}.1`);
    const line = JSON.stringify({ time: now().toISOString(), ...event });
    await appendFile(options.path, `${line}\n`, { mode: 0o600 });
    await chmod(options.path, 0o600).catch(() => undefined);
  };

  return {
    record(event) {
      // One write at a time, in order; failures are swallowed (see above).
      queue = queue.then(() => write(event)).catch(() => undefined);
      return queue;
    },
  };
}
