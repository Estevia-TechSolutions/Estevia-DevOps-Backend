require('dotenv').config();
const db = require('./config/db');
const pipelineController = require('./controllers/pipelineController.js');

// Simulate the listPipelineRuns request
const req = {
    query: {
        organizationId: 'estevia'
    }
};

const res = {
    json: (data) => {
        console.log('API response data (runs count):', data.length);
        const evaopsRuns = data.filter(r => r.project_name && r.project_name.toLowerCase().includes('evaops'));
        console.log('Evaops runs in API response:');
        console.log(JSON.stringify(evaopsRuns.map(r => ({
            id: r.id,
            project_name: r.project_name,
            supported_branches: r.supported_branches,
            branches: r.branches
        })), null, 2));
        process.exit(0);
    },
    status: (code) => {
        return {
            json: (err) => {
                console.error('Error status:', code, err);
                process.exit(1);
            }
        };
    }
};

pipelineController.listPipelineRuns(req, res).catch(err => {
    console.error('Failed to run listPipelineRuns:', err);
    process.exit(1);
});
