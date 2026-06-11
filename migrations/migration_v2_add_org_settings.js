const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
    console.log('Connecting to database server...');
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'dev.c8h82uuqyx51.us-east-1.rds.amazonaws.com',
        user: process.env.DB_USER || 'admin',
        password: process.env.DB_PASSWORD || 'Ewco26INCP',
        database: process.env.DB_NAME || 'estevia_devops',
        port: process.env.DB_PORT || 3306
    });

    try {
        console.log('Altering organizations table to add settings columns...');
        
        const alterStatements = [
            `ALTER TABLE organizations ADD COLUMN azure_subscription_id VARCHAR(100) DEFAULT NULL`,
            `ALTER TABLE organizations ADD COLUMN azure_resource_group VARCHAR(100) DEFAULT NULL`,
            `ALTER TABLE organizations ADD COLUMN default_dns_domain VARCHAR(100) DEFAULT NULL`,
            `ALTER TABLE organizations ADD COLUMN azure_devops_org_url VARCHAR(255) DEFAULT NULL`,
            `ALTER TABLE organizations ADD COLUMN azure_devops_project VARCHAR(100) DEFAULT NULL`,
            `ALTER TABLE organizations ADD COLUMN pipeline_variable_group VARCHAR(100) DEFAULT NULL`,
            `ALTER TABLE organizations ADD COLUMN github_owner VARCHAR(100) DEFAULT NULL`
        ];

        for (const sql of alterStatements) {
            try {
                await connection.query(sql);
            } catch (err) {
                if (err.code === 'ER_DUP_FIELDNAME' || err.message.includes('Duplicate column name')) {
                    console.log(`Column already exists. Skipping.`);
                } else {
                    throw err;
                }
            }
        }
        console.log('Table alteration completed successfully.');

        // Seed/Update 'estevia' organization values
        console.log('Seeding and updating configuration for "estevia" organization...');
        await connection.query(`
            INSERT IGNORE INTO organizations (id, name) VALUES ('estevia', 'Estevia Tech Solutions')
        `);

        await connection.query(`
            UPDATE organizations SET
                azure_subscription_id = ?,
                azure_resource_group = ?,
                default_dns_domain = ?,
                azure_devops_org_url = ?,
                azure_devops_project = ?,
                pipeline_variable_group = ?,
                github_owner = ?
            WHERE id = 'estevia'
        `, [
            'a812e8e3-34f9-4773-82ee-6398869533b0',
            'Estevia-Prod-RG',
            'esteviatech.com',
            'https://dev.azure.com/esteviatech',
            'Estevia-Platform',
            'estevia-frontend-vars',
            'Estevia-TechSolutions'
        ]);

        // Seed/Update 'org-1' organization values with placeholders
        console.log('Seeding and updating configuration for "org-1" organization...');
        await connection.query(`
            UPDATE organizations SET
                azure_subscription_id = ?,
                azure_resource_group = ?,
                default_dns_domain = ?,
                azure_devops_org_url = ?,
                azure_devops_project = ?,
                pipeline_variable_group = ?,
                github_owner = ?
            WHERE id = 'org-1'
        `, [
            '00000000-0000-0000-0000-000000000000',
            'Org1-Prod-RG',
            'org1tech.com',
            'https://dev.azure.com/org1tech',
            'Org1-Platform',
            'org1-frontend-vars',
            'Org1-TechSolutions'
        ]);

        console.log('Migration and seeding completed successfully!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await connection.end();
        console.log('Connection closed.');
    }
}

migrate().catch(console.error);
