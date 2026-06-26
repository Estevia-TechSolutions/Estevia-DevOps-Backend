const jwt = require('jsonwebtoken');
const db = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'estevia-devops-jwt-super-secret-key-12345';

const protect = async (req, res, next) => {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ error: 'Not authorized, token missing' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;

        // If organization_id is set, verify organization status (active vs disabled)
        if (decoded.organization_id) {
            // Bypass restriction ONLY for org status, invoices list, and invoice pay endpoints
            const isBypassUrl = req.originalUrl.endsWith('/org/invoices') || 
                                req.originalUrl.includes('/org/invoices/') || 
                                req.originalUrl.endsWith('/org/status');

            if (!isBypassUrl) {
                const [orgs] = await db.query('SELECT is_disabled FROM organizations WHERE id = ?', [decoded.organization_id]);
                if (orgs.length > 0 && orgs[0].is_disabled) {
                    return res.status(403).json({ 
                        error: 'Your organization account has been suspended due to pending billing. Access is restricted to billing & licensing.',
                        isOrgDisabled: true
                    });
                }
            }
        }

        next();
    } catch (err) {
        console.error('[authMiddleware] Token validation failed:', err.message);
        return res.status(401).json({ error: 'Not authorized, token invalid or expired' });
    }
};

const protectCrm = (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
        return res.status(401).json({ error: 'Not authorized CRM token missing' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.isCrm) {
            return res.status(403).json({ error: 'Access denied: not a valid CRM session' });
        }
        req.crmUser = decoded;
        next();
    } catch (err) {
        console.error('[authMiddleware] CRM token validation failed:', err.message);
        return res.status(401).json({ error: 'Not authorized CRM token invalid or expired' });
    }
};

const restrictTo = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(403).json({ error: 'Access denied: role not identified.' });
        }
        
        const userRole = req.user.role.toLowerCase();
        const hasPermission = allowedRoles.some(role => role.toLowerCase() === userRole);
        
        if (!hasPermission) {
            return res.status(403).json({ 
                error: `Access denied: this action requires one of the following roles: [${allowedRoles.join(', ')}]. Current role: ${userRole}` 
            });
        }
        next();
    };
};

module.exports = { protect, restrictTo, protectCrm };
