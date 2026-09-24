// Deployment target resolution (RT-01). Exact values only; absent means the
// backward-compatible Node target. Never inferred from headers, credentials
// or a failed backend connection.

export type DeploymentTarget = 'node' | 'cloudflare';

export type DeploymentTargetResolution =
  | { ok: true; target: DeploymentTarget }
  | { ok: false; error: 'invalid_deployment_target' };

type TargetEnv = Readonly<Record<string, string | undefined>>;

export function resolveDeploymentTarget(env: TargetEnv = process.env): DeploymentTargetResolution {
  const raw = env.DEPLOYMENT_TARGET;
  if (raw === undefined || raw === '') return { ok: true, target: 'node' };
  if (raw === 'node' || raw === 'cloudflare') return { ok: true, target: raw };
  return { ok: false, error: 'invalid_deployment_target' };
}

/**
 * Whether production-only configuration rules apply. A Cloudflare Worker never
 * relies on runtime NODE_ENV: OpenNext replaces only the literal
 * `process.env.NODE_ENV` expression, so aliased reads see it undefined there.
 */
export function isProductionStrict(env: TargetEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  if (env.DEPLOYMENT_TARGET === 'cloudflare') return true;
  return (globalThis as { [key: symbol]: unknown })[Symbol.for('openinterviewer.worker-runtime')] === true;
}
