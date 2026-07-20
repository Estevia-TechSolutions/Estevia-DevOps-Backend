const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');

console.log('--- DevOps Email Service Initialization ---');
console.log('EMAIL_USER:', process.env.EMAIL_USER ? 'CONFIGURED' : 'MISSING');

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.office365.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false, // STARTTLS
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        rejectUnauthorized: false
    }
});

const readTemplate = async (templateName, variables = {}) => {
    try {
        const filePath = path.join(__dirname, 'templates', `${templateName}_template.html`);
        let html = await fs.readFile(filePath, 'utf8');

        // Simple variable substitution
        for (const [key, val] of Object.entries(variables)) {
            const regex = new RegExp(`{{${key}}}`, 'g');
            html = html.replace(regex, val !== undefined && val !== null ? String(val) : '');
        }

        return html;
    } catch (err) {
        console.error(`[EmailService] Failed to read HTML template ${templateName}:`, err.message);
        throw err;
    }
};

const sendMail = async ({ to, subject, html }) => {
    try {
        const from = process.env.EMAIL_FROM || `"EvaOps Alerts" <${process.env.EMAIL_USER || 'no-reply@esteviatech.com'}>`;
        const targetTo = to || process.env.EMAIL_DEVOPS_ADMIN || process.env.EMAIL_USER || 'ops-team@esteviatech.com';

        const info = await transporter.sendMail({
            from,
            to: targetTo,
            subject,
            html
        });
        console.log(`[EmailService] DevOps Email sent successfully to ${targetTo}: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (err) {
        console.error('[EmailService] Failed to send email:', err.message);
        return { success: false, error: err.message };
    }
};

const sendEvaOpsDeploymentNotification = async (payload) => {
    const html = await readTemplate('evaops_deployment', payload);
    return await sendMail({
        to: payload.to,
        subject: `[EvaOps] Deployment ${payload.status || 'Complete'}: ${payload.serviceName || 'App'} (${payload.envName || 'Production'})`,
        html
    });
};

const sendEvaOpsCnameSwapNotification = async (payload) => {
    const html = await readTemplate('evaops_cname_swap', payload);
    return await sendMail({
        to: payload.to,
        subject: `[EvaOps] CNAME Subdomain Swap Executed: ${payload.domainName}`,
        html
    });
};

const sendEvaOpsContainerRestartAlert = async (payload) => {
    const html = await readTemplate('evaops_container_restart', payload);
    return await sendMail({
        to: payload.to,
        subject: `⚠️ [EvaOps Alert] Container Crash Loop Detected: ${payload.appName}`,
        html
    });
};

const sendEvaOpsEnvHydrationAudit = async (payload) => {
    const html = await readTemplate('evaops_env_hydration', payload);
    return await sendMail({
        to: payload.to,
        subject: `[EvaOps Audit] Environment File Drift Detected: ${payload.repoName}`,
        html
    });
};

const sendEvaOpsDbMigrationStatus = async (payload) => {
    const html = await readTemplate('evaops_db_migration', payload);
    return await sendMail({
        to: payload.to,
        subject: `⚡ [EvaOps DB] Migration Complete: ${payload.serviceName}`,
        html
    });
};

const sendEvaOpsSecurityVulnerabilityAlert = async (payload) => {
    const html = await readTemplate('evaops_security_vulnerability', payload);
    return await sendMail({
        to: payload.to,
        subject: `🛡️ [EvaOps Security] High Priority Risk Detected: ${payload.resourceName}`,
        html
    });
};

module.exports = {
    sendMail,
    readTemplate,
    sendEvaOpsDeploymentNotification,
    sendEvaOpsCnameSwapNotification,
    sendEvaOpsContainerRestartAlert,
    sendEvaOpsEnvHydrationAudit,
    sendEvaOpsDbMigrationStatus,
    sendEvaOpsSecurityVulnerabilityAlert
};
