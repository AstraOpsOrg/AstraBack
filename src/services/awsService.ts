// AWS service for state management and STS role assumption
import { STSClient, AssumeRoleCommand, type AssumeRoleCommandOutput } from '@aws-sdk/client-sts';
import { S3Client as BunS3Client } from 'bun';
import type { InfrastructureState } from '@/types';

class AWSService {
  private stsClient: STSClient;

  constructor() {
    // Initialize STS client with backend role credentials
    this.stsClient = new STSClient({
      region: process.env.AWS_REGION || 'us-west-2'
    });
  }

  // Assume role provided by CLI
  async assumeUserRole(roleArn: string, jobId: string): Promise<AssumeRoleCommandOutput | null> {
    try {
      const command = new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `astraops-${jobId}`,
        DurationSeconds: 3600 // 1 hour
      });

      const result = await this.stsClient.send(command);
      console.log(`Successfully assumed role: ${roleArn}`);
      return result;
    } catch (error) {
      console.error(`Failed to assume role ${roleArn}`);
      return null;
    }
  }

  // Create Bun S3 client with assumed role credentials
  private createBunS3Client(
    credentials: AssumeRoleCommandOutput['Credentials'],
    bucket: string
  ): BunS3Client | null {
    if (!credentials || !credentials.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      console.error('Invalid credentials provided');
      return null;
    }
    return new BunS3Client({
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      bucket,
      region: process.env.AWS_REGION || 'us-west-2'
    });
  }

  // Check if infrastructure exists and get state
  async checkInfrastructureState(
    accountId: string, 
    credentials: AssumeRoleCommandOutput['Credentials']
  ): Promise<InfrastructureState> {
    const bucketName = `astraops-tfstate-${accountId}`;
    const client = this.createBunS3Client(credentials, bucketName);
    if (!client) {
      console.error('Cannot check infrastructure state without valid S3 client');
      return Promise.resolve({ exists: false, healthy: false });
    }
    const stateFile = client.file('infrastructure/terraform.tfstate');
    try {
      const exists = await stateFile.exists();
      if (!exists) {
        console.log(`Infrastructure state not found for account ${accountId}`);
        return { exists: false, healthy: false };
      }
      try {
        const tfState = await stateFile.json();
        const stat = await stateFile.stat();
        return {
          exists: true,
          healthy: true, // TODO: validate real health
          version: tfState?.terraform_version,
          resources: {
            eksCluster: 'ACTIVE',
            nodeGroups: 1,
            loadBalancer: 'ACTIVE'
          },
          lastUpdate: stat?.lastModified?.toISOString()
        };
      } catch (e) {
        console.warn('State file exists but could not be parsed:', e);
        return { exists: true, healthy: false };
      }
    } catch (error) {
      console.error('Error checking infrastructure state:', error);
      return { exists: false, healthy: false };
    }
  }

  // Helpers for future S3 operations using Bun's S3
  async s3Exists(
    accountId: string,
    credentials: AssumeRoleCommandOutput['Credentials'],
    key: string
  ): Promise<boolean> {
    const client = this.createBunS3Client(credentials, this.getStateBucketName(accountId));
    if (!client) return false;
    try {
      return await client.file(key).exists();
    } catch {
      return false;
    }
  }

  async s3ReadJson<T = unknown>(
    accountId: string,
    credentials: AssumeRoleCommandOutput['Credentials'],
    key: string
  ): Promise<T | null> {
    const client = this.createBunS3Client(credentials, this.getStateBucketName(accountId));
    if (!client) return null;
    try {
      return await client.file(key).json();
    } catch {
      return null;
    }
  }

  async s3WriteJson(
    accountId: string,
    credentials: AssumeRoleCommandOutput['Credentials'],
    key: string,
    data: unknown
  ): Promise<boolean> {
    const client = this.createBunS3Client(credentials, this.getStateBucketName(accountId));
    if (!client) return false;
    try {
      await client.file(key).write(JSON.stringify(data), { type: 'application/json' });
      return true;
    } catch (e) {
      console.error('s3WriteJson error:', e);
      return false;
    }
  }

  async s3Delete(
    accountId: string,
    credentials: AssumeRoleCommandOutput['Credentials'],
    key: string
  ): Promise<boolean> {
    const client = this.createBunS3Client(credentials, this.getStateBucketName(accountId));
    if (!client) return false;
    try {
      await client.file(key).delete();
      return true;
    } catch (e) {
      console.error('s3Delete error:', e);
      return false;
    }
  }

  async s3Presign(
    accountId: string,
    credentials: AssumeRoleCommandOutput['Credentials'],
    key: string,
    opts?: { method?: 'GET' | 'PUT' | 'DELETE' | 'HEAD' | 'POST'; expiresIn?: number; type?: string; acl?: string }
  ): Promise<string | null> {
    const client = this.createBunS3Client(credentials, this.getStateBucketName(accountId));
    if (!client) return null;
    try {
      return client.file(key).presign({
        method: opts?.method,
        expiresIn: opts?.expiresIn,
        type: opts?.type,
        acl: opts?.acl as any
      });
    } catch (e) {
      console.error('s3Presign error:', e);
      return null;
    }
  }

  async s3List(
    accountId: string,
    credentials: AssumeRoleCommandOutput['Credentials'],
    prefix?: string,
    maxKeys?: number
  ): Promise<string[]> {
    const client = this.createBunS3Client(credentials, this.getStateBucketName(accountId));
    if (!client) return [];
    try {
      const result = await (client as any).list?.({ prefix, maxKeys });
      const contents = result?.contents || result?.Contents || [];
      return contents.map((o: any) => o.key || o.Key).filter(Boolean);
    } catch (e) {
      // If instance list is not available, fall back to empty
      return [];
    }
  }

  // Validate infrastructure health (placeholder for future implementation)
  async validateInfrastructureHealth(
    accountId: string, 
    credentials: AssumeRoleCommandOutput['Credentials']
  ): Promise<boolean> {
    // TODO: Implement actual EKS cluster health checks
    // For now, assume healthy if state exists
    const state = await this.checkInfrastructureState(accountId, credentials);
    return state.exists && state.healthy;
  }

  // Get bucket name for account
  getStateBucketName(accountId: string): string {
    return `astraops-tfstate-${accountId}`;
  }

  // Get state file key for infrastructure
  getInfrastructureStateKey(): string {
    return 'infrastructure/terraform.tfstate';
  }

  // Get state file key for application deployment
  getApplicationStateKey(applicationName: string): string {
    return `deployments/${applicationName}/terraform.tfstate`;
  }
}

export const awsService = new AWSService();