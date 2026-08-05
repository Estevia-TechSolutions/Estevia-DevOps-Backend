require('dotenv').config();
const pipelineController = require('./controllers/pipelineController.js');

const branchesEvaops = pipelineController.getSupportedBranches('api-evaops');
const branchesFrontend = pipelineController.getSupportedBranches('evaops-frontend-swa');

console.log('branchesEvaops:', branchesEvaops);
console.log('branchesFrontend:', branchesFrontend);
process.exit(0);
