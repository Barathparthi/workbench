// Spike S2 reverse proxy in front of Theia browser backends (the S1 app).
//
//   node proxy.mjs path        http://127.0.0.1:8080/w/<id>/      → upstream /
//   node proxy.mjs subdomain   http://<id>.ws.localhost:8080/     → upstream /
//
// WORKSPACES="ws-a=http://127.0.0.1:3000,ws-b=http://127.0.0.1:3001" (default: test-ws → :3000).
// COOKIE_PATH_REWRITE=1 rewrites `Set-Cookie: …; Path=/` to `Path=/w/<id>/` (path mode only).
// Anything outside a workspace route is answered 404 and logged as an ESCAPE, because in production it
// would reach the wrong workspace (or none).
import proxy from '@fastify/http-proxy';
import Fastify from 'fastify';

const mode = process.argv[2] ?? 'path';
const port = Number(process.env.PROXY_PORT ?? 8080);
const rewriteCookiePath = process.env.COOKIE_PATH_REWRITE === '1';
const workspaces = (process.env.WORKSPACES ?? 'test-ws=http://127.0.0.1:3000').split(',').map((entry) => {
  const [id, upstream] = entry.split('=');
  return { id, upstream };
});

const app = Fastify({ logger: false });
const escapes = new Map();
const recordEscape = (req) => {
  const key = `${req.method} ${req.headers.host ?? ''}${req.url}`;
  escapes.set(key, (escapes.get(key) ?? 0) + 1);
  console.log(`ESCAPE ${key}`);
};

// Spike-only introspection and fault injection (would not exist in production).
const liveSockets = new Set();
app.server.on('upgrade', (_req, socket) => {
  liveSockets.add(socket);
  socket.on('close', () => liveSockets.delete(socket));
});
app.get('/__spike/escapes', async () => Object.fromEntries(escapes));
app.post('/__spike/drop-sockets', async () => {
  const dropped = liveSockets.size;
  for (const socket of liveSockets) socket.destroy();
  return { dropped };
});

const withCookiePath = (path) => (headers) => {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return headers;
  const rewrite = (c) => c.replace(/;\s*Path=\/(?=;|$)/i, `; Path=${path}`);
  return { ...headers, 'set-cookie': Array.isArray(setCookie) ? setCookie.map(rewrite) : rewrite(setCookie) };
};

if (mode === 'path') {
  const prefixes = new Set(workspaces.map(({ id }) => `/w/${id}`));
  // Without the trailing slash relative asset URLs resolve one level too high.
  app.addHook('onRequest', async (req, reply) => {
    const [path, query] = req.url.split('?');
    if (prefixes.has(path)) return reply.redirect(`${path}/${query ? `?${query}` : ''}`, 308);
  });
  for (const { id, upstream } of workspaces) {
    const prefix = `/w/${id}`;
    await app.register(proxy, {
      upstream,
      prefix,
      rewritePrefix: '',
      websocket: true,
      ...(rewriteCookiePath ? { replyOptions: { rewriteHeaders: withCookiePath(`${prefix}/`) } } : {}),
    });
  }
  app.setNotFoundHandler((req, reply) => {
    recordEscape(req);
    return reply.code(404).send({ error: 'outside workspace route' });
  });
} else if (mode === 'subdomain') {
  const [{ id, upstream }] = workspaces;
  const workspaceHost = `${id}.ws.localhost:${port}`;
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/__spike/')) return;
    if (req.headers.host !== workspaceHost) {
      recordEscape(req);
      return reply.code(404).send({ error: 'unknown workspace host' });
    }
  });
  await app.register(proxy, { upstream, websocket: true });
} else {
  throw new Error(`unknown mode ${mode}`);
}

await app.listen({ host: '127.0.0.1', port });
for (const { id, upstream } of workspaces) {
  const url = mode === 'path' ? `http://127.0.0.1:${port}/w/${id}/` : `http://${id}.ws.localhost:${port}/`;
  console.log(`S2 proxy (${mode}${rewriteCookiePath ? ', cookie path rewrite' : ''}): ${url} → ${upstream}`);
}
