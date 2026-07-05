const mysql = require('mysql2/promise');
require('dotenv').config();

// Standard pricing for sub-packages
const pricing = {
    devops: { USD: 150.00, INR: 12500.00, type: 'devops_package', label: 'DevOps' },
    developer: { USD: 99.00, INR: 8250.00, type: 'developer_package', label: 'Developer' },
    security: { USD: 120.00, INR: 10000.00, type: 'security_package', label: 'Security' }
};

async function run() {
    console.log('[Regenerate Invoices] Starting billing correction for existing organizations...');
    
    // Require db config directly
    const db = require('./config/db');
    
    try {
        // Fetch all organizations with their licensing and tier info
        const [orgs] = await db.query('SELECT id, name, billing_currency, license_tier, operator_seats_limit, sub_package_devops, sub_package_developer, sub_package_security FROM organizations');
        console.log(`[Regenerate Invoices] Found ${orgs.length} organizations to process.`);
        
        for (const org of orgs) {
            const orgId = org.id;
            const currency = org.billing_currency || 'USD';
            console.log(`\nProcessing Org: ${orgId} (${org.name || 'N/A'}), Preferred Currency: ${currency}`);
            
            // ── Part 1: Sub-Package Invoices Correction and Duplicate Cleanup ──
            const packagesToCheck = [];
            if (org.sub_package_devops === 1 || org.sub_package_devops === true) {
                packagesToCheck.push('devops');
            }
            if (org.sub_package_developer === 1 || org.sub_package_developer === true) {
                packagesToCheck.push('developer');
            }
            if (org.sub_package_security === 1 || org.sub_package_security === true) {
                packagesToCheck.push('security');
            }
            
            if (packagesToCheck.length > 0) {
                console.log(`  -> Active sub-packages: ${packagesToCheck.join(', ')}`);
                
                for (const pkgKey of packagesToCheck) {
                    const pkgInfo = pricing[pkgKey];
                    const expectedPrice = pkgInfo[currency];
                    const pkgType = pkgInfo.type;
                    
                    // Check if invoice(s) for this sub-package already exist
                    const [existingInvoices] = await db.query(
                        'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ? ORDER BY id ASC',
                        [orgId, pkgType]
                    );
                    
                    // Cleanup duplicate pending invoices if they exist
                    if (existingInvoices.length > 1) {
                        console.log(`  [${pkgInfo.label}] Found ${existingInvoices.length} duplicate invoices! Cleaning up extras...`);
                        const idsToDelete = existingInvoices.slice(1).map(inv => inv.id);
                        await db.query(
                            'DELETE FROM billing_invoices WHERE id IN (?) AND status = "Pending"',
                            [idsToDelete]
                        );
                        
                        // Re-fetch remaining
                        const [cleanedInvoices] = await db.query(
                            'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ?',
                            [orgId, pkgType]
                        );
                        existingInvoices.splice(0, existingInvoices.length, ...cleanedInvoices);
                    }
                    
                    if (existingInvoices.length > 0) {
                        const invoice = existingInvoices[0];
                        console.log(`  [${pkgInfo.label}] Invoice already exists: ${invoice.invoice_number} (Amount: ${invoice.amount} ${invoice.currency}, Status: ${invoice.status})`);
                        
                        // Verify if amount/currency is correct. If not, fix it!
                        if (parseFloat(invoice.amount) !== expectedPrice || invoice.currency !== currency) {
                            console.log(`    -> Fixing invoice ${invoice.invoice_number}: Updating amount to ${expectedPrice} and currency to ${currency}`);
                            await db.query(
                                'UPDATE billing_invoices SET amount = ?, currency = ? WHERE id = ?',
                                [expectedPrice, currency, invoice.id]
                            );
                        }
                    } else {
                        // Try to find a generic or NULL invoice for this package, if any
                        const [legacyInvoices] = await db.query(
                            'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL AND amount = ? AND currency = ?',
                            [orgId, expectedPrice, currency]
                        );
                        
                        if (legacyInvoices.length > 0) {
                            const legacyInv = legacyInvoices[0];
                            console.log(`  [${pkgInfo.label}] Found legacy matching invoice: ${legacyInv.invoice_number}. Updating invoice_type to ${pkgType}`);
                            await db.query(
                                'UPDATE billing_invoices SET invoice_type = ? WHERE id = ?',
                                [pkgType, legacyInv.id]
                            );
                        } else {
                            // Generate a brand new invoice
                            const invoiceNumber = `INV-EV-${orgId}-${pkgInfo.label.toUpperCase()}-${Date.now()}`;
                            const issueDate = new Date();
                            const dueDate = new Date();
                            dueDate.setDate(issueDate.getDate() + 7);
                            
                            console.log(`  [${pkgInfo.label}] Generating new Pending invoice: ${invoiceNumber} (Amount: ${expectedPrice} ${currency})`);
                            await db.query(
                                `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency, invoice_type)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                [orgId, invoiceNumber, expectedPrice, 'Pending', issueDate, dueDate, currency, pkgType]
                            );
                        }
                    }
                }
            } else {
                console.log(`  -> No active sub-packages subscribed.`);
            }
            
            // ── Part 2: Platform Seat & License Fee Invoice Correction and Generation ──
            const tier = (org.license_tier || 'growth').toLowerCase();
            const platformPricing = {
                USD: {
                    growth:     { base: 1000, perSeat: 40 },
                    enterprise: { base: 2000, perSeat: 90 },
                    sovereign:  { base: 4000, perSeat: 30 }
                },
                INR: {
                    growth:     { base: 83333, perSeat: 3333 },
                    enterprise: { base: 166666, perSeat: 7500 },
                    sovereign:  { base: 333333, perSeat: 2500 }
                }
            };
            const pricingGroup = platformPricing[currency] || platformPricing.USD;
            const tierPricing = pricingGroup[tier] || pricingGroup.growth;

            // Compute expected price based on ACTIVE seats (write-role users: owner, admin, contributor)
            const [[{ activeSeats }]] = await db.query(
                `SELECT COUNT(*) AS activeSeats FROM users WHERE organization_id = ? AND role IN ('owner','admin','contributor')`,
                [orgId]
            );
            const expectedPlatformPrice = tierPricing.base + (activeSeats * tierPricing.perSeat);
            
            // Check if Platform invoice exists (invoice_type IS NULL)
            const [existingPlatformInvoices] = await db.query(
                'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL ORDER BY id ASC',
                [orgId]
            );

            // Cleanup duplicate pending platform invoices if they exist
            if (existingPlatformInvoices.length > 1) {
                console.log(`  [Platform] Found ${existingPlatformInvoices.length} duplicate platform invoices! Cleaning up extras...`);
                const idsToDelete = existingPlatformInvoices.slice(1).map(inv => inv.id);
                await db.query(
                    'DELETE FROM billing_invoices WHERE id IN (?) AND status = "Pending"',
                    [idsToDelete]
                );
                const [cleanedPlatformInvoices] = await db.query(
                    'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type IS NULL',
                    [orgId]
                );
                existingPlatformInvoices.splice(0, existingPlatformInvoices.length, ...cleanedPlatformInvoices);
            }

            if (existingPlatformInvoices.length > 0) {
                const platformInv = existingPlatformInvoices[0];
                console.log(`  [Platform] Invoice already exists: ${platformInv.invoice_number} (Amount: ${platformInv.amount} ${platformInv.currency}, Status: ${platformInv.status})`);
                if (parseFloat(platformInv.amount) !== expectedPlatformPrice || platformInv.currency !== currency) {
                    console.log(`    -> Fixing platform invoice ${platformInv.invoice_number}: Updating amount to ${expectedPlatformPrice} and currency to ${currency}`);
                    await db.query(
                        'UPDATE billing_invoices SET amount = ?, currency = ? WHERE id = ?',
                        [expectedPlatformPrice, currency, platformInv.id]
                    );
                }
            } else {
                const platformInvoiceNumber = `INV-EV-${orgId}-PLATFORM-${Date.now()}`;
                const platformIssueDate = new Date();
                const platformDueDate = new Date();
                platformDueDate.setDate(platformIssueDate.getDate() + 7);

                console.log(`  [Platform] Generating new Pending platform invoice: ${platformInvoiceNumber} (Amount: ${expectedPlatformPrice} ${currency})`);
                await db.query(
                    `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency, invoice_type)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
                    [orgId, platformInvoiceNumber, expectedPlatformPrice, 'Pending', platformIssueDate, platformDueDate, currency]
                );
            }
        }
        
        console.log('\n[Regenerate Invoices] Invoices regeneration/correction completed successfully.');
    } catch (err) {
        console.error('[Regenerate Invoices] Error executing correction script:', err.message);
    } finally {
        // Since we imported db (pool), we should end it to release pool connection
        try {
            await db.end();
        } catch (_) {}
    }
}

run();
