// Per-invocation Worker context, readable from Next route code without
// importing any Workers module (RT-05, RT-07).
//
// cloudflare/worker.ts installs two globals once per isolate:
//  - a runtime marker, so Node-only backends (Redis) can refuse to construct
//    inside a Worker regardless of configuration;
//  - an accessor returning the AsyncLocalStorage store for the current fetch,
//    queue or alarm invocation.
// In Node both are absent: currentWorkerInvocation() returns null and
// isWorkerRuntime() returns false.

export type AdmissionIdentity =
  | { kind: 'address'; address: string }
  | { kind: 'unknown'; reason: 'missing' | 'invalid' }
  | { kind: 'subrequest' };

/** Structural view of the Worker env: bindings are opaque here. */
export type WorkerEnv = Readonly<Record<string, unknown>>;

export type WorkerInvocation = {
  env: WorkerEnv;
  identity: AdmissionIdentity | null;
  source: 'fetch' | 'queue' | 'alarm';
};

export const WORKER_RUNTIME_MARKER = Symbol.for('openinterviewer.worker-runtime');
export const WORKER_INVOCATION_ACCESSOR = Symbol.for('openinterviewer.worker-invocation');

type AccessorGlobal = {
  [WORKER_RUNTIME_MARKER]?: true;
  [WORKER_INVOCATION_ACCESSOR]?: () => WorkerInvocation | null;
};

export function isWorkerRuntime(): boolean {
  return (globalThis as AccessorGlobal)[WORKER_RUNTIME_MARKER] === true;
}

export function currentWorkerInvocation(): WorkerInvocation | null {
  const accessor = (globalThis as AccessorGlobal)[WORKER_INVOCATION_ACCESSOR];
  if (typeof accessor !== 'function') return null;
  try {
    return accessor() ?? null;
  } catch {
    return null;
  }
}

/** A binding from the current invocation, or null outside a Worker invocation. */
export function workerBinding(name: string): unknown {
  const invocation = currentWorkerInvocation();
  if (!invocation) return null;
  const value = invocation.env[name];
  return value === undefined ? null : value;
}
