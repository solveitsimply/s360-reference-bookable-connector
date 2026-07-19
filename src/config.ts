/**
 * Runtime configuration + credential loading for the reference connector.
 *
 * Credentials come from env for local runs, or from AWS Secrets Manager
 * (secret `s360/ref-bookable-connector/client`, JSON `{clientId, clientSecret}`)
 * in the deployed Lambda. The Secrets Manager SDK is imported dynamically and
 * marked external at bundle time so local unit tests need neither AWS nor the
 * SDK installed.
 */
import type { ConnectorConfig, ConnectorCredentials } from './client.js';

export interface LoadedConfig {
  baseUrl: string | null;
  secretArn: string | null;
  scope: string;
}

export const loadEnvConfig = (env: NodeJS.ProcessEnv = process.env): LoadedConfig => ({
  baseUrl: env.S360_API_BASE_URL ?? null,
  secretArn: env.S360_SECRET_ARN ?? null,
  scope: env.S360_SCOPE ?? 'records:write',
});

/** Read credentials from env, falling back to Secrets Manager if an ARN is set. */
export const loadCredentials = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectorCredentials | null> => {
  const clientId = env.S360_CLIENT_ID;
  const clientSecret = env.S360_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  const secretArn = env.S360_SECRET_ARN;
  if (!secretArn) return null;

  try {
    // Dynamic import keeps @aws-sdk out of unit tests and the local build.
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const client = new SecretsManagerClient({});
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) return null;
    const parsed = JSON.parse(response.SecretString) as Partial<ConnectorCredentials>;
    if (!parsed.clientId || !parsed.clientSecret) return null;
    // A placeholder secret (clientId === 'TODO') is treated as "not yet seeded".
    if (parsed.clientId === 'TODO' || parsed.clientSecret === 'TODO') return null;
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch (error) {
    // A missing/unreadable/not-yet-seeded secret means "not configured", not a
    // crash. /health must stay green so it can prove the deploy path.
    console.warn(`Secret read failed (treating as not configured): ${String(error)}`);
    return null;
  }
};

/** Build a full ConnectorConfig, or null when base URL / credentials are absent. */
export const resolveConnectorConfig = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectorConfig | null> => {
  const { baseUrl, scope } = loadEnvConfig(env);
  const credentials = await loadCredentials(env);
  if (!baseUrl || !credentials) return null;
  return { baseUrl, credentials, scope };
};
