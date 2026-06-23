'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.SMALLCASE_ENCRYPTION_KEY;
  if (!hex) throw new Error('SMALLCASE_ENCRYPTION_KEY env var is not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('SMALLCASE_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(stored) {
  const key = getKey();
  const [ivB64, authTagB64, encryptedB64] = stored.split(':');
  if (!ivB64 || !authTagB64 || !encryptedB64) throw new Error('Invalid encrypted token format');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
