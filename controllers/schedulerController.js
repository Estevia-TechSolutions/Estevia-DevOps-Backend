const db = require('../config/db');

const schedulerController = {
    /**
     * GET /api/scheduler/rules?organizationId=...
     */
    getRules: async (req, res) => {
        try {
            const orgId = req.query.organizationId || req.user?.organization_id || 'estevia';
            
            // Fetch all applications for this organization from DB
            const [apps] = await db.query(
                'SELECT id, name, app_type, status FROM applications WHERE organization_id = ?',
                [orgId]
            );

            const [rows] = await db.query('SELECT * FROM sleep_schedules WHERE organization_id = ?', [orgId]);
            
            if (rows.length === 0) {
                // Return default weekly active hour settings (e.g. Monday-Friday 8 AM to 6 PM active, active: true)
                const defaultRules = {
                    mon: { start: '08:00', end: '18:00', enabled: true },
                    tue: { start: '08:00', end: '18:00', enabled: true },
                    wed: { start: '08:00', end: '18:00', enabled: true },
                    thu: { start: '08:00', end: '18:00', enabled: true },
                    fri: { start: '08:00', end: '18:00', enabled: true },
                    sat: { start: '08:00', end: '18:00', enabled: false },
                    sun: { start: '08:00', end: '18:00', enabled: false },
                    autoScaleAca: true,
                    autoStopVm: false,
                    selectedApps: []
                };
                return res.json({
                    success: true,
                    organization_id: orgId,
                    rules: defaultRules,
                    active: true,
                    is_default: true,
                    applications: apps
                });
            }

            const schedule = rows[0];
            const rules = typeof schedule.rules_json === 'string' ? JSON.parse(schedule.rules_json) : schedule.rules_json;

            res.json({
                success: true,
                organization_id: orgId,
                rules,
                active: !!schedule.active,
                is_default: false,
                applications: apps
            });
        } catch (error) {
            console.error('[SchedulerController] Failed to get rules:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    /**
     * POST /api/scheduler/rules
     */
    saveRules: async (req, res) => {
        try {
            const { organizationId, rules, active } = req.body;
            const orgId = organizationId || req.user?.organization_id || 'estevia';
            
            if (!rules) {
                return res.status(400).json({ success: false, message: 'Missing rules parameter.' });
            }

            const [existing] = await db.query('SELECT id FROM sleep_schedules WHERE organization_id = ?', [orgId]);
            const rulesJson = JSON.stringify(rules);
            const activeVal = active !== undefined ? (active ? 1 : 0) : 1;

            if (existing.length === 0) {
                await db.query(
                    'INSERT INTO sleep_schedules (organization_id, rules_json, active) VALUES (?, ?, ?)',
                    [orgId, rulesJson, activeVal]
                );
            } else {
                await db.query(
                    'UPDATE sleep_schedules SET rules_json = ?, active = ? WHERE organization_id = ?',
                    [rulesJson, activeVal, orgId]
                );
            }

            res.json({
                success: true,
                message: 'Weekly sleep schedule rules saved successfully.',
                organization_id: orgId,
                active: !!activeVal,
                rules
            });
        } catch (error) {
            console.error('[SchedulerController] Failed to save rules:', error);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};

module.exports = schedulerController;
