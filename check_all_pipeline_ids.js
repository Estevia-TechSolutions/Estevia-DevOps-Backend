const path = require('path');
const fs = require('fs');

const envFile = process.env.ENV_FILE || (fs.existsSync('.env.deployment') ? '.env.deployment' : '.env');
console.log(`Loading environment from: ${envFile}`);
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const db = require('./config/db');

function stripEnvSuffixes(name) {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/-(dev|qa|prod|production|staging|test)(-swa)?$/i, '')
        .replace(/(-swa)?$/i, '');
}

async function check() {
    try {
        console.log('=== Database Pipeline ID Mapping Check ===');
        
        console.log('Fetching applications from database...');
        const [apps] = await db.query('SELECT id, name, app_type, pipeline_id, azure_resource_details FROM applications');
        
        console.log('Fetching pipelines from database...');
        const [pipelines] = await db.query('SELECT id, project_name, name FROM pipelines');
        
        console.log(`\nFound ${apps.length} applications and ${pipelines.length} pipelines in DB.\n`);
        
        const pipelineMap = new Map();
        pipelines.forEach(p => pipelineMap.set(String(p.id), p));
        
        let mismatchesCount = 0;
        
        apps.forEach(app => {
            const rawPipeId = app.pipeline_id ? String(app.pipeline_id) : null;
            if (!rawPipeId) {
                console.log(`ℹ️  [OK] Application '${app.name}' has no pipeline_id configured.`);
                return;
            }
            
            if (rawPipeId.startsWith('github-actions:')) {
                console.log(`ℹ️  [OK] Application '${app.name}' is mapped to GitHub Actions: '${rawPipeId}'.`);
                return;
            }
            
            const matchedPipeline = pipelineMap.get(rawPipeId);
            if (!matchedPipeline) {
                console.log(`⚠️  [MISMATCH] Application '${app.name}' is mapped to pipeline ID '${rawPipeId}' but no such pipeline exists in pipelines table.`);
                mismatchesCount++;
                return;
            }
            
            const strippedApp = stripEnvSuffixes(app.name);
            const strippedPipe = stripEnvSuffixes(matchedPipeline.project_name || matchedPipeline.name);
            
            if (strippedApp !== strippedPipe) {
                console.log(`❌ [MISMATCH] Application '${app.name}' has pipeline_id '${rawPipeId}' (which belongs to pipeline '${matchedPipeline.name}' / project '${matchedPipeline.project_name}'). Names do not match!`);
                mismatchesCount++;
            } else {
                console.log(`✅ [OK] Application '${app.name}' is correctly mapped to pipeline '${matchedPipeline.name}' (ID: ${rawPipeId}).`);
            }
        });
        
        console.log(`\n=== Check complete. Found ${mismatchesCount} mismatch(es). ===`);
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Error connecting to database:', err.message);
        console.log('\nPlease make sure your VPN is connected / database host is reachable and try again.');
        process.exit(1);
    }
}

check();
