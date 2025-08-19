// Unified deployment worker that handles both infrastructure setup and application deployment
import type { DeployRequest } from '@/types';
import type { AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { jobService } from '@/services/jobService';
import { awsService } from '@/services/awsService';
import { runTerraformApply } from '@/services/terraformService';
import { kubectlApply } from '@/services/kubernetesService';

class DeploymentWorker {  
  
  // Main worker function that handles the entire deployment process
  async executeDeployment(jobId: string, request: DeployRequest): Promise<void> {
    console.log(`Starting deployment for ${jobId}`);

    jobService.updateJobStatus(jobId, 'RUNNING');

    // PHASE 0: Authentication - Assume IAM role
    const authOk = await this.handleAuthPhase(jobId, request);
    if (!authOk) {
      await this.finishJobFailed(jobId);
      return;
    }

    // PHASE 1: Infrastructure Setup/Check
    const infrastructureReady = await this.handleInfrastructurePhase(jobId, request);
    if (!infrastructureReady) {
      await this.finishJobFailed(jobId);
      return;
    }

    // PHASE 2: Application Deployment (if infrastructure is ready)
    const deployOk = await this.handleApplicationDeploymentPhase(jobId, request);
    if (!deployOk) {
      await this.finishJobFailed(jobId);
      return;
    }

    // Complete the job
    await this.completeJob(jobId);
  }

  // Phase 0: Authentication - Assume the IAM role provided by CLI
  private async handleAuthPhase(jobId: string, request: DeployRequest): Promise<boolean> {
    jobService.updatePhaseStatus(jobId, 'auth', 'RUNNING');
    
    jobService.addLog(jobId, { phase: 'auth', level: 'info', message: `Preparing AWS credentials for role: ${request.roleArn}` });

    try {
      // Prefer credentials from CLI if provided; fallback to local AssumeRole (dev)
      if (request.awsCredentials && request.awsCredentials.accessKeyId && request.awsCredentials.secretAccessKey && request.awsCredentials.sessionToken) {
        jobService.addLog(jobId, { phase: 'auth', level: 'success', message: 'Using temporary AWS credentials provided by CLI' });
        this.setJobCredentials(jobId, {
          AccessKeyId: request.awsCredentials.accessKeyId,
          SecretAccessKey: request.awsCredentials.secretAccessKey,
          SessionToken: request.awsCredentials.sessionToken,
          Expiration: request.awsCredentials.expiration ? new Date(request.awsCredentials.expiration) : undefined
        } as any);
      } else {
        const credentials = await awsService.assumeUserRole(request.roleArn, jobId);
        if (!credentials || !credentials.Credentials) {
          jobService.addLog(jobId, { phase: 'auth', level: 'error', message: 'Failed to obtain credentials (no CLI creds and AssumeRole failed)' });
          jobService.updatePhaseStatus(jobId, 'auth', 'FAILED');
          return false;
        }
        jobService.addLog(jobId, { phase: 'auth', level: 'success', message: 'Assumed IAM role using backend configuration (dev fallback)' });
        this.setJobCredentials(jobId, credentials.Credentials!);
      }

      jobService.updatePhaseStatus(jobId, 'auth', 'COMPLETED');
      return true;

    } catch {
      jobService.addLog(jobId, { phase: 'auth', level: 'error', message: 'Failed to assume IAM role' });
      jobService.updatePhaseStatus(jobId, 'auth', 'FAILED');
      return false;
    }
  }

  // Phase 1: Infrastructure Setup/Check
  private async handleInfrastructurePhase(jobId: string, request: DeployRequest): Promise<boolean> {
    jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'RUNNING');
    
    jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Checking existing infrastructure state...' });

    try {
      // Get credentials from secure store
      const credentials = this.getJobCredentials(jobId);
      
      if (!credentials) {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'No credentials available for infrastructure check' });
        jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'FAILED');
        return false;
      }

      // Create S3 bucket for state if it doesn't exist
      const ensured = await awsService.ensureStateBucketExists(
        request.accountId,
        {
        AccessKeyId: String(credentials.AccessKeyId),
        SecretAccessKey: String(credentials.SecretAccessKey),
        SessionToken: String(credentials.SessionToken),
        },
        request.region,
      );
      if (!ensured) {
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Failed to ensure state bucket exists' });
        jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'FAILED');
        return false;
      }

      jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: 'Reconciling infrastructure with Terraform (plan/apply)...' });
      const ok = await runTerraformApply(jobId, request, {
        AccessKeyId: String(credentials.AccessKeyId),
        SecretAccessKey: String(credentials.SecretAccessKey),
        SessionToken: String(credentials.SessionToken)
      });
      if (!ok.success) {
        jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'FAILED');
        return false;
      }
      jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'COMPLETED');
      return true;
      
    } catch {
      jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Infrastructure phase failed' });
      jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'FAILED');
      return false;
    }
  }

  // Phase 2: Application Deployment
  private async handleApplicationDeploymentPhase(jobId: string, request: DeployRequest): Promise<boolean> {
    jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'RUNNING');
    
    jobService.addLog(jobId, { phase: 'deployment', level: 'info', message: 'Starting application deployment...' });

    try {
      // Check credentials again (should be set in auth phase)
      const credentials = this.getJobCredentials(jobId);
      if (!credentials) {
        jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'No credentials available for application deployment' });
        jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'FAILED');
        return false;
      }
      const kubeOk = await kubectlApply(jobId, request, {
        AccessKeyId: String(credentials.AccessKeyId),
        SecretAccessKey: String(credentials.SecretAccessKey),
        SessionToken: String(credentials.SessionToken)
      });
      if (!kubeOk.success) {
        jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'FAILED');
        return false;
      }
      jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'COMPLETED');
      return true;

    } catch {
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'Application deployment failed' });
      jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'FAILED');
      return false;
    }
  }

  // Complete the job successfully
  private async completeJob(jobId: string): Promise<void> {
    const duration = jobService.getJobDuration(jobId);
    
    jobService.addLog(jobId, { phase: 'deployment', level: 'success', message: 'Deployment completed successfully' });

    jobService.updateJobStatus(jobId, 'COMPLETED');
    console.log(`${jobId} completed successfully in ${duration}`);

    // Cleanup credentials after completion
    this.clearJobCredentials(jobId);
  }

  // Finish job as failed (no stack traces)
  private async finishJobFailed(jobId: string): Promise<void> {
    const duration = jobService.getJobDuration(jobId);
    jobService.addLog(jobId, { phase: 'error', level: 'error', message: 'Deployment failed' });
    jobService.updateJobStatus(jobId, 'FAILED');
    console.error(`${jobId} failed after ${duration}`);
    this.clearJobCredentials(jobId);
  }

  // Secure ephemeral credentials store per job (in-memory)
  private jobCredentials = new Map<string, NonNullable<AssumeRoleCommandOutput['Credentials']>>();

  private setJobCredentials(jobId: string, credentials: NonNullable<AssumeRoleCommandOutput['Credentials']>) {
    this.jobCredentials.set(jobId, credentials);
  }

  private getJobCredentials(jobId: string) {
    return this.jobCredentials.get(jobId);
  }

  private clearJobCredentials(jobId: string) {
    this.jobCredentials.delete(jobId);
  }
}

export const deploymentWorker = new DeploymentWorker();