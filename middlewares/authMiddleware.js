const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'estevia-devops-jwt-super-secret-key-12345';

const protect = (req, res, next) => {
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
        next();
    } catch (err) {
        console.error('[authMiddleware] Token validation failed:', err.message);
        return res.status(401).json({ error: 'Not authorized, token invalid or expired' });
    }
};

module.exports = { protect };
