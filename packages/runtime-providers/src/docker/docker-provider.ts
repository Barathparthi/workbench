import {
  cloneCommand,
  IDE_PORT,
  PROJECT_DIR,
  RUNTIME_UID,
  runtimeNames,
  RuntimeProfiles,
  toBytes,
  toNanoCpus,
  WORKSPACE_LABEL,
  type RuntimeSpec,
  type RuntimeStatus,
  type WorkspaceRuntimeProvider,
} from '../types.js';
import { DockerEngineError, expectStatus, type DockerEngine } from './engine.js';

export interface DockerProviderOptions {
  readonly engine: DockerEngine;
  /** Bridge network for workspaces; created if missing. Keep it without routes to lab networks. */
  readonly network: string;
  /**
   * `published`: the IDE port is published on 127.0.0.1 (control plane on the host — development).
   * `network`: the control plane shares `network` and reaches http://<container>:3000.
   */
  readonly endpointMode: 'published' | 'network';
  /** Maximum time for the first-start git clone. */
  readonly cloneTimeoutSec?: number;
}

interface ContainerInspect {
  State?: { Running?: boolean; Status?: string; ExitCode?: number };
  NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

const enc = encodeURIComponent;
const tcp = `${String(IDE_PORT)}/tcp`;

/** Container create body for the IDE: non-root, no capabilities, no new privileges, bounded resources. */
export function ideContainerSpec(
  spec: RuntimeSpec,
  options: Pick<DockerProviderOptions, 'network' | 'endpointMode'>,
) {
  const names = runtimeNames(spec.workspaceId);
  const r = RuntimeProfiles[spec.profile];
  return {
    Image: spec.image,
    User: `${String(RUNTIME_UID)}:${String(RUNTIME_UID)}`,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: { [WORKSPACE_LABEL]: spec.workspaceId, 'app.kubernetes.io/part-of': 'qe-workspace' },
    ExposedPorts: { [tcp]: {} },
    HostConfig: {
      Memory: toBytes(r.memory),
      MemorySwap: toBytes(r.memory), // no swap beyond the limit
      NanoCpus: toNanoCpus(r.cpu),
      PidsLimit: r.pids,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Privileged: false,
      // The root filesystem stays writable for now: Theia keeps user settings under /home/qe/.theia.
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=512m' },
      Mounts: [{ Type: 'volume', Source: names.volume, Target: PROJECT_DIR }],
      NetworkMode: options.network,
      RestartPolicy: { Name: 'no' },
      ...(options.endpointMode === 'published' && {
        PortBindings: { [tcp]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      }),
    },
  };
}

/** Docker-backed runtimes for development and single-host team servers (Phase 05 §5.2). */
export class DockerProvider implements WorkspaceRuntimeProvider {
  readonly kind = 'docker';
  constructor(private readonly options: DockerProviderOptions) {}

  private get engine(): DockerEngine {
    return this.options.engine;
  }

  async ensureStarted(spec: RuntimeSpec): Promise<RuntimeStatus> {
    const names = runtimeNames(spec.workspaceId);
    await this.ensureNetwork();
    await this.ensureImage(spec.image);
    const freshVolume = await this.ensureVolume(names.volume, spec.workspaceId);
    if (freshVolume && spec.git !== undefined) await this.clone(spec, names.volume);

    const existing = await this.inspect(names.container);
    if (existing === undefined) {
      await expectStatus(
        this.engine,
        [201],
        'POST',
        `/containers/create?name=${enc(names.container)}`,
        ideContainerSpec(spec, this.options),
      );
    }
    if (existing?.State?.Running !== true) {
      await expectStatus(this.engine, [204, 304], 'POST', `/containers/${enc(names.container)}/start`);
    }
    return this.status(spec.workspaceId);
  }

  async ensureStopped(workspaceId: string): Promise<void> {
    const { container } = runtimeNames(workspaceId);
    await expectStatus(this.engine, [204, 304, 404], 'POST', `/containers/${enc(container)}/stop?t=10`);
    await expectStatus(this.engine, [204, 404], 'DELETE', `/containers/${enc(container)}?force=true`);
  }

  async status(workspaceId: string): Promise<RuntimeStatus> {
    const names = runtimeNames(workspaceId);
    const c = await this.inspect(names.container);
    if (c === undefined) {
      const volume = await this.engine.call('GET', `/volumes/${enc(names.volume)}`);
      return { phase: volume.status === 200 ? 'stopped' : 'absent' };
    }
    if (c.State?.Running === true) {
      const endpoint = this.endpoint(names.container, c);
      return endpoint === undefined ? { phase: 'starting' } : { phase: 'running', endpoint };
    }
    if (c.State?.Status === 'created' || c.State?.Status === 'restarting') return { phase: 'starting' };
    return {
      phase: 'failed',
      reason: `container ${c.State?.Status ?? 'unknown'} (exit ${String(c.State?.ExitCode ?? '?')})`,
    };
  }

  async destroy(workspaceId: string): Promise<void> {
    await this.ensureStopped(workspaceId);
    await expectStatus(
      this.engine,
      [204, 404],
      'DELETE',
      `/volumes/${enc(runtimeNames(workspaceId).volume)}`,
    );
  }

  async listRuntimes(): Promise<string[]> {
    const filters = enc(JSON.stringify({ label: [WORKSPACE_LABEL] }));
    const res = await expectStatus(this.engine, [200], 'GET', `/containers/json?all=true&filters=${filters}`);
    const list = Array.isArray(res.body) ? (res.body as { Labels?: Record<string, string> }[]) : [];
    return [
      ...new Set(list.map((c) => c.Labels?.[WORKSPACE_LABEL]).filter((v): v is string => v !== undefined)),
    ];
  }

  private endpoint(container: string, c: ContainerInspect): string | undefined {
    if (this.options.endpointMode === 'network') return `http://${container}:${String(IDE_PORT)}`;
    const binding = c.NetworkSettings?.Ports?.[tcp]?.[0];
    return binding?.HostPort ? `http://127.0.0.1:${binding.HostPort}` : undefined;
  }

  private async inspect(container: string): Promise<ContainerInspect | undefined> {
    const res = await expectStatus(this.engine, [200, 404], 'GET', `/containers/${enc(container)}/json`);
    return res.status === 404 ? undefined : (res.body as ContainerInspect);
  }

  private async ensureNetwork(): Promise<void> {
    const res = await this.engine.call('GET', `/networks/${enc(this.options.network)}`);
    if (res.status === 200) return;
    await expectStatus(this.engine, [201, 409], 'POST', '/networks/create', {
      Name: this.options.network,
      Driver: 'bridge',
      Labels: { 'app.kubernetes.io/part-of': 'qe-workspace' },
    });
  }

  private async ensureImage(image: string): Promise<void> {
    const res = await this.engine.call('GET', `/images/${enc(image)}/json`);
    if (res.status === 200) return;
    await expectStatus(this.engine, [200], 'POST', `/images/create?fromImage=${enc(image)}`);
    const check = await this.engine.call('GET', `/images/${enc(image)}/json`);
    if (check.status !== 200) throw new DockerEngineError(check.status, `image ${image} could not be pulled`);
  }

  /** True when the volume was created now (first start). */
  private async ensureVolume(name: string, workspaceId: string): Promise<boolean> {
    const res = await this.engine.call('GET', `/volumes/${enc(name)}`);
    if (res.status === 200) return false;
    await expectStatus(this.engine, [201], 'POST', '/volumes/create', {
      Name: name,
      Labels: { [WORKSPACE_LABEL]: workspaceId },
    });
    return true;
  }

  private async clone(spec: RuntimeSpec, volume: string): Promise<void> {
    if (spec.git === undefined) return;
    const name = `${runtimeNames(spec.workspaceId).container}-clone`;
    await expectStatus(this.engine, [204, 404], 'DELETE', `/containers/${enc(name)}?force=true`);
    await expectStatus(this.engine, [201], 'POST', `/containers/create?name=${enc(name)}`, {
      Image: spec.image,
      User: `${String(RUNTIME_UID)}:${String(RUNTIME_UID)}`,
      Entrypoint: [],
      Cmd: cloneCommand(spec.git),
      Labels: { 'qews.clone-of': spec.workspaceId },
      HostConfig: {
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Mounts: [{ Type: 'volume', Source: volume, Target: PROJECT_DIR }],
        NetworkMode: this.options.network,
        Memory: toBytes('1Gi'),
        PidsLimit: 256,
      },
    });
    try {
      await expectStatus(this.engine, [204], 'POST', `/containers/${enc(name)}/start`);
      const wait = await Promise.race([
        expectStatus(this.engine, [200], 'POST', `/containers/${enc(name)}/wait`),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => {
              reject(new Error('git clone timed out'));
            },
            (this.options.cloneTimeoutSec ?? 300) * 1000,
          ).unref(),
        ),
      ]);
      const code = (wait.body as { StatusCode?: number }).StatusCode;
      if (code !== 0) throw new Error(`git clone failed (exit ${String(code)})`);
    } catch (error) {
      // A failed clone must not leave a half-filled volume that would skip the clone next time.
      await expectStatus(this.engine, [204, 404], 'DELETE', `/containers/${enc(name)}?force=true`);
      await expectStatus(this.engine, [204, 404, 409], 'DELETE', `/volumes/${enc(volume)}`);
      throw error;
    }
    await expectStatus(this.engine, [204, 404], 'DELETE', `/containers/${enc(name)}?force=true`);
  }
}
