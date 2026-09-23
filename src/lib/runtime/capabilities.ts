// Central capability resolution (RT-01). The one place that turns
// DEPLOYMENT_TARGET, DEPLOYMENT_MODE and AI_TRANSPORT into a supported
// runtime shape. Storage and analysis execution are derived here, never
// selected independently, and never inferred from credentials or headers.

import { resolveAITransport, type AITransport } from '../aiTransport';
import { resolveDeploymentMode, type DeploymentMode } from '../mode';
import { resolveDeploymentTarget, type DeploymentTarget } from './target';
import { isWorkerRuntime } from './workerInvocation';

export type StorageBackendKind = 'redis' | 'redis-byos' | 'workspace-do';
export type AnalysisExecution = 'synchronous' | 'queued-v2';

export type Capabilities = {
  target: DeploymentTarget;
  mode: DeploymentMode;
  transport: AITransport;
  storage: StorageBackendKind;
  analysisExecution: AnalysisExecution;
};

export type CapabilityError =
  | 'invalid_deployment_target'
  | 'missing_deployment_mode'
  | 'invalid_deployment_mode'
  | 'invalid_ai_transport'
  | 'unsupported_cloudflare_mode'
  | 'unsupported_cloudflare_transport'
  | 'gateway_not_supported_hosted';

export type CapabilityResolution =
  | { ok: true; capabilities: Capabilities }
  | { ok: false; error: CapabilityError };

type CapabilityEnv = Readonly<Record<string, string | undefined>>;

export function resolveCapabilities(env: CapabilityEnv = process.env): CapabilityResolution {
  const target = resolveDeploymentTarget(env);
  if (!target.ok) return { ok: false, error: target.error };

  if (target.target === 'cloudflare') {
    const mode = env.DEPLOYMENT_MODE;
    if (mode === undefined || mode === '') return { ok: false, error: 'missing_deployment_mode' };
    if (mode === 'hosted') return { ok: false, error: 'unsupported_cloudflare_mode' };
    if (mode !== 'standalone') return { ok: false, error: 'invalid_deployment_mode' };
    const transport = env.AI_TRANSPORT?.trim();
    if (transport === 'gateway') return { ok: false, error: 'unsupported_cloudflare_transport' };
    if (transport && transport !== 'direct') return { ok: false, error: 'invalid_ai_transport' };
    return {
      ok: true,
      capabilities: {
        target: 'cloudflare',
        mode: 'standalone',
        transport: 'direct',
        storage: 'workspace-do',
        analysisExecution: 'queued-v2',
      },
    };
  }

  // The backward-compatible Node default must never select Redis inside a
  // Worker, e.g. when process.env was not populated from the Worker env.
  if (isWorkerRuntime()) return { ok: false, error: 'invalid_deployment_target' };

  const mode = resolveDeploymentMode(env);
  if (!mode.ok) return { ok: false, error: mode.error };
  let transport: AITransport;
  try {
    transport = resolveAITransport(env as NodeJS.ProcessEnv);
  } catch {
    return { ok: false, error: 'invalid_ai_transport' };
  }
  if (mode.mode === 'hosted') {
    if (transport !== 'direct') return { ok: false, error: 'gateway_not_supported_hosted' };
    return {
      ok: true,
      capabilities: { target: 'node', mode: 'hosted', transport, storage: 'redis-byos', analysisExecution: 'synchronous' },
    };
  }
  return {
    ok: true,
    capabilities: { target: 'node', mode: 'standalone', transport, storage: 'redis', analysisExecution: 'synchronous' },
  };
}

/** Throws a fixed, value-free message when the configuration is unsupported. */
export function getCapabilities(env: CapabilityEnv = process.env): Capabilities {
  const resolved = resolveCapabilities(env);
  if (!resolved.ok) {
    throw new Error(`Unsupported deployment configuration: ${resolved.error}`);
  }
  return resolved.capabilities;
}

export function isCloudflareTarget(env: CapabilityEnv = process.env): boolean {
  const target = resolveDeploymentTarget(env);
  return target.ok && target.target === 'cloudflare';
}
