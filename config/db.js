const mysql = require('mysql2/promise');

if (process.env.NODE_ENV === 'test') {
    console.log('[DevOps DB] Using mock database connection pool for testing mode.');
    const mockPool = {
        query: async (sql, params) => {
            console.log(`[Mock DB] Executing query: ${sql}`);
            const sqlLower = sql.toLowerCase();
            if (sqlLower.includes('select column_name')) {
                return [['azure_container_registry', 'azure_devops_service_connection', 'docker_registry_service_connection', 'azure_key_vault_url', 'dev_db_host', 'qa_db_host', 'prod_db_host', 'dev_managed_env_id', 'prod_managed_env_id', 'disabled_rules', 'rule_severities', 'billing_currency', 'sub_package_devops', 'sub_package_developer', 'sub_package_security'].map(name => ({ COLUMN_NAME: name }))];
            }
            if (sqlLower.includes('from applications')) {
                return [[
                    { id: 1, name: 'estevia-feedback-api-dev', app_type: 'backend', status: 'deployed', azure_resource_details: '{}' },
                    { id: 2, name: 'estevia-db-flex', app_type: 'database', status: 'active', azure_resource_details: '{}' }
                ]];
            }
            if (sqlLower.includes('select * from organizations') || sqlLower.includes('from organizations where id =')) {
                return [[
                    { id: 'estevia', azure_subscription_id: 'sub-id', azure_resource_group: 'rg', default_dns_domain: 'esteviatech.com', disabled_rules: 'tagging', rule_severities: '{"network-security":"Critical"}', billing_currency: 'USD', sub_package_devops: 0, sub_package_developer: 0, sub_package_security: 0 }
                ]];
            }
            if (sqlLower.includes('insert into audit_logs')) {
                return [{ insertId: 99 }];
            }
            return [[]];
        },
        getConnection: async () => ({
            query: async () => [[]],
            release: () => {}
        })
    };
    module.exports = mockPool;
    return;
}

const host = process.env.DB_HOST;
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;
const database = process.env.DB_NAME || 'evaops';
const port = process.env.DB_PORT || 3306;

if (!host || !user || !password) {
    console.error('[FATAL] Database connection credentials (DB_HOST, DB_USER, DB_PASSWORD) are not configured. Exiting.');
    process.exit(1);
}

const pool = mysql.createPool({
    host,
    user,
    password,
    database,
    port,
    ssl: { require: true, rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function runAutoMigration() {
    try {
        console.log('[DevOps DB] Running database migrations check...');
        const [columns] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'organizations'
        `);
        const columnNames = columns.map(c => c.COLUMN_NAME.toLowerCase());
        
        if (!columnNames.includes('azure_container_registry')) {
            console.log('[DevOps DB] Adding column azure_container_registry to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN azure_container_registry VARCHAR(255) DEFAULT NULL`);
        }
        if (!columnNames.includes('azure_devops_service_connection')) {
            console.log('[DevOps DB] Adding column azure_devops_service_connection to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN azure_devops_service_connection VARCHAR(100) DEFAULT NULL`);
        }
        if (!columnNames.includes('docker_registry_service_connection')) {
            console.log('[DevOps DB] Adding column docker_registry_service_connection to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN docker_registry_service_connection VARCHAR(100) DEFAULT NULL`);
        }
        if (!columnNames.includes('azure_key_vault_url')) {
            console.log('[DevOps DB] Adding column azure_key_vault_url to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN azure_key_vault_url VARCHAR(255) DEFAULT NULL`);
        }
        if (!columnNames.includes('dev_db_host')) {
            console.log('[DevOps DB] Adding column dev_db_host to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN dev_db_host VARCHAR(255) DEFAULT NULL`);
        }
        if (!columnNames.includes('qa_db_host')) {
            console.log('[DevOps DB] Adding column qa_db_host to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN qa_db_host VARCHAR(255) DEFAULT NULL`);
        }
        if (!columnNames.includes('prod_db_host')) {
            console.log('[DevOps DB] Adding column prod_db_host to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN prod_db_host VARCHAR(255) DEFAULT NULL`);
        }
        if (!columnNames.includes('dev_managed_env_id')) {
            console.log('[DevOps DB] Adding column dev_managed_env_id to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN dev_managed_env_id VARCHAR(500) DEFAULT NULL`);
        }
        if (!columnNames.includes('prod_managed_env_id')) {
            console.log('[DevOps DB] Adding column prod_managed_env_id to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN prod_managed_env_id VARCHAR(500) DEFAULT NULL`);
        }
        if (!columnNames.includes('prod_log_analytics_workspace_id')) {
            console.log('[DevOps DB] Adding column prod_log_analytics_workspace_id to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN prod_log_analytics_workspace_id VARCHAR(255) DEFAULT NULL`);
        }
        if (!columnNames.includes('disabled_rules')) {
            console.log('[DevOps DB] Adding column disabled_rules to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN disabled_rules TEXT DEFAULT NULL`);
        }
        if (!columnNames.includes('rule_severities')) {
            console.log('[DevOps DB] Adding column rule_severities to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN rule_severities TEXT DEFAULT NULL`);
        }

        // --- License Enforcement Columns (organizations) ---
        if (!columnNames.includes('license_tier')) {
            console.log('[DevOps DB] Adding column license_tier to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN license_tier VARCHAR(50) NOT NULL DEFAULT 'growth'`);
        }
        if (!columnNames.includes('operator_seats_limit')) {
            console.log('[DevOps DB] Adding column operator_seats_limit to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN operator_seats_limit INT NOT NULL DEFAULT 10`);
        }
        if (!columnNames.includes('downgrade_pending')) {
            console.log('[DevOps DB] Adding column downgrade_pending to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN downgrade_pending TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!columnNames.includes('allowed_providers')) {
            console.log('[DevOps DB] Adding column allowed_providers to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN allowed_providers VARCHAR(255) NOT NULL DEFAULT 'azure'`);
        }
        if (!columnNames.includes('billing_currency')) {
            console.log('[DevOps DB] Adding column billing_currency to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN billing_currency VARCHAR(10) NOT NULL DEFAULT 'USD'`);
        }
        if (!columnNames.includes('sub_package_devops')) {
            console.log('[DevOps DB] Adding column sub_package_devops to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN sub_package_devops TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!columnNames.includes('sub_package_developer')) {
            console.log('[DevOps DB] Adding column sub_package_developer to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN sub_package_developer TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!columnNames.includes('sub_package_security')) {
            console.log('[DevOps DB] Adding column sub_package_security to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN sub_package_security TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!columnNames.includes('sub_package_observability')) {
            console.log('[DevOps DB] Adding column sub_package_observability to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN sub_package_observability TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!columnNames.includes('billing_corrected')) {
            console.log('[DevOps DB] Adding column billing_corrected to organizations...');
            await pool.query(`ALTER TABLE organizations ADD COLUMN billing_corrected TINYINT(1) NOT NULL DEFAULT 0`);
        }
        // Force re-run of invoice correction on this deployment to pick up latest pricing logic
        await pool.query(`UPDATE organizations SET billing_corrected = 0`);

        // --- License Enforcement Columns (applications) ---
        const [appColumns] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'applications'
        `);
        const appColumnNames = appColumns.map(c => c.COLUMN_NAME.toLowerCase());
        if (!appColumnNames.includes('license_frozen')) {
            console.log('[DevOps DB] Adding column license_frozen to applications...');
            await pool.query(`ALTER TABLE applications ADD COLUMN license_frozen TINYINT(1) NOT NULL DEFAULT 0`);
        }
        
        const masterOrgId = process.env.MASTER_ORGANIZATION_ID || 'estevia';
        const masterAdminEmail = process.env.MASTER_ADMIN_EMAIL || 'govind.m@esteviatech.com';
        console.log(`[DevOps DB] Seeding admin_email and license tier for ${masterOrgId} organization...`);
        await pool.query(`
            UPDATE organizations 
            SET admin_email = ?,
                license_tier = 'sovereign',
                operator_seats_limit = 100,
                allowed_providers = 'azure'
            WHERE id = ?
        `, [masterAdminEmail, masterOrgId]);

        // Create billing_invoices table if not exists
        console.log('[DevOps DB] Checking billing_invoices table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS billing_invoices (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                invoice_number VARCHAR(100) UNIQUE NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                status VARCHAR(50) DEFAULT 'Pending',
                issue_date DATE NOT NULL,
                due_date DATE NOT NULL,
                payment_date DATE DEFAULT NULL,
                currency VARCHAR(10) NOT NULL DEFAULT 'USD',
                invoice_type VARCHAR(50) DEFAULT NULL,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        // Check if existing billing_invoices lacks columns
        const [invoiceCols] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'billing_invoices'
        `);
        const invoiceColNames = invoiceCols.map(c => c.COLUMN_NAME.toLowerCase());
        
        if (!invoiceColNames.includes('currency')) {
            console.log('[DevOps DB] Adding column currency to billing_invoices...');
            await pool.query(`ALTER TABLE billing_invoices ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'USD'`);
        }
        if (!invoiceColNames.includes('invoice_type')) {
            console.log('[DevOps DB] Adding column invoice_type to billing_invoices...');
            await pool.query(`ALTER TABLE billing_invoices ADD COLUMN invoice_type VARCHAR(50) DEFAULT NULL`);
        }

        // Create applied_remediations table if not exists
        console.log('[DevOps DB] Checking applied_remediations table...');
        await pool.query(`
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

        // Check if suggestion_id in applied_remediations needs modification
        const [remediationCols] = await pool.query(`
            SELECT CHARACTER_MAXIMUM_LENGTH 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'applied_remediations'
              AND COLUMN_NAME = 'suggestion_id'
        `);
        if (remediationCols.length > 0 && remediationCols[0].CHARACTER_MAXIMUM_LENGTH < 255) {
            console.log('[DevOps DB] Modifying suggestion_id length to VARCHAR(255) in applied_remediations...');
            await pool.query(`ALTER TABLE applied_remediations MODIFY COLUMN suggestion_id VARCHAR(255) NOT NULL`);
        }

        // Check if users table lacks columns
        const [userCols] = await pool.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'users'
        `);
        const userColNames = userCols.map(c => c.COLUMN_NAME.toLowerCase());
        if (!userColNames.includes('status')) {
            console.log('[DevOps DB] Adding column status to users...');
            await pool.query(`ALTER TABLE users ADD COLUMN status VARCHAR(50) NOT NULL DEFAULT 'active'`);
        }
        if (!userColNames.includes('mfa_registered_name')) {
            console.log('[DevOps DB] Adding column mfa_registered_name to users...');
            await pool.query(`ALTER TABLE users ADD COLUMN mfa_registered_name VARCHAR(255) DEFAULT NULL`);
        }
        if (!userColNames.includes('mfa_registered_issuer')) {
            console.log('[DevOps DB] Adding column mfa_registered_issuer to users...');
            await pool.query(`ALTER TABLE users ADD COLUMN mfa_registered_issuer VARCHAR(255) DEFAULT NULL`);
        }
        // Auto-backfill active MFA accounts
        await pool.query(`
            UPDATE users 
            SET mfa_registered_name = email, mfa_registered_issuer = 'EvaOps' 
            WHERE mfa_enabled = 1 AND mfa_registered_name IS NULL
        `);

        // Seed initial directory users and roles
        console.log('[DevOps DB] Seeding initial directory users...');
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

        const tenantId = process.env.MICROSOFT_TENANT_ID || 'a39c526c-2005-4529-ab5a-f008fc5cbc57';
        for (const u of initialUsers) {
            await pool.query(`
                INSERT INTO users (id, email, name, organization_id, role, tenant_id)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE name = VALUES(name)
            `, [u.email, u.email, u.name, masterOrgId, u.role, tenantId]);
        }

        // Verify and seed user_resource_permissions table for Dynamic Granular RBAC
        console.log('[DevOps DB] Verifying user_resource_permissions table for Granular RBAC...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_resource_permissions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                organization_id VARCHAR(255) NOT NULL,
                app_key VARCHAR(255) NOT NULL,
                environment ENUM('dev', 'qa', 'prod') NOT NULL,
                actions JSON NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_user_app_env (user_id, app_key, environment),
                INDEX idx_user_org (user_id, organization_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        console.log('[DevOps DB] Seeding & updating role-based granular grants for existing users...');
        await pool.query(`
            INSERT IGNORE INTO user_resource_permissions (user_id, organization_id, app_key, environment, actions)
            SELECT u.id, u.organization_id, app_list.app_key, env_list.environment, 
                   CASE 
                       WHEN LOWER(u.role) IN ('owner', 'admin') THEN '["view", "deploy", "provision", "cost_remediation", "db_manage"]'
                       WHEN LOWER(u.role) IN ('contributor', 'member') THEN '["view", "deploy", "provision", "cost_remediation"]'
                       WHEN LOWER(u.role) = 'viewer' THEN '["view"]'
                       ELSE '["view", "deploy"]'
                   END AS actions
            FROM users u
            CROSS JOIN (SELECT 'connecthub' AS app_key UNION SELECT 'docai' UNION SELECT 'protrack' UNION SELECT 'talenthq' UNION SELECT 'evafusion' UNION SELECT 'evaops') app_list
            CROSS JOIN (SELECT 'dev' AS environment UNION SELECT 'qa' UNION SELECT 'prod') env_list
            WHERE NOT (LOWER(u.role) = 'member' AND env_list.environment = 'prod');
        `);

        await pool.query(`
            UPDATE user_resource_permissions urp
            JOIN users u ON urp.user_id = u.id AND urp.organization_id = u.organization_id
            SET urp.actions = CASE 
                WHEN LOWER(u.role) IN ('owner', 'admin') THEN '["view", "deploy", "provision", "cost_remediation", "db_manage"]'
                WHEN LOWER(u.role) IN ('contributor', 'member') THEN '["view", "deploy", "provision", "cost_remediation"]'
                WHEN LOWER(u.role) = 'viewer' THEN '["view"]'
                ELSE '["view", "deploy"]'
            END;
        `);

        // Verify and seed azure_consumption_bills table for Azure Infrastructure Cloud Bills
        console.log('[DevOps DB] Verifying azure_consumption_bills table for Azure Cloud Infrastructure Billing...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS azure_consumption_bills (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(255) NOT NULL,
                azure_subscription_id VARCHAR(255) NOT NULL,
                invoice_number VARCHAR(100) NOT NULL,
                billing_period VARCHAR(50) NOT NULL,
                issue_date DATE NOT NULL,
                due_date DATE NOT NULL,
                payment_date DATE DEFAULT NULL,
                status ENUM('Paid', 'Pending', 'Overdue') NOT NULL DEFAULT 'Paid',
                currency VARCHAR(10) NOT NULL DEFAULT 'USD',
                total_amount DECIMAL(12,2) NOT NULL,
                aca_compute_amount DECIMAL(12,2) NOT NULL,
                mysql_db_amount DECIMAL(12,2) NOT NULL,
                swa_cdn_amount DECIMAL(12,2) NOT NULL,
                storage_vm_amount DECIMAL(12,2) NOT NULL,
                network_egress_amount DECIMAL(12,2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_org_sub_period (organization_id, azure_subscription_id, billing_period),
                INDEX idx_org_period (organization_id, billing_period)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        console.log('[DevOps DB] Seeding historical Azure Cloud Infrastructure bills (Empty - No Mocks)...');
        const historicalAzureBills = [];

        for (const bill of historicalAzureBills) {
            await pool.query(`
                INSERT INTO azure_consumption_bills 
                (organization_id, azure_subscription_id, invoice_number, billing_period, issue_date, due_date, payment_date, status, currency, total_amount, aca_compute_amount, mysql_db_amount, swa_cdn_amount, storage_vm_amount, network_egress_amount)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    total_amount = VALUES(total_amount),
                    aca_compute_amount = VALUES(aca_compute_amount),
                    mysql_db_amount = VALUES(mysql_db_amount),
                    swa_cdn_amount = VALUES(swa_cdn_amount),
                    storage_vm_amount = VALUES(storage_vm_amount),
                    network_egress_amount = VALUES(network_egress_amount);
            `, bill);
        }

        console.log('[DevOps DB] Database migrations check completed successfully.');
        
        // Automatically run invoice correction & regeneration
        await runInvoiceRegeneration(pool);
    } catch (err) {
        console.error('[DevOps DB] Database migration check failed:', err.message);
    }
}

async function runInvoiceRegeneration(db) {
    console.log('[DevOps DB] Starting billing correction for existing organizations...');
    try {
        const [orgs] = await db.query('SELECT id, name, billing_currency, license_tier, operator_seats_limit, sub_package_devops, sub_package_developer, sub_package_security FROM organizations WHERE billing_corrected = 0');
        
        if (orgs.length === 0) {
            console.log('[DevOps DB] All organizations have already been corrected. Skipping invoice regeneration.');
            return;
        }
        
        // Standard pricing for sub-packages
        const pricing = {
            devops: { USD: 150.00, INR: 12500.00, type: 'devops_package', label: 'DevOps' },
            developer: { USD: 99.00, INR: 8250.00, type: 'developer_package', label: 'Developer' },
            security: { USD: 120.00, INR: 10000.00, type: 'security_package', label: 'Security' }
        };

        for (const org of orgs) {
            const orgId = org.id;
            const currency = org.billing_currency || 'USD';
            
            // Part 1: Sub-Package Invoices
            const packagesToCheck = [];
            const isSubDevops = org.sub_package_devops === 1 || org.sub_package_devops === true || (Buffer.isBuffer(org.sub_package_devops) && org.sub_package_devops[0] === 1);
            const isSubDeveloper = org.sub_package_developer === 1 || org.sub_package_developer === true || (Buffer.isBuffer(org.sub_package_developer) && org.sub_package_developer[0] === 1);
            const isSubSecurity = org.sub_package_security === 1 || org.sub_package_security === true || (Buffer.isBuffer(org.sub_package_security) && org.sub_package_security[0] === 1);

            if (isSubDevops) packagesToCheck.push('devops');
            if (isSubDeveloper) packagesToCheck.push('developer');
            if (isSubSecurity) packagesToCheck.push('security');
            
            for (const pkgKey of packagesToCheck) {
                const pkgInfo = pricing[pkgKey];
                const expectedPrice = pkgInfo[currency];
                const pkgType = pkgInfo.type;
                
                const [existingInvoices] = await db.query(
                    'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ? ORDER BY id ASC',
                    [orgId, pkgType]
                );
                
                if (existingInvoices.length > 1) {
                    const idsToDelete = existingInvoices.slice(1).map(inv => inv.id);
                    await db.query(
                        'DELETE FROM billing_invoices WHERE id IN (?) AND status = "Pending"',
                        [idsToDelete]
                    );
                    const [cleanedInvoices] = await db.query(
                        'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ?',
                        [orgId, pkgType]
                    );
                    existingInvoices.splice(0, existingInvoices.length, ...cleanedInvoices);
                }
                
                if (existingInvoices.length > 0) {
                    const invoice = existingInvoices[0];
                    if (parseFloat(invoice.amount) !== expectedPrice || invoice.currency !== currency) {
                        await db.query(
                            'UPDATE billing_invoices SET amount = ?, currency = ? WHERE id = ?',
                            [expectedPrice, currency, invoice.id]
                        );
                    }
                } else {
                    const [legacyInvoices] = await db.query(
                        'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL AND amount = ? AND currency = ?',
                        [orgId, expectedPrice, currency]
                    );
                    if (legacyInvoices.length > 0) {
                        await db.query(
                            'UPDATE billing_invoices SET invoice_type = ? WHERE id = ?',
                            [pkgType, legacyInvoices[0].id]
                        );
                    } else {
                        const invoiceNumber = `INV-EV-${orgId}-${pkgInfo.label.toUpperCase()}-${Date.now()}`;
                        const issueDate = new Date();
                        const dueDate = new Date();
                        dueDate.setDate(issueDate.getDate() + 7);
                        await db.query(
                            `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency, invoice_type)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [orgId, invoiceNumber, expectedPrice, 'Pending', issueDate, dueDate, currency, pkgType]
                        );
                    }
                }
            }

            // Part 2: Platform Seat & License Fee Invoices
            const tier = (org.license_tier || 'growth').toLowerCase();
            const platformPricing = {
                USD: { growth: { base: 1000, perSeat: 40 }, enterprise: { base: 2000, perSeat: 90 }, sovereign: { base: 4000, perSeat: 30 } },
                INR: { growth: { base: 83333, perSeat: 3333 }, enterprise: { base: 166666, perSeat: 7500 }, sovereign: { base: 333333, perSeat: 2500 } }
            };
            const pricingGroup = platformPricing[currency] || platformPricing.USD;
            const tierPricing = pricingGroup[tier] || pricingGroup.growth;

            // Compute expected price based on ACTIVE seats (write-role users: owner, admin, contributor)
            const [[{ activeSeats }]] = await db.query(
                `SELECT COUNT(*) AS activeSeats FROM users WHERE organization_id = ? AND role IN ('owner','admin','contributor') AND id NOT LIKE 'dev-bypass-%' AND id NOT LIKE 'admin-override-%' AND id <> 'dev-bypass-user-id'`,
                [orgId]
            );
            const expectedPlatformPrice = tierPricing.base + (activeSeats * tierPricing.perSeat);
            
            const [existingPlatformInvoices] = await db.query(
                'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL ORDER BY id ASC',
                [orgId]
            );

            if (existingPlatformInvoices.length > 1) {
                const idsToDelete = existingPlatformInvoices.slice(1).map(inv => inv.id);
                await db.query(
                    'DELETE FROM billing_invoices WHERE id IN (?) AND status = "Pending"',
                    [idsToDelete]
                );
                const [cleanedPlatformInvoices] = await db.query(
                    'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL',
                    [orgId]
                );
                existingPlatformInvoices.splice(0, existingPlatformInvoices.length, ...cleanedPlatformInvoices);
            }

            if (existingPlatformInvoices.length > 0) {
                const platformInv = existingPlatformInvoices[0];
                if (parseFloat(platformInv.amount) !== expectedPlatformPrice || platformInv.currency !== currency) {
                    await db.query(
                        'UPDATE billing_invoices SET amount = ?, currency = ? WHERE id = ?',
                        [expectedPlatformPrice, currency, platformInv.id]
                    );
                }
            } else {
                const platformInvoiceNumber = `INV-EV-${orgId}-PLATFORM-${Date.now()}`;
                const platformIssueDate = new Date();
                const platformDueDate = new Date();
                platformDueDate.setDate(platformIssueDate.getDate() + 7);
                await db.query(
                    `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency, invoice_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
                    [orgId, platformInvoiceNumber, expectedPlatformPrice, 'Pending', platformIssueDate, platformDueDate, currency]
                );
            }

            // Mark organization as corrected so this runs only once
            await db.query('UPDATE organizations SET billing_corrected = 1 WHERE id = ?', [orgId]);
        }
        console.log('[DevOps DB] Invoices correction/regeneration executed successfully.');
    } catch (err) {
        console.error('[DevOps DB] Error during auto invoice regeneration:', err);
    }
}

runAutoMigration();

module.exports = pool;
