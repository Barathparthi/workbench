import { describe, expect, it } from 'vitest';

import {
  assertWorkspaceId,
  cloneCommand,
  DockerEngineError,
  DockerProvider,
  ideContainerSpec,
  KubernetesApiError,
  KubernetesProvider,
  PACKAGE_NAME,
  podManifest,
  pvcManifest,
  runtimeNames,
  serviceManifest,
  type DockerEngine,
  type KubeApi,
  type RuntimeSpec,
} from '../index.js';

const ID = '0192d2a4-7c1e-7d3a-9f4b-2c5e8a1b3d6f';
const spec: RuntimeSpec = {
  workspaceId: ID,
  image: 'registry.example/qews/runtime@sha256:abc',
  profile: 'standard',
  env: { QE_MODE: 'hosted', QE_WORKSPACE_ID: ID },
  git: { url: 'https://git.example/qe/repo.git', ref: 'main' },
};

describe('@qe/runtime-providers', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@qe/runtime-providers');
  });

  it('names resources after the workspace id and refuses anything that is not a UUID', () => {
    expect(runtimeNames(ID).container).toBe(`qews-ws-${ID}`);
    for (const bad of ['', '../x', 'a b', `${ID};rm`, ID.toUpperCase()]) {
      expect(() => assertWorkspaceId(bad)).toThrow('invalid workspace id');
    }
  });

  it('passes git URL and ref as positional arguments, never inside the script', () => {
    const hostile = { url: 'https://git.example/$(touch /pwn).git', ref: 'main;reboot' };
    const cmd = cloneCommand(hostile);
    expect(cmd.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(cmd[2]).not.toContain('pwn');
    expect(cmd[2]).not.toContain('reboot');
    expect(cmd.slice(4)).toEqual([hostile.url, hostile.ref, '/home/qe/project']);
    expect(cmd[2]).toContain('-- "$1"'); // URL can never become a git option
  });
});

/** In-memory Docker Engine with the endpoints the provider uses. */
function fakeDocker(opts: { cloneExit?: number; pullable?: boolean } = {}) {
  const containers = new Map<string, { body: Record<string, unknown>; running: boolean; status: string }>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const images = new Set<string>();
  const calls: string[] = [];
  const engine: DockerEngine = {
    call: (method, path, body) => {
      calls.push(`${method} ${path}`);
      const url = new URL(path, 'http://d');
      const parts = url.pathname.split('/').map(decodeURIComponent);
      const ok = (status: number, b: unknown = {}) => Promise.resolve({ status, body: b });
      if (parts[1] === 'networks') {
        if (method === 'GET') return ok(networks.has(parts[2] ?? '') ? 200 : 404);
        networks.add((body as { Name: string }).Name);
        return ok(201);
      }
      if (parts[1] === 'images') {
        if (method === 'GET') return ok(images.has(parts[2] ?? '') ? 200 : 404);
        if (opts.pullable !== false) images.add(url.searchParams.get('fromImage') ?? '');
        return ok(200);
      }
      if (parts[1] === 'volumes') {
        if (parts[2] === 'create') {
          volumes.add((body as { Name: string }).Name);
          return ok(201);
        }
        if (method === 'GET') return ok(volumes.has(parts[2] ?? '') ? 200 : 404);
        return ok(volumes.delete(parts[2] ?? '') ? 204 : 404);
      }
      if (parts[1] === 'containers') {
        if (parts[2] === 'create') {
          containers.set(url.searchParams.get('name') ?? '', {
            body: body as Record<string, unknown>,
            running: false,
            status: 'created',
          });
          return ok(201);
        }
        if (parts[2] === 'json') {
          return ok(
            200,
            [...containers.values()]
              .filter((c) => {
                const labels = c.body.Labels;
                return typeof labels === 'object' && labels !== null && 'qews.workspace-id' in labels;
              })
              .map((c) => ({ Labels: c.body.Labels })),
          );
        }
        const c = containers.get(parts[2] ?? '');
        if (c === undefined) return ok(404);
        const action = parts[3];
        if (method === 'DELETE') {
          containers.delete(parts[2] ?? '');
          return ok(204);
        }
        if (action === 'json') {
          return ok(200, {
            State: { Running: c.running, Status: c.status, ExitCode: 0 },
            NetworkSettings: {
              Ports: c.running ? { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } : {},
            },
          });
        }
        if (action === 'start') {
          if (c.running) return ok(304);
          c.running = true;
          c.status = 'running';
          return ok(204);
        }
        if (action === 'stop') {
          c.running = false;
          c.status = 'exited';
          return ok(204);
        }
        if (action === 'wait') return ok(200, { StatusCode: opts.cloneExit ?? 0 });
      }
      return ok(500, { message: `unexpected ${method} ${path}` });
    },
  };
  return { engine, containers, volumes, calls };
}

describe('DockerProvider', () => {
  const provider = (d = fakeDocker()) =>
    new DockerProvider({ engine: d.engine, network: 'qews-ws', endpointMode: 'published' });

  it('builds a hardened container spec', () => {
    const c = ideContainerSpec(spec, { network: 'qews-ws', endpointMode: 'published' });
    expect(c.User).toBe('1000:1000');
    expect(c.HostConfig).toMatchObject({
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      PidsLimit: 1024,
      Memory: 4 * 2 ** 30,
      NanoCpus: 2e9,
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    });
    const mounts = c.HostConfig.Mounts;
    expect(mounts).toEqual([{ Type: 'volume', Source: `qews-ws-${ID}`, Target: '/home/qe/project' }]);
    expect(JSON.stringify(c)).not.toMatch(/docker\.sock|"Binds"|"bind"/);
    expect(ideContainerSpec(spec, { network: 'n', endpointMode: 'network' }).HostConfig).not.toHaveProperty(
      'PortBindings',
    );
  });

  it('starts idempotently, clones once, and reports the published endpoint', async () => {
    const d = fakeDocker();
    const p = provider(d);
    expect(await p.status(ID)).toEqual({ phase: 'absent' });
    expect(await p.ensureStarted(spec)).toEqual({ phase: 'running', endpoint: 'http://127.0.0.1:49153' });
    expect(await p.ensureStarted(spec)).toEqual({ phase: 'running', endpoint: 'http://127.0.0.1:49153' });
    expect(d.calls.filter((c) => c.includes('-clone/start'))).toHaveLength(1);
    expect(d.containers.has(`qews-ws-${ID}-clone`)).toBe(false);
    expect(await p.listRuntimes()).toEqual([ID]);
  });

  it('stops without losing the volume and destroys everything', async () => {
    const d = fakeDocker();
    const p = provider(d);
    await p.ensureStarted(spec);
    await p.ensureStopped(ID);
    await p.ensureStopped(ID);
    expect(await p.status(ID)).toEqual({ phase: 'stopped' });
    await p.ensureStarted(spec);
    expect(d.calls.filter((c) => c.includes('-clone/start'))).toHaveLength(1); // no second clone
    await p.destroy(ID);
    expect(await p.status(ID)).toEqual({ phase: 'absent' });
  });

  it('removes the volume when the clone fails, so the next start clones again', async () => {
    const d = fakeDocker({ cloneExit: 128 });
    await expect(provider(d).ensureStarted(spec)).rejects.toThrow('git clone failed (exit 128)');
    expect(d.volumes.size).toBe(0);
    expect(d.containers.size).toBe(0);
  });

  it('fails when the image cannot be pulled', async () => {
    await expect(provider(fakeDocker({ pullable: false })).ensureStarted(spec)).rejects.toThrow(
      DockerEngineError,
    );
  });

  it('skips the clone when no repository is given', async () => {
    const d = fakeDocker();
    await provider(d).ensureStarted({ ...spec, git: undefined });
    expect(d.calls.some((c) => c.includes('-clone'))).toBe(false);
  });
});

describe('Kubernetes manifests', () => {
  const pod = podManifest(spec);

  it('runs restricted: non-root, no privilege escalation, no capabilities, RuntimeDefault seccomp', () => {
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.enableServiceLinks).toBe(false);
    expect(pod.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    for (const c of [...pod.spec.containers, ...(pod.spec.initContainers ?? [])]) {
      expect(c.securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      });
    }
    expect(JSON.stringify(pod)).not.toMatch(/hostPath|hostNetwork|hostPID|privileged/);
  });

  it('limits resources and mounts only the PVC and a bounded tmp', () => {
    expect(pod.spec.containers[0]?.resources.limits).toEqual({
      cpu: '2',
      memory: '4Gi',
      'ephemeral-storage': '5Gi',
    });
    expect(pod.spec.volumes).toEqual([
      { name: 'project', persistentVolumeClaim: { claimName: `qews-ws-${ID}` } },
      { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
    ]);
  });

  it('adds the clone init container only with a repository', () => {
    expect(pod.spec.initContainers?.[0]?.command).toEqual(cloneCommand(spec.git ?? { url: '', ref: '' }));
    expect(podManifest({ ...spec, git: undefined }).spec).not.toHaveProperty('initContainers');
  });

  it('sizes the PVC from the profile and selects the pod by workspace id', () => {
    expect(pvcManifest(spec, 'fast').spec).toMatchObject({
      storageClassName: 'fast',
      resources: { requests: { storage: '20Gi' } },
    });
    expect(pvcManifest(spec).spec).not.toHaveProperty('storageClassName');
    expect(serviceManifest(ID).spec.selector).toEqual({ 'qews.workspace-id': ID });
  });
});

function fakeKube(podBody?: unknown) {
  const objects = new Map<string, unknown>();
  const calls: string[] = [];
  const api: KubeApi = {
    call: (method, path, body) => {
      calls.push(`${method} ${path}`);
      const base = path.split('?')[0] ?? '';
      if (method === 'POST') {
        const name = (body as { metadata: { name: string } }).metadata.name;
        const key = `${base}/${name}`;
        if (objects.has(key)) return Promise.resolve({ status: 409, body: {} });
        objects.set(key, body);
        return Promise.resolve({ status: 201, body });
      }
      if (method === 'DELETE') return Promise.resolve({ status: objects.delete(base) ? 200 : 404, body: {} });
      if (base.endsWith('/pods')) {
        const items = [...objects.entries()].filter(([k]) => k.includes('/pods/')).map(([, v]) => v);
        return Promise.resolve({ status: 200, body: { items } });
      }
      if (!objects.has(base)) return Promise.resolve({ status: 404, body: {} });
      return Promise.resolve({
        status: 200,
        body: base.includes('/pods/') ? (podBody ?? objects.get(base)) : objects.get(base),
      });
    },
  };
  return { api, objects, calls };
}

describe('KubernetesProvider', () => {
  const runningPod = { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };

  it('creates PVC, service and pod idempotently and reports the service endpoint when ready', async () => {
    const k = fakeKube(runningPod);
    const p = new KubernetesProvider({ api: k.api, namespace: 'qews-workspaces' });
    expect(await p.status(ID)).toEqual({ phase: 'absent' });
    const status = await p.ensureStarted(spec);
    expect(status).toEqual({ phase: 'running', endpoint: `http://qews-ws-${ID}.qews-workspaces.svc:3000` });
    await p.ensureStarted(spec); // 409s are fine
    expect(await p.listRuntimes()).toEqual([ID]);
    await p.ensureStopped(ID);
    expect(await p.status(ID)).toEqual({ phase: 'stopped' });
    await p.destroy(ID);
    expect(await p.status(ID)).toEqual({ phase: 'absent' });
  });

  it.each([
    [{ status: { phase: 'Pending' } }, { phase: 'starting' }],
    [
      { status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } },
      { phase: 'starting' },
    ],
    [{ status: { phase: 'Failed' } }, { phase: 'failed', reason: 'pod Failed' }],
    [
      {
        status: {
          phase: 'Pending',
          containerStatuses: [{ name: 'ide', state: { waiting: { reason: 'ImagePullBackOff' } } }],
        },
      },
      { phase: 'failed', reason: 'ImagePullBackOff' },
    ],
    [
      { status: { phase: 'Pending', initContainerStatuses: [{ state: { terminated: { exitCode: 128 } } }] } },
      { phase: 'failed', reason: 'git clone failed (exit 128)' },
    ],
  ])('maps pod %j to %j', async (pod, expected) => {
    const p = new KubernetesProvider({ api: fakeKube(pod).api, namespace: 'ns' });
    await p.ensureStarted(spec);
    expect(await p.status(ID)).toEqual(expected);
  });

  it('surfaces API errors', async () => {
    const api: KubeApi = { call: () => Promise.resolve({ status: 403, body: { message: 'forbidden' } }) };
    await expect(new KubernetesProvider({ api, namespace: 'ns' }).status(ID)).rejects.toThrow(
      KubernetesApiError,
    );
  });
});
