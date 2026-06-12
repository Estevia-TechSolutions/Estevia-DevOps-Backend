const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Choose which environment config file to load
const envFile = process.env.ENV_FILE || (process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env');
const envPath = path.resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
    console.log(`[DevOps Backend] Loading environment from: ${envFile}`);
    require('dotenv').config({ path: envPath });
} else {
    console.log(`[DevOps Backend] Loading default .env file`);
    require('dotenv').config();
}

const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors());
app.use(express.json());

// Routes
const authRoutes = require('./routes/authRoutes');
const { protect } = require('./middlewares/authMiddleware');

app.use('/api/auth', authRoutes);

const credentialRoutes = require('./routes/credentialRoutes');
app.use('/api/credentials', protect, credentialRoutes);

const appRoutes = require('./routes/appRoutes');
app.use('/api/apps', protect, appRoutes);

const orgRoutes = require('./routes/orgRoutes');
app.use('/api/org', orgRoutes);

app.get('/health', (req, res) => {
    res.json({ status: 'HEALTHY', timestamp: new Date() });
});

app.listen(PORT, () => {
    console.log(`[DevOps Backend] Running on http://localhost:${PORT}`);
});
