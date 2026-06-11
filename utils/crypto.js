const crypto = require('crypto');

const passphrase = process.env.DEVOPS_ENCRYPTION_KEY;
if (!passphrase) {
    console.warn('[WARNING] Encryption key environment variable (DEVOPS_ENCRYPTION_KEY) is not set. Using fallback key.');
}
const MASTER_PASSPHRASE = passphrase || 'EsteviaDevOpsMasterPassphraseSecret2026!';
const key = crypto.createHash('sha256').update(MASTER_PASSPHRASE).digest();

/**
 * Encrypt a text string using AES-256-GCM
 */
function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag
    };
}

/**
 * Decrypt an AES-256-GCM encrypted string
 */
function decrypt(encryptedText, ivHex, authTagHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

module.exports = { encrypt, decrypt };
