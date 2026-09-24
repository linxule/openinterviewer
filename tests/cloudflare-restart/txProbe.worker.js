// Restart-lane probe object (the M0 crash probe's transaction cuts, made
// repeatable). Not deployable and never part of the artifact: it runs only
// under tests/cloudflare-restart/runner.mjs --worker txprobe. Plain
// JavaScript so the Next type-check never sees Workers-only modules.
//
// The production WorkspaceStore commits every job-and-alarm change inside
// `ctx.storage.transaction(async () => { SQL; await setAlarm() })`, but no
// production transaction can be held open from outside. This object holds
// one open on purpose: after its SQL write and its setAlarm, it awaits an
// outbound request that the runner never answers, so the test can SIGKILL the
// runtime while the transaction is still uncommitted.
import { DurableObject } from 'cloudflare:workers';

export class TxProbe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rows (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    });
  }

  async snapshot() {
    const rows = this.ctx.storage.sql.exec(`SELECT id FROM rows ORDER BY at, id`).toArray().map((row) => row.id);
    return { rows, alarm: await this.ctx.storage.getAlarm() };
  }

  /** One committed row and its wake-up, the shape of a committed completion. */
  async commit(id, dueInMs) {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(`INSERT INTO rows (id, at) VALUES (?, ?)`, id, Date.now());
      await this.ctx.storage.setAlarm(Date.now() + dueInMs);
    });
    return this.snapshot();
  }

  /** SQL and an earlier alarm inside a transaction that never commits before the kill. */
  async holdOpen(id, dueInMs) {
    await this.ctx.storage.transaction(async () => {
      this.ctx.storage.sql.exec(`INSERT INTO rows (id, at) VALUES (?, ?)`, id, Date.now());
      await this.ctx.storage.setAlarm(Date.now() + dueInMs);
      await fetch('https://restart-probe.invalid/hold');
      throw new Error('the probe hold was answered');
    });
  }

  async alarm() {
    this.ctx.storage.sql.exec(`INSERT INTO rows (id, at) VALUES (?, ?)`, `alarm-fired-${Date.now()}`, Date.now());
  }
}

const probe = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const stub = env.TX_PROBE.getByName('probe');
    const id = url.searchParams.get('id') ?? 'row';
    const due = Number(url.searchParams.get('due') ?? '60000');
    switch (url.pathname) {
      case '/snapshot':
        return Response.json(await stub.snapshot());
      case '/commit':
        return Response.json(await stub.commit(id, due));
      case '/hold-open':
        return Response.json(await stub.holdOpen(id, due));
      default:
        return new Response('unknown probe route', { status: 404 });
    }
  },
};

export default probe;
