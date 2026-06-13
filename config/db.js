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
        console.log('[DevOps DB] Database migrations check completed successfully.');
    } catch (err) {
        console.error('[DevOps DB] Database migration check failed:', err.message);
    }
}
runAutoMigration();

module.exports = pool;
