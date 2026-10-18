import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createShutdown } from '../shutdown.js';

const fakeApp = (close: () => Promise<void>) =>
  ({ close, log: { info: vi.fn(), error: vi.fn() } }) as unknown as FastifyInstance;

describe('createShutdown', () => {
  it('flips readiness first, then closes the server and the database, then exits 0', async () => {
    const order: string[] = [];
    const state = { shuttingDown: false };
    const exit = vi.fn();
    const shutdown = createShutdown(
      fakeApp(() => {
        order.push(`close (shuttingDown=${String(state.shuttingDown)})`);
        return Promise.resolve();
      }),
      state,
      () => {
        order.push('database');
        return Promise.resolve();
      },
      1000,
      exit,
    );
    await shutdown();
    await shutdown(); // a second signal does not start a second shutdown
    expect(order).toEqual(['close (shuttingDown=true)', 'database']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits 1 when draining exceeds the grace period', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    void createShutdown(
      fakeApp(() => new Promise(() => undefined)),
      { shuttingDown: false },
      () => Promise.resolve(),
      500,
      exit,
    )();
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });
});
