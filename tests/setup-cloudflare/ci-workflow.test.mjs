// Static checks of .github/workflows/ci.yml for the production promotion:
// run-level concurrency (GitHub applies the cancel-in-progress value of the
// run that arrives to every in-progress run in the same group, and a
// cancelled run takes its jobs with it) and the order of the promotion steps.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../../scripts/cloudflare/lib.mjs';
import { evaluateWorkflowValue, parseWorkflowYaml } from './fixtures/workflow-yaml.mjs';

const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const workflow = parseWorkflowYaml(readFileSync(WORKFLOW, 'utf8'));

const run = (eventName, ref, inputs = {}) => ({
  label: `${eventName} ${ref}`,
  context: { github: { workflow: workflow.name, event_name: eventName, ref, run_id: '1' }, inputs },
});

const truthy = (value) => !(value === false || value === null || value === undefined || value === 0 || value === '');

function concurrencyOf(settings, { context }) {
  assert.ok(settings && typeof settings === 'object', 'concurrency must be a mapping with group and cancel-in-progress');
  return {
    // GitHub compares concurrency groups case-insensitively.
    group: String(evaluateWorkflowValue(settings.group, context)).toLowerCase(),
    cancel: truthy(evaluateWorkflowValue(settings['cancel-in-progress'] ?? false, context)),
  };
}

/** Whether `incoming`, once queued, cancels `running` at the run level. */
function cancels(incoming, running) {
  const next = concurrencyOf(workflow.concurrency, incoming);
  return next.cancel && next.group === concurrencyOf(workflow.concurrency, running).group;
}

const dispatchMain = run('workflow_dispatch', 'refs/heads/main', { promote_cloudflare: true });
const secondDispatch = run('workflow_dispatch', 'refs/heads/main', { promote_cloudflare: false });
const dispatchBranch = run('workflow_dispatch', 'refs/heads/feature', { promote_cloudflare: true });
const pushMain = run('push', 'refs/heads/main');
const laterPushMain = run('push', 'refs/heads/main');
const pullRequest = run('pull_request', 'refs/pull/7/merge');
const laterPullRequest = run('pull_request', 'refs/pull/7/merge');

test('no push, pull request or later dispatch cancels a dispatch run (a promotion) in progress', () => {
  for (const incoming of [pushMain, pullRequest, secondDispatch, dispatchBranch]) {
    assert.equal(cancels(incoming, dispatchMain), false, `${incoming.label} would cancel a running promotion`);
  }
});

test('a dispatch never cancels another run in progress', () => {
  for (const running of [pushMain, pullRequest, dispatchMain]) {
    assert.equal(cancels(secondDispatch, running), false, `a dispatch would cancel a running ${running.label}`);
  }
  const dispatch = concurrencyOf(workflow.concurrency, dispatchMain);
  assert.equal(dispatch.cancel, false, 'cancel-in-progress must evaluate to false for workflow_dispatch');
  assert.notEqual(dispatch.group, concurrencyOf(workflow.concurrency, pushMain).group, 'dispatch and push on main must not share a run-level group');
});

test('pushes and pull requests still supersede older runs of the same ref', () => {
  assert.equal(cancels(laterPushMain, pushMain), true);
  assert.equal(cancels(laterPullRequest, pullRequest), true);
  assert.equal(cancels(pullRequest, pushMain), false);
});

test('runs for different refs never cancel each other (the group includes github.ref)', () => {
  const otherPullRequest = run('pull_request', 'refs/pull/8/merge');
  const pushBranch = run('push', 'refs/heads/feature');
  assert.equal(cancels(otherPullRequest, pullRequest), false, 'one pull request would cancel another');
  assert.equal(cancels(pullRequest, otherPullRequest), false, 'one pull request would cancel another');
  assert.equal(cancels(pushBranch, pushMain), false, 'a push to a branch would cancel a push to main');
  assert.equal(cancels(pushMain, pushBranch), false, 'a push to main would cancel a push to a branch');
});

const promote = workflow.jobs['promote-cloudflare'];

test('the promotion job runs only from a main dispatch after every other job, one deploy at a time', () => {
  assert.ok(promote, 'jobs.promote-cloudflare exists');
  const runsFor = (candidate) => truthy(evaluateWorkflowValue(`\${{ ${promote.if} }}`, candidate.context));
  assert.equal(runsFor(dispatchMain), true);
  for (const candidate of [secondDispatch, dispatchBranch, pushMain, pullRequest]) assert.equal(runsFor(candidate), false, candidate.label);
  const others = Object.keys(workflow.jobs).filter((name) => name !== 'promote-cloudflare').sort();
  assert.deepEqual([...promote.needs].sort(), others);
  for (const candidate of [dispatchMain, secondDispatch]) {
    assert.deepEqual(concurrencyOf(promote.concurrency, candidate), { group: 'cloudflare-production', cancel: false });
  }
});

test('the promotion refuses a bootstrap config before the release check, deploys without --bootstrap, then verifies readiness', () => {
  const steps = promote.steps.map((step) => (typeof step.run === 'string' ? step.run : ''));
  const find = (pattern, what) => {
    const index = steps.findIndex((command) => pattern.test(command));
    assert.ok(index >= 0, `promotion step missing: ${what}`);
    return index;
  };
  const write = find(/CLOUDFLARE_INSTALL_CONFIG/, 'write the installation config');
  const checkConfig = find(/node scripts\/cloudflare\/deploy\.mjs --install "([^"]+)" --check-config/, 'deploy.mjs --check-config');
  const release = find(/npm run check:cloudflare/, 'release check');
  const deploy = find(/npm run deploy:cloudflare -- --install "([^"]+)" --confirm/, 'deploy');
  const verify = find(/node scripts\/cloudflare\/setup\.mjs verify --config "([^"]+)" --wait-seconds [1-9]\d*/, 'receipt-less verify');
  assert.ok(write < checkConfig && checkConfig < release && release < deploy && deploy < verify, 'order: write, check-config, release check, deploy, verify');

  const configPath = (index, flag) => new RegExp(`${flag} "([^"]+)"`).exec(steps[index])[1];
  const target = configPath(write, '>');
  assert.equal(configPath(checkConfig, '--install'), target);
  assert.equal(configPath(deploy, '--install'), target);
  assert.equal(configPath(verify, '--config'), target);

  for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) assert.doesNotMatch(String(step.run ?? ''), /--bootstrap/, `${name} must never pass --bootstrap`);
  }
  // Only a held workspace (exit 3) is tolerated; any other failure fails the job.
  assert.match(steps[verify], /if \[ "\$status" -eq 3 \]/);
  assert.match(steps[verify], /exit "\$status"\s*$/);
});
