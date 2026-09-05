// Closed wire family: interview analysis attach/claim (slice P §P6.3).
// Outcome tags map to a closed AnalysisWireOutcome union; the family
// unavailable marker and any tag owned by another family map to `unavailable`.

import { describe, expect, it } from 'vitest';
import { parseAnalysisResult, parsePersistResult } from '@/lib/wire/parse';

describe('wire.analysis: parseAnalysisResult', () => {
  it('maps every arity-1 outcome tag', () => {
    expect(parseAnalysisResult(['oi:analysis-notfound'])).toEqual({ status: 'ok', value: { outcome: 'notfound' } });
    expect(parseAnalysisResult(['oi:analysis-busy'])).toEqual({ status: 'ok', value: { outcome: 'busy' } });
    expect(parseAnalysisResult(['oi:analysis-done'])).toEqual({ status: 'ok', value: { outcome: 'done' } });
    expect(parseAnalysisResult(['oi:analysis-stale'])).toEqual({ status: 'ok', value: { outcome: 'stale' } });
    expect(parseAnalysisResult(['oi:analysis-written'])).toEqual({ status: 'ok', value: { outcome: 'written' } });
    expect(parseAnalysisResult(['oi:analysis-recorded'])).toEqual({ status: 'ok', value: { outcome: 'recorded' } });
  });

  it('maps the claimed tag with its claimId payload', () => {
    expect(parseAnalysisResult(['oi:analysis-claimed', 'claim-123'])).toEqual({
      status: 'ok',
      value: { outcome: 'claimed', value: 'claim-123' },
    });
  });

  it('maps the family unavailable marker to unavailable', () => {
    expect(parseAnalysisResult(['oi:analysis-unavailable'])).toEqual({ status: 'unavailable' });
  });

  it('rejects tags owned by other families', () => {
    expect(parseAnalysisResult(['oi:persist-created'])).toEqual({ status: 'unavailable' });
    expect(parsePersistResult(['oi:analysis-done'])).toEqual({ status: 'unavailable' });
  });

  it('rejects wrong arity, coerced payloads, and unknown tags', () => {
    expect(parseAnalysisResult(['oi:analysis-claimed'])).toEqual({ status: 'unavailable' });
    expect(parseAnalysisResult(['oi:analysis-claimed', 5])).toEqual({ status: 'unavailable' });
    expect(parseAnalysisResult(['oi:analysis-claimed', ''])).toEqual({ status: 'unavailable' });
    expect(parseAnalysisResult(['oi:analysis-done', 'extra'])).toEqual({ status: 'unavailable' });
    expect(parseAnalysisResult(['oi:analysis-totally-unknown'])).toEqual({ status: 'unavailable' });
  });

  it('rejects non-array and empty wires', () => {
    expect(parseAnalysisResult([])).toEqual({ status: 'unavailable' });
    expect(parseAnalysisResult('oi:analysis-done')).toEqual({ status: 'unavailable' });
    expect(parseAnalysisResult(null)).toEqual({ status: 'unavailable' });
  });
});
