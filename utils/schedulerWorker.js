const db = require('../config/db');
const { DefaultAzureCredential } = require('@azure/identity');
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');
const { sendTeamsNotification } = require('./teamsNotifier');

const MASTER_ORGANIZATION_ID = process.env.MASTER_ORGANIZATION_ID || 'estevia';
const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID || 'a812e8e3-34f9-4773-82ee-6398869533b0';
const RESOURCE_GROUP = process.env.AZURE_RESOURCE_GROUP || 'Estevia-Prod-RG';

// In-memory transition state cache: key = "orgId:appName", value = 'active' | 'sleep'
// This ensures Teams is notified only when a state CHANGE occurs, not on every tick.
const scaleStateCache = new Map();

// Helper to fetch Azure credentials for organization
async function getAzureCredential(organizationId) {
    try {
        const credentialController = require('../controllers/credentialController');
        const azureSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure');
        if (azureSecrets && azureSecrets.clientId && azureSecrets.clientSecret && azureSecrets.tenantId) {
            const { ClientSecretCredential } = require('@azure/identity');
            return new ClientSecretCredential(azureSecrets.tenantId, azureSecrets.clientId, azureSecrets.clientSecret);
        }
    } catch (err) {
        // Fallback silently
    }
    if (organizationId === MASTER_ORGANIZATION_ID) {
        return new DefaultAzureCredential();
    }
    throw new Error(`Azure Integration credentials not configured for organization: ${organizationId}`);
}

function resolveOrgAzureSettings(orgRow, orgId) {
    let subId = orgRow?.azure_subscription_id;
    let rg = orgRow?.azure_resource_group;
    if (orgId !== MASTER_ORGANIZATION_ID) {
        if (!subId || subId.trim() === '') {
            throw new Error(`Azure Integration (Subscription ID) is not configured for organization: ${orgId}`);
        }
        if (!rg || rg.trim() === '') {
            throw new Error(`Azure Integration (Resource Group) is not configured for organization: ${orgId}`);
        }
    } else {
        if (!subId) subId = SUBSCRIPTION_ID;
        if (!rg) rg = RESOURCE_GROUP;
    }
    return { subId, rg };
}

// Helper to parse HH:MM into total minutes from midnight
function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// Scaler function
async function setContainerAppScale(orgId, appName, minReplicas, maxReplicas) {
    const isSleeping  = minReplicas === 0 && maxReplicas === 0;
    const targetState = isSleeping ? 'sleep' : 'active';
    const cacheKey    = `${orgId}:${appName}`;
    const prevState   = scaleStateCache.get(cacheKey);

    try {
        const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [orgId]);
        const { subId, rg } = resolveOrgAzureSettings(orgs[0], orgId);

        if (!process.env.AZURE_CLIENT_ID) {
            console.log(`[MOCK SleepScheduler] Scaled container app '${appName}' to min: ${minReplicas}, max: ${maxReplicas} (Dry run/Dev mode)`);
            // Still fire transition notifications in mock/dev mode
            if (prevState !== targetState) {
                scaleStateCache.set(cacheKey, targetState);
                await notifyScaleTransition(orgId, appName, targetState, minReplicas, maxReplicas);
            }
            return;
        }

        console.log(`[SleepScheduler] Connecting to Azure to update container app: ${appName}...`);
        const credential = await getAzureCredential(orgId);
        const client = new ContainerAppsAPIClient(credential, subId);

        // Fetch existing configuration to preserve all other properties
        const appEnvelope = await client.containerApps.get(rg, appName);
        
        // Prevent redundant updates
        if (appEnvelope.template?.scale?.minReplicas === minReplicas && appEnvelope.template?.scale?.maxReplicas === maxReplicas) {
            console.log(`[SleepScheduler] App '${appName}' is already at target scale.`);
            return;
        }

        if (!appEnvelope.template) appEnvelope.template = {};
        appEnvelope.template.scale = {
            minReplicas,
            maxReplicas
        };

        const poller = await client.containerApps.beginCreateOrUpdate(rg, appName, appEnvelope);
        await poller.pollUntilDone();
        console.log(`[SleepScheduler] Successfully scaled container app '${appName}' to min: ${minReplicas}, max: ${maxReplicas}`);

        // Notify Teams only on actual state transition
        if (prevState !== targetState) {
            scaleStateCache.set(cacheKey, targetState);
            await notifyScaleTransition(orgId, appName, targetState, minReplicas, maxReplicas);
        }
    } catch (err) {
        console.error(`[SleepScheduler] Failed to adjust scale for ${appName}:`, err.message);
    }
}

/**
 * Sends a Teams notification when a container app transitions between active and sleep states.
 */
async function notifyScaleTransition(orgId, appName, newState, minReplicas, maxReplicas, appType = 'backend') {
    const isSleeping   = newState === 'sleep';
    const themeColor   = isSleeping ? '6264a7' : '36a64f'; // Teams purple for sleep, green for wake
    const emoji        = isSleeping ? '💤' : '▶️';
    
    let stateLabel = '';
    let costNote = '';
    let appTypeLabel = '';
    
    if (appType === 'frontend') {
        appTypeLabel = 'Static Web App';
        stateLabel = isSleeping ? 'Suspended (Sleep Mode)' : 'Active';
        costNote = isSleeping
            ? 'Traffic routing simulated offline. No bandwidth costs are being incurred.'
            : 'App serving traffic normally.';
    } else if (appType === 'vm') {
        appTypeLabel = 'Virtual Machine';
        stateLabel = isSleeping ? 'Stopped (Deallocated)' : 'Running';
        costNote = isSleeping
            ? 'Compute allocation deallocated. Compute pricing is paused.'
            : 'Compute allocation restarted. VM is running.';
    } else if (appType === 'cluster') {
        appTypeLabel = 'AKS Cluster';
        stateLabel = isSleeping ? 'Stopped (Deallocated)' : 'Running';
        costNote = isSleeping
            ? 'AKS cluster instance VMSS backed nodes stopped. All node billing is paused.'
            : 'AKS cluster instance nodes started. Cluster is running.';
    } else {
        appTypeLabel = 'Container App';
        stateLabel = isSleeping ? 'Scaled Down (Sleep Mode)' : 'Scaled Up (Active)';
        costNote = isSleeping
            ? 'Replica count set to 0. No compute costs are being incurred.'
            : `Replica count restored to min: ${minReplicas}, max: ${maxReplicas}. App is now serving traffic.`;
    }

    await sendTeamsNotification(orgId, {
        title: `${emoji} Sleep Scheduler — ${appName} ${stateLabel}`,
        text:  `${appTypeLabel} **${appName}** has transitioned to **${stateLabel}**.`,
        themeColor,
        facts: [
            { name: 'App Name',    value: appName },
            { name: 'App Type',    value: appTypeLabel },
            { name: 'New State',   value: stateLabel },
            { name: 'Min Replicas', value: String(minReplicas) },
            { name: 'Max Replicas', value: String(maxReplicas) },
            { name: 'Cost Note',   value: costNote },
            { name: 'Triggered At', value: new Date().toISOString() }
        ]
    });
}

// Single tick check runner
async function checkSchedules() {
    try {
        const [schedules] = await db.query('SELECT * FROM sleep_schedules WHERE active = 1');
        if (schedules.length === 0) return;

        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const now = new Date();
        const currentDay = days[now.getDay()];
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        const currentMinutes = currentHour * 60 + currentMinute;

        console.log(`[SleepScheduler] Checking rules at ${currentHour.toString().padStart(2, '0')}:${currentMinute.toString().padStart(2, '0')} (${currentDay})...`);

        for (const schedule of schedules) {
            const orgId = schedule.organization_id;
            const rules = typeof schedule.rules_json === 'string' ? JSON.parse(schedule.rules_json) : schedule.rules_json;

            // Upgrade/Normalize rules format to support multiple schedules
            let schedulesList = [];
            if (rules.schedules && Array.isArray(rules.schedules)) {
                schedulesList = rules.schedules;
            } else {
                schedulesList = [{
                    id: 'default',
                    name: 'Default Sleep Policy',
                    mon: rules.mon,
                    tue: rules.tue,
                    wed: rules.wed,
                    thu: rules.thu,
                    fri: rules.fri,
                    sat: rules.sat,
                    sun: rules.sun,
                    selectedApps: rules.selectedApps || []
                }];
            }

            // Fetch all applications for this organization from DB
            const [apps] = await db.query(
                "SELECT name, app_type, status FROM applications WHERE organization_id = ?",
                [orgId]
            );

            for (const app of apps) {
                // Find all schedules this app is enrolled in
                const appSchedules = schedulesList.filter(s => s.selectedApps && s.selectedApps.includes(app.name));
                
                // If the app is not enrolled in any schedule, skip it (runs 24/7)
                if (appSchedules.length === 0) continue;

                // An app is active if it is active in AT LEAST ONE active schedule it is enrolled in
                let isAppActiveInSomeSchedule = false;

                for (const s of appSchedules) {
                    const dayRule = s[currentDay];
                    if (dayRule && dayRule.enabled) {
                        const startMins = parseTimeToMinutes(dayRule.start);
                        const endMins = parseTimeToMinutes(dayRule.end);
                        if (currentMinutes >= startMins && currentMinutes <= endMins) {
                            isAppActiveInSomeSchedule = true;
                            break; // No need to check other schedules if it's already active in one
                        }
                    }
                }

                const shouldBeSleep = !isAppActiveInSomeSchedule;

                if (app.app_type === 'backend') {
                    if (shouldBeSleep && rules.autoScaleAca) {
                        // Scale down to zero
                        await setContainerAppScale(orgId, app.name, 0, 0);
                    } else {
                        // Restore active container app scaling (e.g. min 1, max 10)
                        await setContainerAppScale(orgId, app.name, 1, 10);
                    }
                } else if (app.app_type === 'frontend') {
                    // Simulate SWA sleep transition
                    const isSleeping  = shouldBeSleep && rules.autoScaleAca;
                    const targetState = isSleeping ? 'sleep' : 'active';
                    const cacheKey    = `${orgId}:${app.name}`;
                    const prevState   = scaleStateCache.get(cacheKey);

                    if (prevState !== targetState) {
                        scaleStateCache.set(cacheKey, targetState);
                        console.log(`[MOCK SWA SleepScheduler] SWA '${app.name}' transitioned to state: ${targetState} (Traffic routing simulated/Mocked)`);
                        await notifyScaleTransition(orgId, app.name, targetState, 0, 0, 'frontend');
                    }
                } else if (app.app_type === 'vm') {
                    if (shouldBeSleep && rules.autoStopVm) {
                        await setVirtualMachinePowerState(orgId, app.name, 'stop');
                    } else {
                        await setVirtualMachinePowerState(orgId, app.name, 'start');
                    }
                } else if (app.app_type === 'cluster') {
                    if (shouldBeSleep && (rules.autoStopVm || rules.autoStopCluster)) {
                        await setClusterPowerState(orgId, app.name, 'stop');
                    } else {
                        await setClusterPowerState(orgId, app.name, 'start');
                    }
                }
            }
        }
    } catch (err) {
        console.error('[SleepScheduler] Worker execution error:', err.message);
    }
}

// Helper to control VM power state inside sleep schedules
async function setVirtualMachinePowerState(orgId, vmName, action) {
    const isStopping = action === 'stop';
    const targetState = isStopping ? 'sleep' : 'active';
    const cacheKey = `${orgId}:${vmName}`;
    const prevState = scaleStateCache.get(cacheKey);

    // Apply self-preservation block
    const nameLower = vmName.toLowerCase();
    if (isStopping && (nameLower.includes('evaops') || nameLower.includes('devops-backend') || nameLower.includes('devops-frontend'))) {
        console.warn(`[SleepScheduler] Skipping stop action for critical platform VM: ${vmName}`);
        return;
    }

    try {
        const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [orgId]);
        const { subId, rg } = resolveOrgAzureSettings(orgs[0], orgId);

        if (!process.env.AZURE_CLIENT_ID) {
            console.log(`[MOCK SleepScheduler] VM '${vmName}' power status changed to: ${action === 'stop' ? 'Stopped (Deallocated)' : 'Running'} (Dry run/Dev mode)`);
            if (prevState !== targetState) {
                scaleStateCache.set(cacheKey, targetState);
                await notifyScaleTransition(orgId, vmName, targetState, 0, 0, 'vm');
                await db.query('UPDATE applications SET status = ? WHERE organization_id = ? AND name = ?', [action === 'stop' ? 'stopped' : 'running', orgId, vmName]);
            }
            return;
        }

        console.log(`[SleepScheduler] Connecting to Azure VM: ${vmName} to perform action: ${action}...`);
        const credential = await getAzureCredential(orgId);
        const tokenRes = await credential.getToken("https://management.azure.com/.default");
        const token = tokenRes.token;

        const azureAction = action === 'stop' ? 'deallocate' : 'start';
        const url = `https://management.azure.com/subscriptions/${subId}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${vmName}/${azureAction}?api-version=2023-09-01`;

        await axios.post(url, {}, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`[SleepScheduler] Successfully performed action '${action}' on VM '${vmName}'`);

        if (prevState !== targetState) {
            scaleStateCache.set(cacheKey, targetState);
            await notifyScaleTransition(orgId, vmName, targetState, 0, 0, 'vm');
            await db.query('UPDATE applications SET status = ? WHERE organization_id = ? AND name = ?', [action === 'stop' ? 'stopped' : 'running', orgId, vmName]);
        }
    } catch (err) {
        console.error(`[SleepScheduler] Failed to adjust VM power state for ${vmName}:`, err.message);
    }
}

// Helper to control AKS Cluster power state inside sleep schedules
async function setClusterPowerState(orgId, clusterName, action) {
    const isStopping = action === 'stop';
    const targetState = isStopping ? 'sleep' : 'active';
    const cacheKey = `${orgId}:${clusterName}`;
    const prevState = scaleStateCache.get(cacheKey);

    try {
        const [orgs] = await db.query('SELECT * FROM organizations WHERE id = ?', [orgId]);
        const { subId, rg } = resolveOrgAzureSettings(orgs[0], orgId);

        if (!process.env.AZURE_CLIENT_ID) {
            console.log(`[MOCK SleepScheduler] AKS Cluster '${clusterName}' power status changed to: ${action === 'stop' ? 'Stopped' : 'Running'} (Dry run/Dev mode)`);
            if (prevState !== targetState) {
                scaleStateCache.set(cacheKey, targetState);
                await notifyScaleTransition(orgId, clusterName, targetState, 0, 0, 'cluster');
                await db.query('UPDATE applications SET status = ? WHERE organization_id = ? AND name = ?', [action === 'stop' ? 'Stopped' : 'Running', orgId, clusterName]);
            }
            return;
        }

        console.log(`[SleepScheduler] Connecting to Azure AKS: ${clusterName} to perform action: ${action}...`);
        const credential = await getAzureCredential(orgId);
        const tokenRes = await credential.getToken("https://management.azure.com/.default");
        const token = tokenRes.token;

        const url = `https://management.azure.com/subscriptions/${subId}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${clusterName}/${action}?api-version=2023-09-01`;

        const axios = require('axios');
        await axios.post(url, {}, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`[SleepScheduler] Successfully performed action '${action}' on AKS Cluster '${clusterName}'`);

        if (prevState !== targetState) {
            scaleStateCache.set(cacheKey, targetState);
            await notifyScaleTransition(orgId, clusterName, targetState, 0, 0, 'cluster');
            await db.query('UPDATE applications SET status = ? WHERE organization_id = ? AND name = ?', [action === 'stop' ? 'Stopped' : 'Running', orgId, clusterName]);
        }
    } catch (err) {
        console.error(`[SleepScheduler] Failed to adjust AKS cluster power state for ${clusterName}:`, err.message);
    }
}

function startSchedulerWorker() {
    console.log('[SleepScheduler] Initializing Weekly sleep scheduler background worker...');
    
    // Execute immediately on startup
    checkSchedules().catch(console.error);

    // Run check once every minute
    setInterval(() => {
        checkSchedules().catch(console.error);
    }, 60000);
}

module.exports = {
    startSchedulerWorker
};
