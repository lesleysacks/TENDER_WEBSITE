'use strict';

const crypto = require('node:crypto');

const REFERENCE_PATTERN = /^PLH-[0-9A-F]{8}$/;

/** A random, non-guessable reference such as PLH-8F3A92C7 (32 bits from the OS CSPRNG). */
function createLeadReference(randomBytes = crypto.randomBytes) {
  return `PLH-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Generate a reference that is not already taken. `exists` checks the store. */
function createUniqueLeadReference(exists, { randomBytes = crypto.randomBytes, attempts = 8 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const reference = createLeadReference(randomBytes);
    if (!exists(reference)) return reference;
  }
  throw new Error('Could not allocate a unique lead reference');
}

/**
 * The edit token proves the browser that created a draft is the one updating it. Only a SHA-256
 * hash is stored: the token is 256 random bits, so a plain hash is appropriate (unlike low-entropy
 * values such as dates of birth, which must never be hashed this way).
 */
function createEditToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || !token || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  REFERENCE_PATTERN,
  createLeadReference,
  createUniqueLeadReference,
  createEditToken,
  hashToken,
  tokenMatches,
};
