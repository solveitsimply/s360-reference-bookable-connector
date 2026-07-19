/**
 * AWS Lambda Function URL handler.
 *
 *   GET  /health          -> liveness + configuration probe (no credentials needed)
 *   POST /run?scenario=X   -> execute a named conformance scenario against the
 *                             live Simply360 ingress (X defaults to "all")
 *
 * The handler is intentionally dependency-light. Live conformance requires a
 * seeded installation grant + the dev ingress flag; until then /health proves
 * the deploy path and /run reports a clear "not configured" state.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { BookableOutcomeConnectorClient } from './client.js';
import { resolveConnectorConfig, loadEnvConfig } from './config.js';
import { runScenario, scenarioNames, scenarios } from './scenarios.js';

const SERVICE = 's360-reference-bookable-connector';
const CONTRACT_SCHEMA_VERSION = 'simply360.bookable-outcome-source/v1';

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body, null, 2),
});

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';
  const query = event.queryStringParameters ?? {};

  if (method === 'GET' && (path === '/health' || path === '/')) {
    const env = loadEnvConfig();
    const config = await resolveConnectorConfig();
    return json(200, {
      status: 'ok',
      service: SERVICE,
      contractSchemaVersion: CONTRACT_SCHEMA_VERSION,
      ingressConfigured: config !== null,
      ingressBaseUrlSet: env.baseUrl !== null,
      scenarios: scenarioNames(),
      note:
        config === null
          ? 'Deploy path healthy. Live conformance is pending: set S360_API_BASE_URL and seed the s360/ref-bookable-connector/client secret, and enable the dev ingress flag + capability row.'
          : 'Connector configured for live conformance.',
    });
  }

  if (method === 'POST' && path === '/run') {
    const config = await resolveConnectorConfig();
    if (!config) {
      return json(400, {
        error: 'not_configured',
        message:
          'Set S360_API_BASE_URL and seed the s360/ref-bookable-connector/client secret (clientId/clientSecret) before running live conformance.',
      });
    }
    const client = new BookableOutcomeConnectorClient(config);
    const requested = query.scenario ?? 'all';
    const names = requested === 'all' ? scenarioNames() : [requested];
    if (requested !== 'all' && !scenarios[requested]) {
      return json(400, { error: 'unknown_scenario', requested, available: scenarioNames() });
    }
    try {
      const results = [];
      for (const name of names) {
        results.push(await runScenario(client, name));
      }
      return json(200, { service: SERVICE, ran: names, results });
    } catch (error) {
      return json(502, { error: 'ingress_error', message: String(error) });
    }
  }

  return json(404, { error: 'not_found', method, path });
};
