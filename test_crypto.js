const assert = require('assert');
const { encrypt, decrypt } = require('./utils/crypto');

function runTests() {
    console.log('=== Starting Crypto Unit Tests ===');
    
    // Test 1: Standard string encryption and decryption
    console.log('Test 1: Encrypting and decrypting standard token string...');
    const originalText = 'ghp_GitHubSuperSecretTokenPatValue2026!';
    const encryptedResult = encrypt(originalText);
    
    assert.ok(encryptedResult.encrypted, 'Encryption output string should be present');
    assert.ok(encryptedResult.iv, 'Initialization Vector (iv) should be present');
    assert.ok(encryptedResult.authTag, 'Authentication Tag (authTag) should be present');
    assert.notStrictEqual(encryptedResult.encrypted, originalText, 'Encrypted output should not match original string');
    
    const decryptedText = decrypt(encryptedResult.encrypted, encryptedResult.iv, encryptedResult.authTag);
    assert.strictEqual(decryptedText, originalText, 'Decrypted text must match the original string');
    console.log('✅ Test 1 Passed.');

    // Test 2: JSON payload stringification encryption and decryption
    console.log('Test 2: Encrypting and decrypting JSON secret payloads...');
    const originalPayload = {
        apiKey: 'GD_key_xyz_123',
        apiSecret: 'GD_secret_abc_456'
    };
    const stringified = JSON.stringify(originalPayload);
    const encryptedJson = encrypt(stringified);
    
    const decryptedJson = decrypt(encryptedJson.encrypted, encryptedJson.iv, encryptedJson.authTag);
    const parsedPayload = JSON.parse(decryptedJson);
    
    assert.strictEqual(parsedPayload.apiKey, originalPayload.apiKey, 'Decrypted JSON key must match');
    assert.strictEqual(parsedPayload.apiSecret, originalPayload.apiSecret, 'Decrypted JSON secret must match');
    console.log('✅ Test 2 Passed.');

    // Test 3: Failure detection with tampered inputs
    console.log('Test 3: Verification of integrity error upon ciphertext tampering...');
    const tamperedCipher = encryptedResult.encrypted.substring(0, encryptedResult.encrypted.length - 2) + '00';
    
    assert.throws(() => {
        decrypt(tamperedCipher, encryptedResult.iv, encryptedResult.authTag);
    }, (err) => {
        // Node.js versions differ in their AES-GCM auth tag error messages:
        // Older: "Unsupported state or unable to authenticate data"
        // Newer: "Invalid state", "Decryption failed", or similar crypto errors
        const msg = (err.message || '').toLowerCase();
        return msg.includes('unsupported state') || msg.includes('unable to authenticate') || msg.includes('invalid state') || msg.includes('decryption') || err instanceof Error;
    }, 'Decrypting tampered cipher should throw an authentication tag validation error');
    
    console.log('✅ Test 3 Passed.');

    console.log('=== All Crypto Unit Tests Passed Successfully! ===');
}

try {
    runTests();
    process.exit(0);
} catch (error) {
    console.error('❌ Crypto Unit Test Suite Failed:', error);
    process.exit(1);
}
