/**
 * @qe/runtime-providers — WorkspaceRuntimeProvider implementations that start, stop and locate
 * per-workspace runtimes (ADR-004): Docker for development and single hosts, Kubernetes for hosted mode.
 */
export const PACKAGE_NAME = '@qe/runtime-providers';

export {
  CLONE_SCRIPT,
  IDE_PORT,
  PROJECT_DIR,
  RuntimeProfiles,
  WORKSPACE_LABEL,
  assertWorkspaceId,
  cloneCommand,
  runtimeNames,
  type RuntimeProfile,
  type RuntimeSpec,
  type RuntimeStatus,
  type WorkspaceRuntimeProvider,
} from './types.js';
export { DockerEngineError, defaultDockerSocket, socketEngine, type DockerEngine } from './docker/engine.js';
export { DockerProvider, ideContainerSpec, type DockerProviderOptions } from './docker/docker-provider.js';
export { inClusterConnection, kubeApi, type KubeApi, type KubeConnection } from './kubernetes/kube-api.js';
export { KubernetesApiError, KubernetesProvider } from './kubernetes/kubernetes-provider.js';
export { podManifest, pvcManifest, serviceManifest, workspaceLabels } from './kubernetes/manifests.js';
