const db = require('./config/db');

async function fix() {
    try {
        await db.query("UPDATE users SET organization_id = 'estevia' WHERE id = 'dev-bypass-user-id'");
        console.log('Successfully updated dev-bypass-user-id organization_id to estevia!');
        process.exit(0);
    } catch (e) {
        console.error('ERROR:', e);
        process.exit(1);
    }
}

fix();
