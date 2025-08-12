// Job management service for handling deployment jobs
import { v4 as uuidv4 } from 'uuid';
import type { Job, DeployRequest, JobStatus, PhaseStatus, LogMessage } from '@/types';
import { formatDateEs, parseEsDate } from '@/utils/date';
import { logStreamService } from './logStreamService';

class JobService {
  private jobs: Map<string, Job> = new Map();

  // Create a new job
  createJob(request: DeployRequest): Job {
    const jobId = `job-${uuidv4().substring(0, 8)}`;
    
    const job: Job = {
      id: jobId,
      status: 'PENDING',
      phases: {
        auth: 'PENDING',
        infrastructureSetup: 'PENDING',
        applicationDeploy: 'PENDING'
      },
      request,
      startTime: formatDateEs(new Date()),
      logs: []
    };

    // To setup memory storage
    this.jobs.set(jobId, job);
    
    console.log(`Created ${jobId} for account ${request.accountId}, starting at ${formatDateEs(job.startTime)}`);
    return job;
  }

  // Get job by ID
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  // Update job status
  updateJobStatus(jobId: string, status: JobStatus): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      console.error(`Job ${jobId} not found`);
      return;
    }

    job.status = status;
    
    if (status === 'COMPLETED' || status === 'FAILED') {
      job.endTime = formatDateEs(new Date());
    }

    console.log(`Updated ${jobId} status to ${status}`);
  }

  // Update phase status
  updatePhaseStatus(jobId: string, phase: keyof PhaseStatus, status: JobStatus): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      console.error(`Job ${jobId} not found`);
      return;
    }

    job.phases[phase] = status;
    console.log(`Updated ${jobId} phase [${phase}] to ${status}`);
  }

  // Add log to job and publish via SSE bridge
  addLog(jobId: string, log: LogMessage): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      console.error(`Job ${jobId} not found`);
      return;
    }

    // Ensure timestamp
    if (!log.timestamp) {
      log.timestamp = formatDateEs(new Date());
    }

    job.logs.push(log);
    
    // Publish log via WebSocket
    logStreamService.publishLog(jobId, log);

    // Keep one informative trace confirming persistence
    console.log(`${jobId}: [${log.phase}] ${log.message}`);

  }

  // Get job logs
  getJobLogs(jobId: string): LogMessage[] {
    const job = this.jobs.get(jobId);
    return job ? job.logs : [];
  }

  // Add a raw log line (unstructured) and publish as plain text SSE (no in-memory storage)
  addRawLog(jobId: string, rawLine: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      console.error(`Job ${jobId} not found`);
      return;
    }
    logStreamService.publishRaw(jobId, rawLine);
  }

  // Calculate job duration
  getJobDuration(jobId: string): string {
    const job = this.jobs.get(jobId);
    if (!job) return '0s';

    const end = job.endTime ? parseEsDate(job.endTime) : new Date();
    const start = parseEsDate(job.startTime);
    const duration = end.getTime() - start.getTime();
    
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }


  // Cleanup old jobs (call periodically)
  cleanupOldJobs(maxAgeHours: number = 24): number {
    let cleanedJobs = 0;
    const cutoffTime = new Date(Date.now() - (maxAgeHours * 60 * 60 * 1000));
    
    for (const [jobId, job] of this.jobs.entries()) {
      if (parseEsDate(job.startTime) < cutoffTime) {
        this.jobs.delete(jobId);
        cleanedJobs++;
        console.log(`Cleaned up old job ${jobId}`);
      }
    }
    return cleanedJobs;
  }

  // Get all jobs (for debugging)
  getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }
}

export const jobService = new JobService();