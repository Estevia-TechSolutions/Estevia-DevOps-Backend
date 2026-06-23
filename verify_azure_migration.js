const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// Choose which environment config file to load
const envFile = process.env.ENV_FILE || (process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env');
const envPath = path.resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
    console.log(`[Migration Verification] Loading environment from: ${envFile}`);
    require('dotenv').config({ path: envPath });
} else {
    console.log(`[Migration Verification] Loading default .env file`);
    require('dotenv').config();
}

async function verifyMigration() {
    if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASSWORD) {
        throw new Error('DB_HOST, DB_USER, and DB_PASSWORD environment variables must be set before running migration verification.');
    }
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'estevia_devops',
        port: parseInt(process.env.DB_PORT) || 3306,
        ssl: { require: true, rejectUnauthorized: false }
    });

    try {
        console.log('================================================================');
        console.log('   AZURE MYSQL - MIGRATION VERIFICATION');
        console.log('================================================================');

        // 1. List all databases on the server
        const [dbs] = await conn.query('SHOW DATABASES');
        console.log('\n📦 Databases on Azure server:');
        dbs.forEach(d => console.log('  -', Object.values(d)[0]));

        // 2. Check tables in estevia_devops
        const [tables] = await conn.query('SHOW TABLES');
        console.log('\n📋 Tables in estevia_devops:');
        tables.forEach(t => console.log('  -', Object.values(t)[0]));

        // 3. Row counts per table
        console.log('\n📊 Row counts:');
        for (const t of tables) {
            const tableName = Object.values(t)[0];
            const [[{ count }]] = await conn.query(`SELECT COUNT(*) as count FROM \`${tableName}\``);
            console.log(`  - ${tableName}: ${count} rows`);
        }

        // 4. Sample organizations
        const [orgs] = await conn.query('SELECT id, name, azure_subscription_id, tenant_id FROM organizations');
        console.log('\n🏢 Organizations:');
        orgs.forEach(o => console.log(`  - [${o.id}] ${o.name} | sub: ${o.azure_subscription_id} | tenant: ${o.tenant_id}`));

        // 5. Sample users
        const [users] = await conn.query('SELECT id, email, name, organization_id, role FROM users');
        console.log('\n👤 Users:');
        users.forEach(u => console.log(`  - [${u.id}] ${u.email} (${u.role}) @ ${u.organization_id}`));

        // 6. Credential providers
        const [creds] = await conn.query('SELECT organization_id, provider, created_at FROM integration_credentials');
        console.log('\n🔑 Credentials:');
        creds.forEach(c => console.log(`  - ${c.organization_id} / ${c.provider} (${c.created_at})`));

        // 7. Applications summary
        const [apps] = await conn.query('SELECT organization_id, name, app_type, status FROM applications LIMIT 10');
        console.log('\n🚀 Applications (first 10):');
        apps.forEach(a => console.log(`  - [${a.app_type}] ${a.name} (${a.status}) @ ${a.organization_id}`));

        console.log('\n================================================================');
        console.log('✅ Verification complete!');
        console.log('================================================================');
    } finally {
        await conn.end();
    }
}

verifyMigration().catch(err => {
    console.error('❌ Verification failed:', err.message);
    process.exit(1);
});
