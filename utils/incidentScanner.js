const db = require('../config/db');
const emailService = require('./emailService');

let isRunning = false;

/**
 * Evaluates real-time telemetry metrics against alert threshold rules
 */
const runIncidentScanCycle = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
        // Query active organizations with Observability & AI Package active
        const [orgs] = await db.query('SELECT id, billing_currency, sub_package_observability FROM organizations WHERE is_disabled = 0');
        if (!orgs || orgs.length === 0) {
            isRunning = false;
            return;
        }

        for (const org of orgs) {
            const orgId = org.id;
            const isSubscribed = org.sub_package_observability ? (Buffer.isBuffer(org.sub_package_observability) ? org.sub_package_observability[0] === 1 : Number(org.sub_package_observability) === 1) : false;
            if (!isSubscribed) {
                continue; // Skip scanning organizations with Observability Package turned off
            }

            // Fetch alert recipient configurations
            const [owners] = await db.query(
                `SELECT app_key, resource_type, environment, primary_owner_user_id, secondary_owner_user_id, notification_email, alert_categories 
                 FROM app_resource_owners WHERE organization_id = ?`,
                [orgId]
            );

            // Fetch latest telemetry metric snapshots
            const [metrics] = await db.query(
                `SELECT rm1.*
                 FROM resource_metrics_history rm1
                 INNER JOIN (
                     SELECT app_key, environment, MAX(recorded_at) as max_time
                     FROM resource_metrics_history
                     WHERE organization_id = ?
                     GROUP BY app_key, environment
                 ) rm2 ON rm1.app_key = rm2.app_key AND rm1.environment = rm2.environment AND rm1.recorded_at = rm2.max_time
                 WHERE rm1.organization_id = ?`,
                [orgId, orgId]
            );

            for (const m of metrics) {
                const ownerConfig = (owners || []).find(o => o.app_key === m.app_key && o.environment === m.environment);
                const categories = ownerConfig 
                    ? (typeof ownerConfig.alert_categories === 'string' ? JSON.parse(ownerConfig.alert_categories) : ownerConfig.alert_categories)
                    : ["CRITICAL_OUTAGE", "HIGH_RESOURCE_PRESSURE", "LATENCY_DEGRADATION"];

                // Rule 1: HIGH_RESOURCE_PRESSURE (CPU > 85%)
                if (m.cpu_percent > 85 && categories.includes("HIGH_RESOURCE_PRESSURE")) {
                    await triggerIncident({
                        organization_id: orgId,
                        app_key: m.app_key,
                        resource_type: m.resource_type || 'aca',
                        environment: m.environment,
                        category: 'HIGH_RESOURCE_PRESSURE',
                        severity: 'P2_HIGH',
                        title: `High CPU Pressure on ${m.app_key.toUpperCase()} (${m.environment})`,
                        description: `CPU utilization spiked to ${m.cpu_percent.toFixed(1)}% exceeding the 85% safety threshold.`,
                        telemetry_snapshot: m,
                        notification_email: ownerConfig ? ownerConfig.notification_email : null
                    });
                }

                // Rule 2: CRITICAL_OUTAGE (5xx Errors >= 5)
                if (m.http_5xx_count >= 5 && categories.includes("CRITICAL_OUTAGE")) {
                    await triggerIncident({
                        organization_id: orgId,
                        app_key: m.app_key,
                        resource_type: m.resource_type || 'aca',
                        environment: m.environment,
                        category: 'CRITICAL_OUTAGE',
                        severity: 'P1_CRITICAL',
                        title: `Critical 5xx Outage Detected on ${m.app_key.toUpperCase()} (${m.environment})`,
                        description: `Server outage detected with ${m.http_5xx_count} 5xx HTTP errors recorded in the last scan window.`,
                        telemetry_snapshot: m,
                        notification_email: ownerConfig ? ownerConfig.notification_email : null
                    });
                }

                // Rule 3: LATENCY_DEGRADATION (p95 > 2000ms)
                if (m.p95_latency_ms > 2000 && categories.includes("LATENCY_DEGRADATION")) {
                    await triggerIncident({
                        organization_id: orgId,
                        app_key: m.app_key,
                        resource_type: m.resource_type || 'aca',
                        environment: m.environment,
                        category: 'LATENCY_DEGRADATION',
                        severity: 'P3_MEDIUM',
                        title: `Latency Degradation on ${m.app_key.toUpperCase()} (${m.environment})`,
                        description: `p95 API response latency increased to ${m.p95_latency_ms}ms.`,
                        telemetry_snapshot: m,
                        notification_email: ownerConfig ? ownerConfig.notification_email : null
                    });
                }

                // Rule 4: HEALTH_CHECK_FAILURE (Replicas = 0 or liveness probe failure)
                if (m.replica_count === 0 && categories.includes("HEALTH_CHECK_FAILURE")) {
                    await triggerIncident({
                        organization_id: orgId,
                        app_key: m.app_key,
                        resource_type: m.resource_type || 'aca',
                        environment: m.environment,
                        category: 'HEALTH_CHECK_FAILURE',
                        severity: 'P2_HIGH',
                        title: `Container Health Check Failure on ${m.app_key.toUpperCase()} (${m.environment})`,
                        description: `Active container replica count dropped to 0 instances. Health probe check failed.`,
                        telemetry_snapshot: m,
                        notification_email: ownerConfig ? ownerConfig.notification_email : null
                    });
                }

                // Rule 5: STORAGE_VOLUME_FULL (Storage > 90%)
                if (m.storage_percent > 90 && categories.includes("STORAGE_VOLUME_FULL")) {
                    await triggerIncident({
                        organization_id: orgId,
                        app_key: m.app_key,
                        resource_type: m.resource_type || 'vm',
                        environment: m.environment,
                        category: 'STORAGE_VOLUME_FULL',
                        severity: 'P3_MEDIUM',
                        title: `Storage Capacity Exhaustion on ${m.app_key.toUpperCase()} (${m.environment})`,
                        description: `Storage volume utilization reached ${m.storage_percent.toFixed(1)}% exceeding safety capacity threshold.`,
                        telemetry_snapshot: m,
                        notification_email: ownerConfig ? ownerConfig.notification_email : null
                    });
                }
            }
        }
    } catch (err) {
        console.error('[IncidentScanner] Scan loop error:', err.message);
    } finally {
        isRunning = false;
    }
};

/**
 * Triggers an incident record and dispatches email notification if not already triggered
 */
const triggerIncident = async (data) => {
    try {
        // Check if active incident already exists for this app, env, and category
        const [existing] = await db.query(
            `SELECT id FROM resource_incidents 
             WHERE organization_id = ? AND app_key = ? AND environment = ? AND category = ? AND status = 'triggered'`,
            [data.organization_id, data.app_key, data.environment, data.category]
        );

        if (existing && existing.length > 0) {
            return; // Prevent duplicate email alerts for active incident
        }

        const snapshotJson = JSON.stringify(data.telemetry_snapshot || {});
        const [result] = await db.query(
            `INSERT INTO resource_incidents (organization_id, app_key, resource_type, environment, category, severity, title, description, telemetry_snapshot, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'triggered')`,
            [data.organization_id, data.app_key, data.resource_type, data.environment, data.category, data.severity, data.title, data.description, snapshotJson]
        );

        console.log(`[IncidentScanner] Triggered new ${data.severity} incident for ${data.app_key} (${data.environment})`);

        // Dispatch Email Notification to Responsible Owner if notification_email exists
        if (data.notification_email && emailService && emailService.sendEmail) {
            const htmlContent = `
                <div style="font-family: Arial, sans-serif; background-color: #0f172a; padding: 24px; color: #f8fafc; border-radius: 12px;">
                    <div style="background-color: #ef4444; color: #fff; padding: 8px 16px; border-radius: 6px; display: inline-block; font-weight: bold; margin-bottom: 16px;">
                        🚨 ${data.severity.replace('_', ' ')}: ${data.category}
                    </div>
                    <h2 style="margin: 0 0 8px 0; color: #ffffff;">${data.title}</h2>
                    <p style="color: #94a3b8; font-size: 14px;">${data.description}</p>

                    <div style="background-color: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin: 20px 0;">
                        <h4 style="margin: 0 0 10px 0; color: #a78bfa;">Telemetry Snapshot at Trigger Time:</h4>
                        <table style="width: 100%; border-collapse: collapse; font-size: 13px; color: #cbd5e1;">
                            <tr><td><strong>Resource Asset:</strong></td><td>${data.app_key} (${data.resource_type.toUpperCase()})</td></tr>
                            <tr><td><strong>Environment:</strong></td><td>${data.environment.toUpperCase()}</td></tr>
                            <tr><td><strong>CPU Utilization:</strong></td><td>${data.telemetry_snapshot.cpu_percent || 0}%</td></tr>
                            <tr><td><strong>Memory Usage:</strong></td><td>${data.telemetry_snapshot.memory_mb || 0} MB</td></tr>
                            <tr><td><strong>p95 Latency:</strong></td><td>${data.telemetry_snapshot.p95_latency_ms || 0} ms</td></tr>
                            <tr><td><strong>5xx Error Count:</strong></td><td>${data.telemetry_snapshot.http_5xx_count || 0}</td></tr>
                        </table>
                    </div>

                    <p style="font-size: 12px; color: #64748b;">This automated incident alert was generated by EvaOps Incident Management Daemon.</p>
                </div>
            `;

            await emailService.sendEmail({
                to: data.notification_email,
                subject: `[EvaOps Incident] ${data.severity}: ${data.title}`,
                html: htmlContent
            }).catch(e => console.error('[IncidentScanner] Email send error:', e.message));
        }
    } catch (err) {
        console.error('[IncidentScanner] Error recording incident:', err.message);
    }
};

const startIncidentScanner = () => {
    console.log('[IncidentScanner] Starting 24/7 background telemetry & incident evaluation daemon (60s interval)...');
    runIncidentScanCycle();
    setInterval(runIncidentScanCycle, 60000);
};

module.exports = { startIncidentScanner };
