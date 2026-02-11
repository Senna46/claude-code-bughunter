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
    return false;
  }

  validTimestamps.push(now);
  rateLimitMap.set(clientIp, validTimestamps);

  return true;
}

// Bug: Prototype pollution via user input
export function mergeConfig(baseConfig: Record<string, unknown>, userInput: string): Record<string, unknown> {
  const parsed = JSON.parse(userInput);
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

  function sanitizeObject(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item));
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (!dangerousKeys.includes(key)) {
        sanitized[key] = sanitizeObject((obj as Record<string, unknown>)[key]);
      }
    }
    return sanitized;
  }

  const sanitized = sanitizeObject(parsed) as Record<string, unknown>;

  for (const key of Object.keys(sanitized)) {
    if (!dangerousKeys.includes(key)) {
      baseConfig[key] = sanitized[key];
    }
  }
  return baseConfig;
}

// Bug: ReDoS vulnerability - catastrophic backtracking regex
export function validateEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*@[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\.[a-zA-Z]{2,}$/;
  if (email.length > 320) return false;
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

  const promise = Promise.resolve(fetchFn()).then(
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
  const offset = page * pageSize;
  if (!Number.isSafeInteger(offset) || offset === Infinity) {
    throw new Error('Pagination offset exceeds safe integer range');
  }
  return offset;
}

// Bug: Path traversal - user input used directly in file path
export function buildFilePath(baseDir: string, fileName: string): string {
  const path = require('path');
  const resolved = path.resolve(baseDir, fileName);
  const normalizedBase = path.resolve(baseDir);

  if (resolved === normalizedBase || resolved.startsWith(normalizedBase + path.sep)) {
    const relPath = path.relative(normalizedBase, resolved);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      throw new Error('Path traversal detected');
    }
    return resolved;
  }

  throw new Error('Path traversal detected');
}
