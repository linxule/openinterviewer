// M0 crash-cut probe: commit SQL+alarm in a DO, SIGKILL the whole local
// runtime before the RPC reply, restart on the same persistence directory,
// make no request until after the alarm is due, then observe durable state.
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const [envFile, persistDir, port = '8798', mode = 'after-commit'] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}/__probe`;

function start() {
  const child = spawn('./node_modules/.bin/wrangler', ['dev', '--config', 'cloudflare/probe/wrangler.probe.jsonc', '--local',
    '--port', port, '--ip', '127.0.0.1', '--env-file', envFile, '--persist-to', persistDir],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  return child;
}
async function waitUp() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/config/mode`); if (r.ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error('runtime did not start');
}
function killTree(child) {
  const descendants = (pid) => {
    let out = [];
    try { out = execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean).map(Number); } catch {}
    return out.flatMap((c) => [c, ...descendants(c)]);
  };
  const all = [child.pid, ...descendants(child.pid)];
  for (const pid of all.reverse()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  return all.length;
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

let child = start();
await waitUp();
log('reset', await (await fetch(`${base}/reset`)).text());
const due = 25_000;
const target = mode === 'inside-tx' ? `${base}/stall-in-tx?id=crash-2&stall=30000` : `${base}/commit?id=crash-1&due=${due}&stall=30000`;
const pending = fetch(target).then((r) => r.text(), (e) => `request-error:${e.cause?.code ?? e.name}`);
await sleep(3000);
log('killed processes:', killTree(child));
log('commit reply observed by client:', await pending);
await sleep(1500);
child = start();
// Wait without any request to the worker until the alarm has been due for a while.
await sleep(due + 20_000);
log('snapshot after restart (first request):', await (await fetch(`${base}/snapshot`)).text());
killTree(child);
