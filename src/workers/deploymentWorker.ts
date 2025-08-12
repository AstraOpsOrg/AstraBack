// Unified deployment worker that handles both infrastructure setup and application deployment
import type { DeployRequest } from '@/types';
import type { AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { jobService } from '@/services/jobService';
import { awsService } from '@/services/awsService';
// Note: timestamps are auto-assigned in jobService.addLog

class DeploymentWorker {  
  
  // Main worker function that handles the entire deployment process
  async executeDeployment(jobId: string, request: DeployRequest): Promise<void> {
    console.log(`Starting deployment for ${jobId}`);

    // Update job status to running
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
    await this.completeJob(jobId, request);
  }

  // Phase 0: Authentication - Assume the IAM role provided by CLI
  private async handleAuthPhase(jobId: string, request: DeployRequest): Promise<boolean> {
    jobService.updatePhaseStatus(jobId, 'auth', 'RUNNING');
    
    jobService.addLog(jobId, { phase: 'auth', level: 'info', message: `Attempting to assume IAM role: ${request.roleArn}` });

    try {
      const credentials = await awsService.assumeUserRole(request.roleArn, jobId);
      if (!credentials || !credentials.Credentials) {
        jobService.addLog(jobId, { phase: 'auth', level: 'error', message: 'Failed to obtain credentials from assumed role' });
        jobService.updatePhaseStatus(jobId, 'auth', 'FAILED');
        return false;
      }

      jobService.addLog(jobId, { phase: 'auth', level: 'success', message: 'Successfully assumed IAM role' });

      jobService.updatePhaseStatus(jobId, 'auth', 'COMPLETED');

      // Save credentials in a private map with short lifecycle
      this.setJobCredentials(jobId, credentials.Credentials!);
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

      // Check infrastructure state
      const infraState = await awsService.checkInfrastructureState(request.accountId, credentials);
      
      if (infraState.exists && infraState.healthy) {
        // Infrastructure already exists and is healthy
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'success', message: 'Infrastructure found and healthy, skipping setup' });
        
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Infrastructure version: ${infraState.version || 'unknown'}` });
        
        if (infraState.lastUpdate) {
          jobService.addLog(jobId, { phase: 'infrastructure', level: 'info', message: `Last updated: ${infraState.lastUpdate}` });
        }
        
        jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'SKIPPED');
        return true;
        
      } else if (infraState.exists && !infraState.healthy) {
        // Infrastructure exists but is unhealthy
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'Infrastructure is unhealthy' });
        jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'FAILED');
        return false;
        
      } else {
        // No infrastructure found - need to create it
        jobService.addLog(jobId, { phase: 'infrastructure', level: 'error', message: 'No infrastructure found' });
        jobService.updatePhaseStatus(jobId, 'infrastructureSetup', 'FAILED');
        return false;
      }
      
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
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'Application deployment not implemented in production' });
      jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'FAILED');
      return false;

    } catch {
      jobService.addLog(jobId, { phase: 'deployment', level: 'error', message: 'Application deployment failed' });
      jobService.updatePhaseStatus(jobId, 'applicationDeploy', 'FAILED');
      return false;
    }
  }

  // Simulations removed from production worker (handled via /deploy/simulate)

  // Complete the job successfully
  private async completeJob(jobId: string, request: DeployRequest): Promise<void> {
    const duration = jobService.getJobDuration(jobId);
    const appUrl = `https://${request.astraopsConfig.applicationName}.astraops-demo.com`;
    
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
    console.error(`Job ${jobId} failed after ${duration}`);
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