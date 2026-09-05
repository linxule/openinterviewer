// Test-only launcher. Never enable the Next test proxy in application config.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const port = Number(process.argv[3] || process.env.PLAYWRIGHT_PORT || 3100);
const transport = process.argv[2];

function fixtureEnv(selectedTransport) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'CI']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // Explicitly blank every documented setting, including optional commented
  // settings, so Next's dotenv loading cannot adopt a developer's credentials.
  for (const match of readFileSync('.env.example', 'utf8').matchAll(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)) {
    env[match[1]] = '';
  }
  return {
    ...env,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DEPLOYMENT_MODE: 'standalone',
    APP_BASE_URL: 'https://workflow.example.test',
    ADMIN_PASSWORD: 'synthetic-e2e-admin-password',
    SESSION_SECRET: 'synthetic-e2e-researcher-signing-secret-0001',
    PARTICIPANT_TOKEN_SECRET: 'synthetic-e2e-participant-signing-secret-0002',
    RATE_LIMIT_SALT: 'synthetic-e2e-rate-limit-hash-salt-0003',
    KV_REST_API_URL: 'https://workflow-fixture.upstash.io',
    KV_REST_API_TOKEN: 'synthetic-e2e-redis-token',
    AI_PROVIDER: 'openai',
    AI_TRANSPORT: selectedTransport,
    OPENAI_API_KEY: selectedTransport === 'direct' ? 'synthetic-e2e-openai-key' : '',
    AI_GATEWAY_API_KEY: selectedTransport === 'gateway' ? 'synthetic-e2e-gateway-key' : '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    AI_GATEWAY_BASE_URL: 'https://ai-gateway.vercel.sh/v4/ai',
    VERCEL: '',
    VERCEL_OIDC_TOKEN: '',
    VERCEL_URL: '',
    VERCEL_PROJECT_PRODUCTION_URL: '',
    KV_URL: '',
    REDIS_URL: '',
    KV_REST_API_READ_ONLY_TOKEN: '',
  };
}

if (transport === 'direct' || transport === 'gateway') {
  const isolatedEnv = fixtureEnv(transport);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, isolatedEnv);
  const { default: next } = await import('next');
  const { interceptTestApis, wrapRequestHandlerWorker } = await import('next/dist/experimental/testmode/server.js');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error(`Unintercepted external request blocked by workflow fixture: ${url.origin}`);
    }
    return nativeFetch(input, init);
  };
  // Install the same interception and request context Next uses for testProxy,
  // at this test-only custom server boundary. Application config stays intact.
  interceptTestApis();
  const app = next({ dev: false, hostname: '127.0.0.1', port });
  await app.prepare();
  const server = createServer(wrapRequestHandlerWorker(app.getRequestHandler()));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  console.log(`Synthetic ${transport} workflow server ready on ${port}`);
  process.send?.('ready');
  const close = () => server.close(() => void app.close().then(() => process.exit(0)));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} else {
  const children = new Set();
  let stopping = false;
  const start = (args, env, ipc = false) => {
    const child = spawn(process.execPath, args, { env, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  };
  const close = () => {
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  const build = start(['node_modules/next/dist/bin/next', 'build'], fixtureEnv('direct'));
  const buildCode = await new Promise(resolve => build.once('exit', resolve));
  if (buildCode !== 0) process.exit(buildCode || 1);
  for (const [index, selected] of ['direct', 'gateway'].entries()) {
    const child = start(['tests/e2e/server.mjs', selected, String(port + index)], fixtureEnv(selected), true);
    child.once('exit', code => {
      if (!stopping) {
        close();
        process.exitCode = code || 1;
      }
    });
    // Playwright waits for Gateway's URL. Starting it after direct has bound
    // ensures that this one readiness check covers both transport servers.
    await new Promise((resolve, reject) => {
      child.once('message', message => message === 'ready' ? resolve() : reject(new Error('Unexpected server readiness message')));
      child.once('exit', () => reject(new Error(`${selected} workflow server exited before readiness`)));
      child.once('error', reject);
    }).catch(error => {
      close();
      throw error;
    });
  }
}
