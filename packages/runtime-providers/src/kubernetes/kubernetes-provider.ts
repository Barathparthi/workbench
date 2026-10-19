import {
  IDE_PORT,
  runtimeNames,
  WORKSPACE_LABEL,
  type RuntimeSpec,
  type RuntimeStatus,
  type WorkspaceRuntimeProvider,
} from '../types.js';
import type { KubeApi } from './kube-api.js';
import { podManifest, pvcManifest, serviceManifest } from './manifests.js';

export interface KubernetesProviderOptions {
  readonly api: KubeApi;
  readonly namespace: string;
  readonly storageClass?: string | undefined;
}

export class KubernetesApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`kubernetes api ${String(status)}: ${message}`);
    this.name = 'KubernetesApiError';
  }
}

interface PodStatus {
  status?: {
    phase?: string;
    conditions?: { type: string; status: string }[];
    containerStatuses?: { name: string; state?: { waiting?: { reason?: string } } }[];
    initContainerStatuses?: { state?: { terminated?: { exitCode?: number } } }[];
  };
}

/** Waiting reasons that will not fix themselves: report FAILED instead of waiting for the start timeout. */
const STUCK = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'InvalidImageName',
]);

/** Kubernetes-backed runtimes for hosted mode (Phase 05 §5.3): PVC + Pod + ClusterIP Service per workspace. */
export class KubernetesProvider implements WorkspaceRuntimeProvider {
  readonly kind = 'kubernetes';
  constructor(private readonly options: KubernetesProviderOptions) {}

  private path(kind: 'pods' | 'services' | 'persistentvolumeclaims', name?: string): string {
    const ns = encodeURIComponent(this.options.namespace);
    return `/api/v1/namespaces/${ns}/${kind}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;
  }

  private async expect(ok: number[], method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    const res = await this.options.api.call(method, path, body);
    if (!ok.includes(res.status)) {
      const message =
        typeof res.body === 'object' && res.body !== null && 'message' in res.body
          ? String((res.body as { message: unknown }).message)
          : `${method} ${path}`;
      throw new KubernetesApiError(res.status, message);
    }
    return res;
  }

  async ensureStarted(spec: RuntimeSpec): Promise<RuntimeStatus> {
    // 409 = already exists: every step is safe to repeat.
    await this.expect(
      [201, 409],
      'POST',
      this.path('persistentvolumeclaims'),
      pvcManifest(spec, this.options.storageClass),
    );
    await this.expect([201, 409], 'POST', this.path('services'), serviceManifest(spec.workspaceId));
    await this.expect([201, 409], 'POST', this.path('pods'), podManifest(spec));
    return this.status(spec.workspaceId);
  }

  async ensureStopped(workspaceId: string): Promise<void> {
    const names = runtimeNames(workspaceId);
    await this.expect([200, 202, 404], 'DELETE', this.path('pods', names.container));
    await this.expect([200, 202, 404], 'DELETE', this.path('services', names.service));
  }

  async status(workspaceId: string): Promise<RuntimeStatus> {
    const names = runtimeNames(workspaceId);
    const res = await this.expect([200, 404], 'GET', this.path('pods', names.container));
    if (res.status === 404) {
      const pvc = await this.expect([200, 404], 'GET', this.path('persistentvolumeclaims', names.pvc));
      return { phase: pvc.status === 200 ? 'stopped' : 'absent' };
    }
    const pod = res.body as PodStatus;
    const phase = pod.status?.phase;
    if (phase === 'Failed' || phase === 'Succeeded') return { phase: 'failed', reason: `pod ${phase}` };
    const clone = pod.status?.initContainerStatuses?.[0]?.state?.terminated?.exitCode;
    if (clone !== undefined && clone !== 0)
      return { phase: 'failed', reason: `git clone failed (exit ${String(clone)})` };
    const waiting = pod.status?.containerStatuses?.find((c) => c.name === 'ide')?.state?.waiting?.reason;
    if (waiting !== undefined && STUCK.has(waiting)) return { phase: 'failed', reason: waiting };
    const ready = pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true;
    if (phase === 'Running' && ready) {
      const ns = this.options.namespace;
      return { phase: 'running', endpoint: `http://${names.service}.${ns}.svc:${String(IDE_PORT)}` };
    }
    return { phase: 'starting' };
  }

  async destroy(workspaceId: string): Promise<void> {
    await this.ensureStopped(workspaceId);
    await this.expect(
      [200, 202, 404],
      'DELETE',
      this.path('persistentvolumeclaims', runtimeNames(workspaceId).pvc),
    );
  }

  async listRuntimes(): Promise<string[]> {
    const res = await this.expect(
      [200],
      'GET',
      `${this.path('pods')}?labelSelector=${encodeURIComponent(WORKSPACE_LABEL)}`,
    );
    const items = (res.body as { items?: { metadata?: { labels?: Record<string, string> } }[] }).items ?? [];
    return [
      ...new Set(
        items.map((i) => i.metadata?.labels?.[WORKSPACE_LABEL]).filter((v): v is string => v !== undefined),
      ),
    ];
  }
}
