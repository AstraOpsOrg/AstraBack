import { streamRaw } from '@/services/streamService'

export async function setupMonitoringAndGetUrl(
  namespace: string,
  region: string,
  clusterName: string,
  credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string },
  jobId: string
): Promise<string> {
  // Prepare AWS env and kubeconfig targeting USER'S EKS cluster
  const envBase = {
    ... Bun.env,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_DEFAULT_REGION: region,
  }
  const kubeconfigPath = `./iac/k8s/.kubeconfig-monitoring-${Date.now()}`
  const upd = Bun.spawn(['aws', 'eks', 'update-kubeconfig', '--name', clusterName, '--region', region, '--kubeconfig', kubeconfigPath], { stdout: 'pipe', stderr: 'pipe', env: envBase })
  await Promise.all([streamRaw(jobId, 'aws-eks:', upd.stdout), streamRaw(jobId, 'aws-eks:', upd.stderr)])
  const updExit = await upd.exited
  if (updExit !== 0) throw new Error('aws eks update-kubeconfig failed')
  const env = { ...envBase, KUBECONFIG: kubeconfigPath }

  // Add repo (ignore errors if exists)
  try {
    const add = Bun.spawn(['helm', 'repo', 'add', 'prometheus-community', 'https://prometheus-community.github.io/helm-charts'], { stdout: 'pipe', stderr: 'pipe', env })
    await Promise.all([streamRaw(jobId, 'helm:', add.stdout), streamRaw(jobId, 'helm:', add.stderr)])
    await add.exited
  } catch {}

  // Update repos
  try {
    const upd2 = Bun.spawn(['helm', 'repo', 'update'], { stdout: 'pipe', stderr: 'pipe', env })
    await Promise.all([streamRaw(jobId, 'helm:', upd2.stdout), streamRaw(jobId, 'helm:', upd2.stderr)])
    await upd2.exited
  } catch {}

  // Install/upgrade kube-prometheus-stack exposing Grafana via LoadBalancer
  const install = Bun.spawn([
    'helm', 'upgrade', '--install', 'monitoring', 'prometheus-community/kube-prometheus-stack',
    '-n', 'monitoring', '--create-namespace', '--wait',
    '--set', 'grafana.service.type=LoadBalancer'
  ], { stdout: 'pipe', stderr: 'pipe', env })
  await Promise.all([streamRaw(jobId, 'helm:', install.stdout), streamRaw(jobId, 'helm:', install.stderr)])
  const code = await install.exited
  if (code !== 0) throw new Error('helm upgrade --install failed')

  // Get Grafana service hostname/IP
  const get = Bun.spawn(['kubectl', '-n', 'monitoring', 'get', 'svc', 'monitoring-grafana', '-o', 'json'], { stdout: 'pipe', stderr: 'pipe', env })
  const out = await new Response(get.stdout).text()
  await streamRaw(jobId, 'kubectl:', get.stderr)
  const ok = await get.exited
  if (ok !== 0) throw new Error('failed to get grafana svc')
  const svc = JSON.parse(out)
  const ingress = svc?.status?.loadBalancer?.ingress?.[0]
  const host = ingress?.hostname || ingress?.ip
  if (!host) throw new Error('grafana LoadBalancer not ready')
  const base = `http://${host}`

  // Default dashboard from kube-prometheus-stack (namespace pods)
  const path = `/d/k8s-resources-namespace/kubernetes-compute-resources-namespace-pods?var-namespace=${encodeURIComponent(namespace)}`
  const url = `${base}${path}`
  // Best-effort cleanup kubeconfig
  try { await Bun.write(kubeconfigPath, '') } catch {}
  return url
}


