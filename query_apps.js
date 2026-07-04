require('dotenv').config();
const db = require('./config/db');

async function main() {
    try {
        const [rows] = await db.query("SELECT id, name, app_type, repository_url, branch, pipeline_id FROM applications LIMIT 50;");
        console.log(JSON.stringify(rows, null, 2));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
main();
