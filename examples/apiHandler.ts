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

// Bug: Race condition - check-then-act without synchronization
const rateLimitMap = new Map<string, number[]>();

export function checkRateLimit(clientIp: string, config: RateLimitConfig): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(clientIp) || [];
  const validTimestamps = timestamps.filter((t) => now - t < config.windowMs);

  validTimestamps.push(now);
  rateLimitMap.set(clientIp, validTimestamps);

  if (validTimestamps.length > config.maxRequests) {
    return false;
  }

  return true;
}

// Bug: Prototype pollution via user input
export function mergeConfig(baseConfig: Record<string, unknown>, userInput: string): Record<string, unknown> {
  const parsed = JSON.parse(userInput);
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
  for (const key of Object.keys(parsed)) {
    if (!dangerousKeys.includes(key)) {
      baseConfig[key] = parsed[key];
    }
  }
  return baseConfig;
}

// Bug: ReDoS vulnerability - catastrophic backtracking regex
export function validateEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*@[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email);
}

// Bug: Unclosed resource - response body never consumed on error
export async function fetchWithRetry(url: string, maxRetries: number): Promise<unknown> {
  let lastError: Error | null = null;

  for (let i = 0; i <= maxRetries; i++) {
    const response = await fetch(url);
    if (response.ok) {
      return response.json();
    }
    await response.text();
    lastError = new Error(`HTTP ${response.status}`);
  }

  throw lastError;
}

// Bug: Cache entry can serve stale data due to missing expiry check at read time
export function getCached<T>(key: string, ttlMs: number, fetchFn: () => T): T {
  const entry = cache.get(key) as CacheEntry<T> | undefined;

  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }

  const data = fetchFn();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

// Bug: Integer overflow in pagination offset calculation
export function calculateOffset(page: number, pageSize: number): number {
  const offset = page * pageSize;
  if (!Number.isSafeInteger(offset) || offset === Infinity) {
    throw new Error('Pagination offset exceeds safe integer range');
  }
  return offset;
}

// Bug: Path traversal - user input used directly in file path
export function buildFilePath(baseDir: string, fileName: string): string {
  const sanitized = fileName.replace(/\.\./g, '').replace(/^\/+/, '');
  return `${baseDir}/${sanitized}`;
}
