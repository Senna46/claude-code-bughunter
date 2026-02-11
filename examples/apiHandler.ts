// API request handler with rate limiting and caching.
// Provides HTTP endpoint helpers for a REST API service.

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const pendingRequests = new Map<string, Promise<unknown>>();
const MAX_CACHE_SIZE = 1000;

// Bug: Race condition - check-then-act without synchronization
const rateLimitMap = new Map<string, number[]>();

export function checkRateLimit(clientIp: string, config: RateLimitConfig): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(clientIp) || [];
  const validTimestamps = timestamps.filter((t) => now - t < config.windowMs);

  for (const [ip, ts] of rateLimitMap.entries()) {
    if (ts.length === 0 || ts.every((t) => now - t >= config.windowMs)) {
      rateLimitMap.delete(ip);
    }
  }

  if (validTimestamps.length >= config.maxRequests) {
    rateLimitMap.set(clientIp, validTimestamps);
    return false;
  }

  validTimestamps.push(now);
  rateLimitMap.set(clientIp, validTimestamps);

  return true;
}

// Bug: Prototype pollution via user input
export function mergeConfig(baseConfig: Record<string, unknown>, userInput: string): Record<string, unknown> {
  let parsed;
  try {
    parsed = JSON.parse(userInput);
  } catch (error) {
    throw new Error('Invalid JSON input');
  }
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

  function sanitizeObject(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item));
    }

    const sanitized = Object.create(null);
    for (const key of Object.keys(obj)) {
      if (!dangerousKeys.includes(key)) {
        sanitized[key] = sanitizeObject((obj as Record<string, unknown>)[key]);
      }
    }
    return sanitized;
  }

  const sanitized = sanitizeObject(parsed) as Record<string, unknown>;

  const result = Object.create(null);
  for (const key of Object.keys(baseConfig)) {
    result[key] = baseConfig[key];
  }
  for (const key of Object.keys(sanitized)) {
    if (!dangerousKeys.includes(key) && Object.prototype.hasOwnProperty.call(sanitized, key)) {
      result[key] = sanitized[key];
    }
  }
  return result;
}

// Bug: ReDoS vulnerability - catastrophic backtracking regex
export function validateEmail(email: string): boolean {
  if (email.length > 320) return false;
  const emailRegex = /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*@[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

// Bug: Unclosed resource - response body never consumed on error
export async function fetchWithRetry(url: string, maxRetries: number): Promise<unknown> {
  let lastError: Error = new Error('Fetch failed with no retries');

  for (let i = 0; i <= maxRetries; i++) {
    const response = await fetch(url);
    if (response.ok) {
      try {
        return await response.json();
      } catch (error) {
        await response.text().catch(() => {});
        throw error;
      }
    }
    await response.text().catch(() => {});
    lastError = new Error(`HTTP ${response.status}`);

    if (i < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, i), 10000)));
    }
  }

  throw lastError;
}

// Bug: Cache entry can serve stale data due to missing expiry check at read time
export async function getCached<T>(key: string, ttlMs: number, fetchFn: () => Promise<T> | T): Promise<T> {
  const now = Date.now();
  const entry = cache.get(key) as CacheEntry<T> | undefined;

  if (entry && entry.expiresAt > now) {
    return entry.data;
  }

  const pending = pendingRequests.get(key) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }

  for (const [k, v] of cache.entries()) {
    if (v.expiresAt <= now) {
      cache.delete(k);
    }
  }

  if (cache.size >= MAX_CACHE_SIZE) {
    let oldestKey: string | undefined;
    let oldestExpiry = Infinity;
    for (const [k, v] of cache.entries()) {
      if (v.expiresAt < oldestExpiry) {
        oldestExpiry = v.expiresAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  const promise = Promise.resolve()
    .then(() => fetchFn())
    .then(
      (data) => {
        const expiresAt = Date.now() + ttlMs;
        cache.set(key, { data, expiresAt });
        pendingRequests.delete(key);
        return data;
      },
      (error) => {
        pendingRequests.delete(key);
        throw error;
      }
    );

  pendingRequests.set(key, promise);
  return promise;
}

// Bug: Integer overflow in pagination offset calculation
export function calculateOffset(page: number, pageSize: number): number {
  if (page < 0 || pageSize < 0) {
    throw new Error('Page and pageSize must be non-negative');
  }
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize)) {
    throw new Error('Page and pageSize must be safe integers');
  }
  const offset = page * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new Error('Pagination offset exceeds safe integer range');
  }
  const MAX_REASONABLE_OFFSET = 1000000000;
  if (offset > MAX_REASONABLE_OFFSET) {
    throw new Error('Pagination offset exceeds reasonable limit');
  }
  return offset;
}

// Bug: Path traversal - user input used directly in file path
export function buildFilePath(baseDir: string, fileName: string): string {
  const path = require('path');
  const normalizedBase = path.resolve(baseDir) + path.sep;
  const resolved = path.resolve(baseDir, fileName);

  if (!resolved.startsWith(normalizedBase)) {
    throw new Error('Path traversal detected');
  }

  const relPath = path.relative(normalizedBase, resolved);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}
