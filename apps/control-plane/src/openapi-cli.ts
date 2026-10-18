import { writeFile } from 'node:fs/promises';

import { generateOpenApi } from './openapi.js';

const out = process.argv[2] ?? 'openapi.json';
await writeFile(out, `${JSON.stringify(await generateOpenApi(), null, 2)}\n`);
console.log(`openapi: wrote ${out}`);
