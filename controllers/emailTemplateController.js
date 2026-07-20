const emailService = require('../utils/emailService');

const EVAOPS_TEMPLATES = [
    {
        id: 'evaops_deployment',
        name: 'CI/CD Deployment Status',
        templateName: 'evaops_deployment',
        appId: 'evaops',
        productName: 'EvaOps',
        category: 'Deployments & Releases',
        lifecycleStage: 'event',
        subject: '🚀 [EvaOps] Deployment Success: Estevia Core Service (Production)',
        description: 'Automated notification dispatched upon Azure Static Web App or Container App build pipeline completion.',
        recipient: 'DevOps Team, Project Leads & System Admins',
        trigger: 'Triggered automatically when a CI/CD build or deployment pipeline finishes.',
        sampleData: {
            serviceName: 'Estevia-Marketing-Web',
            envName: 'Production',
            status: 'SUCCESS',
            commitHash: '8bb2713',
            triggeredBy: 'GitHub Actions / DevOps Scanner',
            buildDuration: '42s',
            buildLogSummary: '[INFO] Container image built successfully\n[INFO] DNS CNAME validated\n[SUCCESS] Health check returned 200 OK',
            dashboardUrl: 'https://devops.esteviatech.com/dashboard'
        }
    },
    {
        id: 'evaops_cname_swap',
        name: 'CNAME & DNS Subdomain Swap',
        templateName: 'evaops_cname_swap',
        appId: 'evaops',
        productName: 'EvaOps',
        category: 'Networking & DNS',
        lifecycleStage: 'event',
        subject: '🌐 [EvaOps] CNAME Subdomain Swap Executed: api.esteviatech.com',
        description: 'Sent when automated DNS cutover performs a zero-downtime subdomain CNAME swap.',
        recipient: 'Infrastructure Owner & Lead Architect',
        trigger: 'Triggered upon executing zero-downtime GoDaddy CNAME / Azure Static Web App domain swaps.',
        sampleData: {
            domainName: 'api.esteviatech.com',
            targetHost: 'estevia-prod-slot-b.azurecontainerapps.io',
            previousHost: 'estevia-prod-slot-a.azurecontainerapps.io',
            swapTime: '2026-07-20 19:45:00 UTC',
            latencyMs: '120',
            domainManagementUrl: 'https://devops.esteviatech.com/crm'
        }
    },
    {
        id: 'evaops_container_restart',
        name: 'Container Crash & Restart Alert',
        templateName: 'evaops_container_restart',
        appId: 'evaops',
        productName: 'EvaOps',
        category: 'Monitoring & Health',
        lifecycleStage: 'urgent',
        subject: '⚠️ [EvaOps Alert] Container Crash Loop Detected: Estevia-Backend-API',
        description: 'Urgent notification triggered when continuous container telemetry detects repeated crash loops.',
        recipient: 'On-Call SRE & System Administrator',
        trigger: 'Triggered when container telemetry detects crash loops or restart count exceeds threshold (>2).',
        sampleData: {
            appName: 'Estevia-Backend-API',
            containerId: 'cnt-89102-prod',
            restartCount: '5',
            exitCode: '137 (OOMKilled)',
            restartedAt: '2026-07-20 19:40:12 UTC',
            crashStackTrace: 'FATAL ERROR: JavaScript heap out of memory\n  at processTicksAndRejections (node:internal/process/task_queues:95:5)',
            logsUrl: 'https://devops.esteviatech.com/logs'
        }
    },
    {
        id: 'evaops_env_hydration',
        name: 'Environment Hydration Audit',
        templateName: 'evaops_env_hydration',
        appId: 'evaops',
        productName: 'EvaOps',
        category: 'Repository Scanning',
        lifecycleStage: 'daily',
        subject: '[EvaOps Audit] Environment File Drift Detected: Estevia-DevOps-Backend',
        description: 'Automated scan audit reporting missing or mismatched API URL keys across standard .env files.',
        recipient: 'DevOps Security Lead & Platform Admin',
        trigger: 'Triggered during repository audit scan when missing or mismatched keys are found in standard .env files.',
        sampleData: {
            repoName: 'Estevia-DevOps-Backend',
            driftStatus: 'Missing Key Discrepancy',
            missingKeys: 'VITE_API_URL, AZURE_CONTAINER_KEY',
            recommendationText: 'Define standard .env.development, .env.qa, and .env.production files in Git root as required by EvaOps Rule #1.',
            repoAuditUrl: 'https://devops.esteviatech.com/dashboard'
        }
    },
    {
        id: 'evaops_db_migration',
        name: 'Database Auto-Migration Report',
        templateName: 'evaops_db_migration',
        appId: 'evaops',
        productName: 'EvaOps',
        category: 'Database Operations',
        lifecycleStage: 'event',
        subject: '⚡ [EvaOps DB] Migration Complete: Estevia-DevOps-Backend',
        description: 'Report sent on container boot after CREATE DATABASE IF NOT EXISTS and migrations execute.',
        recipient: 'Database Administrator & Backend Lead',
        trigger: 'Triggered on microservice container boot when CREATE DATABASE IF NOT EXISTS and migrations complete.',
        sampleData: {
            serviceName: 'Estevia-DevOps-Backend',
            dbHost: 'estevia-qa-db.mysql.database.azure.com',
            dbName: 'estevia_devops',
            migrationCount: '3',
            executionTime: '1.42s',
            migrationLogs: '[SUCCESS] 001_create_orgs.sql applied\n[SUCCESS] 002_create_email_logs.sql applied\n[SUCCESS] Seeded default tenant records',
            dbCatalogUrl: 'https://devops.esteviatech.com/database-catalog'
        }
    },
    {
        id: 'evaops_security_vulnerability',
        name: 'Cloud Security Vulnerability Alert',
        templateName: 'evaops_security_vulnerability',
        appId: 'evaops',
        productName: 'EvaOps',
        category: 'Security & Compliance',
        lifecycleStage: 'urgent',
        subject: '🛡️ [EvaOps Security] High Priority Risk Detected: Azure KeyVault Instance',
        description: 'High-priority alert sent when policy scanner detects uncontained ports or expiring SSL certificates.',
        recipient: 'Chief Security Officer & Compliance Lead',
        trigger: 'Triggered when cloud scanner detects uncontained management ports or SSL certificate expiration <7 days.',
        sampleData: {
            resourceName: 'kv-estevia-prod-keys',
            severity: 'CRITICAL',
            vulnerabilityType: 'Exposed Management Port / SSL Expiration <7 Days',
            policyRule: 'EVAOPS-SEC-089 (Zero-Trust KeyVault Ingress)',
            detectedAt: '2026-07-20 19:30:00 UTC',
            remediationSteps: 'Restrict IP ingress rules in Azure KeyVault Firewall settings and trigger SSL certificate auto-renewal.',
            securityDashboardUrl: 'https://devops.esteviatech.com/credentials'
        }
    }
];

exports.getEmailTemplates = async (req, res) => {
    try {
        return res.status(200).json({
            success: true,
            templates: EVAOPS_TEMPLATES,
            total: EVAOPS_TEMPLATES.length
        });
    } catch (err) {
        console.error('[EvaOps Controller] Error fetching email templates:', err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.getTemplatePreview = async (req, res) => {
    try {
        const { id } = req.params;
        const template = EVAOPS_TEMPLATES.find(t => t.id === id);
        if (!template) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }

        const html = await emailService.readTemplate(template.templateName, template.sampleData);
        return res.status(200).json({
            success: true,
            template,
            html
        });
    } catch (err) {
        console.error('[EvaOps Controller] Error rendering template preview:', err);
        return res.status(500).json({ success: false, message: 'Failed to render preview' });
    }
};

exports.sendTestEmail = async (req, res) => {
    try {
        const { templateId, recipientEmail, customVariables } = req.body;
        const template = EVAOPS_TEMPLATES.find(t => t.id === templateId);
        if (!template) {
            return res.status(404).json({ success: false, message: 'Template not found' });
        }

        const variables = { ...template.sampleData, ...customVariables };
        const html = await emailService.readTemplate(template.templateName, variables);

        const result = await emailService.sendMail({
            to: recipientEmail,
            subject: `[TEST] ${template.subject}`,
            html
        });

        if (result.success) {
            return res.status(200).json({ success: true, message: `Test email dispatched to ${recipientEmail}` });
        } else {
            return res.status(500).json({ success: false, message: result.error || 'Failed to dispatch email' });
        }
    } catch (err) {
        console.error('[EvaOps Controller] Error sending test email:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
};
