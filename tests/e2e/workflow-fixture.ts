import { createClient } from 'redis';
import { test as nextTest, expect } from 'next/experimental/testmode/playwright';
import type { BrowserContext } from '@playwright/test';
import { startDisposableRedis } from '../helpers/disposableRedis';

export const ANSWER = 'I keep a short project note so I remember why I saved the document.';
export const GREETING = 'Tell me how you return to a saved research document.';
export const INSIGHT = 'Project notes preserve the reason for saving.';

const synthesis = {
  statedPreferences: ['A short project note'], revealedPreferences: ['Context before rereading'],
  themes: [{ theme: 'Remembering context', frequency: 1, evidenceRefs: [{ quote: ANSWER, turnIndex: 2 }] }],
  contradictions: [], keyInsights: [INSIGHT], bottomLine: INSIGHT,
};
export const UNSAID = 'I never write anything down about a document.';
const aggregate = {
  commonThemes: [{
    theme: 'Remembering context', frequency: 2,
    quoteRefs: [
      { interviewIndex: 1, turnIndex: 2, quote: ANSWER },
      { interviewIndex: 2, turnIndex: 2, quote: UNSAID },
    ],
  }],
  divergentViews: [], keyFindings: ['Both participants keep contextual notes.'],
  researchImplications: ['Investigate when notes are written.'], bottomLine: 'Context notes help both participants resume work.',
};

type ProviderCall = { transport: 'direct' | 'gateway'; operation: string; model: string };
type Workflow = {
  calls: ProviderCall[];
  unexpected: string[];
  failNextSynthesis: boolean;
  interruptStorageAfterSynthesis: boolean;
  storageOffline: boolean;
  participantContext(): Promise<BrowserContext>;
};

function encodeRedis(value: unknown): unknown {
  if (typeof value === 'string') return value === 'OK' ? value : Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(encodeRedis);
  return value;
}

export const test = nextTest.extend<{ workflow: Workflow }>({
  workflow: async ({ next, page, browser, baseURL, _nextWorker }, runTest, testInfo) => {
    // Refuse inherited connection/attestation configuration. Each test must own
    // its Redis process/container, including retries and concurrent projects.
    if (process.env.REDIS_URL || process.env.REDIS_ATTESTATION_FILE) {
      throw new Error('Workflow E2E requires runner-owned Redis; unset inherited Redis configuration.');
    }
    const redis = await startDisposableRedis();
    const client = createClient({ url: redis.url });
    await client.connect().catch(async error => {
      await redis.close();
      throw error;
    });
    const contexts: BrowserContext[] = [];
    const workflow: Workflow = {
      calls: [], unexpected: [], failNextSynthesis: false,
      interruptStorageAfterSynthesis: false, storageOffline: false,
      async participantContext() {
        // A separate browser context guarantees no researcher cookie or storage.
        // Pass only Next's documented test proxy headers, not application auth.
        const context = await browser.newContext({
          baseURL,
          extraHTTPHeaders: {
            'Next-Test-Proxy-Port': String(_nextWorker.proxyPort),
            'Next-Test-Data': testInfo.testId,
          },
        });
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin === new URL(baseURL!).origin) return route.continue();
          workflow.unexpected.push(`browser ${route.request().method()} ${url.origin}${url.pathname}`);
          return route.abort();
        });
        contexts.push(context);
        return context;
      },
    };
    await page.context().route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseURL!).origin) return route.fallback();
      workflow.unexpected.push(`browser ${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    next.onFetch(async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://workflow-fixture.upstash.io') {
        if (workflow.storageOffline) {
          return Response.json({ error: 'Synthetic storage interruption' }, { status: 503 });
        }
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-e2e-redis-token');
        const body = await request.json() as unknown[];
        const pipelined = url.pathname === '/pipeline';
        const commands = pipelined ? body as unknown[][] : [body];
        const results = [];
        for (const command of commands) {
          try {
            const result = await client.sendCommand(command.map(String));
            results.push({ result: request.headers.get('upstash-encoding') === 'base64' ? encodeRedis(result) : result });
          } catch (error) {
            results.push({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        return Response.json(pipelined ? results : results[0]);
      }
      const direct = url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses';
      const gateway = url.origin === 'https://ai-gateway.vercel.sh' && url.pathname === '/v4/ai/language-model';
      if (!direct && !gateway) {
        workflow.unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
        return 'abort';
      }
      const body = await request.json();
      const schema = direct ? body.text?.format?.schema : body.responseFormat?.schema;
      const properties = schema?.properties ?? {};
      const operation = 'commonThemes' in properties ? 'aggregate' : 'statedPreferences' in properties ? 'synthesis' : 'message' in properties ? 'interview' : 'greeting';
      const model = direct ? body.model : request.headers.get('ai-language-model-id');
      workflow.calls.push({ transport: direct ? 'direct' : 'gateway', operation, model });
      if (gateway) {
        expect(body.providerOptions.gateway.only).toEqual(['openai']);
        expect(body.providerOptions.gateway.models).toBeUndefined();
      }
      if (operation === 'synthesis' && workflow.failNextSynthesis) {
        workflow.failNextSynthesis = false;
        // A terminal 400 prevents the provider SDK's transport retry from hiding
        // the user-facing retry. The user must explicitly retry finalization.
        return Response.json({ error: { message: 'Synthetic unavailable synthesis model', type: 'invalid_request_error' } }, { status: 400 });
      }
      const text = operation === 'greeting' ? GREETING : JSON.stringify(
        operation === 'synthesis' ? synthesis : operation === 'aggregate' ? aggregate : {
          message: 'Thank you. That completes our conversation.', questionAddressed: 0,
          phaseTransition: 'wrap-up', profileUpdates: [], shouldConclude: true,
        },
      );
      if (operation === 'synthesis' && workflow.interruptStorageAfterSynthesis) {
        workflow.interruptStorageAfterSynthesis = false;
        workflow.storageOffline = true;
      }
      if (direct) {
        return Response.json({
          id: 'resp_synthetic', object: 'response', created_at: 1, status: 'completed', model,
          output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
        });
      }
      return Response.json({
        content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } },
        response: { id: 'synthetic_gateway', modelId: model, timestamp: new Date().toISOString() },
      });
    });
    try {
      await runTest(workflow);
      expect(workflow.unexpected).toEqual([]);
    } finally {
      await Promise.allSettled([...contexts.map(context => context.close()), client.close()]);
      await redis.close();
    }
  },
});

export { expect };
