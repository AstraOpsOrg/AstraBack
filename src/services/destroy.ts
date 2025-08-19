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
      jobService.addLog(jobId, { phase: 'destroy', level: 'error', message: 'Terraform not available or directory missing.' })
      return { success: false }
    }

    // init backend
    const bucketName = `astraops-tfstate-${request.accountId}`
    const stateKey = 'infrastructure/terraform.tfstate'
    jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: `Running terraform init (S3 backend: ${bucketName}/${stateKey})...` })
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
      jobService.addLog(jobId, { phase: 'destroy', level: 'error', message: 'Terraform init failed' })
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
      jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: `Best-effort: deleting namespace ${clusterName} before destroy...` })
      const update = Bun.spawn(['aws', 'eks', 'update-kubeconfig', '--name', clusterName, '--region', region], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-eks:', update.stdout)
      await streamRaw(jobId, 'aws-eks:', update.stderr)
      await update.exited
      
      // Delete application namespace
      const delns = Bun.spawn(['kubectl', 'delete', 'ns', clusterName, '--wait=true'], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'kubectl:', delns.stdout)
      await streamRaw(jobId, 'kubectl:', delns.stderr)
      await delns.exited
      
      // Delete monitoring namespace and Helm release if exists
      jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: 'Best-effort: cleaning up monitoring (Grafana/Prometheus)...' })
      const helmList = Bun.spawn(['helm', 'list', '-n', 'monitoring', '-q'], { stdout: 'pipe', stderr: 'pipe', env })
      const helmOutput = await new Response(helmList.stdout).text()
      await streamRaw(jobId, 'helm:', helmList.stderr)
      await helmList.exited
      
      if (helmOutput.trim().includes('monitoring')) {
        const helmUninstall = Bun.spawn(['helm', 'uninstall', 'monitoring', '-n', 'monitoring'], { stdout: 'pipe', stderr: 'pipe', env })
        await streamRaw(jobId, 'helm:', helmUninstall.stdout)
        await streamRaw(jobId, 'helm:', helmUninstall.stderr)
        await helmUninstall.exited
      }
      
      const delMonNs = Bun.spawn(['kubectl', 'delete', 'ns', 'monitoring', '--wait=true'], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'kubectl:', delMonNs.stdout)
      await streamRaw(jobId, 'kubectl:', delMonNs.stderr)
      await delMonNs.exited
    } catch {}

    jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: 'Running terraform destroy...' })
    const destroy = Bun.spawn(['terraform', 'destroy', '-auto-approve', '-input=false', ...tfVars], { stdout: 'pipe', stderr: 'pipe', cwd: workdir, env })
    await streamRaw(jobId, 'terraform:', destroy.stdout)
    await streamRaw(jobId, 'terraform:', destroy.stderr)
    const code = await destroy.exited
    if (code !== 0) {
      jobService.addLog(jobId, { phase: 'destroy', level: 'error', message: 'Terraform destroy failed' })
      return { success: false }
    }

    jobService.addLog(jobId, { phase: 'destroy', level: 'success', message: 'Terraform destroy completed' })

    // Best-effort: remove terraform state from S3 to avoid storage costs
    try {
      jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: 'Cleaning up Terraform state in S3...' })
      
      // First, try to remove all objects recursively
      const rmAllObjects = Bun.spawn(['aws', 's3', 'rm', `s3://${bucketName}`, '--recursive'], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-s3:', rmAllObjects.stdout)
      await streamRaw(jobId, 'aws-s3:', rmAllObjects.stderr)
      await rmAllObjects.exited

      // For versioned buckets: remove object versions specifically
      jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: `Removing all object versions from bucket ${bucketName}...` })
      
      // List and delete all versions
      const listVersions = Bun.spawn(['aws', 's3api', 'list-object-versions', '--bucket', bucketName], { stdout: 'pipe', stderr: 'pipe', env })
      const versionsOutput = await new Response(listVersions.stdout).text()
      await streamRaw(jobId, 'aws-s3:', listVersions.stderr)
      await listVersions.exited
      
      // Parse the output and delete versions if any exist
      try {
        const versionsData = JSON.parse(versionsOutput)
        
        // Delete all object versions
        if (versionsData.Versions && versionsData.Versions.length > 0) {
          for (const version of versionsData.Versions) {
            const deleteVersion = Bun.spawn(['aws', 's3api', 'delete-object', '--bucket', bucketName, '--key', version.Key, '--version-id', version.VersionId], { stdout: 'pipe', stderr: 'pipe', env })
            await streamRaw(jobId, 'aws-s3:', deleteVersion.stdout)
            await streamRaw(jobId, 'aws-s3:', deleteVersion.stderr)
            await deleteVersion.exited
          }
        }
        
        // Delete all delete markers
        if (versionsData.DeleteMarkers && versionsData.DeleteMarkers.length > 0) {
          for (const marker of versionsData.DeleteMarkers) {
            const deleteMarker = Bun.spawn(['aws', 's3api', 'delete-object', '--bucket', bucketName, '--key', marker.Key, '--version-id', marker.VersionId], { stdout: 'pipe', stderr: 'pipe', env })
            await streamRaw(jobId, 'aws-s3:', deleteMarker.stdout)
            await streamRaw(jobId, 'aws-s3:', deleteMarker.stderr)
            await deleteMarker.exited
          }
        }
      } catch (parseError) {
        jobService.addLog(jobId, { phase: 'destroy', level: 'warn', message: 'Could not parse object versions list, trying direct bucket deletion...' })
      }

      // remove the bucket 
      jobService.addLog(jobId, { phase: 'destroy', level: 'info', message: `Removing S3 bucket ${bucketName}...` })
      const rmBucket = Bun.spawn(['aws', 's3', 'rb', `s3://${bucketName}`], { stdout: 'pipe', stderr: 'pipe', env })
      await streamRaw(jobId, 'aws-s3:', rmBucket.stdout)
      await streamRaw(jobId, 'aws-s3:', rmBucket.stderr)
      const bucketExitCode = await rmBucket.exited
      
      if (bucketExitCode === 0) {
        jobService.addLog(jobId, { phase: 'destroy', level: 'success', message: `S3 bucket ${bucketName} removed successfully` })
      } else {
        jobService.addLog(jobId, { phase: 'destroy', level: 'warn', message: `S3 bucket ${bucketName} could not be removed` })
      }
    } catch {
      // Ignore cleanup errors
      jobService.addLog(jobId, { phase: 'destroy', level: 'warn', message: 'S3 cleanup had errors' })
    }

    return { success: true }
  } catch (e) {
    jobService.addLog(jobId, { phase: 'destroy', level: 'error', message: 'Terraform destroy execution error' })
    return { success: false }
  }
}


