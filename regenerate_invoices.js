const mysql = require('mysql2/promise');
require('dotenv').config();

// Standard pricing
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
        // Fetch all organizations
        const [orgs] = await db.query('SELECT id, name, billing_currency, sub_package_devops, sub_package_developer, sub_package_security FROM organizations');
        console.log(`[Regenerate Invoices] Found ${orgs.length} organizations to process.`);
        
        for (const org of orgs) {
            const orgId = org.id;
            const currency = org.billing_currency || 'USD';
            console.log(`\nProcessing Org: ${orgId} (${org.name || 'N/A'}), Preferred Currency: ${currency}`);
            
            // Check sub-packages
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
            
            if (packagesToCheck.length === 0) {
                console.log(`  -> No active sub-packages subscribed. Skipping.`);
                continue;
            }
            
            console.log(`  -> Active sub-packages: ${packagesToCheck.join(', ')}`);
            
            for (const pkgKey of packagesToCheck) {
                const pkgInfo = pricing[pkgKey];
                const expectedPrice = pkgInfo[currency];
                const pkgType = pkgInfo.type;
                
                // Check if an invoice for this sub-package already exists
                const [existingInvoices] = await db.query(
                    'SELECT * FROM billing_invoices WHERE organization_id = ? AND invoice_type = ?',
                    [orgId, pkgType]
                );
                
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
                    // (e.g., if there's a legacy invoice of the exact amount/dates for this org with NULL invoice_type)
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
