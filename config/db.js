const mysql = require('mysql2/promise');

const host = process.env.DB_HOST;
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;
const database = process.env.DB_NAME || 'estevia_devops';
const port = process.env.DB_PORT || 3306;

if (!host || !user || !password) {
    console.warn('[WARNING] Database environment variables (DB_HOST, DB_USER, DB_PASSWORD) are not fully configured. Using fallback credentials.');
}

const pool = mysql.createPool({
    host: host || 'estevia-prod-db-v2.estevia-prod-db.private.mysql.database.azure.com',
    user: user || 'estevia',
    password: password || 'Ewco26INCP',
    database,
    port,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
