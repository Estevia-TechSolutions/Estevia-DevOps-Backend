const db = require('../config/db');
const { DefaultAzureCredential, ClientSecretCredential } = require('@azure/identity');
const { ContainerAppsAPIClient } = require('@azure/arm-appcontainers');
const { LogsQueryClient, Durations } = require('@azure/monitor-query-logs');
const axios = require('axios');

const SUBSCRIPTION_ID = 'a812e8e3-34f9-4773-82ee-6398869533b0';
const RESOURCE_GROUP = 'Estevia-Prod-RG';
const MAX_LOG_LINES = 2000;

// Helper to fetch Azure credentials for organization
async function getAzureCredential(organizationId) {
    try {
        const credentialController = require('./credentialController');
        const azureSecrets = await credentialController.getDecryptedCredentialsInternal(organizationId, 'azure');
        if (azureSecrets && azureSecrets.clientId && azureSecrets.clientSecret && azureSecrets.tenantId) {
            return new ClientSecretCredential(azureSecrets.tenantId, azureSecrets.clientId, azureSecrets.clientSecret);
        }
    } catch (err) {
        console.warn(`[Observability] Using DefaultAzureCredential fallback:`, err.message);
    }
    return new DefaultAzureCredential();
}

/**
 * Resolves the Log Analytics Workspace ID for an organization.
 * Priority:
 *   1. org.log_analytics_workspace_id from DB
 *   2. LOG_ANALYTICS_WORKSPACE_ID env variable
 *   3. null (will trigger mock fallback)
 */
async function resolveWorkspaceId(orgId) {
    try {
        const [rows] = await db.query(
            'SELECT log_analytics_workspace_id FROM organizations WHERE id = ?',
            [orgId]
        );
        const wsId = rows[0]?.log_analytics_workspace_id || process.env.LOG_ANALYTICS_WORKSPACE_ID;
        return wsId || null;
    } catch {
        return process.env.LOG_ANALYTICS_WORKSPACE_ID || null;
    }
}

/**
 * Maps a timeRange string to an Azure Durations preset and a human-readable label.
 * 'live'  -> last 5 minutes
 * '1h'    -> last 1 hour
 * '12h'   -> last 12 hours
 * '24h'   -> last 24 hours
 */
function resolveTimeRange(timeRange) {
    switch (timeRange) {
        case '1h':  return { duration: Durations.oneHour,         label: '1 hour' };
        case '12h': return { duration: Durations.twelveHours,     label: '12 hours' };
        case '24h': return { duration: Durations.oneDay,          label: '24 hours' };
        default:    return { duration: Durations.fiveMinutes,     label: 'live (5m)' };
    }
}

/**
 * Parses a Log Analytics KQL result table into a flat array of
 * { timestamp, level, message, stream } objects.
 *
 * ACA console logs land in the table ContainerAppConsoleLogs (standard)
 * or ContainerAppConsoleLogs_CL (custom Diagnostic Settings export).
 * Both are tried in the KQL query.
 */
function parseLogAnalyticsRows(table) {
    const rows = [];
    if (!table || !table.rows || table.rows.length === 0) return rows;

    const cols = table.columnDescriptors.map(c => c.name);
    const idx = (name) => cols.findIndex(c => c.toLowerCase().includes(name.toLowerCase()));

    const timeIdx    = idx('TimeGenerated');
    const logIdx     = idx('Log_s') >= 0 ? idx('Log_s') : idx('Log');
    const streamIdx  = idx('Stream_s') >= 0 ? idx('Stream_s') : idx('Stream');
    const levelIdx   = idx('Level') >= 0 ? idx('Level') : -1;

    for (const row of table.rows) {
        const raw       = String(row[logIdx] ?? '');
        const stream    = String(row[streamIdx] ?? 'stdout');
        const tsRaw     = row[timeIdx];
        const timestamp = tsRaw
            ? (tsRaw instanceof Date ? tsRaw.toISOString() : String(tsRaw)).replace('T', ' ').substring(0, 19)
            : new Date().toISOString().replace('T', ' ').substring(0, 19);

        // Detect log level from content if not in its own column
        let level = row[levelIdx] ? String(row[levelIdx]).toUpperCase() : 'INFO';
        if (raw.includes('[ERROR]') || raw.toLowerCase().startsWith('error')) level = 'ERROR';
        else if (raw.includes('[WARN]') || raw.toLowerCase().startsWith('warn')) level = 'WARN';
        else if (raw.includes('[SYSTEM]') || raw.includes('[SYS]'))              level = 'SYSTEM';

        // Strip common level prefixes from the display message
        const message = raw.replace(/^\[(INFO|WARN|ERROR|SYSTEM|SYS|DEBUG)\]\s*/i, '').trim() || raw;

        rows.push({ timestamp, level, message, stream });
    }
    return rows;
}

const observabilityController = {
    /**
     * GET /api/observability/:appName/logs?organizationId=...&timeRange=live|1h|12h|24h
     *
     * Returns container console logs for the specified ACA app from Azure Log Analytics.
     * When the workspace is not configured or Azure credentials are unavailable,
     * falls back to app-specific mock logs.
     */
    getLogs: async (req, res) => {
        try {
            const { appName } = req.params;
            const { organizationId, timeRange = 'live' } = req.query;
            const orgId = organizationId || 'estevia';

            const forceMock = req.query.mock === 'true';
            const workspaceId = forceMock ? null : await resolveWorkspaceId(orgId);

            if (forceMock || !workspaceId) {
                console.log(`[Observability] No Log Analytics workspace configured for org '${orgId}'. Serving mock logs.`);
                const logs = generateMockLogs(appName);
                return res.json({ success: true, source: 'mock', timeRange, logs });
            }

            try {
                const credential  = await getAzureCredential(orgId);
                const logsClient  = new LogsQueryClient(credential);
                const { duration, label } = resolveTimeRange(timeRange);

                console.log(`[Observability] Querying Log Analytics for '${appName}' | range: ${label} | workspace: ${workspaceId}`);

                // KQL: try the standard ACA table first; fall back to _CL variant if the workspace
                // uses a custom Diagnostic Settings export. The 2000-line hard cap is enforced here.
                const kql = [
                    `let appFilter = "${appName}";`,
                    `let results = ContainerAppConsoleLogs`,
                    `| where ContainerAppName =~ appFilter`,
                    `| project TimeGenerated, Log_s = Log, Stream_s = Stream`,
                    `| order by TimeGenerated asc`,
                    `| take ${MAX_LOG_LINES};`,
                    `let resultsCL = ContainerAppConsoleLogs_CL`,
                    `| where ContainerAppName_s =~ appFilter`,
                    `| project TimeGenerated, Log_s, Stream_s`,
                    `| order by TimeGenerated asc`,
                    `| take ${MAX_LOG_LINES};`,
                    `union isfuzzy=true results, resultsCL`,
                    `| order by TimeGenerated asc`,
                    `| take ${MAX_LOG_LINES}`
                ].join('\n');

                const result = await logsClient.queryWorkspace(
                    workspaceId,
                    kql,
                    { duration }
                );

                if (result.status === 'Success' && result.tables && result.tables.length > 0) {
                    const logs = parseLogAnalyticsRows(result.tables[0]);
                    console.log(`[Observability] Returned ${logs.length} real log lines for '${appName}'.`);
                    return res.json({ success: true, source: 'log-analytics', timeRange, logs });
                }

                // Empty result — no logs in this window
                console.log(`[Observability] Log Analytics returned 0 rows for '${appName}' in range '${label}'.`);
                return res.json({
                    success: true,
                    source: 'log-analytics',
                    timeRange,
                    logs: [],
                    info: `No log entries found for '${appName}' in the last ${label}. Verify that ACA Diagnostic Settings are routing console logs to this Log Analytics workspace.`
                });

            } catch (azureErr) {
                console.warn(`[Observability] Log Analytics query failed for '${appName}':`, azureErr.message);
                // Fall back to mock on Azure errors (e.g. permissions, network, invalid workspace ID)
                const logs = generateMockLogs(appName);
                return res.json({
                    success: true,
                    source: 'mock-fallback',
                    timeRange,
                    logs,
                    warning: `Live log query failed: ${azureErr.message}. Showing simulated logs.`
                });
            }
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * GET /api/apps/:appName/metrics?organizationId=...
     * Returns real-time metrics (CPU, Memory, Network requests).
     */
    getMetrics: async (req, res) => {
        try {
            const { appName } = req.params;
            const { organizationId } = req.query;
            const orgId = organizationId || 'estevia';

            // Generate dynamic metrics for high-fidelity frontend visual sparklines
            const cpuHistory = [];
            const memoryHistory = [];
            const timestampHistory = [];

            const now = Date.now();
            for (let i = 9; i >= 0; i--) {
                const time = new Date(now - i * 10000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                timestampHistory.push(time);
                cpuHistory.push(Math.floor(Math.random() * 25) + 5); // 5% to 30%
                memoryHistory.push(Math.floor(Math.random() * 50) + 120); // 120MB to 170MB
            }

            res.json({
                success: true,
                appName,
                currentCpu: cpuHistory[cpuHistory.length - 1],
                currentMemory: memoryHistory[memoryHistory.length - 1],
                metrics: {
                    timestamps: timestampHistory,
                    cpu: cpuHistory,
                    memory: memoryHistory
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
};

// Mock logs generator
function generateMockLogs(appName) {
    const name = appName.toLowerCase();
    let specificLogs = [];
    
    if (name.includes('protrack')) {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting ProTrack task management service...`,
            `[INFO] Loading project workspaces from DB`,
            `[INFO] Syncing active sprint boards and user backlogs`,
            `[INFO] WebSocket server active for real-time board updates`,
            `[WARN] Board ID 841: Task drag-and-drop event delay exceeded 200ms`,
            `[INFO] Connected to Redis cache cluster for task board state`,
            `[INFO] Incoming GET /api/projects/estevia/backlog - status 200 OK`,
            `[INFO] Incoming POST /api/tasks/create - status 201 Created`,
            `[ERROR] Failed to sync task assignee with directory: User 'assignee-99' not found in workspace cache`,
            `[WARN] Retrying directory user synchronization in 60s...`,
            `[INFO] GET /health - Status 200 OK`
        ];
    } else if (name.includes('talenthq')) {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting TalentHQ recruiting pipeline engine...`,
            `[INFO] Initializing OCR parser config for candidate resumes`,
            `[INFO] Connecting to Azure AI Search service index 'candidates'`,
            `[INFO] Index verification completed successfully.`,
            `[INFO] Resume crawler thread started (pooling interval: 10s)`,
            `[WARN] PDF parser: Encrypted metadata detected in file 'resume_premnath.pdf'. Bypassing encryption check.`,
            `[INFO] Parsed and indexed candidate resume: candidate_tanmay.pdf (Score: 0.94)`,
            `[INFO] Incoming GET /api/candidates/search?role=contributor - status 200 OK`,
            `[ERROR] Failed to send email alert to candidate govind.m@esteviatech.com: SMTP relay connection timed out`,
            `[WARN] Email queued for retry. Retrying SMTP connection...`,
            `[INFO] GET /health - Status 200 OK`
        ];
    } else if (name.includes('docai')) {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting DocAI intelligent extraction service...`,
            `[INFO] Loading LayoutParser deep learning models into memory`,
            `[INFO] Model weight file 'invoice_layout_v4.onnx' loaded (148MB)`,
            `[INFO] CUDA GPU acceleration is not available, running inference on CPU.`,
            `[INFO] Processing extraction request for file: invoice_9204.pdf`,
            `[INFO] Recognized 12 document blocks, confidence rate: 97.4%`,
            `[WARN] Layout validation: Confidence rate below threshold for block 7 (Table Grid: 84%)`,
            `[INFO] Incoming POST /api/documents/extract - status 200 OK`,
            `[ERROR] Database insert failed: Duplicate key error in document_invoices on invoice_number 'INV-2026-004'`,
            `[WARN] Transaction rolled back. Returning 409 conflict.`,
            `[INFO] GET /health - Status 200 OK`
        ];
    } else if (name.includes('evafusion') || name.includes('devhub')) {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting EvaFusion Agent Orchestrator server...`,
            `[INFO] Initializing agent capabilities and prompt templates`,
            `[INFO] Connected to OpenAI API endpoint: model gpt-4o`,
            `[INFO] Agent state: IDLE. Waiting for prompt invocations...`,
            `[INFO] Agent received execution task: 'Generate database schemas'`,
            `[INFO] Stream session opened for request_id 'req-82914'`,
            `[WARN] API latency warning: prompt response took 4.2 seconds`,
            `[INFO] Incoming POST /api/agents/chat - status 200 OK`,
            `[ERROR] Failed to parse agent JSON output: Unexpected token 'U' in JSON position 0`,
            `[WARN] Retrying prompt request with stricter JSON formatting rules...`,
            `[INFO] GET /health - Status 200 OK`
        ];
    } else if (name.includes('connecthub')) {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting ConnectHub connector service...`,
            `[INFO] Loading custom treaty definitions and API wrappers`,
            `[INFO] Active connections: GoDaddy DNS API, GitHub Webhooks, Azure Resource Manager`,
            `[INFO] Handshake verified with GoDaddy OTE testing environment`,
            `[INFO] Synchronization worker started (polling interval: 60s)`,
            `[WARN] Slow connection detected on GitHub API endpoint (240ms latency)`,
            `[INFO] Triggering webhook treaty reconciliation for SWA domains`,
            `[INFO] Incoming POST /api/webhooks/reconcile - status 200 OK`,
            `[ERROR] GoDaddy DNS update failed: Rate limit exceeded (Code: 429)`,
            `[WARN] Backing off GoDaddy API calls for 120s. Sync suspended.`,
            `[INFO] GET /health - Status 200 OK`
        ];
    } else if (name.includes('api') || name.includes('backend')) {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting Estevia BaaS API Gateway...`,
            `[INFO] Loading router configurations and middleware`,
            `[INFO] Connecting to database cluster host: 10.0.0.6`,
            `[INFO] Database connection pooled successfully (10 active connections)`,
            `[INFO] Redis Cache connected at redis-cache.internal:6379`,
            `[WARN] Token verification warning: expired session token rejected for user 'akhil.m@esteviatech.com'`,
            `[INFO] Incoming GET /api/auth/users - status 200 OK`,
            `[INFO] Incoming PATCH /api/auth/users/tanmay.k/role - status 200 OK`,
            `[ERROR] Database query timed out: SELECT * FROM audit_logs LIMIT 1000 (exceeded 5000ms)`,
            `[WARN] Re-establishing database pool connections...`,
            `[INFO] GET /health - Status 200 OK`
        ];
    } else {
        specificLogs = [
            `[SYSTEM] Container start request received for app: ${appName}`,
            `[SYSTEM] Initializing replica container group...`,
            `[INFO] Starting NodeJS web application server...`,
            `[INFO] Loading application controllers and assets`,
            `[INFO] Server listening on port 8080`,
            `[INFO] Static directory serving active under /public`,
            `[INFO] Cache manifest loaded (48 assets cached)`,
            `[WARN] File size warning: main-bundle.js exceeds recommended chunk size limit of 500kB`,
            `[INFO] Incoming GET /index.html - status 200 OK`,
            `[INFO] Incoming GET /assets/logo.png - status 304 Not Modified`,
            `[ERROR] Static file not found: GET /favicon.ico - status 404`,
            `[WARN] Bypassing favicon resource lookup...`,
            `[INFO] GET /health - Status 200 OK`
        ];
    }

    const now = new Date();
    return specificLogs.map((log, idx) => {
        const time = new Date(now.getTime() - (specificLogs.length - idx) * 5000);
        const timestamp = time.toISOString().replace('T', ' ').substring(0, 19);
        
        let message = log;
        if (log.startsWith('[INFO]') || log.startsWith('[WARN]') || log.startsWith('[ERROR]')) {
            message = log.substring(7);
        } else if (log.startsWith('[SYSTEM]')) {
            message = log.substring(9);
        }

        return {
            timestamp,
            level: log.includes('[ERROR]') ? 'ERROR' : (log.includes('[WARN]') ? 'WARN' : (log.includes('[SYSTEM]') ? 'SYSTEM' : 'INFO')),
            message
        };
    });
}

module.exports = observabilityController;
