# EvaOps — AWS (Amazon Web Services) Integration Architecture & Blueprint

**Document Version:** 1.0.0  
**Target Platform:** EvaOps (Estevia DevOps & Cloud Productivity Platform)  
**Scope:** AWS Cloud Scanner, Authentication, Resource Auto-Discovery, Environment Hydration, DB Isolation, and Observability  

---

## Executive Summary

EvaOps is designed as a unified multi-cloud control plane for the Estevia Enterprise Ecosystem. While historically integrated with Azure (Container Apps, Static Web Apps, KeyVault, Database for MySQL), this blueprint outlines the technical specification for natively extending EvaOps to **Amazon Web Services (AWS)**.

Integrating AWS into EvaOps allows automated multi-region resource scanning, unified repository-to-cloud mapping, seamless secret audit/hydration, container orchestration (ECS Fargate/EKS), static web hosting (S3 + CloudFront), database hub management (AWS RDS/Aurora), and observability via AWS CloudWatch.

---

## 1. System Architecture Blueprint

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                         EvaOps Frontend (React/Vite)                        │
 │    [ Dashboard ]  │  [ App Inventory ]  │  [ DB Hub ]  │  [ Incidents ]     │
 └───────────────────────────────────┬─────────────────────────────────────────┘
                                     │ REST APIs & WebSockets
 ┌───────────────────────────────────▼─────────────────────────────────────────┐
 │                         EvaOps Backend (Node.js/Express)                    │
 │                                                                             │
 │  ┌───────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐  │
 │  │ AWS Credential Manager│ │ AWS Cloud Scanner    │ │ Repo Matcher Engine │  │
 │  │ (STS / OIDC / IAM)    │ │ (SDK v3 Multi-Region)│ │ (Suffix Deduce)     │  │
 │  └───────────┬───────────┘ └──────────┬───────────┘ └──────────┬──────────┘  │
 └──────────────│────────────────────────│────────────────────────│────────────┘
                │                        │                        │
                ▼                        ▼                        ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                               Amazon Web Services                           │
 │                                                                             │
 │  ┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐  │
 │  │ Container Compute    │ │ Static & CDN        │ │ Database Hub        │  │
 │  │ ECS Fargate / EKS    │ │ S3 + CloudFront     │ │ RDS MySQL/Aurora    │  │
 │  └──────────────────────┘ └──────────────────────┘ └─────────────────────┘  │
 │  ┌──────────────────────┐ ┌──────────────────────┐ ┌─────────────────────┐  │
 │  │ Secrets & Config     │ │ Observability        │ │ Container Registry  │  │
 │  │ Secrets Manager / SSM│ │ CloudWatch & X-Ray   │ │ ECR                 │  │
 │  └──────────────────────┘ └──────────────────────┘ └─────────────────────┘  │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Authentication & Identity Federation

EvaOps avoids long-lived static AWS access keys wherever possible, utilizing **IAM Role Assumption with External IDs** or **AWS OIDC Federation**.

### 2.1 Cross-Account IAM Role Architecture
For multi-account Estevia environments (`Estevia-Dev`, `Estevia-QA`, `Estevia-Prod` AWS Accounts):

1. **Central EvaOps IAM Role**: Created in the management account.
2. **Target Account Execution Roles**: `EvaOpsScannerRole` in each target AWS Account with a trust policy restricting access to the central role.
3. **External ID Enforcement**: Prevents confused deputy attacks across multi-tenant deployments.

#### IAM Trust Policy Template (`EvaOpsScannerRole`):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/EvaOpsCentralBackendRole"
      },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "evaops-tenant-estevia-prod-2026"
        }
      }
    }
  ]
}
```

#### Required IAM Policy Permissions:
- `ecs:ListClusters`, `ecs:ListServices`, `ecs:DescribeServices`, `ecs:ListTasks`, `ecs:DescribeTasks`
- `s3:ListAllMyBuckets`, `s3:GetBucketLocation`, `s3:GetBucketTagging`, `s3:GetBucketWebsite`
- `cloudfront:ListDistributions`, `cloudfront:GetDistribution`
- `rds:DescribeDBInstances`, `rds:DescribeDBClusters`
- `secretsmanager:ListSecrets`, `ssm:DescribeParameters`
- `cloudwatch:GetMetricData`, `logs:FilterLogEvents`

---

## 3. AWS Resource Scanner & Auto-Discovery

The EvaOps AWS Scanner operates as an automated background job (using `@aws-sdk/client-*` modular SDK v3) to poll AWS resources across designated regions (e.g. `us-east-1`, `eu-west-1`).

### 3.1 Mapping AWS Service Equivalents

| EvaOps Feature Domain | Azure Resource Equivalent | AWS Resource Equivalent | SDK Client (`@aws-sdk`) |
| :--- | :--- | :--- | :--- |
| **Microservice Compute** | Azure Container Apps (ACA) | AWS ECS Fargate / AWS App Runner | `@aws-sdk/client-ecs` / `@aws-sdk/client-apprunner` |
| **Frontend Web Hosting** | Azure Static Web Apps (SWA) | AWS S3 + CloudFront Distribution | `@aws-sdk/client-s3` / `@aws-sdk/client-cloudfront` |
| **Relational Database** | Azure Database for MySQL | AWS RDS MySQL / Aurora MySQL | `@aws-sdk/client-rds` |
| **In-Memory Cache** | Azure Cache for Redis | AWS ElastiCache for Redis | `@aws-sdk/client-elasticache` |
| **Secret Management** | Azure Key Vault | AWS Secrets Manager / SSM Parameter Store | `@aws-sdk/client-secrets-manager` / `@aws-sdk/client-ssm` |
| **Metrics & Logs** | Azure Log Analytics / App Insights | AWS CloudWatch Logs & Metrics | `@aws-sdk/client-cloudwatch` / `@aws-sdk/client-cloudwatch-logs` |

---

## 4. Automatic Repository & Environment Matching Engine

Per EvaOps design guidelines, the cloud scanner must **automatically deduce and populate the GitHub repository URL (`repo_url`)** without requiring manual UI configuration.

### 4.1 Deductive Name Matching Logic
The scanner parses AWS resource names or tags, strips environment suffixes, and computes the exact Git repository mapping:

```typescript
// EvaOps AWS Name-Deduction Rules Engine
export function deduceRepoUrlFromAwsResource(resourceName: string, tags?: Record<string, string>): string {
  // 1. Prioritize explicit tag if present
  if (tags?.['repository'] || tags?.['repo_url']) {
    return tags['repository'] || tags['repo_url'];
  }

  // 2. Strip Environment & Service Suffixes
  // Example inputs: "estevia-hub-dev-ecs", "evanet-frontend-qa-s3", "protrack-backend-prod-rds"
  let cleanName = resourceName.toLowerCase();

  // Strip cloud provider prefixes/suffixes
  cleanName = cleanName.replace(/^(aws-|evaops-)/, '');
  cleanName = cleanName.replace(/-(ecs|fargate|apprunner|s3|cloudfront|rds|aurora|swa|aca)$/, '');

  // Strip environment suffixes
  cleanName = cleanName.replace(/-(dev|development|qa|staging|prod|production)$/, '');

  // Map cleanName to standard Estevia repository convention
  const repoMappingTable: Record<string, string> = {
    'estevia-hub': 'https://github.com/Estevia-TechSolutions/estevia-hub',
    'evanet-frontend': 'https://github.com/Estevia-TechSolutions/evanet-frontend',
    'evanet': 'https://github.com/Estevia-TechSolutions/evanet-frontend',
    'protrack-frontend': 'https://github.com/Estevia-TechSolutions/ProTrack-Frontend',
    'protrack': 'https://github.com/Estevia-TechSolutions/ProTrack-Frontend',
    'talenthq-frontend': 'https://github.com/Estevia-TechSolutions/TalentHQ-Frontend',
    'docai-frontend': 'https://github.com/Estevia-TechSolutions/DocAI-Frontend',
    'connecthub-frontend': 'https://github.com/Estevia-TechSolutions/ConnectHub-Frontend',
    'evafusion-frontend': 'https://github.com/Estevia-TechSolutions/EvaFusion-Frontend',
    'estevia-devops-backend': 'https://github.com/Estevia-TechSolutions/Estevia-DevOps-Backend',
    'estevia-devops-frontend': 'https://github.com/Estevia-TechSolutions/Estevia-DevOps-Frontend',
    'estevia-backend-api': 'https://github.com/Estevia-TechSolutions/Estevia-Backend-API'
  };

  return repoMappingTable[cleanName] || `https://github.com/Estevia-TechSolutions/${cleanName}`;
}
```

---

## 5. Environment Hydration & Secret Auditing

EvaOps enforces native environment auditing by comparing committed Git environment files with cloud secrets.

### 5.1 Standard Environment Files in Repositories
Every frontend and microservice in the Estevia ecosystem commits standard environment configurations:
- `.env.development`
- `.env.qa`
- `.env.production`

### 5.2 AWS Hydration Scanner Workflow
1. **Git Fetch**: EvaOps backend fetches `.env.{env}` directly from the repository default branch.
2. **AWS SSM / Secrets Manager Sync**: EvaOps queries AWS SSM Parameter Store (`/estevia/{app_name}/{env}/*`) or AWS Secrets Manager (`estevia-{app_name}-{env}-secrets`).
3. **Discrepancy Audit**: EvaOps flags missing environment variables, mismatched API URLs, or unencrypted secrets in the EvaOps Compliance Dashboard.

---

## 6. Database Hub & Automated Provisioning

Per EvaOps Backend Guidelines:
- **Auto-Initialization & Migrations**: All microservices auto-initialize database instances (`CREATE DATABASE IF NOT EXISTS`) and run migrations on container startup.
- **Environment Isolation**: Strict host/cluster isolation between Dev, QA, and Production AWS RDS instances.

### 6.1 AWS RDS & Aurora Provisioning Structure

| Environment | AWS DB Identifier | Engine | Multi-AZ | Host Isolation |
| :--- | :--- | :--- | :--- | :--- |
| **Development** | `estevia-db-dev-rds` | Aurora MySQL Serverless v2 (0.5 - 2 ACU) | No | `db-dev.internal.estevia.io` |
| **QA** | `estevia-db-qa-rds` | Aurora MySQL Serverless v2 (1 - 4 ACU) | No | `db-qa.internal.estevia.io` |
| **Production** | `estevia-db-prod-aurora` | Aurora MySQL Provisioned Cluster | Yes | `db-prod.internal.estevia.io` |

---

## 7. AWS Scanner Implementation Snippet (Node.js Backend)

Below is the concrete controller method to add to `Estevia-DevOps-Backend/controllers/appController.js`:

```javascript
const { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } = require('@aws-sdk/client-ecs');
const { S3Client, ListBucketsCommand, GetBucketTaggingCommand } = require('@aws-sdk/client-s3');
const { CloudFrontClient, ListDistributionsCommand } = require('@aws-sdk/client-cloudfront');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { deduceRepoUrlFromAwsResource } = require('../utils/awsRepoMatcher');

/**
 * Scans AWS Cloud infrastructure for ECS Services, S3/CloudFront Apps, and RDS Instances
 */
async function scanAwsInfrastructure(req, res) {
  try {
    const region = process.env.AWS_REGION || 'us-east-1';
    const ecsClient = new ECSClient({ region });
    const s3Client = new S3Client({ region });
    const cloudfrontClient = new CloudFrontClient({ region });
    const rdsClient = new RDSClient({ region });

    const scannedApps = [];

    // 1. Scan ECS Services (Microservices)
    const { clusterArns } = await ecsClient.send(new ListClustersCommand({}));
    for (const clusterArn of clusterArns || []) {
      const { serviceArns } = await ecsClient.send(new ListServicesCommand({ cluster: clusterArn }));
      if (serviceArns && serviceArns.length > 0) {
        const { services } = await ecsClient.send(new DescribeServicesCommand({ cluster: clusterArn, services: serviceArns }));
        for (const service of services || []) {
          const repoUrl = deduceRepoUrlFromAwsResource(service.serviceName);
          scannedApps.push({
            name: service.serviceName,
            app_type: 'ecs_fargate',
            cloud_provider: 'aws',
            status: service.runningCount > 0 ? 'running' : 'stopped',
            repo_url: repoUrl,
            running_tasks: service.runningCount,
            desired_tasks: service.desiredCount,
            cluster_arn: clusterArn,
            last_scanned: new Date()
          });
        }
      }
    }

    // 2. Scan S3 Buckets & CloudFront (Static Web Hosting)
    const { Distributions } = await cloudfrontClient.send(new ListDistributionsCommand({}));
    for (const dist of Distributions?.Items || []) {
      const distName = dist.Comment || dist.Id;
      const repoUrl = deduceRepoUrlFromAwsResource(distName);
      scannedApps.push({
        name: distName,
        app_type: 's3_cloudfront',
        cloud_provider: 'aws',
        status: dist.Enabled ? 'active' : 'disabled',
        repo_url: repoUrl,
        domain_name: dist.DomainName,
        last_scanned: new Date()
      });
    }

    // 3. Scan RDS Database Instances
    const { DBInstances } = await rdsClient.send(new DescribeDBInstancesCommand({}));
    for (const db of DBInstances || []) {
      scannedApps.push({
        name: db.DBInstanceIdentifier,
        app_type: 'rds_mysql',
        cloud_provider: 'aws',
        status: db.DBInstanceStatus,
        repo_url: deduceRepoUrlFromAwsResource(db.DBInstanceIdentifier),
        endpoint: db.Endpoint?.Address,
        engine: db.Engine,
        last_scanned: new Date()
      });
    }

    return res.status(200).json({
      success: true,
      provider: 'aws',
      total_scanned: scannedApps.length,
      apps: scannedApps
    });
  } catch (error) {
    console.error('[EvaOps AWS Scanner Error]:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = { scanAwsInfrastructure };
```

---

## 8. Database Schema Extension for AWS Multi-Cloud Support

To record AWS resources alongside Azure in the `apps` table of the EvaOps MySQL database:

```sql
-- Migration: Add AWS Multi-Cloud Support to EvaOps
ALTER TABLE `apps` 
  ADD COLUMN `cloud_provider` ENUM('azure', 'aws', 'gcp') NOT NULL DEFAULT 'azure' AFTER `app_type`,
  ADD COLUMN `aws_region` VARCHAR(32) NULL AFTER `cloud_provider`,
  ADD COLUMN `aws_arn` VARCHAR(255) NULL AFTER `aws_region`,
  ADD INDEX `idx_cloud_provider` (`cloud_provider`),
  ADD INDEX `idx_aws_arn` (`aws_arn`);
```

---

## 9. Next Steps & Implementation Roadmap

1. **Phase 1: SDK & Migration Deployment**
   - Install `@aws-sdk/client-*` dependencies in `Estevia-DevOps-Backend`.
   - Apply MySQL migration `ALTER TABLE apps ADD COLUMN cloud_provider`.

2. **Phase 2: Backend Scanner & Repo Matcher**
   - Integrate `awsRepoMatcher.js` and `scanAwsInfrastructure` controller endpoint in `Estevia-DevOps-Backend`.
   - Update `schedulerWorker.js` to run Azure and AWS scans sequentially.

3. **Phase 3: Frontend UI Indicators**
   - Add AWS Cloud provider badges (`AWS ECS`, `AWS S3/CloudFront`, `AWS RDS`) in `Estevia-DevOps-Frontend`.
   - Display dynamic cloud provider toggle in EvaOps App Inventory.

---
*Document maintained by the Estevia DevOps Architecture & Engineering Team.*
