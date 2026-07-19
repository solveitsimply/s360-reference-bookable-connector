/**
 * Minimal out-of-process client for the Simply360 BOOKABLE_OUTCOME_SOURCE
 * ingress. It speaks ONLY the public boundary:
 *
 *   - client-credentials token exchange at POST /marketplace/oauth/token
 *   - the installation-scoped ingress at
 *     POST /v1/integrations/outcome-sources/{preview,submit,snapshot}
 *
 * Team / installation / epoch identity is derived server-side from the bearer
 * token binding; the connector never puts installation identity in the body.
 */
import {
  validateBookableOutcomeSubmissionV1,
  type BookableOutcomeSubmissionV1,
} from '@s360/contracts/app-platform';

export interface ConnectorCredentials {
  clientId: string;
  clientSecret: string;
}

export interface ConnectorConfig {
  /** Base origin serving both /marketplace and /v1 (e.g. https://dev.simply360.app). */
  baseUrl: string;
  credentials: ConnectorCredentials;
  /** Requested scope; the ingress requires records:write. */
  scope?: string;
  /** Retry budget for idempotent posts. */
  maxAttempts?: number;
  /** Base backoff in ms (exponential with jitter). */
  backoffBaseMs?: number;
  /** Injected fetch (defaults to global fetch); handy for tests. */
  fetchImpl?: typeof fetch;
  /** Injected sleep (defaults to real timer); handy for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type IngressOperation = 'preview' | 'submit' | 'snapshot';

export interface IngressResult {
  operation: IngressOperation;
  submissionKey: string;
  status: number;
  attempts: number;
  ok: boolean;
  body: unknown;
}

const DEFAULT_SCOPE = 'records:write';
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Choose the ingress operation for a submission unless one is forced. */
export const operationForSubmission = (submission: BookableOutcomeSubmissionV1): IngressOperation =>
  submission.mode === 'COMPLETE_SNAPSHOT' ? 'snapshot' : 'submit';

export class BookableOutcomeConnectorClient {
  private readonly config: Required<Omit<ConnectorConfig, 'fetchImpl' | 'sleepImpl' | 'scope'>> &
    Pick<ConnectorConfig, 'fetchImpl' | 'sleepImpl'> & { scope: string };

  private token: { accessToken: string; expiresAtMs: number } | null = null;

  constructor(config: ConnectorConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      credentials: config.credentials,
      scope: config.scope ?? DEFAULT_SCOPE,
      maxAttempts: config.maxAttempts ?? 4,
      backoffBaseMs: config.backoffBaseMs ?? 200,
      fetchImpl: config.fetchImpl,
      sleepImpl: config.sleepImpl,
    };
  }

  private get fetch(): typeof fetch {
    const impl = this.config.fetchImpl ?? globalThis.fetch;
    if (!impl) throw new Error('No fetch implementation available');
    return impl;
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.config.sleepImpl ?? defaultSleep;
  }

  private backoffDelay(attempt: number): number {
    const exp = this.config.backoffBaseMs * 2 ** (attempt - 1);
    return Math.round(exp * (0.5 + Math.random() * 0.5)); // full-ish jitter
  }

  /** Acquire (and cache) a client-credentials installation access token. */
  async acquireToken(force = false): Promise<string> {
    const now = Date.now();
    if (!force && this.token && this.token.expiresAtMs - 30_000 > now) {
      return this.token.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.credentials.clientId,
      client_secret: this.config.credentials.clientSecret,
      scope: this.config.scope,
    });
    const response = await this.fetch(`${this.config.baseUrl}/marketplace/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} ${text.slice(0, 500)}`);
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new Error('Token response missing access_token');
    const expiresInMs = (parsed.expires_in ?? 300) * 1000;
    this.token = { accessToken: parsed.access_token, expiresAtMs: now + expiresInMs };
    return parsed.access_token;
  }

  /**
   * Validate and POST a submission with bounded exponential-backoff retry.
   * The submissionKey is stable across retries, so a retried ACCEPT_NEW is a
   * server-side NO_OP rather than a duplicate — idempotency by construction.
   */
  async postSubmission(
    submission: BookableOutcomeSubmissionV1,
    operation: IngressOperation = operationForSubmission(submission),
  ): Promise<IngressResult> {
    // Fail fast if the connector produced a non-conformant payload (this also
    // re-verifies snapshot hash + control totals via the public authority).
    const validated = await validateBookableOutcomeSubmissionV1(submission);

    const url = `${this.config.baseUrl}/v1/integrations/outcome-sources/${operation}`;
    let attempts = 0;
    let lastError: unknown;

    while (attempts < this.config.maxAttempts) {
      attempts += 1;
      try {
        const accessToken = await this.acquireToken();
        const response = await this.fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'idempotency-key': validated.submissionKey,
          },
          body: JSON.stringify(validated),
        });
        const text = await response.text();
        const body = text ? safeJson(text) : null;

        if (response.status === 401 && attempts < this.config.maxAttempts) {
          // Token may have rotated/expired — refresh once and retry.
          await this.acquireToken(true);
          await this.sleep(this.backoffDelay(attempts));
          continue;
        }
        if (RETRYABLE_STATUSES.has(response.status) && attempts < this.config.maxAttempts) {
          await this.sleep(this.backoffDelay(attempts));
          continue;
        }
        return {
          operation,
          submissionKey: validated.submissionKey,
          status: response.status,
          attempts,
          ok: response.ok,
          body,
        };
      } catch (error) {
        lastError = error;
        if (attempts >= this.config.maxAttempts) break;
        await this.sleep(this.backoffDelay(attempts));
      }
    }
    throw new Error(
      `Ingress ${operation} for ${validated.submissionKey} failed after ${attempts} attempts: ${String(lastError)}`,
    );
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
