const mysql = require('mysql2');
require('dotenv').config({ path: '/Users/gmenon/WorkSpace/Estevia/CodeBase/Estevia-Workspace/Estevia-DevOps-Backend/.env' });

const connection = mysql.createConnection({
  host: '10.0.0.6', // DB_HOST from .env
  user: 'estevia',
  password: 'Ewco26INCP',
  database: 'estevia_devops',
  port: 3306,
});

connection.connect((err) => {
  if (err) {
    console.error('Connection failed:', err.message);
    return;
  }
  console.log('Connected successfully to estevia_devops');
  
  // Show tables first
  connection.query('SHOW TABLES', (err, tables) => {
    if (err) {
      console.error(err);
      connection.end();
      return;
    }
    console.log('Tables:', tables.map(r => Object.values(r)[0]));
    
    // Check recent builds/runs
    connection.query('SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 5', (err, runs) => {
      if (err) {
        console.error('Error querying pipeline_runs (maybe table doesn\'t exist?):', err.message);
      } else {
        console.log('Recent pipeline runs:');
        console.log(JSON.stringify(runs, null, 2));
      }
      connection.end();
    });
  });
});
