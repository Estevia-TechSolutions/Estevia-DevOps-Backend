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
    host: host || 'dev.c8h82uuqyx51.us-east-1.rds.amazonaws.com',
    user: user || 'admin',
    password: password || 'Ewco26INCP',
    database,
    port,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;
