const jwt = require('jsonwebtoken');

module.exports = function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'estevia_devops_secret_key_2026');
            req.user = decoded;
        }
    } catch (e) {
        // Optional authentication: proceed even if token is missing or invalid
    }
    next();
};
