/**
 * Client transport behaviour with an injected fetch: token exchange, retry with
 * backoff on retryable status codes, and a stable idempotency-key across retries.
 */
import { describe, expect, it } from 'vitest';

import { BookableOutcomeConnectorClient } from '../src/client.js';
import { deltaFixtures } from '../src/fixtures.js';

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

const makeResponse = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const buildClient = (responders: Array<(url: string, init?: RequestInit) => Response>) => {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const responder = responders[Math.min(i, responders.length - 1)]!;
    i += 1;
    return responder(url, init);
  }) as unknown as typeof fetch;

  const client = new BookableOutcomeConnectorClient({
    baseUrl: 'https://dev.example.test',
    credentials: { clientId: 'cid', clientSecret: 'secret' },
    backoffBaseMs: 1,
    sleepImpl: async () => {},
    fetchImpl,
  });
  return { client, calls };
};

const tokenResponder = (url: string): Response | null =>
  url.endsWith('/marketplace/oauth/token') ? makeResponse(200, { access_token: 's360_inst_at_test', expires_in: 300 }) : null;

describe('BookableOutcomeConnectorClient', () => {
  it('acquires a token then posts the submission with a Bearer + idempotency-key', async () => {
    const { client, calls } = buildClient([
      (url) => tokenResponder(url) ?? makeResponse(200, { decision: 'ACCEPT_NEW' }),
    ]);
    const submission = deltaFixtures.newLodging();
    const result = await client.postSubmission(submission);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.operation).toBe('submit');

    const tokenCall = calls.find((c) => c.url.endsWith('/marketplace/oauth/token'));
    const submitCall = calls.find((c) => c.url.endsWith('/v1/integrations/outcome-sources/submit'));
    expect(tokenCall).toBeDefined();
    expect(submitCall).toBeDefined();
    const headers = new Headers(submitCall?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer s360_inst_at_test');
    expect(headers.get('idempotency-key')).toBe(submission.submissionKey);
  });

  it('retries on 503 with a stable idempotency-key, then succeeds', async () => {
    let submitCount = 0;
    const { client, calls } = buildClient([
      (url) => {
        const token = tokenResponder(url);
        if (token) return token;
        submitCount += 1;
        return submitCount === 1 ? makeResponse(503, { error: 'unavailable' }) : makeResponse(200, { decision: 'ACCEPT_NEW' });
      },
    ]);
    const submission = deltaFixtures.newLodging();
    const result = await client.postSubmission(submission);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    const submitCalls = calls.filter((c) => c.url.endsWith('/submit'));
    expect(submitCalls.length).toBe(2);
    const keys = submitCalls.map((c) => new Headers(c.init?.headers).get('idempotency-key'));
    expect(new Set(keys).size).toBe(1); // stable across retries
  });

  it('routes complete-snapshot submissions to the snapshot endpoint', async () => {
    const { client, calls } = buildClient([(url) => tokenResponder(url) ?? makeResponse(200, { decision: 'ACCEPT_NEW' })]);
    const snapshot = await (await import('../src/fixtures.js')).buildSnapshotSubmission(
      'conformance/snapshot/mixed',
      'conformance/mixed',
      'RETAIN_MISSING',
      [deltaFixtures.newLodging().outcomes[0]!],
    );
    const result = await client.postSubmission(snapshot);
    expect(result.operation).toBe('snapshot');
    expect(calls.some((c) => c.url.endsWith('/v1/integrations/outcome-sources/snapshot'))).toBe(true);
  });
});
