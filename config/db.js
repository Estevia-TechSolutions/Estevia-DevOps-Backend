const mysql = require('mysql2/promise');

if (process.env.NODE_ENV === 'test') {
    console.log('[DevOps DB] Using mock database connection pool for testing mode.');
    const mockPool = {
        query: async (sql, params) => {
            console.log(`[Mock DB] Executing query: ${sql}`);
            const sqlLower = sql.toLowerCase();
            if (sqlLower.includes('select column_name')) {
                return [['azure_container_registry', 'azure_devops_service_connection', 'docker_registry_service_connection', 'azure_key_vault_url', 'dev_db_host', 'qa_db_host', 'prod_db_host', 'dev_managed_env_id', 'prod_managed_env_id'].map(name => ({ COLUMN_NAME: name }))];
            }
            if (sqlLower.includes('from applications')) {
                return [[
                    { id: 1, name: 'estevia-feedback-api-dev', app_type: 'backend', status: 'deployed', azure_resource_details: '{}' },
                    { id: 2, name: 'estevia-db-flex', app_type: 'database', status: 'active', azure_resource_details: '{}' }
                ]];
            }
            if (sqlLower.includes('select * from organizations')) {
                return [[
                    { id: 'estevia', azure_subscription_id: 'sub-id', azure_resource_group: 'rg', default_dns_domain: 'esteviatech.com' }
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
        
        const masterOrgId = process.env.MASTER_ORGANIZATION_ID || 'estevia';
        const masterAdminEmail = process.env.MASTER_ADMIN_EMAIL || 'govind.m@esteviatech.com';
        console.log(`[DevOps DB] Seeding admin_email for ${masterOrgId} organization...`);
        await pool.query(`
            UPDATE organizations 
            SET admin_email = ? 
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
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

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
        
        console.log('[DevOps DB] Database migrations check completed successfully.');
    } catch (err) {
        console.error('[DevOps DB] Database migration check failed:', err.message);
    }
}
runAutoMigration();

module.exports = pool;
