'use strict';

/*
 * Cloudflare Turnstile verification (optional bot check on enquiry submission).
 * Enabled only when TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set. Fails closed: if Cloudflare
 * cannot be reached, the submission is refused and the customer is asked to try again.
 */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function createTurnstile({ siteKey, secretKey, fetchImpl = globalThis.fetch, timeoutMs = 5000, logger = console } = {}) {
  const enabled = Boolean(siteKey && secretKey);

  async function verify(token, remoteIp) {
    if (!enabled) return true;
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    try {
      const response = await fetchImpl(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
      const data = await response.json();
      return data.success === true;
    } catch (error) {
      logger.error(`[turnstile] verification failed: ${error.message}`);
      return false;
    }
  }

  return { enabled, siteKey: enabled ? siteKey : null, verify };
}

module.exports = { createTurnstile };
