'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { LeadError } = require('./lead-service');
const { createRateLimiter } = require('./rate-limit');

const MAX_BODY_BYTES = 8 * 1024;

// Only these paths are public. Lead data, server code and tests are never served.
const PUBLIC_FILES = new Set(['index.html', 'faq.html', 'robots.txt', 'sitemap.xml']);
const PUBLIC_DIRS = new Set(['css', 'js', 'shared', 'assets']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

// Cloudflare Turnstile needs its script and iframe allowed, but only when it is switched on.
function buildSecurityHeaders({ turnstile = false } = {}) {
  const cf = turnstile ? ' https://challenges.cloudflare.com' : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self'${cf}`,
      `frame-src${cf || " 'none'"}`,
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

const SECURITY_HEADERS = buildSecurityHeaders();

const LEAD_ROUTE = /^\/api\/leads\/(PLH-[0-9A-F]{8})(\/submit)?$/;

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: code, message, ...extra.body }, extra.headers);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) {
      reject(new LeadError('unsupported_media_type', 'Requests must be sent as JSON.'));
      req.resume();
      return;
    }
    const tooLarge = () => new LeadError('payload_too_large', 'Request is too large.');
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      reject(tooLarge());
      return;
    }
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (overflow) return;
      if (size > MAX_BODY_BYTES) {
        overflow = true; // keep draining so the client can read the 413 response
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new LeadError('invalid_json', 'Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const ERROR_STATUS = {
  validation: 422,
  not_found: 404,
  conflict: 409,
  invalid_json: 400,
  unsupported_media_type: 415,
  payload_too_large: 413,
  rejected: 400,
};

function createApp({
  rootDir,
  leadService,
  trustProxy = false,
  allowedOrigins = [],
  rateLimits = {},
  turnstile = { enabled: false, siteKey: null, verify: async () => true },
  logger = console,
}) {
  const root = path.resolve(rootDir);
  const pageHeaders = buildSecurityHeaders({ turnstile: turnstile.enabled });
  const TEN_MINUTES = 10 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const limiters = {
    // Per visitor address
    create: createRateLimiter({ windowMs: TEN_MINUTES, max: 10, ...rateLimits.create }),
    update: createRateLimiter({ windowMs: TEN_MINUTES, max: 120, ...rateLimits.update }),
    submit: createRateLimiter({ windowMs: TEN_MINUTES, max: 10, ...rateLimits.submit }),
    // Across all visitors — caps a spam wave spread over many addresses
    globalCreate: createRateLimiter({ windowMs: HOUR, max: 300, ...rateLimits.globalCreate }),
    globalSubmit: createRateLimiter({ windowMs: HOUR, max: 150, ...rateLimits.globalSubmit }),
  };

  // Behind Cloudflare (including Cloudflare Tunnel) every request arrives from the proxy, so the real
  // visitor address must come from CF-Connecting-IP, or all visitors would share one rate-limit bucket.
  const clientAddress = (req) => {
    if (trustProxy === 'cloudflare') {
      const cfIp = String(req.headers['cf-connecting-ip'] || '').trim();
      if (cfIp) return cfIp;
    } else if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // Reject cross-site API writes. Same-origin browser requests and non-browser clients pass.
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host || allowedOrigins.includes(origin);
    } catch {
      return false;
    }
  };

  function limit(res, limiter, req, globalLimiter) {
    let result = limiter.check(clientAddress(req));
    if (result.allowed && globalLimiter) result = globalLimiter.check('all');
    if (!result.allowed) {
      sendError(res, 429, 'rate_limited', 'Too many requests. Please wait a few minutes and try again.', {
        headers: { 'Retry-After': String(result.retryAfterSeconds) },
      });
    }
    return result.allowed;
  }

  // Bots tend to fill every field; people never see this one.
  const isSpam = (body) => typeof body.website === 'string' && body.website.trim() !== '';

  async function handleApi(req, res, pathname) {
    // CORS only for explicitly allowed origins (e.g. VS Code Live Server during local development).
    const origin = req.headers.origin;
    const corsAllowed = Boolean(origin && allowedOrigins.includes(origin));
    if (corsAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Lead-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(corsAllowed ? 204 : 403, SECURITY_HEADERS);
      res.end();
      return;
    }

    if (req.method !== 'GET' && !originAllowed(req)) {
      sendError(res, 403, 'forbidden_origin', 'Cross-site requests are not allowed.');
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Public settings the page needs (only the Turnstile site key, which is public by design).
    if (pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, { turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : null });
      return;
    }

    if (pathname === '/api/leads') {
      if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
      if (!limit(res, limiters.create, req, limiters.globalCreate)) return;
      const body = await readJsonBody(req);
      if (isSpam(body)) throw new LeadError('rejected', 'Unable to process this request.');
      const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.slice(0, 64) : '';
      const result = await leadService.createDraft(body.requirements, key);
      sendJson(res, result.replayed ? 200 : 201, { lead: result.lead, editToken: result.token });
      return;
    }

    const match = LEAD_ROUTE.exec(pathname);
    if (!match) return sendError(res, 404, 'not_found', 'Not found.');
    const [, reference, submitSuffix] = match;
    const token = String(req.headers['x-lead-token'] || '');

    if (submitSuffix) {
      if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
      if (!limit(res, limiters.submit, req, limiters.globalSubmit)) return;
      const body = await readJsonBody(req);
      if (isSpam(body)) throw new LeadError('rejected', 'Unable to process this request.');
      if (turnstile.enabled && !(await turnstile.verify(body.turnstileToken, clientAddress(req)))) {
        sendError(res, 403, 'verification_failed', 'Please complete the security check and try again.');
        return;
      }
      const result = await leadService.submit(reference, token, body.contact);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET') {
      if (!limit(res, limiters.update, req)) return;
      sendJson(res, 200, { lead: await leadService.getDraft(reference, token) });
      return;
    }

    if (req.method === 'PATCH') {
      if (!limit(res, limiters.update, req)) return;
      const body = await readJsonBody(req);
      sendJson(res, 200, { lead: await leadService.updateDraft(reference, token, body.requirements) });
      return;
    }

    sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    let relative;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    } catch {
      relative = '';
    }
    const segments = relative.split('/');
    const isPublic =
      relative &&
      !segments.some((segment) => segment === '..' || segment === '' || segment.startsWith('.')) &&
      (segments.length === 1 ? PUBLIC_FILES.has(relative) : PUBLIC_DIRS.has(segments[0]));

    const filePath = path.join(root, ...segments);
    if (!isPublic || !filePath.startsWith(root + path.sep)) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        ...pageHeaders,
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
      else await serveStatic(req, res, pathname);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof LeadError) {
        const body = error.details ? { errors: error.details } : {};
        const headers = error.code === 'payload_too_large' ? { Connection: 'close' } : {};
        if (error.code === 'payload_too_large') res.on('finish', () => req.destroy());
        sendError(res, ERROR_STATUS[error.code] || 400, error.code, error.message, { body, headers });
        return;
      }
      logger.error(`[server] ${req.method} ${pathname} failed:`, error);
      sendError(res, 500, 'server_error', 'Something went wrong on our side. Please try again.');
    }
  });
}

module.exports = { createApp };
