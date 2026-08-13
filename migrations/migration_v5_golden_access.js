/**
 * Migration v5 — Golden Access
 * Adds `golden_access` TINYINT(1) column to organizations table.
 * Immediately sets golden_access = 1 for the Estevia organization.
 *
 * IDEMPOTENT: Safe to run multiple times. Checks column existence before ALTER.
 * Run: node migrations/migration_v5_golden_access.js
 */

const db = require('../config/db');

async function run() {
    try {
        console.log('[Migration v5] Checking golden_access column on organizations...');

        const [cols] = await db.query(`
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'organizations'
              AND COLUMN_NAME  = 'golden_access'
        `);

        if (cols.length > 0) {
            console.log('[Migration v5] golden_access column already exists — skipping ALTER.');
        } else {
            await db.query(`
                ALTER TABLE organizations
                ADD COLUMN golden_access TINYINT(1) NOT NULL DEFAULT 0
            `);
            console.log('[Migration v5] Added golden_access column to organizations.');
        }

        // Seed Estevia organization with golden access
        const [result] = await db.query(
            `UPDATE organizations SET golden_access = 1 WHERE id = 'estevia'`
        );

        if (result.affectedRows > 0) {
            console.log('[Migration v5] Set golden_access = 1 for Estevia organization.');
        } else {
            // Try finding by name in case id differs
            const [byName] = await db.query(
                `SELECT id FROM organizations WHERE LOWER(name) LIKE '%estevia%' LIMIT 5`
            );
            if (byName.length > 0) {
                console.log('[Migration v5] Estevia not found by id="estevia". Found by name:');
                byName.forEach(org => console.log(`  id="${org.id}"`));
                console.log('[Migration v5] Update the WHERE clause and re-run.');
            } else {
                console.log('[Migration v5] No organization with id="estevia" found. Check your org ID and re-run.');
            }
        }

        console.log('[Migration v5] Done.');
        process.exit(0);
    } catch (err) {
        console.error('[Migration v5] Failed:', err.message);
        process.exit(1);
    }
}

run();
