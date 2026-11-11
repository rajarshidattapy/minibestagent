/**
 * Per-caller rate limiting for /api/chat.
 *
 * Without this, one authenticated user (or anyone at all, when
 * AUTH_OPTIONAL=true) can hold the endpoint open and spend without bound.
 * Two windows run together: a burst window that keeps a single user from
 * flooding, and a sustained window that caps the damage over an hour.
 *
 * NOTE: the store is in-memory and therefore per-instance. On a single
 * server that is exact; across several serverless instances each enforces
 * the limit separately, so the effective ceiling is the limit times the
 * instance count. That is a real weakening, and it is the price of keeping
 * the deploy dependency-free - swap `MemoryStore` for Redis to make it
 * global. See DESIGN.md.
 */

export type Rule = { name: string; limit: number; windowMs: number };

export const DEFAULT_RULES: Rule[] = [
  { name: "burst", limit: 15, windowMs: 60_000 },
  { name: "sustained", limit: 150, windowMs: 60 * 60_000 },
];

export type Decision =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; retryAfterSeconds: number; rule: Rule; resetAt: number };

type Counter = { count: number; resetAt: number };

/**
 * Bound on tracked keys. Without it, a flood of distinct keys would turn the
 * limiter itself into a memory-exhaustion vector.
 */
const MAX_TRACKED_KEYS = 20_000;

export class MemoryStore {
  private counters = new Map<string, Counter>();

  private prune(now: number): void {
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key);
    }

    // Still oversized after dropping expired entries: evict whatever resets
    // soonest, which is the closest thing to least-useful here.
    if (this.counters.size > MAX_TRACKED_KEYS) {
      const byExpiry = [...this.counters.entries()].sort(
        (a, b) => a[1].resetAt - b[1].resetAt,
      );
      for (const [key] of byExpiry.slice(0, this.counters.size - MAX_TRACKED_KEYS)) {
        this.counters.delete(key);
      }
    }
  }

  /** Current count for a key, treating an expired window as empty. */
  get(key: string, now: number): Counter | null {
    const counter = this.counters.get(key);
    if (!counter || counter.resetAt <= now) return null;
    return counter;
  }

  increment(key: string, now: number, windowMs: number): void {
    const existing = this.get(key, now);
    if (existing) {
      existing.count += 1;
      return;
    }
    if (this.counters.size >= MAX_TRACKED_KEYS) this.prune(now);
    this.counters.set(key, { count: 1, resetAt: now + windowMs });
  }

  /** Test seam. */
  clear(): void {
    this.counters.clear();
  }

  get size(): number {
    return this.counters.size;
  }
}

const defaultStore = new MemoryStore();

export type CheckOptions = {
  rules?: Rule[];
  store?: MemoryStore;
  now?: number;
};

/**
 * Check every rule, and only then charge the request against all of them.
 * Checking first means a rejected request does not consume quota - otherwise
 * a client that keeps retrying could hold itself locked out indefinitely.
 */
export function checkRateLimit(key: string, options: CheckOptions = {}): Decision {
  const rules = options.rules ?? DEFAULT_RULES;
  const store = options.store ?? defaultStore;
  const now = options.now ?? Date.now();

  for (const rule of rules) {
    const counter = store.get(`${rule.name}:${key}`, now);
    if (counter && counter.count >= rule.limit) {
      return {
        allowed: false,
        rule,
        resetAt: counter.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - now) / 1000)),
      };
    }
  }

  for (const rule of rules) {
    store.increment(`${rule.name}:${key}`, now, rule.windowMs);
  }

  // Report headroom against the tightest rule, which is the one a caller
  // will actually hit.
  let remaining = Infinity;
  let resetAt = now;
  for (const rule of rules) {
    const counter = store.get(`${rule.name}:${key}`, now);
    const left = rule.limit - (counter?.count ?? 0);
    if (left < remaining) {
      remaining = left;
      resetAt = counter?.resetAt ?? now + rule.windowMs;
    }
  }

  return { allowed: true, remaining: Math.max(0, remaining), resetAt };
}

/**
 * Who to bill a request to. The authenticated subject when we have one;
 * otherwise the client IP.
 *
 * The IP comes from a proxy header, which a caller can forge unless a trusted
 * proxy overwrites it (Vercel and most managed platforms do). So IP-keyed
 * limiting is a speed bump, not a control - the subject key is the real one,
 * which is another reason to run with authentication enabled.
 */
export function rateLimitKey(subject: string | null, request: Request): string {
  if (subject) return `sub:${subject}`;

  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

/** `RateLimit-*` headers, so a well-behaved client can pace itself. */
export function rateLimitHeaders(decision: Decision): Record<string, string> {
  const resetSeconds = Math.max(0, Math.ceil((decision.resetAt - Date.now()) / 1000));
  if (decision.allowed) {
    return {
      "RateLimit-Remaining": String(decision.remaining),
      "RateLimit-Reset": String(resetSeconds),
    };
  }
  return {
    "Retry-After": String(decision.retryAfterSeconds),
    "RateLimit-Limit": String(decision.rule.limit),
    "RateLimit-Remaining": "0",
    "RateLimit-Reset": String(resetSeconds),
  };
}
