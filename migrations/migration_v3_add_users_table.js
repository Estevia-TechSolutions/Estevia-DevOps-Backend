const mysql = require('mysql2/promise');
require('dotenv').config();

async function migrate() {
    console.log('Connecting to database server...');
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'estevia-dev-db.mysql.database.azure.com',
        user: process.env.DB_USER || 'estevia',
        password: process.env.DB_PASSWORD || 'Ewco26INCP',
        database: process.env.DB_NAME || 'estevia_devops',
        port: process.env.DB_PORT || 3306
    });

    try {
        console.log('Creating users table...');
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255),
                organization_id VARCHAR(50) DEFAULT 'org-1',
                role VARCHAR(50) DEFAULT 'member',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
            )
        `);
        console.log('Users table created successfully.');

        console.log('Seeding Developer Bypass user...');
        await connection.query(`
            INSERT IGNORE INTO users (id, email, name, organization_id, role)
            VALUES ('dev-bypass-user-id', 'dev@estevia.com', 'Developer Bypass', 'org-1', 'admin')
        `);
        console.log('Developer Bypass user seeded successfully.');

        console.log('Migration v3 completed successfully!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await connection.end();
        console.log('Connection closed.');
    }
}

migrate().catch(console.error);
