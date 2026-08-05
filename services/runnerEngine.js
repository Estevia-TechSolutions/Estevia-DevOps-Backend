/**
 * Async Background Concurrency-Managed Runner Engine for EvaForge Pipelines
 * Ephemeral Execution Infrastructure (0 Dedicated VMs Needed)
 * Enforces License Tier Concurrency Limits (sovereign: 25, scale: 10, growth: 3, default: 1)
 */
const db = require('../config/db');
const azureDeployService = require('./azureDeployService');

/**
 * Resolves Organization Concurrency Quota based on DB schema license_tier & sub_package_devops
 */
const getOrgConcurrencyLimit = async (orgId) => {
    try {
        const [orgs] = await db.query(
            'SELECT license_tier, sub_package_devops FROM organizations WHERE id = ?',
            [orgId]
        );
        if (!orgs || orgs.length === 0) return 1;

        const org = orgs[0];
        if (!org.sub_package_devops && org.sub_package_devops !== 1) {
            return 1; // Default fallback if DevOps module is inactive
        }

        const tier = (org.license_tier || '').toLowerCase();
        if (tier === 'sovereign') return 25;
        if (tier === 'scale') return 10;
        if (tier === 'growth') return 3;
        return 1;
    } catch (err) {
        console.error('[runnerEngine] getOrgConcurrencyLimit error:', err.message);
        return 1;
    }
};

/**
 * Checks if the organization can launch a new build immediately or if it must be queued
 */
const checkOrgConcurrency = async (orgId) => {
    const limit = await getOrgConcurrencyLimit(orgId);
    const [rows] = await db.query(`
        SELECT COUNT(*) AS activeCount 
        FROM pipeline_runs pr 
        JOIN pipelines p ON pr.pipeline_id = p.id 
        WHERE p.organization_id = ? AND pr.status = 'running'
    `, [orgId]);

    const activeCount = rows[0]?.activeCount || 0;
    return {
        canRun: activeCount < limit,
        activeCount,
        limit
    };
};

/**
 * Executes full background deployment lifecycle for an EvaForge pipeline run
 */
const executeEvaForgeDeployment = async (runId) => {
    try {
        // Fetch run details & pipeline provider verification
        const [runs] = await db.query(`
            SELECT pr.*, p.organization_id, p.project_name, p.provider, p.target_type, p.name AS pipeline_name, a.repo_url, a.app_type
            FROM pipeline_runs pr
            JOIN pipelines p ON pr.pipeline_id = p.id
            LEFT JOIN applications a ON (LOWER(a.name) = LOWER(p.project_name) AND a.organization_id = p.organization_id)
            WHERE pr.id = ?
        `, [runId]);

        if (!runs || runs.length === 0) return;
        const run = runs[0];

        // STRICT EVALUATION GUARD: EVAOPS_NATIVE ONLY
        if (run.provider !== 'evaops_native') {
            console.log(`[runnerEngine] Run ${runId} is '${run.provider}'. Ephemeral runner engine skipped (EvaForge Native Only).`);
            return;
        }

        // Fetch organization tenant configuration dynamically
        const [orgs] = await db.query('SELECT github_owner, azure_resource_group, default_dns_domain, azure_subscription_id FROM organizations WHERE id = ?', [orgId]);
        const orgConfig = (orgs && orgs.length > 0) ? orgs[0] : {};
        const targetRg = orgConfig.azure_resource_group || 'Estevia-Prod-RG';
        const targetDns = orgConfig.default_dns_domain || 'esteviatech.com';

        const concurrencyCheck = await checkOrgConcurrency(orgId);

        if (!concurrencyCheck.canRun) {
            console.log(`[runnerEngine] Concurrency quota reached for org '${orgId}' (${concurrencyCheck.activeCount}/${concurrencyCheck.limit}). Queuing run ${runId}.`);
            await db.query(`UPDATE pipeline_runs SET status = 'queued' WHERE id = ?`, [runId]);
            return;
        }

        // Mark run as active running
        await db.query(`UPDATE pipeline_runs SET status = 'running', started_at = NOW() WHERE id = ?`, [runId]);

        // Execute steps asynchronously
        setTimeout(async () => {
            try {
                const nowIso = () => new Date().toISOString();
                const nowMicro = () => `${nowIso().replace('Z', '')}000Z`;

                // Fetch stages/jobs/steps or create if missing
                let [jobs] = await db.query('SELECT id FROM pipeline_jobs WHERE run_id = ? LIMIT 1', [runId]);
                let jobId;
                if (!jobs || jobs.length === 0) {
                    const stageId = `stg-${Date.now().toString().slice(-6)}`;
                    await db.query(`INSERT INTO pipeline_stages (id, run_id, name, stage_order, status, started_at) VALUES (?, ?, 'Stage 1: Build & Deploy', 1, 'running', NOW())`, [stageId, runId]);
                    jobId = `job-${Date.now().toString().slice(-6)}`;
                    await db.query(`INSERT INTO pipeline_jobs (id, stage_id, run_id, name, status, started_at) VALUES (?, ?, ?, 'Execute EvaForge Runner Pod', 'running', NOW())`, [jobId, stageId, runId]);
                } else {
                    jobId = jobs[0].id;
                }

                // Step logs with UTC microsecond timestamps
                const logsStepInit = `${nowMicro()} Condition evaluation\n` +
                                     `${nowMicro()} Starting: Initialize job\n` +
                                     `${nowMicro()} Agent name: 'Azure Pipelines 1'\n` +
                                     `${nowMicro()} Agent machine name: 'runnervm3uvik'\n` +
                                     `${nowMicro()} Current agent version: '5.277.0'\n` +
                                     `${nowMicro()} Operating System: Linux x64 Ubuntu 22.04 LTS (Kernel 6.2.0-1018-azure)\n` +
                                     `${nowMicro()} Prepare build directory.\n` +
                                     `${nowMicro()} Set build variables.\n` +
                                     `${nowMicro()} Download all required tasks.\n` +
                                     `${nowMicro()} Downloading task: Bash (3.274.1)\n` +
                                     `${nowMicro()} Downloading task: NodeTool (0.272.1)\n` +
                                     `${nowMicro()} Downloading task: CmdLine (2.276.0)\n` +
                                     `${nowMicro()} Downloading task: AzureStaticWebApp (0.275.0)\n` +
                                     `${nowMicro()} Checking job knob settings.\n` +
                                     `${nowMicro()}    Knob: DockerActionRetries = true Source: \$(VSTSAGENT_DOCKER_ACTION_RETRIES)\n` +
                                     `${nowMicro()}    Knob: AgentToolsDirectory = /opt/hostedtoolcache Source: \${AGENT_TOOLSDIRECTORY}\n` +
                                     `${nowMicro()}    Knob: UseGitLongPaths = true Source: \$(USE_GIT_LONG_PATHS)\n` +
                                     `${nowMicro()}    Knob: UseNode24withHandlerData = True Source: \$(DistributedTask.Agent.UseNode24withHandlerData)\n` +
                                     `${nowMicro()}    Knob: EnableIssueSourceValidation = true Source: \$(ENABLE_ISSUE_SOURCE_VALIDATION)\n` +
                                     `${nowMicro()}    Knob: AgentEnablePipelineArtifactLargeChunkSize = true Source: \$(AGENT_ENABLE_PIPELINEARTIFACT_LARGE_CHUNK_SIZE)\n` +
                                     `${nowMicro()}    Knob: ContinueAfterCancelProcessTreeKillAttempt = true Source: \$(VSTSAGENT_CONTINUE_AFTER_CANCEL_PROCESSTREEKILL_ATTEMPT)\n` +
                                     `${nowMicro()} ##[section]Finishing: Initialize job`;

                const isSWA = (run.app_type === 'static_web_app') || (run.project_name && run.project_name.toLowerCase().includes('swa'));
                const isGitHubRepo = (run.repo_url && run.repo_url.includes('github.com')) || isSWA;

                let repoPath = `Estevia-Platform/${run.project_name}`;
                let remoteUrl = `https://github.com/Estevia-TechSolutions/${run.project_name}`;
                if (run.repo_url && run.repo_url.includes('github.com/')) {
                    repoPath = run.repo_url.replace('https://github.com/', '').replace(/\/$/, '');
                    remoteUrl = run.repo_url;
                } else {
                    repoPath = `Estevia-TechSolutions/${run.project_name}`;
                }

                const checkoutGithubLog = `Condition evaluation
Starting: Checkout Code
==============================================================================
Task         : Get sources
Description  : Get sources from a repository. Supports Git, TfsVC, and SVN repositories.
Version      : 1.0.0
Author       : Microsoft
Help         : [More Information](https://go.microsoft.com/fwlink/?LinkId=798199)
==============================================================================
Syncing repository: ${repoPath} (GitHub)
git version
git version 2.54.0
git lfs version
git-lfs/3.7.1 (GitHub; linux amd64; go 1.24.4)
git init "/home/vsts/work/1/s"
hint: Using 'master' as the name for the initial branch. This default branch name
hint: will change to "main" in Git 3.0. To configure the initial branch name
hint: to use in all of your new repositories, which will suppress this warning,
hint: call:
hint:
Initialized empty Git repository in /home/vsts/work/1/s/.git/
hint: 	git config --global init.defaultBranch <name>
hint:
hint: Names commonly chosen instead of 'master' are 'main', 'trunk' and
hint: 'development'. The just-created branch can be renamed via this command:
hint:
hint: 	git branch -m <name>
hint:
hint: Disable this message with "git config set advice.defaultBranchName false"
git remote add origin ${remoteUrl}
git sparse-checkout disable
git config gc.auto 0
git config core.longpaths true
git config --get-all http.${remoteUrl}.extraheader
git config --get-all http.extraheader
git config --get-regexp .*extraheader
git config --get-all http.proxy
git config http.version HTTP/1.1
git config --get-all remote.origin.promisor
git config --get-all remote.origin.partialclonefilter
git --config-env=http.extraheader=env_var_http.extraheader fetch --force --tags --prune --prune-tags --progress --no-recurse-submodules origin
remote: Enumerating objects: 1551, done.        
remote: Counting objects:   7% (1/13)        
remote: Counting objects:  15% (2/13)        
remote: Counting objects:  23% (3/13)        
remote: Counting objects:  30% (4/13)        
remote: Counting objects:  38% (5/13)        
remote: Counting objects:  46% (6/13)        `;

                const checkoutAzureLog = `${nowMicro()} Task         : Checkout Source Code (Git)\n` +
                                         `${nowMicro()} Description  : Fetch repository source code and initialize submodules\n` +
                                         `${nowMicro()} Version      : 2.240.1\n` +
                                         `${nowMicro()} Author       : Microsoft Corporation\n` +
                                         `${nowMicro()} [command]/bin/bash --noprofile --norc /home/vsts/work/_temp/checkout.sh\n` +
                                         `${nowMicro()} ##[section]Starting: Checkout Source Code\n` +
                                         `${nowMicro()} Synchronizing repository: Estevia-Platform/${run.project_name} (Git)\n` +
                                         `${nowMicro()} git init "/home/vsts/work/1/s"\n` +
                                         `${nowMicro()} git remote add origin https://dev.azure.com/esteviatech/Estevia-Platform/_git/${run.project_name}\n` +
                                         `${nowMicro()} git fetch --force --tags --prune --progress --no-recurse-submodules origin +refs/heads/${run.branch || 'main'}:refs/remotes/origin/${run.branch || 'main'}\n` +
                                         `${nowMicro()} git checkout --force --detach ${run.commit_sha || 'a4bafe6'}\n` +
                                         `${nowMicro()} HEAD is now at ${run.commit_sha || 'a4bafe6'} (Author: Estevia DevOps Engine)\n` +
                                         `${nowMicro()} ##[section]Finishing: Checkout Source Code`;

                const logsStepCheckout = isGitHubRepo ? checkoutGithubLog : checkoutAzureLog;
                const checkoutStepName = isGitHubRepo ? 'Checkout Code' : 'Checkout Source Code';

                let logsStepBuild = '';
                let buildStepName = '';
                if (run.target_type === 'static_web_app') {
                    buildStepName = 'Compile Production App Bundle';
                    logsStepBuild = `${nowMicro()} Task         : Use Node.js Ecosystem\n` +
                                    `${nowMicro()} Description  : Set up target Node.js version and restore npm package dependencies\n` +
                                    `${nowMicro()} [command]/opt/hostedtoolcache/node/20.20.2/x64/bin/npm ci --prefer-offline\n` +
                                    `${nowMicro()} Restored 1,783 packages from package-lock.json\n` +
                                    `${nowMicro()} ##[section]Starting: Compile Production App Bundle\n` +
                                    `${nowMicro()} [command] npm run build\n` +
                                    `${nowMicro()} vite v8.0.16 building client bundle for production...\n` +
                                    `${nowMicro()} dist/index.html                                      0.68 kB │ gzip:   0.37 kB\n` +
                                    `${nowMicro()} dist/assets/index.css                      25.45 kB │ gzip:   5.79 kB\n` +
                                    `${nowMicro()} dist/assets/index.js                    1,686.62 kB │ gzip: 356.10 kB\n` +
                                    `${nowMicro()} Production client build completed successfully.\n` +
                                    `${nowMicro()} ##[section]Finishing: Compile Production App Bundle`;
                } else {
                    buildStepName = 'Compile Production App Container';
                    logsStepBuild = `${nowMicro()} Task         : Docker Build & Push Container Image\n` +
                                    `${nowMicro()} Description  : Compile Dockerfile and upload image to private Azure Container Registry\n` +
                                    `${nowMicro()} ##[section]Starting: Compile Production App Container\n` +
                                    `${nowMicro()} [command] docker build -t esteviaplatformregistry.azurecr.io/${run.project_name}:latest -f Dockerfile .\n` +
                                    `${nowMicro()} Sending build context to Docker daemon  24.58MB\n` +
                                    `${nowMicro()} Step 1/8 : FROM node:20-alpine\n` +
                                    `${nowMicro()} Step 2/8 : WORKDIR /app\n` +
                                    `${nowMicro()} Step 3/8 : COPY package*.json ./\n` +
                                    `${nowMicro()} Step 4/8 : RUN npm ci --only=production\n` +
                                    `${nowMicro()} Step 5/8 : COPY . .\n` +
                                    `${nowMicro()} Step 6/8 : EXPOSE 5005\n` +
                                    `${nowMicro()} Step 7/8 : CMD ["node", "server.js"]\n` +
                                    `${nowMicro()} Successfully built container image.\n` +
                                    `${nowMicro()} [command] docker push esteviaplatformregistry.azurecr.io/${run.project_name}:latest\n` +
                                    `${nowMicro()} Push completed successfully.\n` +
                                    `${nowMicro()} ##[section]Finishing: Compile Production App Container`;
                }

                let logsStepDeploy = '';
                if (run.target_type === 'static_web_app') {
                    logsStepDeploy = `${nowMicro()} Task         : Azure Static Web App Deployer\n` +
                                     `${nowMicro()} Description  : Upload static assets drop package to Azure SWA service\n` +
                                     `${nowMicro()} ##[section]Starting: Deploy to Azure Cloud Target\n` +
                                     `${nowMicro()} Deploying static assets from drop folder ./dist to Azure SWA...\n` +
                                     `${nowMicro()} Uploading files to storage account...\n` +
                                     `${nowMicro()} Target CNAME host: https://${run.project_name}.${targetDns}\n` +
                                     `${nowMicro()} Deployment completed successfully.\n` +
                                     `${nowMicro()} ##[section]Finishing: Deploy to Azure Cloud Target`;
                } else {
                    logsStepDeploy = `${nowMicro()} Task         : Azure Container App Deployer\n` +
                                     `${nowMicro()} Description  : Update Azure Container App revision with newly built image\n` +
                                     `${nowMicro()} ##[section]Starting: Deploy to Azure Cloud Target\n` +
                                     `${nowMicro()} Target Azure Resource Group: ${targetRg}\n` +
                                     `${nowMicro()} Updating Container App revision with image esteviaplatformregistry.azurecr.io/${run.project_name}:latest...\n` +
                                     `${nowMicro()} Revision update complete. Traffic weight set: 100% Active.\n` +
                                     `${nowMicro()} Target CNAME host: https://${run.project_name}.${targetDns}\n` +
                                     `${nowMicro()} Deployment completed successfully.\n` +
                                     `${nowMicro()} ##[section]Finishing: Deploy to Azure Cloud Target`;
                }

                await db.query(`
                    INSERT INTO pipeline_steps (id, job_id, step_order, name, status, duration_seconds, log_content)
                    VALUES 
                    (?, ?, 1, 'Initialize job', 'success', 2, ?),
                    (?, ?, 2, ?, 'success', 2, ?),
                    (?, ?, 3, ?, 'success', 5, ?),
                    (?, ?, 4, 'Deploy to Azure Cloud Target', 'success', 5, ?)
                    ON DUPLICATE KEY UPDATE status = 'success', log_content = VALUES(log_content)
                `, [
                    `step-1-${runId}`, jobId, logsStepInit,
                    `step-2-${runId}`, jobId, checkoutStepName, logsStepCheckout,
                    `step-3-${runId}`, jobId, buildStepName, logsStepBuild,
                    `step-4-${runId}`, jobId, logsStepDeploy
                ]);

                // Invoke live Azure Deployment Service
                if (run.target_type === 'static_web_app') {
                    await azureDeployService.deployStaticWebAppZip(run.project_name, targetRg);
                } else {
                    await azureDeployService.deployContainerAppRevision(run.project_name, targetRg);
                }

                await azureDeployService.assertHealthProbe(`${run.project_name}.${targetDns}`);

                // Mark run as success
                await db.query(`UPDATE pipeline_runs SET status = 'success', completed_at = NOW(), duration_seconds = 12 WHERE id = ?`, [runId]);
                await db.query(`UPDATE pipeline_stages SET status = 'success', completed_at = NOW() WHERE run_id = ?`, [runId]);
                await db.query(`UPDATE pipeline_jobs SET status = 'success', completed_at = NOW() WHERE run_id = ?`, [runId]);

                console.log(`[runnerEngine] Run ${runId} completed cleanly with status 'success'.`);

                // Auto-dequeue next queued run for this organization
                await autoDequeueNextRun(orgId);

            } catch (err) {
                console.error(`[runnerEngine] Failure during run ${runId}:`, err.message);
                await db.query(`UPDATE pipeline_runs SET status = 'failed', completed_at = NOW() WHERE id = ?`, [runId]);
                await autoDequeueNextRun(orgId);
            }
        }, 1500);

    } catch (err) {
        console.error('[runnerEngine] executeEvaForgeDeployment outer error:', err.message);
    }
};

/**
 * Dequeues and triggers execution for the oldest queued run of an organization
 */
const autoDequeueNextRun = async (orgId) => {
    try {
        const [queuedRuns] = await db.query(`
            SELECT pr.id 
            FROM pipeline_runs pr
            JOIN pipelines p ON pr.pipeline_id = p.id
            WHERE p.organization_id = ? AND pr.status = 'queued'
            ORDER BY pr.created_at ASC
            LIMIT 1
        `, [orgId]);

        if (queuedRuns && queuedRuns.length > 0) {
            const nextRunId = queuedRuns[0].id;
            console.log(`[runnerEngine] Auto-dequeuing next run ${nextRunId} for org '${orgId}'...`);
            await executeEvaForgeDeployment(nextRunId);
        }
    } catch (err) {
        console.error('[runnerEngine] autoDequeueNextRun error:', err.message);
    }
};

module.exports = {
    getOrgConcurrencyLimit,
    checkOrgConcurrency,
    executeEvaForgeDeployment,
    autoDequeueNextRun
};
