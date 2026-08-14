// Deployment mode detection
// Controls whether the app runs in single-tenant (standalone) or multi-tenant (hosted) mode.
// Exact values only — typos never fall through to standalone.

export type DeploymentMode = 'standalone' | 'hosted';

export type DeploymentModeError = 'missing_deployment_mode' | 'invalid_deployment_mode';

export type DeploymentModeResolution =
  | { ok: true; mode: DeploymentMode }
  | { ok: false; error: DeploymentModeError };

type ModeEnv = {
  DEPLOYMENT_MODE?: string;
  NODE_ENV?: string;
};

export function resolveDeploymentMode(env: ModeEnv = process.env): DeploymentModeResolution {
  const raw = env.DEPLOYMENT_MODE;
  if (raw === undefined || raw === '') {
    if (env.NODE_ENV === 'production') {
      return { ok: false, error: 'missing_deployment_mode' };
    }
    return { ok: true, mode: 'standalone' };
  }

  if (raw === 'standalone' || raw === 'hosted') {
    return { ok: true, mode: raw };
  }

  return { ok: false, error: 'invalid_deployment_mode' };
}

export function getDeploymentMode(): DeploymentMode {
  const resolved = resolveDeploymentMode();
  if (!resolved.ok) {
    throw new Error(
      resolved.error === 'missing_deployment_mode'
        ? 'DEPLOYMENT_MODE must be set to "standalone" or "hosted" in production'
        : 'DEPLOYMENT_MODE must be exactly "standalone" or "hosted"'
    );
  }
  return resolved.mode;
}

export function isHostedMode(): boolean {
  return getDeploymentMode() === 'hosted';
}

export function isStandaloneMode(): boolean {
  return getDeploymentMode() === 'standalone';
}
