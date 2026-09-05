import { Citation, Coordinate, Label, Rule, Verbatim } from '@/components/ui';
import { resolveThemeEvidence } from '@/lib/evidence';
import type { AggregateSynthesisResult, InterviewMessage, SynthesisResult } from '@/types';

export interface SynthesisReadingProps {
  synthesis: SynthesisResult
  /** The record every citation is checked against. */
  transcript: InterviewMessage[]
  /** Controlled note state, keyed `${themeIndex}:${refIndex}`. A missing key means open. */
  openNotes: Record<string, boolean>
  onNoteOpenChange: (themeIndex: number, refIndex: number, open: boolean) => void
  /**
   * Renders "Read in full transcript" inside each verified note. Omit on a
   * surface with no transcript to jump to — `Synthesis.tsx` has none.
   */
  onTraceToTurn?: (turnIndex: number) => void
}

export interface AggregateReadingProps {
  synthesis: AggregateSynthesisResult
}

export interface ProvenanceFooterProps {
  model?: string
  studyRevision?: number
  /** Preformatted by the consumer, which owns its screen's date format. */
  timestamp: string
  /** How the record came to exist at that time. */
  verb: 'saved' | 'generated'
  /** Trailing honesty clause, e.g. the aggregate's ephemerality warning. */
  note?: string
}

/**
 * The per-interview synthesis reading (C1): bottom line, stated vs revealed,
 * key themes with evidence, contradictions, additional insights. Written
 * once for Synthesis.tsx (researcher/preview branch) and InterviewDetail.tsx.
 * Returns a fragment of sibling elements — every consumer supplies its own
 * `space-y-6` wrapper.
 */
export function SynthesisReading({
  synthesis,
  transcript,
  openNotes,
  onNoteOpenChange,
  onTraceToTurn,
}: SynthesisReadingProps) {
  const isNoteOpen = (themeIndex: number, refIndex: number) => openNotes[`${themeIndex}:${refIndex}`] ?? true;

  return (
    <>
      {/* Bottom line */}
      <section>
        <Label className="block">Bottom line</Label>
        <Verbatim
          as="p"
          className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]"
        >
          {synthesis.bottomLine}
        </Verbatim>
      </section>
      <Rule className="mt-8" />

      {/* Stated vs Revealed */}
      <section>
        <h3 className="font-sans text-[15px] font-semibold text-ink-900">Stated vs Revealed</h3>
        <div className="mt-4 md:grid md:grid-cols-2 md:gap-10">
          <div>
            <Label>What they said</Label>
            <ul>
              {synthesis.statedPreferences.map((item, i) => (
                <li
                  key={i}
                  className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-6 md:mt-0">
            <Label>What their behavior revealed</Label>
            <ul>
              {synthesis.revealedPreferences.map((item, i) => (
                <li
                  key={i}
                  className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
      <Rule className="mt-8" />

      {/* Key Themes */}
      <section>
        <h3 className="font-sans text-[15px] font-semibold text-ink-900">Key Themes</h3>
        <ul className="mt-4">
          {synthesis.themes.map((theme, i) => {
            const view = resolveThemeEvidence(theme, transcript);
            return (
              <li key={i} className="border-t border-ink-300 py-4">
                <p className="font-sans text-[15px] font-medium text-ink-900">
                  {theme.theme}
                  {view.kind === 'refs'
                    ? view.entries.map((entry, j) =>
                        entry.match.status === 'verified' ? (
                          <Citation
                            key={j}
                            label={`t.${entry.ref.turnIndex}`}
                            open={isNoteOpen(i, j)}
                            onOpenChange={(next) => onNoteOpenChange(i, j, next)}
                            className="ml-1"
                          >
                            <span className="block text-[19px] leading-[31px] text-ink-900">
                              {`“${entry.quotedFromRecord}”`}
                            </span>
                            <Coordinate className="mt-2 block">
                              {`Participant · turn ${entry.ref.turnIndex}`}
                            </Coordinate>
                            {onTraceToTurn ? (
                              <button
                                type="button"
                                onClick={() => onTraceToTurn(entry.ref.turnIndex)}
                                className="mt-2 block font-sans text-[13px] text-action underline underline-offset-2"
                              >
                                Read in full transcript
                              </button>
                            ) : null}
                          </Citation>
                        ) : null
                      )
                    : null}
                </p>
                {view.kind === 'legacy' ? (
                  <Verbatim
                    as="p"
                    className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700"
                  >
                    {view.text}
                  </Verbatim>
                ) : null}
                {view.kind === 'refs'
                  ? view.entries
                      .filter((entry) => entry.match.status !== 'verified')
                      .map((entry, j) => (
                        <Verbatim
                          key={j}
                          as="p"
                          className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700"
                        >
                          {entry.ref.quote}
                        </Verbatim>
                      ))
                  : null}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Contradictions */}
      {synthesis.contradictions.length > 0 && (
        <section className="border-t border-ink-300 pt-5">
          <h3 className="font-sans text-[15px] font-semibold text-ink-900">Potential Contradictions</h3>
          <ul className="mt-3 space-y-2">
            {synthesis.contradictions.map((c, i) => (
              <li key={i} className="max-w-measure font-sans text-[15px] leading-[24px] text-ink-700">
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Additional Insights */}
      <section>
        <h3 className="font-sans text-[15px] font-semibold text-ink-900">Additional Insights</h3>
        <ul className="mt-4">
          {synthesis.keyInsights.map((insight, i) => (
            <li
              key={i}
              className="border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
            >
              {insight}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * The aggregate synthesis reading (C1/B3): bottom line, key findings, common
 * themes with representative quotes, divergent views, and research
 * implications. `quoteRefs` stays unread — aggregate citations are Slice L.
 */
export function AggregateReading({ synthesis }: AggregateReadingProps) {
  return (
    <>
      {/* Bottom line */}
      <section>
        <Label className="block">Bottom line</Label>
        <Verbatim
          as="p"
          className="mt-3 max-w-measure text-[24px] font-normal leading-[36px] text-ink-900 md:text-[28px] md:leading-[40px]"
        >
          {synthesis.bottomLine}
        </Verbatim>
      </section>
      <Rule className="mt-8" />

      {/* Key Findings */}
      <section>
        <h4 className="font-sans text-[15px] font-semibold text-ink-900">Key Findings</h4>
        <ul className="mt-3">
          {synthesis.keyFindings.map((finding, i) => (
            <li
              key={i}
              className="max-w-measure border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
            >
              {finding}
            </li>
          ))}
        </ul>
      </section>

      {/* Common Themes */}
      {synthesis.commonThemes.length > 0 && (
        <section>
          <h4 className="font-sans text-[15px] font-semibold text-ink-900">Common Themes</h4>
          <ul className="mt-3">
            {synthesis.commonThemes.map((theme, i) => (
              <li key={i} className="border-t border-ink-300 py-4">
                <p className="font-sans text-[15px] font-medium text-ink-900">{theme.theme}</p>
                {theme.representativeQuotes.map((quote, j) => (
                  <Verbatim
                    key={j}
                    as="p"
                    className="mt-2 max-w-measure border-l border-ink-300 pl-4 text-[17px] leading-[28px] text-ink-700"
                  >
                    {quote}
                  </Verbatim>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Divergent Views */}
      {synthesis.divergentViews.length > 0 && (
        <section>
          <h4 className="font-sans text-[15px] font-semibold text-ink-900">Divergent Views</h4>
          <ul className="mt-3">
            {synthesis.divergentViews.map((view, i) => (
              <li key={i} className="border-t border-ink-300 py-4">
                <p className="font-sans text-[15px] font-medium text-ink-900">{view.topic}</p>
                <ul className="mt-2">
                  <li className="max-w-measure border-l border-ink-300 pl-4 font-sans text-[15px] leading-[24px] text-ink-700">
                    {view.viewA}
                  </li>
                  <li className="mt-2 max-w-measure border-l border-ink-300 pl-4 font-sans text-[15px] leading-[24px] text-ink-700">
                    {view.viewB}
                  </li>
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Research Implications */}
      {synthesis.researchImplications.length > 0 && (
        <section>
          <h4 className="font-sans text-[15px] font-semibold text-ink-900">Research Implications</h4>
          <ul className="mt-3">
            {synthesis.researchImplications.map((implication, i) => (
              <li
                key={i}
                className="max-w-measure border-t border-ink-300 py-2 font-sans text-[15px] leading-[24px] text-ink-700"
              >
                {implication}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * B1: honest provenance — the record's own facts, plainly labeled where a
 * field is missing. No cryptographic-token fragment is ever printed (see docs/design/slice-I-spec.md I3).
 */
export function ProvenanceFooter({ model, studyRevision, timestamp, verb, note }: ProvenanceFooterProps) {
  const line = [
    `Synthesized by ${model || 'unrecorded model'}`,
    `study rev ${studyRevision ?? '—'}`,
    `${verb} ${timestamp}`,
    ...(note ? [note] : []),
  ].join(' · ');
  return (
    <footer className="mt-10 border-t border-ink-300 pt-4">
      <Coordinate className="block">{line}</Coordinate>
    </footer>
  );
}
