const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
    const host = process.env.DB_HOST || 'estevia-prod-db-v2.estevia-prod-db.private.mysql.database.azure.com';
    const user = process.env.DB_USER || 'estevia';
    const password = process.env.DB_PASSWORD || 'Ewco26INCP';
    const database = process.env.DB_NAME || 'estevia_devops';
    const port = process.env.DB_PORT || 3306;

    console.log(`Connecting to MySQL database server: ${host} as ${user}...`);
    
    let connection;
    try {
        connection = await mysql.createConnection({
            host,
            user,
            password,
            port
        });
    } catch (err) {
        console.error('CRITICAL: Failed to connect to database server:', err.message);
        console.log('\nTroubleshooting Info:');
        console.log('1. Ensure you are connected to the corporate VPN if using a private endpoint host.');
        console.log('2. Verify that your local machine is whitelisted on the MySQL Server firewall rules.');
        console.log('3. Ensure Azure credentials in the .env match host authorization.');
        process.exit(1);
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
                created_by VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Create users table
        console.log('Creating users table...');
        await connection.query(`
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
            )
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

        // 6. Seed initial organizations
        console.log('Seeding initial organizations and config settings...');
        await connection.query(`
            INSERT INTO organizations (
                id, name, azure_subscription_id, azure_resource_group, default_dns_domain, 
                azure_devops_org_url, azure_devops_project, pipeline_variable_group, github_owner,
                tenant_id, onboarding_complete
            ) VALUES (
                'estevia', 'Estevia Tech Solutions', 'a812e8e3-34f9-4773-82ee-6398869533b0', 'Estevia-Prod-RG', 'esteviatech.com',
                'https://dev.azure.com/esteviatech', 'Estevia-Platform', 'estevia-frontend-vars', 'Estevia-TechSolutions',
                'a39c526c-2005-4529-ab5a-f008fc5cbc57', 1
            ) ON DUPLICATE KEY UPDATE 
                azure_subscription_id = VALUES(azure_subscription_id),
                azure_resource_group = VALUES(azure_resource_group),
                tenant_id = VALUES(tenant_id),
                onboarding_complete = VALUES(onboarding_complete)
        `);

        await connection.query(`
            INSERT INTO organizations (id, name) VALUES ('org-1', 'Estevia Techsolutions')
            ON DUPLICATE KEY UPDATE name = VALUES(name)
        `);

        // 7. Seed bypass developer user
        console.log('Seeding Developer Bypass account...');
        await connection.query(`
            INSERT INTO users (id, email, name, organization_id, role)
            VALUES ('dev-bypass-user-id', 'dev@estevia.com', 'Developer Bypass', 'estevia', 'admin')
            ON DUPLICATE KEY UPDATE organization_id = VALUES(organization_id), role = VALUES(role)
        `);

        console.log('\n================================================================');
        console.log('SUCCESS: Database migration and seeding completed successfully!');
        console.log('================================================================');
        process.exit(0);

    } catch (err) {
        console.error('ERROR: Migration execution failed:', err);
        process.exit(1);
    } finally {
        if (connection) await connection.end();
    }
}

main().catch(console.error);
