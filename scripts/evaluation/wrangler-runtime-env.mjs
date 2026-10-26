import path from 'node:path';

export function buildVerifierRuntimeEnv({baseEnv = process.env, outputDirectory, localKey, remote = false} = {}) {
  if (typeof outputDirectory !== 'string' || outputDirectory.trim() === '' ||
      typeof localKey !== 'string' || localKey.trim() === '') {
    throw new Error('invalid_verifier_runtime_environment');
  }

  return {
    ...baseEnv,
    INGEST_API_KEY:localKey,
    WRANGLER_LOG_PATH:path.join(outputDirectory, 'wrangler-logs'),
    ...(remote ? {} : {
      XDG_CONFIG_HOME:path.join(outputDirectory, 'wrangler-config'),
      XDG_CACHE_HOME:path.join(outputDirectory, 'wrangler-cache'),
    }),
  };
}
