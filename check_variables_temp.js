const db = require('./config/db');
const { decrypt } = require('./utils/crypto');
const axios = require('axios');

async function checkVariables() {
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
        const groupName = 'estevia-frontend-vars';
        const listUrl = `${orgUrl}/${project}/_apis/distributedtask/variablegroups?groupName=${groupName}&api-version=7.1-preview.1`;

        console.log(`Fetching variable group '${groupName}'...`);
        const listRes = await axios.get(listUrl, {
            headers: {
                'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`
            }
        });

        if (!listRes.data || listRes.data.count === 0) {
            console.warn(`Variable group '${groupName}' not found.`);
            return;
        }

        const group = listRes.data.value[0];
        console.log(`Variable group '${groupName}' details:`);
        console.log(`ID: ${group.id}`);
        console.log(`Variables:`, Object.keys(group.variables));
    } catch (e) {
        console.error('Error:', e.response?.data || e.message);
    } finally {
        await db.end();
    }
}

checkVariables();
