const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
    console.log('Connecting to database server...');
    if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD) {
        throw new Error('DB_HOST, DB_USER, and DB_PASSWORD environment variables must be set before running migrations.');
    }
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'estevia_devops',
        port: process.env.DB_PORT || 3306
    });

    try {
        console.log('Altering organizations table...');
        // Add columns if they do not exist
        const [orgColumns] = await connection.query('SHOW COLUMNS FROM organizations');
        const orgColNames = orgColumns.map(c => c.Field);

        if (!orgColNames.includes('tenant_id')) {
            console.log('Adding tenant_id column to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN tenant_id VARCHAR(255) UNIQUE NULL');
        }
        if (!orgColNames.includes('admin_email')) {
            console.log('Adding admin_email column to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN admin_email VARCHAR(255) NULL');
        }
        if (!orgColNames.includes('onboarding_complete')) {
            console.log('Adding onboarding_complete column to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN onboarding_complete BOOLEAN DEFAULT FALSE');
        }
        if (!orgColNames.includes('plan')) {
            console.log('Adding plan column to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN plan VARCHAR(50) DEFAULT "free"');
        }
        if (!orgColNames.includes('created_by')) {
            console.log('Adding created_by column to organizations...');
            await connection.query('ALTER TABLE organizations ADD COLUMN created_by VARCHAR(255) NULL');
        }

        console.log('Altering users table...');
        const [userColumns] = await connection.query('SHOW COLUMNS FROM users');
        const userColNames = userColumns.map(c => c.Field);

        if (!userColNames.includes('tenant_id')) {
            console.log('Adding tenant_id column to users...');
            await connection.query('ALTER TABLE users ADD COLUMN tenant_id VARCHAR(255) NULL');
        }

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
        console.log('organization_invites table created or verified.');

        console.log('Updating estevia organization tenant settings...');
        // Match Estevia organization and seed its tenant ID and onboarding status
        await connection.query(`
            UPDATE organizations 
            SET tenant_id = 'a39c526c-2005-4529-ab5a-f008fc5cbc57', onboarding_complete = 1 
            WHERE id = 'estevia'
        `);
        console.log('Estevia organization updated successfully.');

        console.log('Migration v4 completed successfully!');
    } catch (err) {
        console.error('Migration failed:', err);
        throw err;
    } finally {
        await connection.end();
        console.log('Connection closed.');
    }
}

migrate().catch(err => {
    console.error(err);
    process.exit(1);
});
