const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseLogger(value) {
  if (value === undefined || value === '') return false;
  if (value === 'false' || value === '0' || value === 'off') return false;
  return { level: value };
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || DEFAULT_HOST,
    port: parsePort(env.PORT),
    logger: parseLogger(env.LOG_LEVEL),
    databaseUrl: env.DATABASE_URL || null,
    sessionSecret: env.SESSION_SECRET || null
  };
}

export const config = loadConfig();
