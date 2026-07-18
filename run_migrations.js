const mysql = require('mysql2/promise');
require('dotenv').config();

const platformPricing = {
    USD: {
        growth:     { base: 1000, perSeat: 40 },
        enterprise: { base: 2000, perSeat: 90 },
        sovereign:  { base: 4000, perSeat: 30 }
    },
    INR: {
        growth:     { base: 83333, perSeat: 3333 },
        enterprise: { base: 166666, perSeat: 7500 },
        sovereign:  { base: 333333, perSeat: 2500 }
    }
};

const subPackagePricing = {
    devops: { USD: 150.00, INR: 12500.00, type: 'devops_package', label: 'DevOps' },
    developer: { USD: 99.00, INR: 8250.00, type: 'developer_package', label: 'Developer' },
    security: { USD: 120.00, INR: 10000.00, type: 'security_package', label: 'Security' }
};

async function main() {
    if (process.env.NODE_ENV === 'test') {
        console.log('[DevOps DB] Skipping migrations & database connection check in test/mock mode.');
        return;
    }
    const host = process.env.DB_HOST || '127.0.0.1';
    const user = process.env.DB_USER || 'root';
    const password = process.env.DB_PASSWORD || '';
    const database = process.env.DB_NAME || 'evaops';
    const port = process.env.DB_PORT || 3306;

    console.log(`Connecting to MySQL database server: ${host} as ${user}...`);

    let connection;
    try {
        connection = await mysql.createConnection({
            host,
            user,
            password,
            port,
            ssl: {
                require: true,
                rejectUnauthorized: false, // This is needed for self-signed certs on internal Azure networks
            }
        });
    } catch (err) {
        console.error('CRITICAL: Failed to connect to database server:', err.message);
        console.log('\nTroubleshooting Info:');
        console.log('1. Ensure you are connected to the corporate VPN if using a private endpoint host.');
        console.log('2. Verify that your local machine is whitelisted on the MySQL Server firewall rules.');
        console.log('3. Ensure Azure credentials in the .env match host authorization.');
        if (require.main === module) {
            process.exit(1);
        } else {
            throw err;
        }
    }

    try {
        console.log(`Creating database ${database} (if it doesn't exist)...`);
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
        console.log(`Database ${database} verified.`);

        console.log(`Switching to ${database} database context...`);
        await connection.query(`USE \`${database}\``);

        // 1. Create organizations table
        console.log('Creating organizations table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS organizations (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                azure_subscription_id VARCHAR(100) DEFAULT NULL,
                azure_resource_group VARCHAR(100) DEFAULT NULL,
                default_dns_domain VARCHAR(100) DEFAULT NULL,
                azure_devops_org_url VARCHAR(255) DEFAULT NULL,
                azure_devops_project VARCHAR(100) DEFAULT NULL,
                pipeline_variable_group VARCHAR(100) DEFAULT NULL,
                github_owner VARCHAR(100) DEFAULT NULL,
                tenant_id VARCHAR(255) UNIQUE NULL,
                admin_email VARCHAR(255) NULL,
                onboarding_complete BOOLEAN DEFAULT FALSE,
                plan VARCHAR(50) DEFAULT 'free',
                teams_webhook_url VARCHAR(500) DEFAULT NULL,
                teams_webhook_token VARCHAR(64) DEFAULT NULL,
                log_analytics_workspace_id VARCHAR(100) DEFAULT NULL,
                azure_key_vault_url VARCHAR(255) DEFAULT NULL,
                dev_db_host VARCHAR(255) DEFAULT NULL,
                qa_db_host VARCHAR(255) DEFAULT NULL,
                prod_db_host VARCHAR(255) DEFAULT NULL,
                dev_managed_env_id VARCHAR(500) DEFAULT NULL,
                prod_managed_env_id VARCHAR(500) DEFAULT NULL,
                created_by VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Alter organizations table dynamically if columns are missing
        const [orgCols] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'organizations'
        `);
        const orgColNames = orgCols.map(c => c.COLUMN_NAME.toLowerCase());
        if (!orgColNames.includes('teams_webhook_url')) {
            console.log('Adding column teams_webhook_url to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN teams_webhook_url VARCHAR(500) DEFAULT NULL');
        }
        if (!orgColNames.includes('teams_webhook_token')) {
            console.log('Adding column teams_webhook_token to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN teams_webhook_token VARCHAR(64) DEFAULT NULL');
        }
        if (!orgColNames.includes('log_analytics_workspace_id')) {
            console.log('Adding column log_analytics_workspace_id to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN log_analytics_workspace_id VARCHAR(100) DEFAULT NULL');
        }
        if (!orgColNames.includes('azure_key_vault_url')) {
            console.log('Adding column azure_key_vault_url to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN azure_key_vault_url VARCHAR(255) DEFAULT NULL');
        }
        if (!orgColNames.includes('dev_db_host')) {
            console.log('Adding column dev_db_host to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN dev_db_host VARCHAR(255) DEFAULT NULL');
        }
        if (!orgColNames.includes('qa_db_host')) {
            console.log('Adding column qa_db_host to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN qa_db_host VARCHAR(255) DEFAULT NULL');
        }
        if (!orgColNames.includes('prod_db_host')) {
            console.log('Adding column prod_db_host to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN prod_db_host VARCHAR(255) DEFAULT NULL');
        }
        if (!orgColNames.includes('dev_managed_env_id')) {
            console.log('Adding column dev_managed_env_id to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN dev_managed_env_id VARCHAR(500) DEFAULT NULL');
        }
        if (!orgColNames.includes('prod_managed_env_id')) {
            console.log('Adding column prod_managed_env_id to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN prod_managed_env_id VARCHAR(500) DEFAULT NULL');
        }
        if (!orgColNames.includes('manual_mfa_required')) {
            console.log('Adding column manual_mfa_required to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN manual_mfa_required TINYINT(1) DEFAULT 0');
        }
        if (!orgColNames.includes('sso_mfa_required')) {
            console.log('Adding column sso_mfa_required to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN sso_mfa_required TINYINT(1) DEFAULT 0');
        }

        // Generate unique teams_webhook_token for organizations currently lacking one
        const crypto = require('crypto');
        const [orgRows] = await connection.query('SELECT id FROM organizations WHERE teams_webhook_token IS NULL');
        for (const row of orgRows) {
            const token = crypto.randomBytes(16).toString('hex');
            await connection.query('UPDATE organizations SET teams_webhook_token = ? WHERE id = ?', [token, row.id]);
            console.log(`Generated teams_webhook_token for organization ${row.id}`);
        }

        // 2. Create users table
        console.log('Creating users table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255),
                organization_id VARCHAR(50) DEFAULT NULL,
                role VARCHAR(50) DEFAULT 'member',
                status VARCHAR(50) NOT NULL DEFAULT 'active',
                tenant_id VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
            )
        `);

        // Alter users table dynamically if columns are missing
        const [userCols] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'users'
        `);
        const userColNames = userCols.map(c => c.COLUMN_NAME.toLowerCase());
        if (!userColNames.includes('mfa_secret')) {
            console.log('Adding column mfa_secret to users...');
            await connection.query('ALTER TABLE users ADD COLUMN mfa_secret VARCHAR(255) DEFAULT NULL');
        }
        if (!userColNames.includes('mfa_enabled')) {
            console.log('Adding column mfa_enabled to users...');
            await connection.query('ALTER TABLE users ADD COLUMN mfa_enabled TINYINT(1) DEFAULT 0');
        }

        // 3. Create integration_credentials table
        console.log('Creating integration_credentials table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS integration_credentials (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                provider VARCHAR(50) NOT NULL,
                credential_name VARCHAR(100) NOT NULL,
                encrypted_secrets TEXT NOT NULL,
                iv VARCHAR(100) NOT NULL,
                auth_tag VARCHAR(100) NOT NULL,
                expires_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // Alter integration_credentials table to add expires_at column if missing
        console.log('Altering integration_credentials table to add expires_at column if missing...');
        const [icColsList] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'integration_credentials'
        `);
        const icColNamesList = icColsList.map(c => c.COLUMN_NAME.toLowerCase());
        if (!icColNamesList.includes('expires_at')) {
            console.log('Adding column expires_at to integration_credentials...');
            await connection.query('ALTER TABLE integration_credentials ADD COLUMN expires_at TIMESTAMP NULL');
        }

        // 3.1 Populate default expiration dates for existing credentials if currently NULL
        console.log('Populating default expiration dates for existing credentials...');
        await connection.query(`
            UPDATE integration_credentials 
            SET expires_at = DATE_ADD(created_at, INTERVAL 30 DAY)
            WHERE expires_at IS NULL AND provider IN ('github', 'azure_devops')
        `);
        await connection.query(`
            UPDATE integration_credentials 
            SET expires_at = DATE_ADD(created_at, INTERVAL 365 DAY)
            WHERE expires_at IS NULL AND provider = 'azure' AND credential_name NOT LIKE '%Managed Identity%'
        `);

        // 4. Create applications table
        console.log('Creating applications table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS applications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                name VARCHAR(100) NOT NULL,
                repo_url VARCHAR(255) NOT NULL,
                app_type VARCHAR(50) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'pending',
                azure_resource_details JSON DEFAULT NULL,
                godaddy_dns_details JSON DEFAULT NULL,
                pipeline_id VARCHAR(100) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // 5. Create organization_invites table
        console.log('Creating organization_invites table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS organization_invites (
                id VARCHAR(36) PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                invited_email VARCHAR(255) NOT NULL,
                invited_by VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'member',
                expires_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // 5.5 Create billing_invoices table
        console.log('Creating billing_invoices table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS billing_invoices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                status VARCHAR(50) DEFAULT 'Pending',
                issue_date DATE NOT NULL,
                due_date DATE NOT NULL,
                payment_date DATE DEFAULT NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // 5.6 Create audit_logs table
        console.log('Creating audit_logs table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                actor_email VARCHAR(150) NOT NULL,
                action_type VARCHAR(50) NOT NULL,
                target VARCHAR(255) NOT NULL,
                details TEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5.7 Create sleep_schedules table
        console.log('Creating sleep_schedules table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS sleep_schedules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                rules_json TEXT NOT NULL,
                active BOOLEAN DEFAULT TRUE,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // 5.9 Create applied_remediations table
        console.log('Creating applied_remediations table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS applied_remediations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                suggestion_id VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                app_name VARCHAR(100) NOT NULL,
                savings DECIMAL(10, 2) NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_suggestion (organization_id, suggestion_id),
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // 5.95 Create crm_users table
        console.log('Creating crm_users table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS crm_users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NULL,
                name VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'agent',
                is_disabled BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Alter crm_users table to make password_hash nullable
        console.log('Altering crm_users table to make password_hash nullable if not already...');
        await connection.query('ALTER TABLE crm_users MODIFY COLUMN password_hash VARCHAR(255) NULL');

        // Alter crm_users table to add is_disabled column if missing
        console.log('Altering crm_users table to add is_disabled column if missing...');
        const [crmColsList] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'crm_users'
        `);
        const crmColNamesList = crmColsList.map(c => c.COLUMN_NAME.toLowerCase());
        if (!crmColNamesList.includes('is_disabled')) {
            console.log('Adding column is_disabled to crm_users...');
            await connection.query('ALTER TABLE crm_users ADD COLUMN is_disabled BOOLEAN DEFAULT FALSE');
        }

        // Seed default CRM user
        const crmAdminEmail = 'admin@evaops.crm';
        const crmAdminHash = require('crypto').createHash('sha256').update('CrmAdminPass123!').digest('hex');
        console.log('Seeding default CRM administrator...');
        await connection.query(`
            INSERT INTO crm_users (email, password_hash, name, role)
            VALUES (?, ?, 'CRM Administrator', 'admin')
            ON DUPLICATE KEY UPDATE name=name
        `, [crmAdminEmail, crmAdminHash]);

        // Alter organizations table to add is_disabled column
        console.log('Altering organizations table to add is_disabled column if missing...');
        const [orgColsList] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'organizations'
        `);
        const orgColNamesList = orgColsList.map(c => c.COLUMN_NAME.toLowerCase());
        if (!orgColNamesList.includes('is_disabled')) {
            console.log('Adding column is_disabled to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN is_disabled BOOLEAN DEFAULT FALSE');
        }
        if (!orgColNamesList.includes('billing_currency')) {
            console.log('Adding column billing_currency to organizations...');
            await connection.query("ALTER TABLE organizations ADD COLUMN billing_currency VARCHAR(10) NOT NULL DEFAULT 'USD'");
        }
        if (!orgColNamesList.includes('sub_package_devops')) {
            console.log('Adding column sub_package_devops to organizations...');
            await connection.query("ALTER TABLE organizations ADD COLUMN sub_package_devops TINYINT(1) NOT NULL DEFAULT 0");
        }
        if (!orgColNamesList.includes('sub_package_developer')) {
            console.log('Adding column sub_package_developer to organizations...');
            await connection.query("ALTER TABLE organizations ADD COLUMN sub_package_developer TINYINT(1) NOT NULL DEFAULT 0");
        }
        if (!orgColNamesList.includes('sub_package_security')) {
            console.log('Adding column sub_package_security to organizations...');
            await connection.query("ALTER TABLE organizations ADD COLUMN sub_package_security TINYINT(1) NOT NULL DEFAULT 0");
        }

        // Check if suggestion_id in applied_remediations needs modification
        const [remediationCols] = await connection.query(`
            SELECT CHARACTER_MAXIMUM_LENGTH 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'applied_remediations'
              AND COLUMN_NAME = 'suggestion_id'
        `);
        if (remediationCols.length > 0 && remediationCols[0].CHARACTER_MAXIMUM_LENGTH < 255) {
            console.log('Modifying suggestion_id length to VARCHAR(255) in applied_remediations...');
            await connection.query(`ALTER TABLE applied_remediations MODIFY COLUMN suggestion_id VARCHAR(255) NOT NULL`);
        }

        // Check if billing_invoices has currency and invoice_type columns
        const [invoiceColsList] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'billing_invoices'
        `);
        const invoiceColNamesList = invoiceColsList.map(c => c.COLUMN_NAME.toLowerCase());
        if (!invoiceColNamesList.includes('currency')) {
            console.log('Adding column currency to billing_invoices...');
            await connection.query("ALTER TABLE billing_invoices ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'USD'");
        }
        if (!invoiceColNamesList.includes('invoice_type')) {
            console.log('Adding column invoice_type to billing_invoices...');
            await connection.query("ALTER TABLE billing_invoices ADD COLUMN invoice_type VARCHAR(50) DEFAULT NULL");
        }

        const masterOrgId = process.env.MASTER_ORGANIZATION_ID || 'estevia';
        const masterOrgName = process.env.MASTER_ORGANIZATION_NAME || 'Estevia Tech Solutions';
        const defaultSubId = process.env.AZURE_SUBSCRIPTION_ID || 'a812e8e3-34f9-4773-82ee-6398869533b0';
        const defaultRg = process.env.AZURE_RESOURCE_GROUP || 'Estevia-Prod-RG';
        const defaultDomain = process.env.DEFAULT_DOMAIN || 'esteviatech.com';
        const defaultDevopsUrl = process.env.AZURE_DEVOPS_ORG_URL || 'https://dev.azure.com/esteviatech';
        const defaultDevopsProject = process.env.AZURE_DEVOPS_PROJECT || 'Estevia-Platform';
        const defaultPipelineVarGroup = process.env.PIPELINE_VARIABLE_GROUP || 'estevia-frontend-vars';
        const defaultGithubOwner = process.env.GITHUB_OWNER || 'Estevia-TechSolutions';
        const defaultTenantId = process.env.MICROSOFT_TENANT_ID || 'a39c526c-2005-4529-ab5a-f008fc5cbc57';
        const defaultAdminEmail = process.env.MASTER_ADMIN_EMAIL || 'govind.m@esteviatech.com';

        // 6. Seed initial organizations
        console.log(`Seeding initial organizations and config settings for master: ${masterOrgId}...`);
        await connection.query(`
            INSERT INTO organizations (
                id, name, azure_subscription_id, azure_resource_group, default_dns_domain, 
                azure_devops_org_url, azure_devops_project, pipeline_variable_group, github_owner,
                tenant_id, admin_email, onboarding_complete
            ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, 1
            ) ON DUPLICATE KEY UPDATE 
                name = VALUES(name),
                azure_subscription_id = VALUES(azure_subscription_id),
                azure_resource_group = VALUES(azure_resource_group),
                default_dns_domain = VALUES(default_dns_domain),
                azure_devops_org_url = VALUES(azure_devops_org_url),
                azure_devops_project = VALUES(azure_devops_project),
                pipeline_variable_group = VALUES(pipeline_variable_group),
                github_owner = VALUES(github_owner),
                tenant_id = VALUES(tenant_id),
                admin_email = VALUES(admin_email),
                onboarding_complete = VALUES(onboarding_complete)
        `, [
            masterOrgId, masterOrgName, defaultSubId, defaultRg, defaultDomain,
            defaultDevopsUrl, defaultDevopsProject, defaultPipelineVarGroup, defaultGithubOwner,
            defaultTenantId, defaultAdminEmail
        ]);
        // 6.1 Revert/Clean up master organization automatic Azure credentials seeding to enforce DefaultAzureCredential fallback.
        // Seeding with SSO OAuth variables overrides the working DefaultAzureCredential (Managed Identity) with keys lacking Azure RBAC permissions.
        // We preserve user-configured/discovered credentials.
        console.log(`Cleaning up any automatically seeded Azure credentials for master organization '${masterOrgId}' to ensure DefaultAzureCredential fallback...`);
        await connection.query(
            "DELETE FROM integration_credentials WHERE organization_id = ? AND provider = 'azure' AND credential_name NOT LIKE '%Auto-Discovered%' AND credential_name NOT LIKE '%Azure Service Principal%'",
            [masterOrgId]
        );

        await connection.query(`
            INSERT INTO organizations (id, name) VALUES ('org-1', ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name)
        `, [`${masterOrgName} Dev/QA`]);

        // 7. Seed bypass developer user
        console.log('Seeding Developer Bypass account...');
        await connection.query(`
            INSERT INTO users (id, email, name, organization_id, role)
            VALUES ('dev-bypass-user-id', ?, 'Developer Bypass', ?, 'admin')
            ON DUPLICATE KEY UPDATE organization_id = VALUES(organization_id), role = VALUES(role)
        `, [`dev-bypass@${masterOrgId}.evaops`, masterOrgId]);

        // 8. Seed initial directory users and roles
        console.log('Seeding initial directory users and roles...');
        const initialUsers = [
            { email: 'tanmay.k@esteviatech.com', name: 'Tanmay Kommireddi', role: 'contributor' },
            { email: 'premnath.m@esteviatech.com', name: 'Premnath Moturi', role: 'contributor' },
            { email: 'akhil.m@esteviatech.com', name: 'Akhil Menon', role: 'contributor' },
            { email: 'vishnu.m@esteviatech.com', name: 'Vishnu Menon', role: 'contributor' },
            { email: 'venkatesan.k@esteviatech.com', name: 'Venkatesan K', role: 'contributor' },
            { email: 'chaintanya.v@esteviatech.com', name: 'Chaitanya Varma', role: 'contributor' },
            { email: 'dhruv.c@esteviatech.com', name: 'Dhruv Charan', role: 'contributor' },
            { email: 'avadhoot.p@esteviatech.com', name: 'Avadhoot Patwardhan', role: 'viewer' },
            { email: 'deepa.g@esteviatech.com', name: 'Deepa Govind', role: 'viewer' },
            { email: 'dilip.m@esteviatech.com', name: 'Dilip Menon', role: 'viewer' },
            { email: 'rajni.m@esteviatech.com', name: 'Rajni Menon', role: 'viewer' }
        ];

        for (const u of initialUsers) {
            await connection.query(`
                INSERT INTO users (id, email, name, organization_id, role, tenant_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE name = VALUES(name)
            `, [u.email, u.email, u.name, masterOrgId, u.role, defaultTenantId]);
        }

        // 9. Backfill historical UNKNOWN_ACTION records from audit_logs
        console.log('Checking for audit logs to backfill...');
        try {
            const [rows] = await connection.query("SELECT id, details FROM audit_logs WHERE action_type = 'UNKNOWN_ACTION'");
            if (rows.length > 0) {
                console.log(`Found ${rows.length} UNKNOWN_ACTION audit records to evaluate for backfilling.`);
                let backfilledCount = 0;
                for (const row of rows) {
                    if (!row.details) continue;
                    let detailsData;
                    try {
                        detailsData = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
                    } catch (err) {
                        continue;
                    }

                    const method = detailsData.method || 'POST';
                    const rawPath = detailsData.path || '';
                    const body = detailsData.payload || {};
                    const path = rawPath.split('?')[0];

                    let actionType = 'UNKNOWN_ACTION';
                    let target = path;

                    // Resolve action type and target using absolute/relative path keywords
                    if (path.includes('/auth/microsoft') || path === '/microsoft') {
                        actionType = 'USER_LOGIN_MS';
                        target = 'Microsoft SSO';
                    } else if (path.includes('/auth/bypass') || path === '/bypass') {
                        actionType = 'USER_LOGIN_BYPASS';
                        target = 'Local Dev Bypass';
                    } else if (path.includes('/cost/ask-eva') || path === '/cost/ask-eva') {
                        actionType = 'EVA_AI_CONSULT';
                        target = body?.question ? body.question.substring(0, 100) : 'Eva AI Assistant';
                    } else if (path.includes('/cost/apply-remediation') || path === '/cost/apply-remediation') {
                        actionType = 'APPLY_REMEDIATION';
                        target = body?.appName ? `${body.appName} (${body.type || 'Remedy'})` : 'Cost Optimization';
                    } else if (path.includes('/users/sync') || path === '/users/sync' || path.includes('/auth/users/sync')) {
                        actionType = 'DIRECTORY_SYNC';
                        target = 'Azure AD Sync';
                    } else if (path.includes('/users/') && path.includes('/role')) {
                        actionType = 'ROLE_CHANGE';
                        const parts = path.split('/');
                        const idx = parts.indexOf('users');
                        target = (idx !== -1 && parts[idx + 1]) ? parts[idx + 1] : 'User Role';
                    } else if (path.includes('/execute-query') || path === '/execute-query') {
                        actionType = 'SQL_RUN';
                        target = body?.query ? body.query.substring(0, 100) : 'SQL Console';
                    } else if (path.includes('/database/migrate') || path.includes('/database-hub/migrate')) {
                        actionType = 'DB_SCHEMA_MIGRATE';
                        target = body?.targetDb || 'Database Hub Migration';
                    } else if (path.includes('/database-hub/compare')) {
                        actionType = 'DB_SCHEMA_COMPARE';
                        target = body?.sourceDb && body?.targetDb ? `${body.sourceDb} -> ${body.targetDb}` : 'Database Hub';
                    } else if (path.includes('/database-hub/migrate-data')) {
                        actionType = 'DB_DATA_MIGRATE';
                        target = body?.targetDb || 'Database Hub Data Migration';
                    } else if (path.includes('/database-hub/backup')) {
                        actionType = 'DB_BACKUP';
                        target = body?.dbName || 'Database Hub Backup';
                    } else if (path.includes('/org/test/')) {
                        const provider = path.split('/test/').pop();
                        actionType = `TEST_${provider.toUpperCase()}_CONN`;
                        target = body?.provider || `${provider.charAt(0).toUpperCase() + provider.slice(1)} Connection`;
                    } else if (path.includes('/organization-settings')) {
                        actionType = 'ORG_SETTINGS_UPDATE';
                        target = body?.orgName || 'Organization Settings';
                    } else if (path.includes('/test-teams-webhook')) {
                        actionType = 'TEAMS_WEBHOOK_TEST';
                        target = body?.webhookUrl || 'Teams Webhook';
                    } else if (path.includes('/setup-teams-service-hook')) {
                        actionType = 'TEAMS_HOOK_SETUP';
                        target = body?.webhookUrl || 'Teams Service Hook';
                    } else if (path.includes('/discover-workspace')) {
                        actionType = 'DISCOVER_WORKSPACE';
                        target = body?.workspaceName || 'Log Analytics Workspace';
                    } else if (path.includes('/create-dockerfile')) {
                        actionType = 'DOCKERFILE_CREATE';
                        target = body?.repoName ? `${body.repoName}/Dockerfile` : 'Dockerfile';
                    } else if (path.includes('/update-dockerfile')) {
                        actionType = 'DOCKERFILE_UPDATE';
                        target = body?.repoName ? `${body.repoName}/Dockerfile` : 'Dockerfile';
                    } else if (path.includes('/dns-swap')) {
                        actionType = 'DNS_SWAP';
                        target = body?.app1Name && body?.app2Name ? `${body.app1Name} <-> ${body.app2Name}` : 'DNS Swap';
                    } else if (path.includes('/provision')) {
                        actionType = 'PROVISION_APP';
                        target = body?.name || 'Azure Resource';
                    } else if (path.includes('/bind-domain')) {
                        actionType = 'BIND_DOMAIN';
                        target = body?.subdomain ? `${body.subdomain}.${body.domain || 'esteviatech.com'}` : 'Custom Domain';
                    } else if (path.includes('/pipeline') || path.includes('/create-pipeline-yml')) {
                        actionType = 'PIPELINE_CREATE';
                        target = body?.appName || body?.repoName || 'CI/CD Pipeline';
                    } else if (path.includes('/databases')) {
                        actionType = 'PROVISION_DB';
                        target = body?.dbName || 'Database Instance';
                    } else if (path.endsWith('/control')) {
                        actionType = 'RESOURCE_POWER_CONTROL';
                        const parts = path.split('/');
                        const idx = parts.indexOf('control');
                        target = (idx > 0) ? parts[idx - 1] : 'Azure Resource';
                    } else if (path.endsWith('/traffic')) {
                        actionType = 'TRAFFIC_UPDATE';
                        const parts = path.split('/');
                        const idx = parts.indexOf('traffic');
                        target = (idx > 0) ? parts[idx - 1] : 'App Traffic';
                    } else if (path.endsWith('/revision-mode')) {
                        actionType = 'REVISION_MODE_UPDATE';
                        const parts = path.split('/');
                        const idx = parts.indexOf('revision-mode');
                        target = (idx > 0) ? parts[idx - 1] : 'App Revision Mode';
                    } else if (path.includes('/clone')) {
                        actionType = 'ENV_CLONE';
                        target = body?.appName ? `${body.appName} (${body.sourceEnv} -> ${body.targetEnv})` : 'Environment';
                    } else if (path.includes('/keyvault/map')) {
                        actionType = 'KEYVAULT_SECRET_MAP';
                        target = body?.secretName || 'KeyVault Secret';
                    } else if (path.includes('/keyvault/mappings/')) {
                        actionType = 'KEYVAULT_SECRET_UNMAP';
                        target = path.split('/').pop() || 'Secret Mapping';
                    } else if (path.includes('/register') || path.includes('/setup-azure') || path.includes('/setup-devops') || path.includes('/setup-dns') || path.includes('/complete')) {
                        actionType = 'ONBOARDING_SETUP';
                        target = path.split('/').pop() || 'Organization Onboarding';
                    } else if (path.includes('/rules')) {
                        actionType = 'SCHEDULER_SAVE';
                        target = body?.ruleName || 'Sleep Scheduler Rule';
                    } else {
                        // Generic path resolver fallback
                        const cleanPath = path.replace(/^\/api\//, '');
                        const segments = cleanPath.split('/').filter(Boolean);
                        
                        if (segments.length > 0) {
                            let actionWord = 'UPDATE';
                            if (method === 'POST') actionWord = 'CREATE';
                            if (method === 'DELETE') actionWord = 'DELETE';
                            if (method === 'GET') actionWord = 'READ';

                            const lastSegment = segments[segments.length - 1];
                            const upperSegment = lastSegment.toUpperCase().replace(/-/g, '_');
                            actionType = `${upperSegment}_${actionWord}`;
                            
                            if (segments.length > 1 && !['apps', 'database-hub', 'org', 'credentials', 'keyvault'].includes(segments[segments.length - 2])) {
                                target = segments[segments.length - 2];
                            } else {
                                target = body?.name || body?.appName || lastSegment;
                            }
                        }
                    }

                    if (actionType !== 'UNKNOWN_ACTION') {
                        await connection.query("UPDATE audit_logs SET action_type = ?, target = ? WHERE id = ?", [actionType, target, row.id]);
                        backfilledCount++;
                    }
                }
                console.log(`Backfill complete: successfully resolved and updated ${backfilledCount} audit records.`);
            }
        } catch (backfillErr) {
            console.error('Failed to run audit logs backfill migration:', backfillErr.message);
        }

        // 10. Regenerate platform invoices to correct active seat counts
        console.log('Running Platform Invoices regeneration...');
        try {
            const [orgs] = await connection.query('SELECT id, name, billing_currency, license_tier, operator_seats_limit, sub_package_devops, sub_package_developer, sub_package_security FROM organizations');
            console.log(`[Regenerate Invoices] Found ${orgs.length} organizations to process.`);
            
            for (const org of orgs) {
                const orgId = org.id;
                const currency = org.billing_currency || 'USD';
                const tier = (org.license_tier || 'growth').toLowerCase();
                
                // ── Sub-Package Invoices Correction and Duplicate Cleanup ──
                const packagesToCheck = [];
                if (org.sub_package_devops === 1 || org.sub_package_devops === true) {
                    packagesToCheck.push('devops');
                }
                if (org.sub_package_developer === 1 || org.sub_package_developer === true) {
                    packagesToCheck.push('developer');
                }
                if (org.sub_package_security === 1 || org.sub_package_security === true) {
                    packagesToCheck.push('security');
                }
                
                if (packagesToCheck.length > 0) {
                    for (const pkgKey of packagesToCheck) {
                        const pkgInfo = subPackagePricing[pkgKey];
                        const expectedPrice = pkgInfo[currency];
                        const pkgType = pkgInfo.type;
                        
                        const [existingInvoices] = await connection.query(
                            'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ? ORDER BY id ASC',
                            [orgId, pkgType]
                        );
                        
                        if (existingInvoices.length > 1) {
                            console.log(`  [${pkgInfo.label}] Found ${existingInvoices.length} duplicate invoices! Cleaning up extras...`);
                            const idsToDelete = existingInvoices.slice(1).map(inv => inv.id);
                            await connection.query(
                                'DELETE FROM billing_invoices WHERE id IN (?) AND status = "Pending"',
                                [idsToDelete]
                            );
                            const [cleanedInvoices] = await connection.query(
                                'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ?',
                                [orgId, pkgType]
                            );
                            existingInvoices.splice(0, existingInvoices.length, ...cleanedInvoices);
                        }
                        
                        if (existingInvoices.length > 0) {
                            const invoice = existingInvoices[0];
                            if (parseFloat(invoice.amount) !== expectedPrice || invoice.currency !== currency) {
                                console.log(`    -> Fixing invoice ${invoice.invoice_number}: Updating amount to ${expectedPrice} and currency to ${currency}`);
                                await connection.query(
                                    'UPDATE billing_invoices SET amount = ?, currency = ? WHERE id = ?',
                                    [expectedPrice, currency, invoice.id]
                                );
                            }
                        }
                    }
                }

                // ── Platform Invoice Correction ──
                const pricingGroup = platformPricing[currency] || platformPricing.USD;
                const tierPricing = pricingGroup[tier] || pricingGroup.growth;

                const [seatsResult] = await connection.query(
                    `SELECT COUNT(*) AS activeSeats FROM users WHERE organization_id = ? AND role IN ('owner','admin','contributor') AND id NOT LIKE 'dev-bypass-%' AND id NOT LIKE 'admin-override-%' AND id <> 'dev-bypass-user-id'`,
                    [orgId]
                );
                const activeSeats = seatsResult[0]?.activeSeats || 0;
                const expectedPlatformPrice = tierPricing.base + (activeSeats * tierPricing.perSeat);
                
                const [existingPlatformInvoices] = await connection.query(
                    'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL ORDER BY id ASC',
                    [orgId]
                );

                if (existingPlatformInvoices.length > 1) {
                    console.log(`  [Platform] Found ${existingPlatformInvoices.length} duplicate platform invoices! Cleaning up extras...`);
                    const idsToDelete = existingPlatformInvoices.slice(1).map(inv => inv.id);
                    await connection.query(
                        'DELETE FROM billing_invoices WHERE id IN (?) AND status = "Pending"',
                        [idsToDelete]
                    );
                    const [cleanedPlatformInvoices] = await connection.query(
                        'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL',
                        [orgId]
                    );
                    existingPlatformInvoices.splice(0, existingPlatformInvoices.length, ...cleanedPlatformInvoices);
                }

                if (existingPlatformInvoices.length > 0) {
                    const platformInv = existingPlatformInvoices[0];
                    if (parseFloat(platformInv.amount) !== expectedPlatformPrice || platformInv.currency !== currency) {
                        console.log(`    -> Fixing platform invoice ${platformInv.invoice_number}: Updating amount to ${expectedPlatformPrice} and currency to ${currency}`);
                        await connection.query(
                            'UPDATE billing_invoices SET amount = ?, currency = ? WHERE id = ?',
                            [expectedPlatformPrice, currency, platformInv.id]
                        );
                    }
                } else {
                    const platformInvoiceNumber = `INV-EV-${orgId}-PLATFORM-${Date.now()}`;
                    const platformIssueDate = new Date();
                    const platformDueDate = new Date();
                    platformDueDate.setDate(platformIssueDate.getDate() + 7);

                    console.log(`  [Platform] Generating new Pending platform invoice: ${platformInvoiceNumber} (Amount: ${expectedPlatformPrice} ${currency})`);
                    await connection.query(
                        `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency, invoice_type)
                         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
                        [orgId, platformInvoiceNumber, expectedPlatformPrice, 'Pending', platformIssueDate, platformDueDate, currency]
                    );
                }
            }
        } catch (invoiceErr) {
            console.error('Failed to run invoice regeneration during migration:', invoiceErr.message);
        }

        // Emergency recovery: Reset MFA for the administrator to allow clean re-setup
        try {
            console.log('[DevOps DB] [Emergency Recovery] Resetting MFA for govind.m@esteviatech.com...');
            await connection.query("UPDATE users SET mfa_secret = NULL, mfa_enabled = 0 WHERE email = 'govind.m@esteviatech.com'");
        } catch (mfaResetErr) {
            console.error('Failed to reset administrator MFA during migration:', mfaResetErr.message);
        }

        console.log('\n================================================================');
        console.log('SUCCESS: Database migration and seeding completed successfully!');
        console.log('================================================================');
        if (require.main === module) {
            process.exit(0);
        }
    } catch (err) {
        console.error('ERROR: Migration execution failed:', err);
        if (require.main === module) {
            process.exit(1);
        } else {
            throw err;
        }
    } finally {
        if (connection) await connection.end();
    }
}

if (require.main === module) {
    main().catch(console.error);
} else {
    module.exports = main;
}
