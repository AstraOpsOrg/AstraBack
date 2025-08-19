import type { DeployRequest } from '@/types'
import { jobService } from '@/services/jobService'
import { rm } from 'node:fs/promises'
import { streamRaw } from '@/services/streamService'
import { writeManifestsToDirectory } from '@/services/manifestService'

type StsLikeCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
}

export async function kubectlApply(
  jobId: string,
  request: DeployRequest,
  credentials: StsLikeCredentials
): Promise<{ success: boolean }> {
  try {
    // Generate ephemeral kubeconfig with AWS CLI
    const region = request.region 
    const envBase = {
      ...Bun.env,
      AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
      AWS_SESSION_TOKEN: credentials.SessionToken,
      AWS_DEFAULT_REGION: region,
    }

    const kubeconfigPath = `./iac/k8s/.kubeconfig-${jobId}`
    const clusterName = String(request.astraopsConfig?.applicationName)
    
    // wait for cluster active
    jobService.addLog(jobId, { phase: 'deployment', level: 'info', message: `Waiting for EKS cluster ACTIVE: ${clusterName}` })
    const waitCluster = Bun.spawn(['aws', 'eks', 'wait', 'cluster-active', '--name', clusterName, '--region', region], { stdout: 'pipe', stderr: 'pipe', env: envBase })
    await streamRaw(jobId, 'aws-eks:', waitCluster.stdout)
    await streamRaw(jobId, 'aws-eks:', waitCluster.stderr)
    if (await waitCluster.exited !== 0) {
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: `Cluster did not reach ACTIVE: ${clusterName}` })
      return { success: false }
    }
    // wait nodegroups active (best-effort)
    const listNg = Bun.spawn(['aws', 'eks', 'list-nodegroups', '--cluster-name', clusterName, '--region', region, '--output', 'json'], { stdout: 'pipe', stderr: 'pipe', env: envBase })
    const listText = await new Response(listNg.stdout).text()
    await new Response(listNg.stderr).text()
    if (await listNg.exited === 0) {
      try {
        const names: string[] = (JSON.parse(listText)?.nodegroups) || []
        for (const ng of names) {
          jobService.addLog(jobId, { phase: 'deployment', level: 'info', message: `Waiting for nodegroup ACTIVE: ${ng}` })
          const waitNg = Bun.spawn(['aws', 'eks', 'wait', 'nodegroup-active', '--cluster-name', clusterName, '--nodegroup-name', ng, '--region', region], { stdout: 'pipe', stderr: 'pipe', env: envBase })
          await streamRaw(jobId, 'aws-eks:', waitNg.stdout)
          await streamRaw(jobId, 'aws-eks:', waitNg.stderr)
          await waitNg.exited
        }
      } catch {}
    }
    // retry wrapper 
    async function retry<T>(label: string, fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
      let lastErr: any
      for (let i = 0; i < attempts; i++) {
        try { return await fn() } catch (e) {
          lastErr = e
          const remaining = attempts - i - 1
          if (remaining > 0) {
            jobService.addLog(jobId, { phase: 'deployment', level: 'info', message: `${label} failed. Retrying in ${Math.round(delayMs/1000)}s... (${remaining} attempts left)` })
            await Bun.sleep(delayMs)
          }
        }
      }
      throw lastErr
    }
    // update kubeconfig with retry
    const doUpdate = async () => {
      const update = Bun.spawn(['aws', 'eks', 'update-kubeconfig', '--name', clusterName, '--region', region, '--kubeconfig', kubeconfigPath], { stdout: 'pipe', stderr: 'pipe', env: envBase })
      await streamRaw(jobId, 'aws-eks:', update.stdout)
      await streamRaw(jobId, 'aws-eks:', update.stderr)
      const code = await update.exited
      if (code !== 0) throw new Error('update-kubeconfig failed')
    }
    try {
      await retry('update-kubeconfig', doUpdate, 3, 15000)
    } catch {
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: `aws eks update-kubeconfig failed (cluster: ${clusterName})` })
      return { success: false }
    }

    const env = { ...envBase, KUBECONFIG: kubeconfigPath }

    // Simple wait for access entries propagation - no complex validation
    jobService.addLog(jobId, { phase: 'deployment', level: 'info', message: 'Waiting for EKS access permissions to propagate...' })
    await Bun.sleep(10000) 

    // Generate yamls per service
    const appName = String(request.astraopsConfig?.applicationName || 'app')
    const outDir = `./iac/k8s/generated-${jobId}`
    const cleanupArtifacts = async () => {
      try { await rm(kubeconfigPath, { force: true }) } catch {}
      try { await rm(outDir, { recursive: true, force: true }) } catch {}
    }
    await writeManifestsToDirectory(request.astraopsConfig as any, outDir, jobId)
    jobService.addLog(jobId, { phase: 'deployment', level: 'info', message: `Applying manifests for ${appName}` })
    // wait nodes Ready (best-effort)
    const waitNodes = Bun.spawn(['kubectl', 'wait', 'nodes', '--for=condition=Ready', '--all', '--timeout=180s'], { stdout: 'pipe', stderr: 'pipe', env })
    await streamRaw(jobId, 'kubectl:', waitNodes.stdout)
    await streamRaw(jobId, 'kubectl:', waitNodes.stderr)
    await waitNodes.exited

    const doApply = async () => {
      // Apply namespace first to avoid "namespace not found"
      const nsFile = `${outDir}/00-namespace.yaml`
      const ns = Bun.spawn(['kubectl', 'apply', '--validate=false', '-f', nsFile], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'kubectl:', ns.stdout)
      await streamRaw(jobId, 'kubectl:', ns.stderr)
      await ns.exited

      const p = Bun.spawn(['kubectl', 'apply', '--server-side', '--force-conflicts', '--validate=false', '-f', outDir], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'kubectl:', p.stdout)
      await streamRaw(jobId, 'kubectl:', p.stderr)
      const code = await p.exited
      if (code !== 0) throw new Error('kubectl apply failed')
    }
    try {
      await retry('kubectl apply', doApply, 3, 20000)
    } catch {
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'kubectl apply failed' })
      await cleanupArtifacts()
      return { success: false }
    }
  // Global wait: all Deployments in the namespace become Available (up to 5 min)
    try {
      const waitAll = Bun.spawn(['kubectl', 'wait', 'deploy', '--for=condition=Available', '--all', '-n', appName, '--timeout=300s'], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'kubectl:', waitAll.stdout)
      await streamRaw(jobId, 'kubectl:', waitAll.stderr)
      const code = await waitAll.exited
      if (code !== 0) {
        jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'Deployments not Available within timeout. Collecting diagnostics...' })
    // Summary status
        const getAll = Bun.spawn(['kubectl', '-n', appName, 'get', 'deploy,rs,po', '-o', 'wide'], { stdout: 'pipe', stderr: 'pipe', env })
        await streamRaw(jobId, 'kubectl:', getAll.stdout)
        await streamRaw(jobId, 'kubectl:', getAll.stderr)
        await getAll.exited
    // Describe all deployments
        const desc = Bun.spawn(['kubectl', '-n', appName, 'describe', 'deploy', '--all'], { stdout: 'pipe', stderr: 'pipe', env })
        await streamRaw(jobId, 'kubectl:', desc.stdout)
        await streamRaw(jobId, 'kubectl:', desc.stderr)
        await desc.exited
    // Recent events
        const ev = Bun.spawn(['kubectl', '-n', appName, 'get', 'events', '--sort-by=.lastTimestamp'], { stdout: 'pipe', stderr: 'pipe', env })
        await streamRaw(jobId, 'kubectl:', ev.stdout)
        await streamRaw(jobId, 'kubectl:', ev.stderr)
        await ev.exited
    // Logs from problematic pods (ImagePull/CrashLoop)
        try {
          const podsJson = Bun.spawn(['kubectl', 'get', 'pods', '-n', appName, '-o', 'json'], { stdout: 'pipe', stderr: 'pipe', env })
          const out = await new Response(podsJson.stdout).text()
          await new Response(podsJson.stderr).text()
          const data = JSON.parse(out)
          const badPods = (data.items || []).filter((pod: any) => (pod?.status?.containerStatuses || []).some((cs: any) => {
            const reason = cs?.state?.waiting?.reason || cs?.state?.terminated?.reason || ''
            return /ImagePull|ErrImagePull|ImagePullBackOff|CrashLoopBackOff/i.test(reason)
          }))
          for (const pod of badPods) {
            const podName = pod?.metadata?.name || 'pod'
            const lg = Bun.spawn(['kubectl', '-n', appName, 'logs', podName, '--all-containers', '--tail=200'], { stdout: 'pipe', stderr: 'pipe', env })
            await streamRaw(jobId, 'kubectl:', lg.stdout)
            await streamRaw(jobId, 'kubectl:', lg.stderr)
            await lg.exited
          }
        } catch {}
        await cleanupArtifacts()
        return { success: false }
      }
    } catch {
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'kubectl wait (Available) failed' })
      await cleanupArtifacts()
      return { success: false }
    }

    // Wait for the frontend Service (LoadBalancer) to get hostname/ip and publish it
    try {
      const ns = appName
      const getSvc = () => Bun.spawn(['kubectl', 'get', 'svc', 'frontend', '-n', ns, '-o', 'json'], { stdout: 'pipe', stderr: 'pipe', env })
      let hostname = ''
      let ip = ''
      for (let i = 0; i < 15; i++) { // ~75s
        const p = getSvc()
        const out = await new Response(p.stdout).text()
        await new Response(p.stderr).text()
        await p.exited
        try {
          const svc = JSON.parse(out)
          const ingress = svc?.status?.loadBalancer?.ingress || []
          if (ingress.length) {
            hostname = ingress[0].hostname || ''
            ip = ingress[0].ip || ''
          }
          if (hostname || ip) break
        } catch {}
        await Bun.sleep(5000)
      }
      const url = hostname ? `http://${hostname}` : (ip ? `http://${ip}` : '')
      if (url) {
        jobService.addLog(jobId, { phase: 'deployment', level: 'success', message: `Frontend public URL: ${url}` })
      } else {
        jobService.addLog(jobId, { phase: 'deployment', level: 'warn', message: 'Frontend LoadBalancer pending (no hostname/ip yet)' })
      }
    } catch {
      jobService.addLog(jobId, { phase: 'deployment', level: 'warn', message: 'Failed to resolve frontend Service URL' })
    }
    jobService.addLog(jobId, { phase: 'deployment', level: 'success', message: 'kubectl apply completed' })
    await cleanupArtifacts()
    return { success: true }
  } catch (e) {
    jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'kubectl execution error (not installed?)' })
    try { await rm(`./iac/k8s/.kubeconfig-${jobId}`, { force: true }) } catch {}
    try { await rm(`./iac/k8s/generated-${jobId}`, { recursive: true, force: true }) } catch {}
    return { success: false }
  }
}


