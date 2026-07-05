const jwt = require('jsonwebtoken');
const db = require('../config/db');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'estevia-devops-jwt-super-secret-key-12345';

// Helper to hash passwords using crypto (standard Node library)
const hashPassword = (password) => {
    return crypto.createHash('sha256').update(password).digest('hex');
};

const login = async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    try {
        const passwordHash = hashPassword(password);
        const [users] = await db.query('SELECT * FROM crm_users WHERE email = ?', [email]);
        if (users.length === 0 || users[0].password_hash !== passwordHash) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const user = users[0];
        if (user.is_disabled) {
            return res.status(403).json({ error: 'This CRM user account has been disabled.' });
        }
        const token = jwt.sign(
            { id: user.id, email: user.email, name: user.name, role: user.role, isCrm: true },
            JWT_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (err) {
        res.status(500).json({ error: 'Server login error', details: err.message });
    }
};

const createCrmUser = async (req, res) => {
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    try {
        const passwordHash = hashPassword(password);
        await db.query(
            'INSERT INTO crm_users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
            [email, passwordHash, name, role || 'agent']
        );
        res.json({ message: 'CRM user created successfully' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'A CRM user with this email already exists' });
        }
        res.status(500).json({ error: 'Server error creating CRM user', details: err.message });
    }
};

const getMe = async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, email, name, role FROM crm_users WHERE id = ?', [req.crmUser.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'CRM user not found' });
        }
        res.json(users[0]);
    } catch (err) {
        res.status(500).json({ error: 'Server error retrieving details', details: err.message });
    }
};

const listCrmUsers = async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, email, name, role, is_disabled, created_at FROM crm_users ORDER BY name ASC');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Server error listing CRM users', details: err.message });
    }
};

const updateCrmUser = async (req, res) => {
    const { id } = req.params;
    const { email, name, role, is_disabled, password } = req.body;
    
    try {
        const [users] = await db.query('SELECT email FROM crm_users WHERE id = ?', [id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'CRM user not found' });
        }
        
        const currentUser = users[0];
        if (currentUser.email === 'admin@evaops.crm') {
            if (email && email !== 'admin@evaops.crm') {
                return res.status(400).json({ error: 'Cannot change default administrator email' });
            }
            if (role && role !== 'admin') {
                return res.status(400).json({ error: 'Cannot demote default administrator' });
            }
            if (is_disabled) {
                return res.status(400).json({ error: 'Cannot disable default administrator' });
            }
        }
        
        const updates = [];
        const params = [];
        
        if (email) {
            updates.push('email = ?');
            params.push(email);
        }
        if (name) {
            updates.push('name = ?');
            params.push(name);
        }
        if (role) {
            updates.push('role = ?');
            params.push(role);
        }
        if (is_disabled !== undefined) {
            updates.push('is_disabled = ?');
            params.push(is_disabled ? 1 : 0);
        }
        if (password) {
            updates.push('password_hash = ?');
            params.push(hashPassword(password));
        }
        
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields provided for update' });
        }
        
        params.push(id);
        await db.query(`UPDATE crm_users SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ message: 'CRM user updated successfully' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'A CRM user with this email already exists' });
        }
        res.status(500).json({ error: 'Server error updating CRM user', details: err.message });
    }
};

const listClients = async (req, res) => {
    try {
        const [clients] = await db.query(
            `SELECT id, name, plan, license_tier, operator_seats_limit, admin_email, onboarding_complete, is_disabled, created_at 
             FROM organizations ORDER BY created_at DESC`
        );
        const enrichedClients = [];
        for (const client of clients) {
            const [[{ activeSeats }]] = await db.query(
                `SELECT COUNT(*) AS activeSeats FROM users 
                 WHERE organization_id = ? AND status = 'active' AND role IN ('owner','admin','contributor')`,
                [client.id]
            );
            const [[{ unpaidInvoicesCount }]] = await db.query(
                `SELECT COUNT(*) AS unpaidInvoicesCount FROM billing_invoices 
                 WHERE organization_id = ? AND status = 'Pending'`,
                [client.id]
            );
            enrichedClients.push({
                ...client,
                activeSeats,
                unpaidInvoicesCount
            });
        }
        res.json(enrichedClients);
    } catch (err) {
        res.status(500).json({ error: 'Server error listing clients', details: err.message });
    }
};

const updateLicensing = async (req, res) => {
    const { id } = req.params;
    const { plan, license_tier, operator_seats_limit } = req.body;
    if (!plan && !license_tier && operator_seats_limit === undefined) {
        return res.status(400).json({ error: 'At least one licensing parameter is required' });
    }
    try {
        const updates = [];
        const params = [];
        if (plan) {
            updates.push('plan = ?');
            params.push(plan);
        }
        if (license_tier) {
            updates.push('license_tier = ?');
            params.push(license_tier);
        }
        if (operator_seats_limit !== undefined) {
            updates.push('operator_seats_limit = ?');
            params.push(operator_seats_limit);
        }
        params.push(id);
        await db.query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ message: 'Licensing updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error updating licensing', details: err.message });
    }
};

const updateStatus = async (req, res) => {
    const { id } = req.params;
    const { is_disabled } = req.body;
    if (is_disabled === undefined) {
        return res.status(400).json({ error: 'is_disabled state is required' });
    }
    try {
        const statusVal = is_disabled ? 1 : 0;
        await db.query('UPDATE organizations SET is_disabled = ? WHERE id = ?', [statusVal, id]);
        res.json({ message: `Organization account status updated successfully` });
    } catch (err) {
        res.status(500).json({ error: 'Server error updating status', details: err.message });
    }
};

const listClientInvoices = async (req, res) => {
    const { id } = req.params;
    try {
        const [invoices] = await db.query(
            'SELECT * FROM billing_invoices WHERE organization_id = ? ORDER BY issue_date DESC',
            [id]
        );
        res.json(invoices);
    } catch (err) {
        res.status(500).json({ error: 'Server error listing client invoices', details: err.message });
    }
};

const TIER_PRICING = {
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

const generateInvoice = async (req, res) => {
    const { id } = req.params;
    const { due_days } = req.body;
    try {
        const [orgs] = await db.query(
            'SELECT license_tier, operator_seats_limit, billing_currency FROM organizations WHERE id = ?',
            [id]
        );
        if (orgs.length === 0) {
            return res.status(404).json({ error: 'Organization not found' });
        }
        const currency = orgs[0].billing_currency || 'USD';
        const tier = (orgs[0].license_tier || 'growth').toLowerCase();
        const pricingGroup = TIER_PRICING[currency] || TIER_PRICING.USD;
        const pricing = pricingGroup[tier] || pricingGroup.growth;

        const [[{ activeSeats }]] = await db.query(
            `SELECT COUNT(*) AS activeSeats FROM users 
             WHERE organization_id = ? AND status = 'active' AND role IN ('owner','admin','contributor')`,
            [id]
        );

        const baseAmount = pricing.base;
        const perSeatAmount = activeSeats * pricing.perSeat;
        const totalAmount = baseAmount + perSeatAmount;

        const invoiceNum = 'INV-' + Date.now() + '-' + Math.floor(100 + Math.random() * 900);
        const issueDate = new Date();
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + (due_days || 15));

        await db.query(
            `INSERT INTO billing_invoices (organization_id, invoice_number, amount, status, issue_date, due_date, currency)
             VALUES (?, ?, ?, 'Pending', ?, ?, ?)`,
            [id, invoiceNum, totalAmount, issueDate, dueDate, currency]
        );
        res.json({
            message: 'Invoice generated successfully',
            invoice_number: invoiceNum,
            breakdown: {
                license_tier: tier,
                currency: currency,
                base_amount: baseAmount,
                active_seats: activeSeats,
                per_seat_price: pricing.perSeat,
                per_seat_total: perSeatAmount,
                total_amount: totalAmount
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error generating invoice', details: err.message });
    }
};

const updateInvoiceStatus = async (req, res) => {
    const { invoiceId } = req.params;
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ error: 'Invoice status is required' });
    }
    try {
        const paymentDate = status.toLowerCase() === 'paid' ? new Date() : null;
        await db.query(
            'UPDATE billing_invoices SET status = ?, payment_date = ? WHERE id = ?',
            [status, paymentDate, invoiceId]
        );
        res.json({ message: 'Invoice status updated successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Server error updating invoice status', details: err.message });
    }
};

module.exports = {
    login,
    createCrmUser,
    getMe,
    listClients,
    updateLicensing,
    updateStatus,
    listClientInvoices,
    generateInvoice,
    updateInvoiceStatus,
    listCrmUsers,
    updateCrmUser
};
