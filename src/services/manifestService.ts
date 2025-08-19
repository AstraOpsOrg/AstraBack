import type { AstraopsConfig, ServiceConfig } from '@/types'
import { mkdir } from 'node:fs/promises'

function renderEnv(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return ''
  const lines = Object.entries(env)
    .map(([k, v]) => `            - name: ${k}\n              value: "${String(v)}"`)
    .join('\n')
  return `\n          env:\n${lines}`
}

function renderDeployment(namespace: string, service: ServiceConfig, revision?: string): string {
  const image = service.image || 'nginx:alpine'
  const containerPort = service.port
  const wantsStorage = Boolean(service.storage)
  const volumeName = `${service.name}-data`
  const mountPath = '/data/db'
  const hasRevision = typeof revision === 'string' && revision.length > 0
  return [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    `  name: ${service.name}`,
    `  namespace: ${namespace}`,
    'spec:',
    '  replicas: 1',
    '  selector:',
    `    matchLabels: { app: ${service.name} }`,
    '  template:',
    '    metadata:',
    `      labels: { app: ${service.name} }`,
    hasRevision ? '      annotations:' : '',
    hasRevision ? `        astraops.io/revision: ${revision}` : '',
    '    spec:',
    '      containers:',
    `        - name: ${service.name}`,
    `          image: ${image}`,
    `          imagePullPolicy: Always`,
    `          ports: [{ containerPort: ${containerPort} }]${renderEnv(service.environment)}`,
    wantsStorage ? `          volumeMounts:\n            - name: ${volumeName}\n              mountPath: ${mountPath}` : '',
    wantsStorage ? `      volumes:\n        - name: ${volumeName}\n          persistentVolumeClaim:\n            claimName: ${service.name}-pvc` : '',
  ].filter(Boolean).join('\n')
}

function renderService(namespace: string, service: ServiceConfig): string {
  const port = service.port
  const isPublicFrontend = String(service.name).toLowerCase() === 'frontend'
  const servicePort = isPublicFrontend ? 80 : port
  return [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    `  name: ${service.name}`,
    `  namespace: ${namespace}`,
    'spec:',
    `  type: ${isPublicFrontend ? 'LoadBalancer' : 'ClusterIP'}`,
    `  selector: { app: ${service.name} }`,
    '  ports:',
    `    - port: ${servicePort}`,
    `      targetPort: ${port}`,
  ].join('\n')
}

function renderNamespace(namespace: string): string {
  return [
    'apiVersion: v1',
    'kind: Namespace',
    'metadata:',
    `  name: ${namespace}`,
  ].join('\n')
}

function renderPVC(namespace: string, service: ServiceConfig): string {
  return [
    'apiVersion: v1',
    'kind: PersistentVolumeClaim',
    'metadata:',
    `  name: ${service.name}-pvc`,
    `  namespace: ${namespace}`,
    'spec:',
    '  accessModes: [ "ReadWriteOnce" ]',
    '  resources:',
    '    requests:',
    `      storage: ${service.storage}`,
  ].join('\n')
}

// Generate dynamic multi-file manifests from astraops.yaml
export async function writeManifestsToDirectory(config: AstraopsConfig, targetDir: string, revision?: string): Promise<string> {
  await mkdir(targetDir, { recursive: true })
  const ns = config.applicationName
  const namespaceYaml = renderNamespace(ns) + '\n'
  await Bun.write(`${targetDir}/00-namespace.yaml`, namespaceYaml)

  for (const svc of config.services) {
    const deployYaml = renderDeployment(ns, svc, revision) + '\n'
    const serviceYaml = renderService(ns, svc) + '\n'
    await Bun.write(`${targetDir}/${svc.name}-deploy.yaml`, deployYaml)
    await Bun.write(`${targetDir}/${svc.name}-svc.yaml`, serviceYaml)
    if (svc.storage) {
      const pvcYaml = renderPVC(ns, svc) + '\n'
      await Bun.write(`${targetDir}/${svc.name}-pvc.yaml`, pvcYaml)
    }
  }
  return targetDir
}

