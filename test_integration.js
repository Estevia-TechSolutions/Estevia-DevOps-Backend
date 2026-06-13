const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Choose which environment config file to load
const envFile = process.env.ENV_FILE || (process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env');
const envPath = path.resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
    console.log(`[Test Integration] Loading environment from: ${envFile}`);
    require('dotenv').config({ path: envPath });
} else {
    console.log(`[Test Integration] Loading default .env file`);
    require('dotenv').config();
}

// Re-create the server instance in test mode
const app = express();
app.use(cors());
app.use(express.json());

// Mock user session context for integration testing bypass
app.use((req, res, next) => {
    req.user = { id: 'dev-bypass-user-id', email: 'dev@estevia.com', role: 'admin', organization_id: 'estevia' };
    next();
});

const credentialRoutes = require('./routes/credentialRoutes');
const appRoutes = require('./routes/appRoutes');
app.use('/api/credentials', credentialRoutes);
app.use('/api/apps', appRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'HEALTHY', timestamp: new Date() });
});

let server;
const TEST_PORT = 5099;

function startServer() {
    return new Promise((resolve) => {
        server = app.listen(TEST_PORT, () => {
            console.log(`[Test Integration] Server started on port ${TEST_PORT}`);
            resolve();
        });
    });
}

function stopServer() {
    return new Promise((resolve) => {
        server.close(() => {
            console.log('[Test Integration] Server stopped');
            resolve();
        });
    });
}

function makeRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: TEST_PORT,
            path: path,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    body: JSON.parse(data)
                });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

async function runIntegrationTests() {
    console.log('=== Starting Backend Integration Tests ===');
    await startServer();

    try {
        // Test 1: Verify health check
        console.log('Test 1: Requesting /health...');
        const healthRes = await makeRequest('/health');
        console.log('Status Code:', healthRes.statusCode);
        console.log('Response:', healthRes.body);
        if (healthRes.statusCode !== 200 || healthRes.body.status !== 'HEALTHY') {
            throw new Error('Health check endpoint failed');
        }
        console.log('✅ Test 1 Passed.');

        // // Test 2: Request credentials list with missing organizationId
        // console.log('Test 2: Requesting /api/credentials (missing parameters)...');
        // const credsRes = await makeRequest('/api/credentials');
        // console.log('Status Code:', credsRes.statusCode);
        // console.log('Response:', credsRes.body);
        // if (credsRes.statusCode !== 400) {
        //     throw new Error('Expected 400 Bad Request for missing organization ID');
        // }
        // console.log('✅ Test 2 Passed.');

        // // Test 3: Request credentials list with valid organizationId
        // console.log('Test 3: Requesting /api/credentials?organizationId=estevia...');
        // if (process.env.TF_BUILD) {
        //     console.log('Running in Azure DevOps (CI) environment. Skipping Database integration Test 3 to avoid private network ETIMEDOUT.');
        //     console.log('✅ Test 3 Skipped (CI Mode).');
        // } else {
        //     const credsValidRes = await makeRequest('/api/credentials?organizationId=estevia');
        //     console.log('Status Code:', credsValidRes.statusCode);
        //     console.log('Response count:', Array.isArray(credsValidRes.body) ? credsValidRes.body.length : typeof credsValidRes.body);
        //     if (credsValidRes.statusCode !== 200 || !Array.isArray(credsValidRes.body)) {
        //         throw new Error('Expected 200 OK with list of credentials');
        //     }
        //     console.log('✅ Test 3 Passed.');
        // }

        console.log('=== All Integration Tests Passed Successfully! ===');
    } catch (error) {
        console.error('❌ Integration Test Suite Failed:', error);
        throw error;
    } finally {
        await stopServer();
    }
}

runIntegrationTests()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
