const db = require('../config/db');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Sends a Microsoft Teams notification using the Office 365 Connector Card (MessageCard) format.
 *
 * @param {string} orgId - The organization ID to look up the teams_webhook_url for.
 * @param {Object} options
 * @param {string} options.title       - Card title (bold header line).
 * @param {string} options.text        - Card body text (markdown supported).
 * @param {string} [options.themeColor] - Hex colour for the card accent strip. Default: '0078D4' (MS Blue).
 * @param {Array}  [options.facts]     - Array of { name, value } pairs shown as a table in the card.
 * @param {Array}  [options.actions]   - Array of OpenUri action objects: { type: 'OpenUri', name, targets: [{os:'default', uri}] }.
 */
async function sendTeamsNotification(orgId, { title, text, themeColor = '0078D4', facts = [], actions = [] }) {
    try {
        // Fetch the webhook URL stored for this organization
        const [rows] = await db.query('SELECT teams_webhook_url FROM organizations WHERE id = ?', [orgId]);
        const webhookUrl = rows[0]?.teams_webhook_url;

        if (!webhookUrl) {
            // Not configured — silently skip without logging an error to prevent noise
            return;
        }

        const payload = {
            '@type': 'MessageCard',
            '@context': 'http://schema.org/extensions',
            themeColor,
            summary: title,
            sections: [
                {
                    activityTitle: `**${title}**`,
                    activityText: text,
                    facts: facts.map(f => ({ name: f.name, value: String(f.value) })),
                    markdown: true
                }
            ]
        };

        if (actions.length > 0) {
            payload.potentialAction = actions;
        }

        const body = JSON.stringify(payload);
        const parsed = new URL(webhookUrl);
        const isHttps = parsed.protocol === 'https:';
        const reqLib = isHttps ? https : http;

        await new Promise((resolve, reject) => {
            const options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            };

            const req = reqLib.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log(`[TeamsNotifier] ✅ Notification sent to Teams for org '${orgId}': "${title}"`);
                        resolve(data);
                    } else {
                        console.error(`[TeamsNotifier] ❌ Teams webhook returned HTTP ${res.statusCode} for org '${orgId}': ${data}`);
                        resolve(data); // Resolve instead of reject so we never block callers
                    }
                });
            });

            req.on('error', (err) => {
                console.error(`[TeamsNotifier] ❌ Network error sending Teams notification for org '${orgId}':`, err.message);
                resolve(); // Never throw — callers must not fail due to notification errors
            });

            req.write(body);
            req.end();
        });
    } catch (err) {
        // Catch-all: never allow Teams notifications to crash background workers or API handlers
        console.error(`[TeamsNotifier] ❌ Unexpected error for org '${orgId}':`, err.message);
    }
}

/**
 * Sends a test ping card to verify Teams webhook connectivity.
 * @param {string} webhookUrl - The raw webhook URL to test (not from DB).
 */
async function testTeamsConnection(webhookUrl) {
    const payload = {
        '@type': 'MessageCard',
        '@context': 'http://schema.org/extensions',
        themeColor: '0078D4',
        summary: 'EvaOps Connection Test (CloudOps Management & Governance)',
        sections: [
            {
                activityTitle: '**✅ EvaOps — Connection Test Successful (CloudOps Management & Governance)**',
                activityText: 'Your Microsoft Teams webhook integration is configured and working correctly. You will now receive real-time DevOps lifecycle alerts in this channel.',
                facts: [
                    { name: 'Status', value: 'Connected' },
                    { name: 'Triggered by', value: 'EvaOps Control Centre (CloudOps Management & Governance)' },
                    { name: 'Timestamp', value: new Date().toISOString() }
                ],
                markdown: true
            }
        ]
    };

    const body = JSON.stringify(payload);
    const parsed = new URL(webhookUrl);
    const isHttps = parsed.protocol === 'https:';
    const reqLib = isHttps ? https : http;

    return new Promise((resolve, reject) => {
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = reqLib.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ success: true, status: res.statusCode });
                } else {
                    reject(new Error(`Teams webhook returned HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = { sendTeamsNotification, testTeamsConnection };
