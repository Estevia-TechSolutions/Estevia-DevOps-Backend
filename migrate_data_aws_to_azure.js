const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
    // Source DB Config (AWS RDS)
    const sourceConfig = {
        host: 'dev.c8h82uuqyx51.us-east-1.rds.amazonaws.com',
        user: 'admin',
        password: 'Ewco26INCP',
        database: 'estevia_devops',
        port: 3306
    };

    // Target DB Config (Azure - loaded from environment settings)
    const targetConfig = {
        host: '10.0.0.4',
        user: process.env.DB_USER || 'estevia',
        password: process.env.DB_PASSWORD || 'Ewco26INCP',
        database: process.env.DB_NAME || 'estevia_devops',
        port: parseInt(process.env.DB_PORT) || 3306
    };

    console.log('================================================================');
    console.log('       ESTEVIA DEVOPS DATABASE MIGRATION ENGINE (AWS -> AZURE)  ');
    console.log('================================================================');
    
    let sourceConn, targetConn;

    try {
        console.log(`Connecting to SOURCE Database (AWS): ${sourceConfig.host}...`);
        sourceConn = await mysql.createConnection(sourceConfig);
        console.log('Connected to source.');
    } catch (err) {
        console.error('ERROR: Failed to connect to AWS source database:', err.message);
        process.exit(1);
    }

    try {
        console.log(`Connecting to TARGET Database (Azure): ${targetConfig.host}...`);
        targetConn = await mysql.createConnection({
            host: targetConfig.host,
            user: targetConfig.user,
            password: targetConfig.password,
            port: targetConfig.port
        });
        console.log('Connected to target.');
    } catch (err) {
        console.error('ERROR: Failed to connect to Azure target database server:', err.message);
        console.log('\nTroubleshooting Tip: Make sure you are connected to the corporate VPN to access the private endpoint.');
        if (sourceConn) await sourceConn.end();
        process.exit(1);
    }

    try {
        // 1. Ensure target schema and database are initialized
        console.log(`\nVerifying database ${targetConfig.database} exists on Azure server...`);
        await targetConn.query(`CREATE DATABASE IF NOT EXISTS \`${targetConfig.database}\``);
        await targetConn.query(`USE \`${targetConfig.database}\``);

        console.log('Initializing schema tables on target (if not present)...');
        
        await targetConn.query(`
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
                created_by VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await targetConn.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255),
                organization_id VARCHAR(50) DEFAULT NULL,
                role VARCHAR(50) DEFAULT 'member',
                tenant_id VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
            )
        `);

        await targetConn.query(`
            CREATE TABLE IF NOT EXISTS integration_credentials (
                id INT AUTO_INCREMENT PRIMARY KEY,
                organization_id VARCHAR(50) NOT NULL,
                provider VARCHAR(50) NOT NULL,
                credential_name VARCHAR(100) NOT NULL,
                encrypted_secrets TEXT NOT NULL,
                iv VARCHAR(100) NOT NULL,
                auth_tag VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
        `);

        await targetConn.query(`
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

        await targetConn.query(`
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
        console.log('Target database tables initialized.');

        // 2. Disable Foreign Key checks on target during load
        console.log('\nTemporarily disabling foreign key constraint checks on target...');
        await targetConn.query('SET FOREIGN_KEY_CHECKS = 0');

        // Helper migration function
        const migrateTable = async (tableName) => {
            console.log(`\nMigrating table: ${tableName}...`);
            const [rows] = await sourceConn.query(`SELECT * FROM \`${tableName}\``);
            console.log(`Found ${rows.length} records in source.`);

            if (rows.length === 0) {
                console.log(`Skipping migration for empty table ${tableName}`);
                return;
            }

            // Extract columns
            const columns = Object.keys(rows[0]);
            const columnsSql = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const updateSql = columns.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');

            const querySql = `
                INSERT INTO \`${tableName}\` (${columnsSql}) 
                VALUES (${placeholders})
                ON DUPLICATE KEY UPDATE ${updateSql}
            `;

            let successCount = 0;
            for (const row of rows) {
                const values = columns.map(col => {
                    const val = row[col];
                    // Handle JSON type columns correctly for mysql2 query parsing
                    if (val !== null && typeof val === 'object') {
                        return JSON.stringify(val);
                    }
                    return val;
                });
                await targetConn.query(querySql, values);
                successCount++;
            }
            console.log(`Migrated ${successCount} records into ${tableName}.`);
        };

        // Migrate in logical dependency order
        await migrateTable('organizations');
        await migrateTable('users');
        await migrateTable('integration_credentials');
        await migrateTable('applications');
        await migrateTable('organization_invites');

        // Re-enable Foreign Key checks
        console.log('\nRe-enabling foreign key constraints on target...');
        await targetConn.query('SET FOREIGN_KEY_CHECKS = 1');

        console.log('\n================================================================');
        console.log('SUCCESS: Database data migration from AWS to Azure completed!   ');
        console.log('================================================================');
        process.exit(0);

    } catch (err) {
        console.error('\nCRITICAL ERROR during database migration:', err);
        if (targetConn) {
            await targetConn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
        }
        process.exit(1);
    } finally {
        if (sourceConn) await sourceConn.end();
        if (targetConn) await targetConn.end();
    }
}

main().catch(console.error);
