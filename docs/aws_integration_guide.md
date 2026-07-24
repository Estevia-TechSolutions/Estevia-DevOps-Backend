# EvaOps — Multi-Tenant SaaS AWS (Amazon Web Services) Integration Architecture & Blueprint

**Document Version:** 2.0.0 (SaaS Edition)  
**Target Platform:** EvaOps (Estevia B2B SaaS DevOps & Cloud Productivity Suite)  
**Scope:** Multi-Tenant Architecture, Self-Service Onboarding, Cross-Account IAM STS, Tenant Data Isolation, Automated Scanner Queue, Metered Billing, and RBAC  

---

## Executive Summary

EvaOps is a **Multi-Tenant B2B Software-as-a-Service (SaaS) Platform** designed to give enterprise customers centralized governance, observability, automated repository matching, secret hydration, and database hub management across multi-cloud environments.

This specification details how external enterprise customers (Tenants) integrate their **AWS Cloud Infrastructure** into the EvaOps SaaS platform seamlessly via 1-click CloudFormation automation, Zero-Trust IAM Role assumption with tenant-specific External IDs, isolated multi-tenant scanning queues, and metered usage billing.

---

## 1. Multi-Tenant SaaS System Architecture

```
 ┌─────────────────────────────────────────────────────────────────────────────────┐
 │                            EvaOps B2B SaaS Web Application                      │
 │    [ Multi-Tenant Portal ]  │  [ AWS Onboarding Wizard ]  │  [ Usage & Billing ]│
 └────────────────────────────────────────┬────────────────────────────────────────┘
                                          │ TLS 1.3 + Tenant JWT Token
 ┌────────────────────────────────────────▼────────────────────────────────────────┐
 │                      EvaOps Enterprise SaaS Core Backend                        │
 │                                                                                 │
 │  ┌────────────────────────┐  ┌─────────────────────────┐  ┌──────────────────┐  │
 │  │ Tenant Isolation & RBAC│  │ AWS Multi-Account STS   │  │ Metered Billing  │  │
 │  │ (Tenant-ID Partition)  │  │ (Cross-Account Assumer) │  │ Engine (Stripe)  │  │
 │  └───────────┬────────────┘  └────────────┬────────────┘  └────────┬─────────┘  │
 │              │                            │                        │            │
 │  ┌───────────▼────────────┐  ┌────────────▼────────────┐  ┌─────────▼──────────┐  │
 │  │ Multi-Tenant DB Schema │  │ Distributed Scanner Pool│  │ Tenant Git Sync  │  │
 │  │ (MySQL / PostgreSQL)   │  │ (BullMQ / SQS Workers)  │  │ (GitHub App/OAuth│  │
 │  └────────────────────────┘  └─────────────────────────┘  └──────────────────┘  │
 └───────────────────────────────────────────┬─────────────────────────────────────┘
                                             │ STS AssumeRole (External ID)
 ┌───────────────────────────────────────────▼─────────────────────────────────────┐
 │                         Customer AWS Accounts (Tenants)                         │
 │                                                                                 │
 │  ┌──────────────────────┐    ┌──────────────────────┐    ┌───────────────────┐  │
 │  │ Tenant A AWS Account │    │ Tenant B AWS Account │    │ Tenant C AWS Account │  │
 │  │ [EvaOpsScannerRole]  │    │ [EvaOpsScannerRole]  │    │ [EvaOpsScannerRole] │  │
 │  │ (ECS, S3, RDS, CloudW)│   │ (ECS, S3, RDS, CloudW)│   │ (ECS, S3, RDS)    │  │
 │  └──────────────────────┘    └──────────────────────┘    └───────────────────┘  │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Self-Service Tenant Onboarding & IAM Role Provisioning

EvaOps SaaS uses **Zero-Trust Cross-Account IAM Federation**. Customer tenants **never** provide static AWS Access Keys or Secret Keys. Instead, onboarding is completed via a 1-click AWS CloudFormation Stack or Terraform Module.

### 2.1 Onboarding Workflow

1. **Tenant Registers in EvaOps SaaS**: A new enterprise account is created, assigning a unique `tenant_id` (e.g. `tnt_8f92a10b`).
2. **External ID Generation**: EvaOps generates a cryptographically secure, tenant-bound `external_id` (e.g., `evaops-saas-tnt_8f92a10b-k3m9p2`).
3. **1-Click CloudFormation Launch**: The EvaOps UI provides a direct AWS Console launch link pre-filled with parameters.
4. **Role Creation**: The CloudFormation stack creates `EvaOpsSaaSScannerRole` in the customer's AWS account, trusting the central EvaOps SaaS AWS account.
5. **ARN Verification**: The customer enters their Role ARN in EvaOps; EvaOps validates connection using `sts:AssumeRole`.

### 2.2 CloudFormation Template (`evaops-aws-onboarding.yaml`)

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Description: 'EvaOps SaaS Multi-Tenant Cross-Account Security & Scanner Role'

Parameters:
  EvaOpsCentralAccountId:
    Type: String
    Default: '123456789012' # Central EvaOps SaaS AWS Account
    Description: 'Central EvaOps Account ID authorized to scan resources'
  TenantExternalId:
    Type: String
    Description: 'Unique Tenant External ID provided in your EvaOps SaaS Dashboard'

Resources:
  EvaOpsSaaSScannerRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: EvaOpsSaaSScannerRole
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              AWS: !Sub 'arn:aws:iam::${EvaOpsCentralAccountId}:role/EvaOpsSaaSWorkerRole'
            Action: 'sts:AssumeRole'
            Condition:
              StringEquals:
                'sts:ExternalId': !Ref TenantExternalId
      Policies:
        - PolicyName: EvaOpsReadonlyScannerPolicy
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action:
                  - 'ecs:ListClusters'
                  - 'ecs:ListServices'
                  - 'ecs:DescribeServices'
                  - 's3:ListAllMyBuckets'
                  - 's3:GetBucketTagging'
                  - 'cloudfront:ListDistributions'
                  - 'rds:DescribeDBInstances'
                  - 'secretsmanager:ListSecrets'
                  - 'ssm:DescribeParameters'
                  - 'cloudwatch:GetMetricData'
                  - 'logs:FilterLogEvents'
                Resource: '*'

Outputs:
  RoleArn:
    Description: 'Provide this Role ARN in your EvaOps SaaS Dashboard'
    Value: !GetAtt EvaOpsSaaSScannerRole.Arn
```

---

## 3. Strict Multi-Tenant Data Isolation & Security

To guarantee Enterprise-grade tenant isolation in a shared SaaS backend:

### 3.1 Partitioning Model
Every relational database table (`tenants`, `tenant_aws_credentials`, `apps`, `incidents`, `secret_audits`) enforces a strict composite key starting with `tenant_id`.

```sql
CREATE TABLE `tenant_aws_accounts` (
  `id` VARCHAR(64) NOT NULL,
  `tenant_id` VARCHAR(64) NOT NULL,
  `account_name` VARCHAR(128) NOT NULL,
  `aws_account_id` VARCHAR(32) NOT NULL,
  `role_arn` VARCHAR(255) NOT NULL,
  `external_id` VARCHAR(128) NOT NULL,
  `regions` JSON NOT NULL,
  `status` ENUM('active', 'error', 'pending') DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`, `tenant_id`),
  INDEX `idx_tenant_status` (`tenant_id`, `status`),
  CONSTRAINT `fk_aws_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.2 Dynamic STS Credentials Management
The EvaOps SaaS scanner assumes short-lived credentials (valid for 1 hour) per scan cycle using AWS STS:

```javascript
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');

async function getTenantAwsCredentials(roleArn, externalId) {
  const stsClient = new STSClient({ region: 'us-east-1' });
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `EvaOpsSaaS-ScanSession`,
    ExternalId: externalId,
    DurationSeconds: 3600
  });

  const response = await stsClient.send(command);
  return {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken
  };
}
```

---

## 4. Multi-Tenant Repository Matching Engine

In a SaaS context, each customer tenant connects their own GitHub Organization or GitLab Group via OAuth / GitHub App.

### 4.1 Tenant-Configured Repository Matcher
The scanner dynamically matches AWS resources to the customer's connected Git repositories:

```javascript
/**
 * EvaOps SaaS Multi-Tenant Repository Matcher
 */
function deduceTenantRepoUrl(resourceName, tenantGitOrg, customRules = {}) {
  let cleanName = resourceName.toLowerCase()
    .replace(/^(aws-|evaops-)/, '')
    .replace(/-(ecs|fargate|apprunner|s3|cloudfront|rds|aurora|dev|qa|prod)$/g, '');

  if (customRules[cleanName]) {
    return customRules[cleanName];
  }

  // Construct tenant-specific repository URL
  return `https://github.com/${tenantGitOrg}/${cleanName}`;
}
```

---

## 5. Multi-Tenant Subscription & Metered Billing Model

EvaOps SaaS offers a tiered B2B SaaS pricing model integrated with **Stripe Billing** or **AWS Marketplace SaaS Subscriptions**.

| Feature Tier | Starter SaaS ($199/mo) | Business SaaS ($499/mo) | Enterprise SaaS (Custom) |
| :--- | :--- | :--- | :--- |
| **Connected AWS Accounts** | 1 Account | Up to 5 Accounts | Unlimited |
| **Scanned Cloud Resources** | Up to 50 Assets | Up to 250 Assets | Unlimited Assets |
| **Scan Frequency** | Every 6 hours | Every 1 hour | Real-Time / Event-Driven |
| **Secret Hydration & Audit** | Basic | Advanced | Custom Policy Enforcement |
| **SSO / SAML RBAC** | No | Included (Okta, Azure AD) | Full Custom Identity Federation |
| **SLA & Support** | 99.9% / Email | 99.95% / 24/7 Slack | 99.99% / Dedicated TAM |

---

## 6. Role-Based Access Control (RBAC) & SAML/OIDC

EvaOps SaaS provides multi-role tenant user management:

- **Tenant Admin**: Full administrative control, billing management, AWS Account onboarding.
- **DevOps Engineer**: View cloud inventory, trigger scans, execute database migrations.
- **Security Auditor**: Read-only access to secret compliance, environment hydration, and audit trails.

---

## 7. Implementation Roadmap & SaaS Launch Checklist

1. **Phase 1: Multi-Tenant Data Schema & STS Engine**
   - Apply tenant-partitioned SQL migrations (`tenants`, `tenant_aws_accounts`).
   - Implement AWS STS Role Assumer with External ID verification.

2. **Phase 2: CloudFormation Onboarding Portal**
   - Build 1-Click CloudFormation launcher UI in `Estevia-DevOps-Frontend`.
   - Implement automated AWS Account connection health checker in `Estevia-DevOps-Backend`.

3. **Phase 3: Background Worker Queue**
   - Implement BullMQ / Redis worker queue to execute isolated tenant cloud scans concurrently without noisy-neighbor degradation.

4. **Phase 4: SaaS Billing & AWS Marketplace Integration**
   - Connect Stripe Customer Portal & AWS Marketplace SaaS Subscription Webhooks.

---
*Document maintained by the Estevia B2B SaaS Platform & Architecture Engineering Group.*
