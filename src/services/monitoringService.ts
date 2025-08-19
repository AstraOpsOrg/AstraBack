import { streamRaw } from '@/services/streamService'
import { jobService } from '@/services/jobService'
import { rm } from 'node:fs/promises'

export async function setupMonitoringAndGetUrl(
  region: string,
  clusterName: string,
  credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string },
  jobId: string
): Promise<{ url: string; username: string; password: string }> {
  jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Starting monitoring setup (Grafana)' })
  
  // Prepare AWS env and kubeconfig targeting USER'S EKS cluster
  const envBase = {
    ... Bun.env,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_DEFAULT_REGION: region,
  }
  const kubeconfigPath = `./iac/k8s/.kubeconfig-monitoring-${Date.now()}`
  try {
    jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Configuring kubectl access to user cluster' })
    const upd = Bun.spawn(['aws', 'eks', 'update-kubeconfig', '--name', clusterName, '--region', region, '--kubeconfig', kubeconfigPath], { stdout: 'pipe', stderr: 'pipe', env: envBase })
    await Promise.all([streamRaw(jobId, 'aws-eks:', upd.stdout), streamRaw(jobId, 'aws-eks:', upd.stderr)])
    const updExit = await upd.exited
    if (updExit !== 0) throw new Error('aws eks update-kubeconfig failed')
    const env = { ...envBase, KUBECONFIG: kubeconfigPath }

  // Add repo (ignore errors if exists)
  jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Adding Prometheus community Helm repository' })
  try {
    const add = Bun.spawn(['helm', 'repo', 'add', 'prometheus-community', 'https://prometheus-community.github.io/helm-charts'], { stdout: 'pipe', stderr: 'pipe', env })
    await Promise.all([streamRaw(jobId, 'helm:', add.stdout), streamRaw(jobId, 'helm:', add.stderr)])
    await add.exited
  } catch {}

  // Update repos
  jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Updating Helm repositories' })
  try {
    const upd2 = Bun.spawn(['helm', 'repo', 'update'], { stdout: 'pipe', stderr: 'pipe', env })
    await Promise.all([streamRaw(jobId, 'helm:', upd2.stdout), streamRaw(jobId, 'helm:', upd2.stderr)])
    await upd2.exited
  } catch {}

  // Install/upgrade kube-prometheus-stack exposing Grafana via LoadBalancer
  // Set explicit admin credentials (prototype): admin/admin
  jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Launching Helm deployment: kube-prometheus-stack with Grafana LoadBalancer' })
  const install = Bun.spawn([
    'helm', 'upgrade', '--install', 'monitoring', 'prometheus-community/kube-prometheus-stack',
    '-n', 'monitoring', '--create-namespace', '--wait',
    '--set', 'grafana.service.type=LoadBalancer',
    '--set', 'grafana.adminUser=admin',
    '--set', 'grafana.adminPassword=admin'
  ], { stdout: 'pipe', stderr: 'pipe', env })
  await Promise.all([streamRaw(jobId, 'helm:', install.stdout), streamRaw(jobId, 'helm:', install.stderr)])
  const code = await install.exited
  if (code !== 0) throw new Error('helm upgrade --install failed')

  // Ensure the running Grafana admin password is reset even if release already existed
  jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Configuring Grafana admin credentials' })
  try {
    // Wait for the grafana deployment to be ready
    const rollout = Bun.spawn(['kubectl', '-n', 'monitoring', 'rollout', 'status', 'deploy/monitoring-grafana', '--timeout=5m'], { stdout: 'pipe', stderr: 'pipe', env })
    await Promise.all([streamRaw(jobId, 'kubectl:', rollout.stdout), streamRaw(jobId, 'kubectl:', rollout.stderr)])
    await rollout.exited

    // Get a grafana pod name
    const getPod = Bun.spawn(['kubectl', '-n', 'monitoring', 'get', 'pod', '-l', 'app.kubernetes.io/name=grafana', '-o', 'jsonpath={.items[0].metadata.name}'], { stdout: 'pipe', stderr: 'pipe', env })
    const podName = (await new Response(getPod.stdout).text()).trim()
    await streamRaw(jobId, 'kubectl:', getPod.stderr)
    await getPod.exited
    if (podName) {
      const reset = Bun.spawn(['kubectl', '-n', 'monitoring', 'exec', podName, '--', 'grafana', 'cli', 'admin', 'reset-admin-password', 'admin'], { stdout: 'pipe', stderr: 'pipe', env })
      await Promise.all([streamRaw(jobId, 'kubectl:', reset.stdout), streamRaw(jobId, 'kubectl:', reset.stderr)])
      await reset.exited
    }
  } catch {}

    // Get Grafana service hostname/IP
    jobService.addLog(jobId, { phase: 'monitoring', level: 'info', message: 'Retrieving Grafana LoadBalancer endpoint' })
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

    const finalUrl = `${base}/dashboards`

    try { jobService.addLog(jobId, { phase: 'monitoring', level: 'success', message: `Monitoring setup completed: ${finalUrl}` }) } catch {}
    
    return { url: finalUrl, username: 'admin', password: 'admin' }
  } finally {
    try { await rm(kubeconfigPath, { force: true }) } catch {}
  }
}


