'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { EvidenceRef, StoredInterview, StoredStudy } from '@/types';
import type { DatasetDescription, DatasetSelection, ExplorationAnswer, ExplorationFinding } from '@/lib/exploration/types';
import { MAX_EXPLORATION_CORPUS_BYTES, MAX_EXPLORATION_QUESTION_CHARS, MAX_EXPLORATION_SELECTED_INTERVIEWS } from '@/lib/exploration/types';
import { askStudyQuestion, listStudyExplorationsPage, readStudyExploration, saveStudyExploration, type ExplorationSubmission, ExplorationApiError } from '@/services/explorationApi';
import { getInterview } from '@/services/storageService';
import { immutableSourceContentHash } from '@/lib/exploration/dataset';
import { isExplorationAnswer, serializedBytes } from '@/lib/exploration/validation';
import { resolveEvidenceRef } from '@/lib/evidence';
import { shortInterviewId } from '@/lib/interviewId';
import { Button, Citation, Coordinate, Field, Label, Notice, Rule, Verbatim } from '@/components/ui';
import { DatasetCoverage, StudyDatasetSelector } from '@/components/StudyDatasetSelector';

const SUGGESTIONS = [
  'What provisional user archetypes are supported by these interviews, and what are the exceptions?',
  'What concerns recur within the recorded profile segment I selected?',
  'Which participant quotations support, challenge or leave my hypothesis uncertain?',
  'What unexpected themes were overlooked by the original interview questions?',
];

type LocalRecoveryCopy = { answer: ExplorationAnswer; receipt?: string; receiptExpiresAt: number };
const MAX_LOCAL_RECOVERY_BYTES = 1024 * 1024;
const RECOVERY_RECEIPT_LIFETIME_MS = 24 * 60 * 60 * 1000;

function readRecoveryCopies(key: string, studyId: string): LocalRecoveryCopy[] {
  const raw = sessionStorage.getItem(key);
  if (!raw) return [];
  if (new TextEncoder().encode(raw).byteLength > MAX_LOCAL_RECOVERY_BYTES) throw new Error('oversize local recovery');
  const value = JSON.parse(raw) as { version?: unknown; copies?: unknown };
  if (value?.version !== 1 || !Array.isArray(value.copies)) throw new Error('unreadable local recovery');
  if (!value.copies.every(copy => copy && typeof copy === 'object' && isExplorationAnswer(copy.answer)
    && copy.answer.studyId === studyId && copy.answer.status === 'complete'
    && (copy.receipt === undefined || typeof copy.receipt === 'string')
    && Number.isSafeInteger(copy.receiptExpiresAt) && copy.receiptExpiresAt > 0)) throw new Error('invalid local recovery');
  if (new Set(value.copies.map(copy => copy.answer.id)).size !== value.copies.length) throw new Error('duplicate local recovery');
  return value.copies;
}

function writeRecoveryCopies(key: string, copies: Map<string, LocalRecoveryCopy>): boolean {
  try {
    if (!copies.size) { sessionStorage.removeItem(key); return true; }
    const value = { version: 1, copies: [...copies.values()] };
    if (serializedBytes(value) > MAX_LOCAL_RECOVERY_BYTES) return false;
    sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

function downloadAnswer(answer: ExplorationAnswer) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(answer, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `study-answer-${answer.id}.json`; link.click(); URL.revokeObjectURL(url);
}

type SourceProblem = 'changed' | 'unavailable';

function failureCopy(answer: ExplorationAnswer): string {
  if (answer.failureKind === 'budget-limited') return 'The researcher AI request budget was reached before any model call. No provider request was made. Wait for the budget reset before starting a new attempt.';
  if (answer.failureKind === 'budget-unavailable') return 'The researcher AI request budget could not be checked, so no provider request was made. Try again when the budget service is available.';
  if (answer.failureKind === 'provider-config') return 'The provider rejected the configuration. Check the study’s provider settings before deliberately starting another request.';
  if (answer.failureKind === 'provider-rate-limited') return 'The provider is limiting requests. Wait before deliberately starting another attempt; no research answer was substituted.';
  if (answer.failureKind === 'provider-invalid-response') return 'The provider response was not a usable research answer. A new attempt is a separate provider request; no answer was substituted.';
  return 'This attempt failed. No generated research answer is substituted.';
}

function executionCopy(answer: ExplorationAnswer): string {
  const execution = answer.execution;
  if (!execution) return 'Execution not yet recorded';
  return [
    `Provider ${execution.provider}`,
    `Served model ${execution.model}`,
    ...(execution.requestedModel !== execution.model ? [`Requested model ${execution.requestedModel}`] : []),
    ...(execution.routedProvider ? [`Routed provider ${execution.routedProvider}`] : []),
    execution.aiTransport === 'cloudflare-gateway' ? 'Cloudflare AI Gateway'
      : execution.routedProvider && execution.provider !== 'openrouter' ? 'Vercel AI Gateway' : 'Direct provider transport',
  ].join(' · ');
}

function Quotation({ evidence, record, selected, studyId, sourceProblem }: { evidence: EvidenceRef; record?: StoredInterview; selected: boolean; studyId: string; sourceProblem?: SourceProblem }) {
  const match = selected && record ? resolveEvidenceRef(evidence, record.transcript) : null;
  if (!record || !selected || !match || match.status !== 'verified') return <div className="mt-2 border-l border-ink-300 pl-4"><Verbatim as="p" className="max-w-measure text-[17px] leading-[28px] text-ink-700">{evidence.quote}</Verbatim><p className="mt-1 text-[13px] text-ink-500">Quotation not located in the selected participant record.</p>{sourceProblem && <p className="mt-1 text-[13px] text-ink-500">{sourceProblem === 'changed' ? 'The original selected source has changed since this answer. A matching quotation in its replacement is not historical evidence.' : 'The original selected source is missing or could not be read.'}</p>}</div>;
  const turn = record.transcript[evidence.turnIndex - 1];
  const quoted = match.spans.map(span => turn.content.slice(span.start, span.end)).join(' … ');
  return <Citation label={`${shortInterviewId(record.id)} · t.${evidence.turnIndex}`} className="mt-2 inline-block">
    <span className="block text-[19px] leading-[31px] text-ink-900">{`“${quoted}”`}</span>
    <Coordinate className="mt-2 block">{`${shortInterviewId(record.id)} · participant · turn ${evidence.turnIndex}`}</Coordinate>
    <span className="mt-1 block font-sans text-[13px] text-ink-500">Quotation located; this does not verify the interpretation.</span>
    <a href={`/dashboard/interview/${encodeURIComponent(record.id)}?studyId=${encodeURIComponent(studyId)}&turn=${evidence.turnIndex}`} className="mt-2 block font-sans text-[13px] text-action underline underline-offset-2">Read in full transcript</a>
  </Citation>;
}

function Finding({ finding, records, selected, studyId, sourceProblems }: { finding: ExplorationFinding; records: Map<string, StoredInterview>; selected: Set<string>; studyId: string; sourceProblems: Map<string, SourceProblem> }) {
  return <section className="border-t border-ink-300 py-4">
    <h4 className="font-sans text-[15px] font-semibold text-ink-900">{finding.heading}</h4>
    <Verbatim as="p" className="mt-2 max-w-measure whitespace-pre-wrap text-[17px] leading-[28px] text-ink-700">{finding.interpretation}</Verbatim>
    {(['supporting', 'challenging', 'uncertain'] as const).map(kind => <div key={kind} className="mt-4"><Label>{kind === 'uncertain' ? 'Ambiguous or uncertain evidence' : `${kind} evidence`}</Label>{finding[kind].length > 0 ? <ul className="mt-2">{finding[kind].map((evidence, index) => <li key={index}><Quotation evidence={evidence} record={evidence.interviewId ? records.get(evidence.interviewId) : undefined} selected={!!evidence.interviewId && selected.has(evidence.interviewId)} studyId={studyId} sourceProblem={evidence.interviewId ? sourceProblems.get(evidence.interviewId) : undefined} /></li>)}</ul> : <p className="mt-1 text-[13px] text-ink-500">No quotations supplied.</p>}</div>)}
  </section>;
}

export function ExplorationAnswerReading({ answer, retainedCount }: { answer: ExplorationAnswer; retainedCount: number }) {
  const [records, setRecords] = useState<Map<string, StoredInterview>>(new Map());
  const [sourceProblems, setSourceProblems] = useState<Map<string, SourceProblem>>(new Map());
  const selected = useMemo(() => new Set(answer.scope.sources.map(source => source.interviewId)), [answer.scope]);
  useEffect(() => {
    let current = true;
    setRecords(new Map());
    setSourceProblems(new Map());
    if (!answer.result) return;
    // Re-read exact owned source records. Summary-only list rows are not evidence.
    const ids = [...new Set(answer.result.findings.flatMap(finding => [...finding.supporting, ...finding.challenging, ...finding.uncertain]).map(ref => ref.interviewId).filter((id): id is string => !!id && selected.has(id)))];
    const loaded = new Map<string, StoredInterview>();
    const problems = new Map<string, SourceProblem>();
    let position = 0;
    const worker = async () => {
      while (position < ids.length) {
        const id = ids[position++];
        try {
          const record = await getInterview(id, answer.studyId);
          const source = answer.scope.sources.find(value => value.interviewId === id);
          if (record?.id !== id || record.studyId !== answer.studyId || !Array.isArray(record.transcript) || !source) { problems.set(id, 'unavailable'); continue; }
          if (await immutableSourceContentHash(record) === source.contentHash) loaded.set(id, record);
          else problems.set(id, 'changed');
        } catch { problems.set(id, 'unavailable'); }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker)).then(() => { if (current) { setRecords(loaded); setSourceProblems(problems); } });
    return () => { current = false; };
  }, [answer.id, answer.result, answer.studyId, answer.scope, selected]);

  return <>
    <Label>Historical source scope</Label>
    <Coordinate className="mt-2 block break-words">{`${answer.scope.selectedCount} selected of ${answer.scope.totalSaved} retained at this attempt · ${answer.scope.excludedCount} excluded · ${answer.scope.unknownProfileCount} unknown profile matches`}</Coordinate>
    <p className="mt-2 text-[13px] text-ink-500">{`Revisions: ${[...new Set(answer.scope.sources.map(source => source.studyRevision ?? 'unrecorded'))].join(', ') || 'none'}. ${answer.scope.pendingAnalysisCount} selected transcripts lacked complete individual analysis.`}</p>
    <details className="mt-2 text-[13px]"><summary className="min-h-11 cursor-pointer py-2 text-action">Inspect exact saved dataset selection</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words bg-paper-2 p-3 text-[12px]">{JSON.stringify({ selection: answer.scope.selection, sourceIds: answer.scope.sources.map(source => source.interviewId), sourceFingerprint: answer.scope.sourceFingerprint }, null, 2)}</pre></details>
    {retainedCount !== answer.scope.totalSaved && <p className="mt-2 text-[13px] text-ink-500">{`This historical answer has not been updated: the study now has ${retainedCount} retained interviews.`}</p>}
    {answer.status === 'running' && <Notice tone="neutral" className="mt-4" role="status"><p className="text-[13px]">This attempt is still running or awaiting confirmation. Checking it does not start another provider request.</p></Notice>}
    {answer.status === 'recovery-required' && <Notice tone="error" className="mt-4" role="status"><p className="text-[13px]">The provider may have received this attempt, but its result could not be confirmed. A deliberate new attempt may incur another provider charge.</p></Notice>}
    {answer.status === 'failed' && <Notice tone="error" className="mt-4" role="status"><p className="text-[13px]">{failureCopy(answer)}</p></Notice>}
    {answer.result && <div className="mt-6 space-y-4">
      <Verbatim as="p" className="max-w-measure whitespace-pre-wrap text-[19px] leading-[31px] text-ink-900">{answer.result.answer}</Verbatim>
      {answer.result.findings.map((finding, index) => <Finding key={index} finding={finding} records={records} selected={selected} studyId={answer.studyId} sourceProblems={sourceProblems} />)}
      <section className="border-t border-ink-300 pt-4"><Label>Limitations</Label>{answer.result.limitations.length ? <ul className="mt-2">{answer.result.limitations.map((limitation, index) => <li key={index} className="max-w-measure py-1 text-[13px] text-ink-700">{limitation}</li>)}</ul> : <p className="mt-2 text-[13px] text-ink-500">No additional limitations were supplied. Interpretations remain provisional and require researcher judgment.</p>}</section>
    </div>}
    <Coordinate className="mt-6 block break-words border-t border-ink-300 pt-4">{`${executionCopy(answer)} · ${new Date(answer.createdAt).toLocaleString()}`}</Coordinate>
  </>;
}

export function StudyExploration({ study, interviews, disabled, initialSelection, initialDataset, onDatasetApply }: {
  study: StoredStudy; interviews: StoredInterview[]; disabled: boolean; initialSelection?: DatasetSelection; initialDataset?: DatasetDescription | null;
  onDatasetApply: (selection: DatasetSelection, dataset: DatasetDescription) => void;
}) {
  const questionId = useId();
  const [selection, setSelection] = useState<DatasetSelection>(initialSelection ?? {});
  const [dataset, setDataset] = useState<DatasetDescription | null>(initialDataset ?? null);
  const [question, setQuestion] = useState('');
  const [parentAnswerId, setParentAnswerId] = useState<string | undefined>();
  const [answers, setAnswers] = useState<ExplorationAnswer[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryStorageFailed, setRecoveryStorageFailed] = useState(false);
  const [unsaved, setUnsaved] = useState<Record<string, string | undefined>>({});
  const [attempt, setAttempt] = useState<{ key: string; input: { question: string; selection: DatasetSelection; parentAnswerId?: string }; answerId?: string; uncertain: boolean } | null>(null);
  const live = useRef(true);
  const unsavedIds = useRef(new Set<string>());
  const recoveryCopies = useRef(new Map<string, LocalRecoveryCopy>());
  const recoveryHydrated = useRef(false);
  const recoveryKey = `oi:study-exploration-unsaved:v1:${study.id}`;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const mergeAnswer = useCallback((value: ExplorationAnswer) => setAnswers(previous => [value, ...previous.filter(item => item.id !== value.id)].sort((a, b) => b.createdAt - a.createdAt)), []);
  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    if (!recoveryHydrated.current) {
      recoveryHydrated.current = true;
      try {
        const copies = readRecoveryCopies(recoveryKey, study.id);
        copies.forEach(copy => { recoveryCopies.current.set(copy.answer.id, copy); unsavedIds.current.add(copy.answer.id); });
        setUnsaved(Object.fromEntries(copies.map(copy => [copy.answer.id, copy.receipt])));
        setAnswers(copies.map(copy => copy.answer).sort((a, b) => b.createdAt - a.createdAt));
      } catch { setRecoveryStorageFailed(true); }
    }
    try {
      const page = await listStudyExplorationsPage(study.id, cursor);
      const saved = page.answers;
      if (live.current) {
        // A successful save whose response was lost is confirmed by the saved artifact,
        // not by a local receipt or persisted citation verdict.
        for (const value of saved) {
          const copy = recoveryCopies.current.get(value.id);
          if (copy && value.status === 'complete' && value.requestFingerprint === copy.answer.requestFingerprint
            && value.scope.sourceFingerprint === copy.answer.scope.sourceFingerprint
            && JSON.stringify(value.result) === JSON.stringify(copy.answer.result)
            && JSON.stringify(value.execution) === JSON.stringify(copy.answer.execution)) {
            recoveryCopies.current.delete(value.id); unsavedIds.current.delete(value.id);
          }
        }
        setUnsaved(Object.fromEntries([...recoveryCopies.current.values()].map(copy => [copy.answer.id, copy.receipt])));
        setRecoveryStorageFailed(!writeRecoveryCopies(recoveryKey, recoveryCopies.current));
        setNextCursor(page.nextCursor);
        setAnswers(previous => [...saved.filter(item => !unsavedIds.current.has(item.id)), ...previous.filter(item => unsavedIds.current.has(item.id) || (!!cursor && !saved.some(value => value.id === item.id)))].sort((a, b) => b.createdAt - a.createdAt));
      }
    }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : 'Saved exploration could not be read.'); }
    finally { if (live.current) setLoading(false); }
  }, [study.id, recoveryKey]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (initialDataset) { setSelection(initialSelection ?? {}); setDataset(initialDataset); } }, [initialSelection, initialDataset]);

  const receive = (response: ExplorationSubmission) => {
    mergeAnswer(response.answer);
    if (response.unsaved) {
      unsavedIds.current.add(response.answer.id);
      recoveryCopies.current.set(response.answer.id, { answer: response.answer, ...(response.saveReceipt ? { receipt: response.saveReceipt } : {}), receiptExpiresAt: Date.now() + RECOVERY_RECEIPT_LIFETIME_MS });
      setUnsaved(previous => ({ ...previous, [response.answer.id]: response.saveReceipt }));
      setRecoveryStorageFailed(!writeRecoveryCopies(recoveryKey, recoveryCopies.current));
    }
    setAttempt(previous => previous ? { ...previous, answerId: response.answer.id, uncertain: response.answer.status === 'running' } : null);
  };

  const submit = async (existing?: { key: string; input: { question: string; selection: DatasetSelection; parentAnswerId?: string } }) => {
    if (disabled || busy) return;
    if (!existing && (!dataset || !dataset.manifest.selectedCount || !question.trim())) return;
    const current = existing ?? { key: crypto.randomUUID(), input: { question: question.trim(), selection, ...(parentAnswerId ? { parentAnswerId } : {}) } };
    setAttempt({ ...current, uncertain: true }); setBusy(true); setError(null);
    try { const response = await askStudyQuestion(study.id, current.input, current.key); if (live.current) receive(response); }
    catch (reason) { if (live.current) { setError(reason instanceof Error ? reason.message : 'The attempt could not be confirmed.'); if (reason instanceof ExplorationApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(reason.status)) setAttempt(null); } }
    finally { if (live.current) setBusy(false); }
  };

  const checkAnswer = async (answerId: string) => {
    setBusy(true); setError(null);
    try { const value = await readStudyExploration(study.id, answerId); if (live.current) { mergeAnswer(value); setAttempt(previous => previous?.answerId === answerId ? { ...previous, uncertain: value.status === 'running' } : previous); } }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : 'This attempt could not be checked.'); }
    finally { if (live.current) setBusy(false); }
  };

  const retrySave = async (answerId: string, receipt: string) => {
    setBusy(true); setError(null);
    try { const saved = await saveStudyExploration(study.id, answerId, receipt); if (live.current) { mergeAnswer(saved); unsavedIds.current.delete(answerId); recoveryCopies.current.delete(answerId); setRecoveryStorageFailed(!writeRecoveryCopies(recoveryKey, recoveryCopies.current)); setUnsaved(previous => { const next = { ...previous }; delete next[answerId]; return next; }); } }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : 'Saving could not be confirmed.'); }
    finally { if (live.current) setBusy(false); }
  };

  return <div className="space-y-6">
    <section><h2 className="font-sans text-[22px] font-semibold text-ink-900">Explore this study</h2><p className="mt-2 max-w-measure text-[15px] text-ink-700">Ask new questions of the saved transcripts, including interviews whose individual analysis is pending or failed. Generated answers are interpretation, never additional interview evidence.</p></section>
    <StudyDatasetSelector studyId={study.id} interviews={interviews} initialSelection={selection} disabled={disabled || busy} onApply={(next, description) => { setSelection(next); setDataset(description); onDatasetApply(next, description); }} />
    <p className="text-[13px] text-ink-500">{`Each question uses the full selected interview context, up to ${MAX_EXPLORATION_SELECTED_INTERVIEWS} interviews and ${MAX_EXPLORATION_CORPUS_BYTES / 1024} KiB. Larger datasets need a narrower selection; nothing is silently sampled.`}</p>
    <section>
      <Field label="Question for these interviews" htmlFor={questionId} hint="One submission starts at most one provider attempt using this study’s configured provider and model."><textarea rows={4} maxLength={MAX_EXPLORATION_QUESTION_CHARS} value={question} onChange={event => setQuestion(event.target.value)} disabled={disabled || busy || !!attempt?.uncertain} className="w-full resize-y" /></Field>
      <details className="mt-2 text-[13px]"><summary className="min-h-11 cursor-pointer py-2 text-action">Question starting points</summary><ul>{SUGGESTIONS.map(suggestion => <li key={suggestion} className="border-t border-ink-300"><Button variant="quiet" className="h-auto text-left" disabled={busy || !!attempt?.uncertain} onClick={() => setQuestion(suggestion)}>{suggestion}</Button></li>)}</ul></details>
      {parentAnswerId && <p className="mt-2 text-[13px] text-ink-500">Continuing from a saved question. The earlier generated answer is not evidence.<Button variant="quiet" onClick={() => setParentAnswerId(undefined)}>Start independently</Button></p>}
      {dataset ? <div className="mt-3"><DatasetCoverage dataset={dataset} /></div> : <p className="mt-3 text-[13px] text-ink-500">Apply a dataset selection before asking a question.</p>}
      <Button variant="primary" className="mt-4" disabled={disabled || busy || !!attempt?.uncertain || !dataset?.manifest.selectedCount || !question.trim()} onClick={() => void submit()}>{busy ? 'Confirming this attempt…' : 'Ask of the selected transcripts'}</Button>
      {attempt?.uncertain && <Notice tone="neutral" role="status" className="mt-4"><p className="text-[13px]">This attempt is not yet confirmed. Check the same attempt; do not automatically start another paid request.</p><Button variant="quiet" disabled={busy || disabled} onClick={() => void (attempt.answerId ? checkAnswer(attempt.answerId) : submit(attempt))}>Check this attempt</Button></Notice>}
      {error && <Notice tone="error" role="status" className="mt-3"><p className="text-[13px]">{error}</p></Notice>}
      {recoveryStorageFailed && <Notice tone="error" role="status" className="mt-3"><p className="text-[13px]">The browser recovery copy could not be stored or read. Any answer still shown remains in memory only. Download unsaved answers before leaving or refreshing this page.</p></Notice>}
    </section>
    <Rule />
    <section><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-sans text-[15px] font-semibold text-ink-900">Study notebook</h3><Button variant="quiet" disabled={loading || busy} onClick={() => void load()}>Refresh saved answers</Button></div>
      <p className="mt-2 text-[13px] text-ink-500">The notebook reads saved answers in pages, newest first. Refresh returns to the latest page and keeps local unsaved answers.</p>
      {loading && <p className="mt-3 text-[13px] text-ink-500">Reading saved answers…</p>}
      {!loading && !answers.length && <p className="mt-3 text-[13px] text-ink-500">No saved questions yet. Refreshing this notebook never calls a provider.</p>}
      {answers.map(value => <article key={value.id} className="mt-6 border-t border-ink-300 pt-5" aria-label={`Answer to ${value.question}`}>
        <h4 className="break-words font-sans text-[17px] font-semibold text-ink-900">{value.question}</h4>
        {Object.hasOwn(unsaved, value.id) && <Notice tone="error" role="status" className="my-4"><p className="text-[13px]">Generated, but saving was not confirmed. Keep a local export. Retrying the save does not send another provider request.</p><p className="mt-2 text-[13px]">The save-only recovery receipt expires after 24 hours and requires your authenticated researcher session. The answer remains exportable after it expires.</p>{unsaved[value.id] && <Button variant="quiet" disabled={busy || disabled} onClick={() => void retrySave(value.id, unsaved[value.id]!)}>Retry saving this answer</Button>}</Notice>}
        <div className="my-4 flex flex-wrap gap-3"><Button variant="quiet" onClick={() => downloadAnswer(value)}>Download answer</Button>{value.status === 'complete' && !Object.hasOwn(unsaved, value.id) && <Button variant="quiet" disabled={busy || !!attempt?.uncertain} onClick={() => { setParentAnswerId(value.id); document.getElementById(questionId)?.focus(); }}>Continue from this question</Button>}{value.status === 'running' && <Button variant="quiet" disabled={busy || disabled} onClick={() => void checkAnswer(value.id)}>Check saved attempt</Button>}{(value.status === 'failed' || value.status === 'recovery-required') && <Button variant="quiet" disabled={busy || disabled || !!attempt?.uncertain} onClick={() => void submit({ key: crypto.randomUUID(), input: { question: value.question, selection: value.scope.selection, ...(value.parentAnswerId ? { parentAnswerId: value.parentAnswerId } : {}) } })}>Start a new paid attempt</Button>}</div>
        <ExplorationAnswerReading answer={value} retainedCount={interviews.length} />
      </article>)}
      {nextCursor && <Button variant="quiet" className="mt-5" disabled={loading || busy} onClick={() => void load(nextCursor)}>Load older saved answers</Button>}
    </section>
  </div>;
}
