const db = require('../config/db');

const auditController = {
    /**
     * GET /api/audit-logs
     * Returns a list of all audited operations.
     */
    getAuditLogs: async (req, res) => {
        try {
            // Retrieve audit logs sorted by newest first
            const [rows] = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
            
            const logs = rows.map(r => ({
                id: r.id,
                actorEmail: r.actor_email,
                actionType: r.action_type,
                target: r.target,
                details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
                createdAt: r.created_at
            }));

            res.json({
                success: true,
                count: logs.length,
                logs
            });
        } catch (error) {
            console.error('[AuditController] Failed to retrieve logs:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};

module.exports = auditController;
