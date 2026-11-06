/** Native-launch-only bootstrap for bounded loopback recovery acceptance.
 * Never accepted from web IPC, a URL argument, an environment variable or disk. */
export interface RecoveryConnection { url: string; ownerToken: string; expiresAt: number }
export function recoveryConnection(value: unknown, now = Date.now()): RecoveryConnection {
  const invalid = () => { throw new Error('invalid_recovery_bootstrap'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'expiresAt,ownerToken,url'
      || typeof data.url !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(data.url)
      || Number(data.url.split(':').at(-1)) > 65535
      || typeof data.ownerToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.ownerToken)
      || !Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) <= now
      || (data.expiresAt as number) > now + 30 * 60 * 1000) return invalid();
  return { url: data.url, ownerToken: data.ownerToken, expiresAt: data.expiresAt as number };
}
