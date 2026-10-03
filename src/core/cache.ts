/**
 * Generic TTL cache held in process memory — TikWM / Tool77 /
 * TikTok-user responses and stashed callback payloads all live here.
 *
 * Deliberately not a database: entries die with the process (a restart
 * expires the bot's download menus, resend the link) and reads are
 * best-effort by construction — a miss just means refetching from the
 * upstream API. Writes can only fail on a value JSON can't stringify,
 * which every caller already tolerates as "cache expired early".
 */

interface Entry {
  value: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export async function cacheGet<T>(key: string): Promise<T | null> {
  const entry = store.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  try {
    return JSON.parse(entry.value) as T;
  } catch {
    store.delete(key);
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  sweep();

  const encoded = JSON.stringify(value);
  if (encoded === undefined) return;

  store.set(key, { value: encoded, expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000 });
}

/** Drops expired entries so a long-lived process doesn't accumulate them. */
function sweep(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}
