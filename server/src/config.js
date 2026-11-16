// Central configuration. All secrets come from the environment — never commit them.
const env = process.env;

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT || 3000),
  databaseUrl: env.DATABASE_URL,
  // Render's managed Postgres requires TLS for external connections; internal
  // connections work either way. Set DATABASE_SSL=false for local development.
  databaseSsl: env.DATABASE_SSL ? env.DATABASE_SSL !== 'false' : env.NODE_ENV === 'production',
  sessionDays: Number(env.SESSION_DAYS || 14),
  // Hours a recipient has to confirm receipt before a transfer is escalated.
  transferAcceptHours: Number(env.TRANSFER_ACCEPT_HOURS || 24),
  clientDist: env.CLIENT_DIST,
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env (local) or configure it on Render.');
}
