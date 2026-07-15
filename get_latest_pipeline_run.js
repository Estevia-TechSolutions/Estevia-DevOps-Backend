const jwt = require('jsonwebtoken');
const axios = require('axios');

const JWT_SECRET = 'estevia-devops-jwt-super-secret-key-12345';
const payload = {
    id: 'govind.m@esteviatech.com',
    email: 'govind.m@esteviatech.com',
    role: 'owner',
    organization_id: 'estevia',
    tenant_id: 'a39c526c-2005-4529-ab5a-f008fc5cbc57'
};

const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

async function main() {
    const url = 'https://api-evaops.mangomoss-fa161497.eastus2.azurecontainerapps.io/api/apps/scan?organizationId=estevia';
    try {
        const res = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const app = res.data.apps.find(a => a.name === 'estevia-restaurant-backend-dev');
        console.log('Latest build details:\n', JSON.stringify(app?.pipelineRun || null, null, 2));
    } catch (e) {
        console.error('Fetch failed:', e.message);
    }
}
main();
