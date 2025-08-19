import type { DeployRequest } from '@/types'
import { jobService } from '@/services/jobService'
import { streamRaw } from '@/services/streamService'

type StsLikeCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
}

export async function runTerraformDestroy(
  jobId: string,
  request: DeployRequest,
  credentials: StsLikeCredentials,
  opts?: { directory?: string }
): Promise<{ success: boolean }> {
  const region = request.region || Bun.env.AWS_REGION || 'us-west-2'
  const env = {
    ...Bun.env,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
    AWS_DEFAULT_REGION: region,
  }

  const workdir = opts?.directory || './iac/terraform'
  jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Terraform directory (backend): ${workdir}` })

  try {
    // terraform version
    const check = Bun.spawn(['terraform', 'version'], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
    await streamRaw(jobId, 'terraform:', check.stdout)
    await streamRaw(jobId, 'terraform:', check.stderr)
    if (await check.exited !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform not available or directory missing.' })
      return { success: false }
    }

    // init backend
    const bucketName = `astraops-tfstate-${request.accountId}`
    const stateKey = 'infrastructure/terraform.tfstate'
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
    if (await init.exited !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform init failed' })
      return { success: false }
    }

    // vars
    const clusterName = String(request.astraopsConfig?.applicationName || 'astraops-eks')
    const accessPrincipalsList = request.roleArn ? `["${request.roleArn}"]` : '[]'
    const tfVars = [
      `-var=region=${request.region}`,
      `-var=cluster_name=${clusterName}`,
      `-var=access_principals=${accessPrincipalsList}`,
      request.roleArn ? `-var=execution_role_arn=${request.roleArn}` : '',
    ]

  // Best-effort: delete the namespace first to avoid orphaned resources (if the cluster already exists)
    try {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Best-effort: deleting namespace ${clusterName} before destroy...` })
      const update = Bun.spawn(['aws', 'eks', 'update-kubeconfig', '--name', clusterName, '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-eks:', update.stdout)
      await streamRaw(jobId, 'aws-eks:', update.stderr)
      await update.exited
      const delns = Bun.spawn(['kubectl', 'delete', 'ns', clusterName, '--wait=true'], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'kubectl:', delns.stdout)
      await streamRaw(jobId, 'kubectl:', delns.stderr)
      await delns.exited
    } catch {}

    jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Running terraform destroy...' })
    const destroy = Bun.spawn(['terraform', 'destroy', '-auto-approve', '-input=false', ...tfVars], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
    await streamRaw(jobId, 'terraform:', destroy.stdout)
    await streamRaw(jobId, 'terraform:', destroy.stderr)
    const code = await destroy.exited
    if (code !== 0) {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform destroy failed' })
      return { success: false }
    }

    jobService.addLog(jobId, { phase: 'infrastructure', level: 'success', message: 'Terraform destroy completed' })

    // Best-effort: remove terraform state from S3 to avoid storage costs
    try {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Cleaning up Terraform state in S3...' })
      const rmState = Bun.spawn(['aws', 's3', 'rm', `s3://${bucketName}/${stateKey}`], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-s3:', rmState.stdout)
      await streamRaw(jobId, 'aws-s3:', rmState.stderr)
      await rmState.exited
      const rmBackup = Bun.spawn(['aws', 's3', 'rm', `s3://${bucketName}/${stateKey}.backup`], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-s3:', rmBackup.stdout)
      await streamRaw(jobId, 'aws-s3:', rmBackup.stderr)
      await rmBackup.exited

      // Finally, remove the whole bucket (force removes all remaining objects/versions)
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Removing S3 bucket ${bucketName} (force)...` })
      const rmBucket = Bun.spawn(['aws', 's3', 'rb', `s3://${bucketName}`, '--force'], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-s3:', rmBucket.stdout)
      await streamRaw(jobId, 'aws-s3:', rmBucket.stderr)
      await rmBucket.exited
    } catch {
      // Ignore cleanup errors
    }

    return { success: true }
  } catch (e) {
    jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Terraform destroy execution error' })
    return { success: false }
  }
}


