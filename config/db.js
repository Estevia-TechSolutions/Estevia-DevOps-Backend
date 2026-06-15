const mysql = require('mysql2/promise');

const host = process.env.DB_HOST;
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;
const database = process.env.DB_NAME || 'estevia_devops';
const port = process.env.DB_PORT || 3306;

if (!host || !user || !password) {
    console.warn('[WARNING] Database environment variables (DB_HOST, DB_USER, DB_PASSWORD) are not fully configured. Using fallback credentials.');
}

const pool = mysql.createPool({
    host: host || 'estevia-dev-db.mysql.database.azure.com',
    user: user || 'estevia',
    password: password || 'Ewco26INCP',
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
        
        console.log('[DevOps DB] Seeding admin_email for estevia organization...');
        await pool.query(`
            UPDATE organizations 
            SET admin_email = 'govind.m@esteviatech.com' 
            WHERE id = 'estevia'
        `);

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

        for (const u of initialUsers) {
            await pool.query(`
                INSERT INTO users (id, email, name, organization_id, role, tenant_id)
                VALUES (?, ?, ?, 'estevia', ?, 'a39c526c-2005-4529-ab5a-f008fc5cbc57')
                ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role)
            `, [u.email, u.email, u.name, u.role]);
        }
        
        console.log('[DevOps DB] Database migrations check completed successfully.');
    } catch (err) {
        console.error('[DevOps DB] Database migration check failed:', err.message);
    }
}
runAutoMigration();

module.exports = pool;
