const db = require('./config/db');
const { decrypt } = require('./utils/crypto');
const axios = require('axios');

async function checkPipelines() {
    try {
        console.log('Retrieving Azure DevOps credentials from DB...');
        const [rows] = await db.query(
            'SELECT encrypted_secrets, iv, auth_tag FROM integration_credentials WHERE organization_id = ? AND provider = ?',
            ['estevia', 'azure_devops']
        );

        if (rows.length === 0) {
            console.error('No Azure DevOps credentials found in DB.');
            return;
        }

        const { encrypted_secrets, iv, auth_tag } = rows[0];
        const decrypted = decrypt(encrypted_secrets, iv, auth_tag);
        const creds = JSON.parse(decrypted);
        const pat = creds.pat;

        const orgUrl = 'https://dev.azure.com/esteviatech';
        const project = 'Estevia-Platform';
        const apiUrl = `${orgUrl}/${project}/_apis/pipelines?api-version=7.1-preview.1`;

        const response = await axios.get(apiUrl, {
            headers: {
                'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
            }
        });

        console.log(`Found ${response.data.count} pipelines:`);
        response.data.value.forEach(p => {
            console.log(`- ID: ${p.id}, Name: ${p.name}`);
        });

    } catch (e) {
        console.error('Error:', e.response?.data || e.message);
    } finally {
        await db.end();
    }
}

checkPipelines();
