/** Typed failures of the AWS-first SPHEREx data path. Every one carries a message that is safe to show to the user. */
export type AwsErrorCode =
  | 'not_found' | 'unpublished' | 'forbidden' | 'rate_limited' | 'server_error' | 'network' | 'timeout' | 'http_error'
  | 'invalid_response' | 'truncated' | 'unsupported_product' | 'too_large' | 'authorization_required' | 'outside_footprint';

export class AwsError extends Error {
  constructor(message: string, public readonly code: AwsErrorCode, public readonly status?: number, public readonly key?: string) {
    super(message);
    this.name = 'AwsError';
  }
  /** Worth retrying automatically (transient). */
  get transient(): boolean {
    return this.code === 'rate_limited' || this.code === 'server_error' || this.code === 'network' || this.code === 'timeout';
  }
}

export class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

export function errorFromStatus(status: number, what: string, key?: string, bodyHint = ''): AwsError {
  const hint = bodyHint ? ` (${bodyHint})` : '';
  if (status === 404) return new AwsError(`${what} was not found in the bucket (HTTP 404)${hint}.`, 'not_found', status, key);
  if (status === 403) return new AwsError(`${what}: access denied (HTTP 403)${hint}. For a public bucket this usually means the object does not exist or the request was signed; requests here are anonymous.`, 'forbidden', status, key);
  if (status === 429) return new AwsError(`${what}: the archive is rate-limiting requests (HTTP 429)${hint}.`, 'rate_limited', status, key);
  if (status === 503 && /SlowDown/i.test(bodyHint)) return new AwsError(`${what}: S3 asked us to slow down (HTTP 503 SlowDown).`, 'rate_limited', status, key);
  if (status >= 500) return new AwsError(`${what}: AWS S3 answered HTTP ${status}${hint}.`, 'server_error', status, key);
  if (status === 416) return new AwsError(`${what}: the requested byte range lies outside the file (HTTP 416).`, 'invalid_response', status, key);
  return new AwsError(`${what}: unexpected HTTP ${status}${hint}.`, 'http_error', status, key);
}
