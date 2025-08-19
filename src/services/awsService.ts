// AWS service for state management and STS role assumption
import { STSClient, AssumeRoleCommand, type AssumeRoleCommandOutput } from '@aws-sdk/client-sts';

class AWSService {
  constructor() {}

  // Assume role provided by CLI
  async assumeUserRole(roleArn: string, jobId: string, region: string): Promise<AssumeRoleCommandOutput | null> {
    try {
      const sts = new STSClient({ region })
      const command = new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `astraops-${jobId}`,
        DurationSeconds: 3600 // 1 hour
      });

      const result = await sts.send(command);
      console.log(`Successfully assumed role: ${roleArn}`);
      return result;
    } catch (error) {
      console.error(`Failed to assume role ${roleArn}`);
      return null;
    }
  }

  // Create state bucket if does not exist
  async ensureStateBucketExists(
    accountId: string,
    credentials: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string },
    region: string
  ): Promise<boolean> {
    const bucketName = this.getStateBucketName(accountId);
    try {
      const { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand, PutBucketEncryptionCommand, PutPublicAccessBlockCommand } = await import('@aws-sdk/client-s3');

      const s3 = new S3Client({
        region,
        credentials: {
          accessKeyId: credentials.AccessKeyId,
          secretAccessKey: credentials.SecretAccessKey,
          sessionToken: credentials.SessionToken,
        },
      });

      // Check existence
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
        console.log(`S3 bucket already exists: ${bucketName}`);
        return true;
      } catch (headErr: any) {
        const code = headErr?.name || headErr?.Code || headErr?.$metadata?.httpStatusCode;
        if (!(code === 'NotFound' || code === 'NoSuchBucket' || code === 404)) {
          console.warn('HeadBucket error, proceeding to create anyway:', headErr?.message || headErr);
        }
      }

      // Create bucket
      const createParams: any = { Bucket: bucketName };
      if (region !== 'us-east-1') {
        createParams.CreateBucketConfiguration = { LocationConstraint: region };
      }
      await s3.send(new CreateBucketCommand(createParams));
      console.log(`Created S3 bucket: ${bucketName}`);

      // Block public access
      await s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }));

      // Enable versioning
      await s3.send(new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: { Status: 'Enabled' },
      }));

      // Enable default encryption (SSE-S3)
      await s3.send(new PutBucketEncryptionCommand({
        Bucket: bucketName,
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            },
          ],
        },
      }));

      // Final head check
      await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
      console.log(`S3 bucket ready: ${bucketName}`);
      return true;
    } catch (error) {
      console.error('ensureStateBucketExists error:', error);
      return false;
    }
  }

  // Get bucket name for account
  getStateBucketName(accountId: string): string {
    return `astraops-tfstate-${accountId}`;
  }
}

export const awsService = new AWSService();