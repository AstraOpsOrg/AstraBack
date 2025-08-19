// Types for AstraOps unified deployment system
export interface ServiceConfig {
  name: string;
  image: string;
  port: number;
  environment?: Record<string, string>;
  storage?: string;
}

export interface AstraopsConfig {
  applicationName: string;
  services: ServiceConfig[];
}

export interface DeployRequest {
  accountId: string;
  region: string;
  roleArn: string;
  awsCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration?: string;
  };
  astraopsConfig: AstraopsConfig;
}

export type JobPhase = 'auth' | 'infrastructure' | 'deployment' | 'error';
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export interface PhaseStatus {
  auth: JobStatus;
  infrastructureSetup: JobStatus;
  applicationDeploy: JobStatus;
}

export interface DeployResponse {
  jobId: string;
  status: JobStatus;
  phases: PhaseStatus;
  message: string;
  duration?: string;
}

export interface LogMessage {
  phase: JobPhase;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  timestamp?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  phases: PhaseStatus;
  request: DeployRequest;
  startTime: string; 
  endTime?: string;  
  logs: LogMessage[];
}

export interface InfrastructureState {
  exists: boolean;
  healthy: boolean;
  version?: string;
  resources?: {
    eksCluster?: 'ACTIVE' | 'CREATING' | 'FAILED';
    nodeGroups?: number;
    loadBalancer?: 'ACTIVE' | 'PROVISIONING';
  };
  lastUpdate?: string;
}