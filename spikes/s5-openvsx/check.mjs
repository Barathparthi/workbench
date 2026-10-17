// Spike S5: is each extension in extensions.json on Open VSX, and does its latest version declare a VS Code
// engine range that the pinned Theia's supported API version satisfies?
//
//   node check.mjs [--theia-api 1.139.0] [--markdown out.md] [--json out.json]
//
// No dependencies. OPENVSX_URL overrides the registry (e.g. an internal mirror).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const registry = (process.env.OPENVSX_URL ?? 'https://open-vsx.org').replace(/\/$/, '');
const theiaApi = arg('theia-api', '1.139.0');
const list = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'extensions.json'), 'utf8'));

const parse = (v) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
const lte = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return true;
};
/** Minimal check for the usual engine forms: "^1.82.0", ">=1.82.0", "1.82.x", "*". */
function engineSatisfied(range, api) {
  if (!range || range === '*') return { ok: true, min: '*' };
  const m = range.match(/(\d+)\.(\d+|x)(?:\.(\d+|x))?/);
  if (!m) return { ok: null, min: range };
  const min = `${m[1]}.${m[2] === 'x' ? 0 : m[2]}.${m[3] && m[3] !== 'x' ? m[3] : 0}`;
  return { ok: lte(min, api) && parse(min)[0] === parse(api)[0], min };
}

/** Theia's registry client installs the newest version whose engine it supports; find that version. */
async function newestCompatibleVersion(namespace, name) {
  const res = await fetch(`${registry}/api/${namespace}/${name}/versions?size=100`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return `n/a (HTTP ${res.status})`;
  const body = await res.json();
  const versions = Object.keys(body.versions ?? {})
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => (lte(a, b) ? 1 : -1));
  for (const v of versions.slice(0, 25)) {
    const r = await fetch(`${registry}/api/${namespace}/${name}/${v}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) continue;
    const engine = (await r.json()).engines?.vscode;
    if (engineSatisfied(engine, theiaApi).ok) return `${v} (${engine})`;
  }
  return 'none in the 25 newest';
}

async function lookup({ id, area, need }) {
  const [namespace, name] = id.split('.');
  const res = await fetch(`${registry}/api/${namespace}/${name}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return { id, area, need, available: false };
  if (!res.ok) return { id, area, need, available: null, error: `HTTP ${res.status}` };
  const d = await res.json();
  const engine = d.engines?.vscode ?? null;
  const compat = engineSatisfied(engine, theiaApi);
  const newestCompatible = compat.ok === false ? await newestCompatibleVersion(namespace, name) : null;
  return {
    id,
    area,
    need,
    available: true,
    version: d.version ?? null,
    published: d.timestamp?.slice(0, 10) ?? null,
    engine,
    engineMin: compat.min,
    theiaCompatible: compat.ok,
    newestCompatible,
    license: d.license ?? null,
    verifiedPublisher: d.verified ?? null,
    deprecated: d.deprecated ?? false,
    downloads: d.downloadCount ?? null,
    platforms: d.downloads ? Object.keys(d.downloads) : [],
  };
}

const results = [];
for (const ext of list.extensions) {
  results.push(await lookup(ext).catch((e) => ({ ...ext, available: null, error: e.message })));
}

const mark = (v) => (v === true ? '✔' : v === false ? '✘' : '?');
const rows = results.map(
  (r) =>
    `| ${r.area} | \`${r.id}\` | ${r.need} | ${mark(r.available)}${r.error ? ` (${r.error})` : ''} | ${r.version ?? ''} | ${r.published ?? ''} | ${r.engine ?? ''} | ${r.available ? mark(r.theiaCompatible) + (r.newestCompatible ? ` → ${r.newestCompatible}` : '') : ''} | ${r.license ?? ''} | ${r.available ? mark(r.verifiedPublisher) : ''} | ${r.platforms?.join(' ') ?? ''} |`,
);
const markdown = [
  `### Open VSX availability — ${new Date().toISOString().slice(0, 10)} — registry ${registry} — Theia VS Code API ${theiaApi}`,
  '',
  '| Area | Extension | Need | On Open VSX | Latest | Published | engines.vscode | Theia-compatible | License | Verified publisher | Platforms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
  '',
].join('\n');

console.log(markdown);
console.log(JSON.stringify({ registry, theiaApi, results }, null, 2));
const md = arg('markdown');
if (md) appendFileSync(md, `${markdown}\n`);
const json = arg('json');
if (json) writeFileSync(json, JSON.stringify({ registry, theiaApi, results }, null, 2));
if (results.some((r) => r.available === null)) process.exitCode = 1;
