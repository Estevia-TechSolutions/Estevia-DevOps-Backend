require('./utils/logCapturer');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const dns = require('dns');

// Ensure homebrew and local paths are included in PATH for child processes like az CLI
if (process.platform === 'darwin') {
    process.env.PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`;
}

// Prefer IPv4 DNS resolution to avoid intermittent ETIMEDOUT connections on IPv4-only networks
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

// Choose which environment config file to load
const envFile = process.env.ENV_FILE || (process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env');
const envPath = path.resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
    console.log(`[DevOps Backend] Loading environment from: ${envFile}`);
    require('dotenv').config({ path: envPath });
} else {
    console.log(`[DevOps Backend] Loading default .env file`);
    require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors());
app.use(express.json());

const auditLogger = require('./middlewares/auditLogger');
app.use(auditLogger);

// Routes
const authRoutes = require('./routes/authRoutes');
const { protect } = require('./middlewares/authMiddleware');

app.use('/api/auth', authRoutes);

const crmRoutes = require('./routes/crmRoutes');
app.use('/api/crm', crmRoutes);

const credentialRoutes = require('./routes/credentialRoutes');
app.use('/api/credentials', protect, credentialRoutes);

const appRoutes = require('./routes/appRoutes');
app.use('/api/apps', protect, appRoutes);

const orgRoutes = require('./routes/orgRoutes');
app.use('/api/org', orgRoutes);

const observabilityRoutes = require('./routes/observabilityRoutes');
app.use('/api/observability', observabilityRoutes);

const schedulerRoutes = require('./routes/schedulerRoutes');
app.use('/api/scheduler', schedulerRoutes);

const dbHubRoutes = require('./routes/dbHubRoutes');
app.use('/api/database-hub', dbHubRoutes);

const cloneRoutes = require('./routes/cloneRoutes');
app.use('/api/environments', cloneRoutes);

const auditRoutes = require('./routes/auditRoutes');
app.use('/api/audit-logs', auditRoutes);

const keyVaultRoutes = require('./routes/keyVaultRoutes');
app.use('/api/keyvault', keyVaultRoutes);

// Public webhook receiver — no auth middleware (token in URL path is the security control)
const webhookRoutes = require('./routes/webhookRoutes');
app.use('/api/webhooks', webhookRoutes);

const emailTemplateRoutes = require('./routes/emailTemplateRoutes');
app.use('/api/devops/email-templates', emailTemplateRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'HEALTHY', timestamp: new Date() });
});

// Run database migrations automatically on startup
const runMigrations = require('./run_migrations');
const schedulerWorker = require('./utils/schedulerWorker');

console.log('[DevOps Backend] Running auto-migrations on server startup...');
runMigrations()
    .then(() => {
        console.log('[DevOps Backend] Database auto-migrations completed successfully.');
        
        // Trigger CRM User seeding from Azure AD in background
        const crmController = require('./controllers/crmController');
        if (crmController.seedCrmUsersFromAzureAD) {
            crmController.seedCrmUsersFromAzureAD().catch(err => {
                console.error('[DevOps Backend] CRM User AD seeding failed:', err.message);
            });
        }

        app.listen(PORT, () => {
            console.log(`[DevOps Backend] Running on http://localhost:${PORT}`);
            // Start Weekly sleep scheduler background loops
            schedulerWorker.startSchedulerWorker();
        });
    })
    .catch((err) => {
        console.error('[DevOps Backend] Database auto-migrations failed to execute:', err.message);
        console.error('Server is shutting down due to migration failure.');
        process.exit(1);
    });
