const http = require('http');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'estevia-devops-jwt-super-secret-key-12345'; // fallback key from middleware/authController
const mockToken = jwt.sign({ id: 'govind.m@Esteviatech.com', role: 'member', tenant_id: 'a39c526c-2005-4529-ab5a-f008fc5cbc57' }, JWT_SECRET, { expiresIn: '1h' });

function makeRequest(path, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: 5005,
            path: path,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, body: data });
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function test() {
    try {
        console.log('TESTING DECRYPT ENDPOINT WITH VALID MOCK JWT:');
        
        // Decrypt github
        const resGithub = await makeRequest('/api/credentials/decrypt?organizationId=estevia&provider=github', mockToken);
        console.log('GitHub response:', resGithub.statusCode, resGithub.body);

        // Decrypt godaddy
        const resGodaddy = await makeRequest('/api/credentials/decrypt?organizationId=estevia&provider=godaddy', mockToken);
        console.log('GoDaddy response:', resGodaddy.statusCode, resGodaddy.body);
        
        // Decrypt azure_devops
        const resDevops = await makeRequest('/api/credentials/decrypt?organizationId=estevia&provider=azure_devops', mockToken);
        console.log('Azure DevOps response:', resDevops.statusCode, resDevops.body);
        
    } catch (e) {
        console.error(e);
    }
}

test();
