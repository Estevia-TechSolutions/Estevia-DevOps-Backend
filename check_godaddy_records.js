const db = require('./config/db');
const { decrypt } = require('./utils/crypto');
const axios = require('axios');
require('dotenv').config();

async function checkGoDaddy() {
    try {
        console.log('Retrieving GoDaddy credentials from DB...');
        const [rows] = await db.query(
            'SELECT encrypted_secrets, iv, auth_tag FROM integration_credentials WHERE organization_id = ? AND provider = ?',
            ['estevia', 'godaddy']
        );

        if (rows.length === 0) {
            console.error('No GoDaddy credentials found in DB.');
            return;
        }

        const { encrypted_secrets, iv, auth_tag } = rows[0];
        const decrypted = decrypt(encrypted_secrets, iv, auth_tag);
        const creds = JSON.parse(decrypted);
        const apiKey = creds.apiKey;
        const apiSecret = creds.apiSecret;

        console.log('Calling GoDaddy API to list CNAME records...');
        const domain = 'esteviatech.com';
        const url = `https://api.godaddy.com/v1/domains/${domain}/records/CNAME`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': `sso-key ${apiKey}:${apiSecret}`
            }
        });

        console.log(`Found ${response.data.length} CNAME records:`);
        response.data.forEach(r => {
            console.log(`- Host: ${r.name}, Points to: ${r.data}`);
        });

    } catch (e) {
        console.error('Error:', e.response?.data || e.message);
    } finally {
        await db.end();
    }
}

checkGoDaddy();
