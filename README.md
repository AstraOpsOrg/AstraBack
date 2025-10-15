# AstraBack

The backend orchestration engine of the AstraOps platform. Provides a REST API that manages the complete deployment lifecycle of containerized applications on AWS EKS.

## What It Does

AstraBack receives deployment requests from AstraCLI and orchestrates the following:

- **Infrastructure Provisioning:** Uses Terraform to create AWS EKS clusters, VPCs, subnets, and security groups
- **Application Deployment:** Generates and applies Kubernetes manifests using kubectl
- **Monitoring Setup:** Installs Grafana and Prometheus monitoring stack via Helm
- **Real-time Logging:** Streams deployment progress to clients via Server-Sent Events (SSE)
- **Job Management:** Tracks deployment jobs through authentication, infrastructure, deployment, and monitoring phases
- **Infrastructure Teardown:** Executes Terraform destroy to clean up all provisioned resources

## Technology Stack

- **Runtime:** Bun
- **Web Framework:** Hono
- **Language:** TypeScript
- **Infrastructure:** Terraform, kubectl, Helm, AWS CLI
- **AWS Integration:** AWS SDK (STS, S3, EKS)
- **Containerization:** Docker

## Quick Start

Clone and install:
```bash
git clone https://github.com/AstraOpsOrg/AstraBack.git
cd AstraBack
bun install
```

Configure environment:
```bash
echo "API_KEY=your-api-key" > .env
echo "AWS_REGION=us-west-2" >> .env
```

Run development server:
```bash
bun run dev
```

Or use Docker:
```bash
docker-compose up
```

## Main API Endpoints

- `POST /v1/deploy` - Create deployment job
- `GET /v1/deploy/{jobId}/logs` - Stream deployment logs (SSE)
- `GET /v1/deploy/{jobId}/status` - Get job status
- `POST /v1/deploy/{jobId}/monitoring` - Setup monitoring stack
- `POST /v1/destroy` - Destroy infrastructure
- `POST /v1/deploy/simulate` - Simulate deployment (no actual resources)

## Project Structure

```
src/
├── server.ts              # Main API server (Hono)
├── apis/v1.ts             # API endpoints
├── services/              # Core business logic
│   ├── awsService.ts      # AWS SDK integration
│   ├── terraformService.ts # Terraform orchestration
│   ├── kubernetesService.ts # kubectl operations
│   └── monitoringService.ts # Helm monitoring setup
├── workers/               # Background job processors
└── validators/            # Request validation

iac/
├── terraform/             # EKS cluster configuration
└── k8s/base/             # Base Kubernetes manifests
```

## Documentation

[DeepWiki Documentation](https://deepwiki.com/AstraOpsOrg/AstraBack)

## License

Apache License 2.0
