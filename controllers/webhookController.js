const db = require('../config/db');
const { sendTeamsNotification } = require('../utils/teamsNotifier');

const webhookController = {
    /**
     * POST /api/webhooks/azure-devops/:webhookToken
     *
     * Public, un-authenticated endpoint that receives Azure DevOps Service Hook payloads
     * (build.complete, run.state-changed) and routes a formatted alert to the Microsoft Teams channel
     * configured for the corresponding organization.
     *
     * The unguessable :webhookToken serves as the shared secret, preventing spoofed payloads.
     */
    handleAzureDevopsWebhook: async (req, res) => {
        const { webhookToken } = req.params;

        try {
            // 1. Look up the organization by the unique token
            const [orgs] = await db.query(
                'SELECT id, name FROM organizations WHERE teams_webhook_token = ?',
                [webhookToken]
            );

            if (orgs.length === 0) {
                // Return 404 to prevent token enumeration
                return res.status(404).json({ message: 'Webhook endpoint not found.' });
            }

            const org = orgs[0];
            const payload = req.body;

            // 2. Parse the Azure DevOps Service Hook event
            const eventType = payload?.eventType || payload?.event_type || '';
            const resource = payload?.resource || {};

            console.log(`[WebhookController] Received Azure DevOps event '${eventType}' for org '${org.id}'`);

            // Acknowledge receipt immediately so Azure DevOps does not retry
            res.json({ success: true, message: 'Webhook received and processed.' });

            // 3. Map event to a Teams MessageCard and send asynchronously (after HTTP response)
            setImmediate(async () => {
                try {
                    if (eventType === 'build.complete' || eventType === 'ms.vss-build.build-completed-event') {
                        await handleBuildComplete(org.id, resource);
                    } else if (eventType === 'run.state-changed' || eventType === 'ms.vss-pipelines.run-state-changed-event') {
                        await handleRunStateChanged(org.id, resource);
                    } else {
                        console.log(`[WebhookController] Unhandled event type '${eventType}' — no Teams alert sent.`);
                    }
                } catch (err) {
                    console.error('[WebhookController] Error processing webhook payload:', err.message);
                }
            });
        } catch (err) {
            console.error('[WebhookController] Unexpected error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Internal webhook processing error.' });
            }
        }
    }
};

/**
 * Formats and sends a Teams notification for a build.complete event.
 */
async function handleBuildComplete(orgId, resource) {
    const buildResult  = (resource?.result || resource?.status || 'unknown').toLowerCase();
    const buildNumber  = resource?.buildNumber || resource?.id || 'N/A';
    const projectName  = resource?.project?.name || resource?.definition?.project?.name || 'Unknown Project';
    const pipelineName = resource?.definition?.name || 'Unknown Pipeline';
    const repoName     = resource?.repository?.name || 'Unknown Repo';
    const branchName   = (resource?.sourceBranch || resource?.branch || '').replace('refs/heads/', '');
    const requestedBy  = resource?.requestedBy?.displayName || resource?.requestedFor?.displayName || 'Unknown';
    const buildUrl     = resource?._links?.web?.href || resource?.url || '';

    const isSuccess = ['succeeded', 'success', 'partiallySucceeded'].includes(buildResult);
    const isFailed  = ['failed', 'failure', 'error'].includes(buildResult);

    const themeColor = isSuccess ? '36a64f' : isFailed ? 'cc3300' : 'FFA500';
    const statusEmoji = isSuccess ? '✅' : isFailed ? '❌' : '⚠️';
    const statusText  = isSuccess ? 'Succeeded' : isFailed ? 'Failed' : 'Partially Succeeded';

    const facts = [
        { name: 'Pipeline',       value: pipelineName },
        { name: 'Project',        value: projectName },
        { name: 'Build Number',   value: buildNumber },
        { name: 'Repository',     value: repoName },
        { name: 'Branch',         value: branchName || 'N/A' },
        { name: 'Triggered By',   value: requestedBy },
        { name: 'Result',         value: `${statusEmoji} ${statusText}` }
    ];

    const actions = buildUrl
        ? [{ '@type': 'OpenUri', name: 'View Pipeline Run', targets: [{ os: 'default', uri: buildUrl }] }]
        : [];

    await sendTeamsNotification(orgId, {
        title: `${statusEmoji} CI/CD Build ${statusText} — ${pipelineName}`,
        text: `Build **#${buildNumber}** on branch \`${branchName || 'main'}\` has ${statusText.toLowerCase()}.`,
        themeColor,
        facts,
        actions
    });
}

/**
 * Formats and sends a Teams notification for a run.state-changed event (YAML pipelines).
 */
async function handleRunStateChanged(orgId, resource) {
    const state        = (resource?.state || 'unknown').toLowerCase();
    const result       = (resource?.result || 'unknown').toLowerCase();
    const runId        = resource?.id || 'N/A';
    const pipelineName = resource?.pipeline?.name || resource?.name || 'Unknown Pipeline';
    const runUrl       = resource?._links?.web?.href || '';

    // Only notify on terminal states
    if (!['completed', 'canceling'].includes(state)) return;

    const isSuccess = result === 'succeeded';
    const isFailed  = ['failed', 'canceled'].includes(result);

    const themeColor = isSuccess ? '36a64f' : isFailed ? 'cc3300' : 'FFA500';
    const statusEmoji = isSuccess ? '✅' : isFailed ? '❌' : '⚠️';
    const statusLabel = `${result.charAt(0).toUpperCase()}${result.slice(1)}`;

    const facts = [
        { name: 'Pipeline', value: pipelineName },
        { name: 'Run ID',   value: String(runId) },
        { name: 'State',    value: state },
        { name: 'Result',   value: `${statusEmoji} ${statusLabel}` }
    ];

    const actions = runUrl
        ? [{ '@type': 'OpenUri', name: 'View Pipeline Run', targets: [{ os: 'default', uri: runUrl }] }]
        : [];

    await sendTeamsNotification(orgId, {
        title: `${statusEmoji} Pipeline Run ${statusLabel} — ${pipelineName}`,
        text: `Pipeline **${pipelineName}** run **#${runId}** has ${statusLabel.toLowerCase()}.`,
        themeColor,
        facts,
        actions
    });
}

module.exports = webhookController;
