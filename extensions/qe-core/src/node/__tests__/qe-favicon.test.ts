import type { Application } from '@theia/core/shared/express';
import { describe, expect, it, vi } from 'vitest';

import { FAVICON_PNG, QeFaviconContribution } from '../qe-favicon';

describe('favicon', () => {
  it('is a 32×32 PNG', () => {
    expect(FAVICON_PNG.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(FAVICON_PNG.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect([FAVICON_PNG.readUInt32BE(16), FAVICON_PNG.readUInt32BE(20)]).toEqual([32, 32]);
  });

  it('is served at /favicon.ico as image/png with caching', () => {
    const routes = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
      get: (path: string, handler: (req: unknown, res: unknown) => void) => routes.set(path, handler),
    };
    new QeFaviconContribution().configure(app as unknown as Application);

    const response = { type: vi.fn(), setHeader: vi.fn(), send: vi.fn() };
    response.type.mockReturnValue(response);
    routes.get('/favicon.ico')?.({}, response);
    expect(response.type).toHaveBeenCalledWith('image/png');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=86400');
    expect(response.send).toHaveBeenCalledWith(FAVICON_PNG);
    expect([...routes.keys()]).toEqual(['/favicon.ico']);
  });
});
