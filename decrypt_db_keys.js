const db = require('./config/db');
const { decrypt } = require('./utils/crypto');

async function check() {
    try {
        const [rows] = await db.query('SELECT * FROM integration_credentials');
        rows.forEach(r => {
            const dec = decrypt(r.encrypted_secrets, r.iv, r.auth_tag);
            console.log(`PROVIDER: ${r.provider}`);
            console.log(`DECRYPTED SECRETS:`, dec);
        });
        process.exit(0);
    } catch (e) {
        console.error('ERROR:', e);
        process.exit(1);
    }
}

check();
