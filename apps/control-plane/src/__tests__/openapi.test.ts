import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { generateOpenApi } from '../openapi.js';

describe('OpenAPI', () => {
  it('is generated from the routes and matches the committed openapi.json (run npm run openapi:generate)', async () => {
    const document = await generateOpenApi();
    const committed = JSON.parse(
      readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(document).toEqual(committed);
  });

  it('documents the v1 workspace operations', async () => {
    const document = (await generateOpenApi()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths['/api/v1/workspaces'] ?? {}).sort()).toEqual(['get', 'post']);
    expect(Object.keys(document.paths['/api/v1/workspaces/{id}'] ?? {}).sort()).toEqual([
      'delete',
      'get',
      'patch',
    ]);
  });
});
