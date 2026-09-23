// Human-readable reporting. Only names, booleans and allowlisted codes.

const LABELS = {
  ready: 'READY',
  'held-maintenance': 'HELD (workspace in a maintenance state)',
  'not-ready': 'NOT READY',
  unreachable: 'UNREACHABLE',
  'config-mismatch': 'CONFIG MISMATCH',
};

export function summarizeVerification(result) {
  return {
    at: result.verifiedAt,
    status: result.status,
    failed: result.checks.filter((check) => !check.ok).map((check) => check.id),
    readinessErrors: result.readinessErrors,
    targets: (result.targets ?? []).map(({ role, status }) => ({ role, status })),
    configOk: result.config.ok,
  };
}

export function printVerification(out, result) {
  const fromConfig = result.source === 'config';
  out.line('');
  out.line(fromConfig
    ? `Verification of ${result.worker ?? 'the Worker'} at ${result.origin ?? '(no valid APP_BASE_URL)'} from ${result.configPath} (no receipt)`
    : `Verification of ${result.install} (${result.env}) at ${result.origin}`);
  for (const target of result.targets ?? []) {
    out.line(`  ${target.role === 'worker' ? 'Worker (workers.dev)' : 'Origin'.padEnd(20)} ${target.url}  ${LABELS[target.status] ?? target.status}`);
  }
  for (const check of result.checks) out.line(`  ${check.ok ? '✓' : '✗'} ${check.id.padEnd(30)} ${check.detail}`);
  out.line(fromConfig
    ? `  ${result.config.ok ? '✓' : '✗'} ${'config.deployable'.padEnd(30)} installation config is complete, Cloudflare standalone and has no bootstrap`
    : `  ${result.config.ok ? '✓' : '✗'} ${'config.identity'.padEnd(30)} installation config matches receipt names and vars`);
  for (const diff of result.config.diffs) out.line(`      ${diff}`);
  if (result.config.templateDrift.length > 0) {
    const remedy = fromConfig ? 'deploy.mjs refuses it until it is regenerated from the current template' : 'run update to deploy the current template';
    out.line(`  i ${'config.template'.padEnd(30)} differs from the current wrangler.jsonc in ${result.config.templateDrift.join(', ')} (${remedy})`);
  }
  out.line(`Result: ${LABELS[result.status] ?? result.status}`);
  if (result.status === 'held-maintenance') {
    out.line('  The workspace is in an operator maintenance state (draining, frozen or recovery). An import target stays in recovery');
    out.line('  until the backup is imported and the recovery epoch activated; otherwise reopen it (RUNBOOK.md) and run verify again.');
  }
  out.line('Not verified by this command (remote gates, 04-verification-and-cutover.md VERIFY-04):');
  for (const limitation of result.limitations) out.line(`  - ${limitation}`);
}
