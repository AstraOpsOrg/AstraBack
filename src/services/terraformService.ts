import type { DeployRequest } from '@/types'
import { jobService } from '@/services/jobService'
import { streamRaw } from '@/services/streamService'

type StsLikeCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
}

export async function runTerraformApply(
  jobId: string,
  request: DeployRequest,
  credentials: StsLikeCredentials,
  opts?: { directory?: string }
): Promise<{ success: boolean }> {
  const region = request.region 
  const env = {
    ...Bun.env,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_DEFAULT_REGION: region
  }

  const defaultDir = './iac/terraform'
  const workdir = opts?.directory || defaultDir
  jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Terraform directory (backend): ${workdir}` })

  try {
    // Check terraform presence
    const check = Bun.spawn(['terraform', 'version'], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
    await streamRaw(jobId, 'terraform:', check.stdout)
    await streamRaw(jobId, 'terraform:', check.stderr)
    const checkExit = await check.exited
    if (checkExit !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform not available or directory missing.' })
      return { success: false }
    }

    // Init with S3 backend (bucket per account)
    const bucketName = `astraops-tfstate-${request.accountId}`
    const stateKey = 'infrastructure/terraform.tfstate'

    // Ensure backend bucket exists and report whether remote state exists
    try {
      // Check bucket
      const headBucket = Bun.spawn(['aws', 's3api', 'head-bucket', '--bucket', bucketName, '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
      await new Response(headBucket.stdout).text();
      await new Response(headBucket.stderr).text();
      const headExit = await headBucket.exited
      if (headExit !== 0) {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `S3 backend bucket not found. Creating: ${bucketName}` })
        const args = ['s3api', 'create-bucket', '--bucket', bucketName, '--region', region]
        if (region !== 'us-east-1') {
          args.push('--create-bucket-configuration', `LocationConstraint=${region}`)
        }
        const create = Bun.spawn(['aws', ...args], { stdout: 'pipe', stderr: 'pipe', env })
        await streamRaw(jobId, 'terraform:', create.stdout)
        await streamRaw(jobId, 'terraform:', create.stderr)
        const createExit = await create.exited
        if (createExit === 0) {
          jobService.addLog(jobId, { phase: 'infrastructure', level: 'success', message: `S3 bucket created: ${bucketName}` })
          // Best-effort enable versioning
          try {
            const vers = Bun.spawn(['aws', 's3api', 'put-bucket-versioning', '--bucket', bucketName, '--versioning-configuration', 'Status=Enabled', '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
            await streamRaw(jobId, 'terraform:', vers.stdout)
            await streamRaw(jobId, 'terraform:', vers.stderr)
            await vers.exited
          } catch {}
        } else {
          jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: `Failed to create S3 bucket: ${bucketName}` })
          return { success: false }
        }
      } else {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `S3 backend bucket exists: ${bucketName}` })
      }

      // Check if remote state object exists
      const headObj = Bun.spawn(['aws', 's3api', 'head-object', '--bucket', bucketName, '--key', stateKey, '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
      await new Response(headObj.stdout).text();
      await new Response(headObj.stderr).text();
      const headObjExit = await headObj.exited
      if (headObjExit !== 0) {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `No existing remote state at ${bucketName}/${stateKey} (first run).` })
      } else {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Existing remote state found at ${bucketName}/${stateKey}.` })
      }
    } catch {
    }

    jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Running terraform init (S3 backend: ${bucketName}/${stateKey})...` })
    const init = Bun.spawn([
      'terraform', 'init', '-input=false', '-reconfigure',
      `-backend-config=bucket=${bucketName}`,
      `-backend-config=key=${stateKey}`,
      `-backend-config=region=${region}`,
      '-backend-config=encrypt=true'
    ], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
    await streamRaw(jobId, 'terraform:', init.stdout)
    await streamRaw(jobId, 'terraform:', init.stderr)
    const initExit = await init.exited
    if (initExit !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform init failed' })
      return { success: false }
    }

    // Wait for any in-flight cluster updates (if any) to avoid 409/ResourceInUse
    const clusterName = String(request.astraopsConfig?.applicationName)
    try {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Checking in-flight EKS updates for cluster: ${clusterName}` })
      const waitOk = await waitForEksNoInProgressUpdates(jobId, clusterName, region, env)
      if (!waitOk) {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Proceeding despite update check timeout (best-effort)' })
      }
    } catch {}

    // Plan + Apply (plan decides if there are changes)
    const accessPrincipalsList = request.roleArn ? `["${request.roleArn}"]` : '[]'
    const tfVars = [
      `-var=region=${request.region}`,
      `-var=cluster_name=${clusterName}`,
      `-var=access_principals=${accessPrincipalsList}`,
      request.roleArn ? `-var=execution_role_arn=${request.roleArn}` : '',
    ]

    jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Running terraform plan (detailed-exitcode)...' })
    const plan = Bun.spawn(['terraform', 'plan', '-detailed-exitcode', '-input=false', ...tfVars], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
    await streamRaw(jobId, 'terraform:', plan.stdout)
    await streamRaw(jobId, 'terraform:', plan.stderr)
    const planExit = await plan.exited

    if (planExit === 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'success', message: 'Infrastructure up-to-date (no changes)' })
      return { success: true }
    }
    if (planExit !== 2) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform plan failed' })
      return { success: false }
    }

    // Preventive attempt: delete orphaned KMS alias if it exists
    try {
      const alias = `alias/eks/${clusterName}`
      const describe = Bun.spawn(['aws', 'kms', 'list-aliases', '--query', `Aliases[?AliasName=='${alias}'].AliasName`, '--output', 'text', '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
      const out = await new Response(describe.stdout).text()
      await describe.exited
      if (out.trim() === alias) {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Found existing KMS alias ${alias}, deleting (best-effort)...` })
        const del = Bun.spawn(['aws', 'kms', 'delete-alias', '--alias-name', alias, '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
        await streamRaw(jobId, 'terraform:', del.stdout)
        await streamRaw(jobId, 'terraform:', del.stderr)
        await del.exited
      }
    } catch {}

    jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Changes detected. Running terraform apply...' })
    const runApply = async () => {
      const p = Bun.spawn(['terraform', 'apply', '-auto-approve', '-input=false', ...tfVars], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
      await streamRaw(jobId, 'terraform:', p.stdout)
      await streamRaw(jobId, 'terraform:', p.stderr)
      return await p.exited
    }
    // Retry if the cluster has simultaneous updates
    let applyExit = await runApply()
    if (applyExit !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Apply failed; waiting for in-flight EKS updates (best-effort) and retrying...' })
      await waitForEksNoInProgressUpdates(jobId, clusterName, region, env)
      await Bun.sleep(15000)
      applyExit = await runApply()
    }
    if (applyExit !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform apply failed' })
      return { success: false }
    }

    jobService.addLog(jobId, { phase: 'infrastructure', level: 'success', message: 'Terraform apply completed' })
    return { success: true }
  } catch (e) {
    jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform execution error (spawn failed or not installed)' })
    return { success: false }
  }
}

async function waitForEksNoInProgressUpdates(jobId: string, clusterName: string, region: string, env: Record<string, string>): Promise<boolean> {
  const maxAttempts = 20
  for (let i = 0; i < maxAttempts; i++) {
    const list = Bun.spawn(['aws', 'eks', 'list-updates', '--name', clusterName, '--region', region, '--output', 'json'], { stdout: 'pipe', stderr: 'pipe', env })
    const out = await new Response(list.stdout).text()
    await new Response(list.stderr).text()
    const exit = await list.exited
    if (exit !== 0) return true
    let ids: string[] = []
    try { ids = (JSON.parse(out)?.updateIds) || [] } catch { ids = [] }
    if (ids.length === 0) return true
    let inProgress = false
    for (const id of ids) {
      const desc = Bun.spawn(['aws', 'eks', 'describe-update', '--name', clusterName, '--update-id', id, '--region', region, '--output', 'json'], { stdout: 'pipe', stderr: 'pipe', env })
      const d = await new Response(desc.stdout).text()
      await new Response(desc.stderr).text()
      await desc.exited
      try {
        const status = JSON.parse(d)?.update?.status
        if (status === 'InProgress') { inProgress = true; break }
      } catch {}
    }
    if (!inProgress) return true
    jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'EKS has update InProgress; waiting 30s...' })
    await Bun.sleep(30000)
  }
  return false
}


