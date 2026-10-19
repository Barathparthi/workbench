import {
  cloneCommand,
  IDE_PORT,
  PROJECT_DIR,
  RUNTIME_UID,
  runtimeNames,
  RuntimeProfiles,
  WORKSPACE_LABEL,
  type RuntimeSpec,
} from '../types.js';

/** Labels on every workspace object; the selector uses only the workspace id. */
export const workspaceLabels = (workspaceId: string) => ({
  [WORKSPACE_LABEL]: workspaceId,
  'app.kubernetes.io/part-of': 'qe-workspace',
  'app.kubernetes.io/component': 'workspace-runtime',
});

/** Container security context compatible with Pod Security Standard "restricted" (07 §5, Phase 16). */
const restrictedContainer = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  runAsNonRoot: true,
  runAsUser: RUNTIME_UID,
  runAsGroup: RUNTIME_UID,
  seccompProfile: { type: 'RuntimeDefault' },
};

export function pvcManifest(spec: RuntimeSpec, storageClass?: string) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: runtimeNames(spec.workspaceId).pvc, labels: workspaceLabels(spec.workspaceId) },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: RuntimeProfiles[spec.profile].disk } },
      ...(storageClass !== undefined && { storageClassName: storageClass }),
    },
  };
}

export function serviceManifest(workspaceId: string) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: runtimeNames(workspaceId).service, labels: workspaceLabels(workspaceId) },
    spec: {
      type: 'ClusterIP',
      selector: { [WORKSPACE_LABEL]: workspaceId },
      ports: [{ name: 'ide', port: IDE_PORT, targetPort: IDE_PORT, protocol: 'TCP' }],
    },
  };
}

/** One pod per running workspace (ADR-004): no service-account token, no service links, restricted. */
export function podManifest(spec: RuntimeSpec) {
  const names = runtimeNames(spec.workspaceId);
  const r = RuntimeProfiles[spec.profile];
  const mounts = [
    { name: 'project', mountPath: PROJECT_DIR },
    { name: 'tmp', mountPath: '/tmp' },
  ];
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: names.container, labels: workspaceLabels(spec.workspaceId) },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: 'Always',
      terminationGracePeriodSeconds: 30,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: RUNTIME_UID,
        runAsGroup: RUNTIME_UID,
        fsGroup: RUNTIME_UID,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      ...(spec.git !== undefined && {
        initContainers: [
          {
            name: 'git-clone',
            image: spec.image,
            command: cloneCommand(spec.git),
            securityContext: restrictedContainer,
            resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
            volumeMounts: mounts,
          },
        ],
      }),
      containers: [
        {
          name: 'ide',
          image: spec.image,
          ports: [{ name: 'ide', containerPort: IDE_PORT }],
          env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
          securityContext: restrictedContainer,
          resources: {
            requests: { cpu: `${String(Number(r.cpu) * 250)}m`, memory: r.memory },
            limits: { cpu: r.cpu, memory: r.memory, 'ephemeral-storage': '5Gi' },
          },
          startupProbe: { tcpSocket: { port: IDE_PORT }, periodSeconds: 2, failureThreshold: 90 },
          readinessProbe: { tcpSocket: { port: IDE_PORT }, periodSeconds: 5 },
          volumeMounts: mounts,
        },
      ],
      volumes: [
        { name: 'project', persistentVolumeClaim: { claimName: names.pvc } },
        { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
      ],
    },
  };
}
