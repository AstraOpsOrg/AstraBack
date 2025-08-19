// Validation functions for deploy requests

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

const AWS_ACCOUNT_ID_REGEX = /^\d{12}$/;
const AWS_REGION_REGEX = /^[a-z]+-[a-z]+-\d+$/;
const IAM_ROLE_ARN_REGEX = /^arn:aws:iam::\d{12}:role\/[a-zA-Z0-9+=,.@_-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class DeployRequestValidator {
  
  static validate(requestBody: any): ValidationResult {
    const errors: string[] = [];

    // Check if body exists
    if (!requestBody || typeof requestBody !== 'object') {
      return {
        isValid: false,
        errors: ['Request body is required and must be a valid JSON object']
      };
    }

    // Validate required fields
    const requiredFields = ['accountId', 'region', 'roleArn', 'astraopsConfig'];
    const missingFields = requiredFields.filter(field => !requestBody[field]);
    
    if (missingFields.length > 0) {
      errors.push(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate individual fields if they exist
    if (requestBody.accountId !== undefined) {
      if (typeof requestBody.accountId !== 'string') {
        errors.push('accountId must be a string');
      } else if (!AWS_ACCOUNT_ID_REGEX.test(requestBody.accountId)) {
        errors.push('accountId must be a 12-digit AWS account ID (e.g., "123456789012")');
      }
    }

    if (requestBody.region !== undefined) {
      if (typeof requestBody.region !== 'string') {
        errors.push('region must be a string');
      } else if (!AWS_REGION_REGEX.test(requestBody.region)) {
        errors.push('region must be a valid AWS region (e.g., "us-west-2", "eu-central-1")');
      }
    }

    if (requestBody.roleArn !== undefined) {
      if (typeof requestBody.roleArn !== 'string') {
        errors.push('roleArn must be a string');
      } else if (!IAM_ROLE_ARN_REGEX.test(requestBody.roleArn)) {
        errors.push('roleArn must be a valid IAM role ARN (e.g., "arn:aws:iam::123456789012:role/ExecutionRole")');
      }
    }

    if (requestBody.awsCredentials !== undefined) {
      const c = requestBody.awsCredentials;
      if (!isPlainObject(c)) {
        errors.push('awsCredentials must be an object');
      } else {
        if (!isNonEmptyString(c.accessKeyId)) errors.push('awsCredentials.accessKeyId is required');
        if (!isNonEmptyString(c.secretAccessKey)) errors.push('awsCredentials.secretAccessKey is required');
        if (!isNonEmptyString(c.sessionToken)) errors.push('awsCredentials.sessionToken is required');
        if (c.expiration && !isNonEmptyString(c.expiration)) errors.push('awsCredentials.expiration must be a string if provided');
      }
    }

    if (requestBody.astraopsConfig !== undefined) {
      const config = requestBody.astraopsConfig;
      const configErrors: string[] = [];

      if (!isPlainObject(config)) {
        configErrors.push('astraopsConfig must be an object');
      } else {
        if (!config.applicationName || typeof config.applicationName !== 'string') {
          configErrors.push('astraopsConfig.applicationName is required and must be a string');
        } 
        if (!config.services || !Array.isArray(config.services)) {
          configErrors.push('astraopsConfig.services is required and must be an array');
        } else if (config.services.length === 0) {
          configErrors.push('astraopsConfig.services must contain at least one service');
        } else {
          config.services.forEach((service: any, index: number) => {
            const prefix = `astraopsConfig.services[${index}]`;

            if (!isPlainObject(service)) {
              configErrors.push(`${prefix} must be an object`);
              return;
            }

            if (!service.name || typeof service.name !== 'string') {
              configErrors.push(`${prefix}.name is required and must be a string`);
            }

            if (!service.port || typeof service.port !== 'number') {
              configErrors.push(`${prefix}.port is required and must be a number`);
            } else if (service.port < 1 || service.port > 65535) {
              configErrors.push(`${prefix}.port must be between 1 and 65535`);
            }

            if (!isNonEmptyString(service.image)) {
              configErrors.push(`${prefix}.image is required and must be a non-empty string (e.g., "usuario/imagen:tag")`);
            }

            if (service.environment !== undefined) {
              if (!isPlainObject(service.environment)) {
                configErrors.push(`${prefix}.environment must be an object (key-value pairs)`);
              }
            }
          });
        }
      }

      if (configErrors.length) {
        errors.push(...configErrors);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

// Convenience function for quick validation
export function validateDeployRequest(requestBody: any): ValidationResult {
  return DeployRequestValidator.validate(requestBody);
}