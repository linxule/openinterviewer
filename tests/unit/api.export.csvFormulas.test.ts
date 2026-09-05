// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { makeStoredInterview } from '../fixtures/models';

/**
 * CSV formula-injection neutralization contract.
 *
 * Any cell value (study name, insight text, etc.) that begins with a
 * spreadsheet formula prefix (=, +, -, @, tab, CR) must be neutralized in the
 * exported summary.csv so the CSV cannot execute formulas in spreadsheet apps.
 *
 * Known gap (intentionally red): summary.csv quotes but does not neutralize
 * leading formula characters.
 */

const contextMock = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
}));

vi.mock('@/lib/researcherContext', () => contextMock);

const kvMock = vi.hoisted(() => ({
  getAllInterviewsChecked: vi.fn(),
  getStudyAggregateChecked: vi.fn().mockResolvedValue({ status: 'not-found' }),
}));

vi.mock('@/lib/kv', () => kvMock);

import { GET } from '@/app/api/interviews/export/route';

function parseCsvRow(row: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }

  cells.push(cell);
  return cells;
}

async function readSummaryRow(interview: ReturnType<typeof makeStoredInterview>): Promise<string[]> {
  kvMock.getAllInterviewsChecked.mockResolvedValue({ status: 'ok', items: [interview] });
  const response = await GET();
  expect(response.status).toBe(200);

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const csv = await zip.file('summary.csv')!.async('string');
  return parseCsvRow(csv.split('\n')[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  contextMock.getRequestContext.mockResolvedValue({
    authorized: true,
    context: { kvClient: {} },
  });
  // vitest.config.mts sets mockReset: true, which wipes a hoisted
  // mockResolvedValue before every test — so the default lives here instead.
  kvMock.getStudyAggregateChecked.mockResolvedValue({ status: 'not-found' });
});

describe('GET /api/interviews/export summary.csv formula neutralization', () => {
  it('neutralizes spreadsheet formulas in the study name cell', async () => {
    const formula = '=HYPERLINK("https://evil.example","Click me")';
    const cells = await readSummaryRow(
      makeStoredInterview({ id: 'interview-x', studyName: formula })
    );

    expect(cells[1]).toBe(`'${formula}`);
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'neutralizes a %j-prefixed study name',
    async (prefix) => {
      const formula = `${prefix}SUM(1,1)`;
      const cells = await readSummaryRow(
        makeStoredInterview({ id: 'interview-x', studyName: formula })
      );

      expect(cells[1]).toBe(`'${formula}`);
    }
  );

  it('neutralizes formulas in synthesis insight cells', async () => {
    const formula = '@SUM(1,1)';
    const cells = await readSummaryRow(
      makeStoredInterview({
        id: 'interview-x',
        synthesis: {
          statedPreferences: [],
          revealedPreferences: [],
          themes: [],
          contradictions: [],
          keyInsights: [],
          bottomLine: formula,
        },
      })
    );

    expect(cells[6]).toBe(`'${formula}`);
  });

  it('leaves benign cell values untouched', async () => {
    const cells = await readSummaryRow(
      makeStoredInterview({ id: 'interview-x', studyName: 'Plain Study Name' })
    );

    expect(cells[1]).toBe('Plain Study Name');
  });
});
