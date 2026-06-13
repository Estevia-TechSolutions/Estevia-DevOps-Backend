const db = require('../config/db');
const { DefaultAzureCredential } = require('@azure/identity');
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');
const { sendTeamsNotification } = require('./teamsNotifier');

const SUBSCRIPTION_ID = 'a812e8e3-34f9-4773-82ee-6398869533b0';
const RESOURCE_GROUP = 'Estevia-Prod-RG';

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
    return new DefaultAzureCredential();
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
        const subId = orgs[0]?.azure_subscription_id || SUBSCRIPTION_ID;
        const rg = orgs[0]?.azure_resource_group || RESOURCE_GROUP;

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
async function notifyScaleTransition(orgId, appName, newState, minReplicas, maxReplicas) {
    const isSleeping   = newState === 'sleep';
    const themeColor   = isSleeping ? '6264a7' : '36a64f'; // Teams purple for sleep, green for wake
    const emoji        = isSleeping ? '💤' : '▶️';
    const stateLabel   = isSleeping ? 'Scaled Down (Sleep Mode)' : 'Scaled Up (Active)';
    const costNote     = isSleeping
        ? 'Replica count set to 0. No compute costs are being incurred.'
        : `Replica count restored to min: ${minReplicas}, max: ${maxReplicas}. App is now serving traffic.`;

    await sendTeamsNotification(orgId, {
        title: `${emoji} Sleep Scheduler — ${appName} ${stateLabel}`,
        text:  `Container app **${appName}** has transitioned to **${stateLabel}**.`,
        themeColor,
        facts: [
            { name: 'App Name',    value: appName },
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

            const dayRule = rules[currentDay];
            let shouldBeSleep = true; // Default to sleep if day is disabled

            if (dayRule && dayRule.enabled) {
                const startMins = parseTimeToMinutes(dayRule.start);
                const endMins = parseTimeToMinutes(dayRule.end);
                
                // If current time is within active start/end range, keep app active
                if (currentMinutes >= startMins && currentMinutes <= endMins) {
                    shouldBeSleep = false;
                }
            }

            // Fetch backends/container apps for this organization
            const [apps] = await db.query(
                "SELECT name, status FROM applications WHERE organization_id = ? AND app_type = 'backend'",
                [orgId]
            );

            for (const app of apps) {
                if (shouldBeSleep && rules.autoScaleAca) {
                    // Scale down to zero
                    await setContainerAppScale(orgId, app.name, 0, 0);
                } else {
                    // Restore active container app scaling (e.g. min 1, max 10)
                    await setContainerAppScale(orgId, app.name, 1, 10);
                }
            }
        }
    } catch (err) {
        console.error('[SleepScheduler] Worker execution error:', err.message);
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
