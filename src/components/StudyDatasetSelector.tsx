'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { StoredInterview } from '@/types';
import type { DatasetDescription, DatasetSelection, RecordedProfileFilter } from '@/lib/exploration/types';
import { describeStudyDataset } from '@/services/explorationApi';
import { Button, Coordinate, Field, Label, Notice } from '@/components/ui';
import { shortInterviewId } from '@/lib/interviewId';

export function DatasetCoverage({ dataset }: { dataset: DatasetDescription }) {
  const scope = dataset.manifest;
  return <div className="space-y-1 text-[13px] text-ink-700" aria-live="polite">
    <Coordinate className="block">{`${scope.selectedCount} selected · ${scope.totalSaved} retained · ${scope.excludedCount} excluded`}</Coordinate>
    <p>{`${scope.unknownProfileCount} unknown for the profile filters · ${scope.pendingAnalysisCount} selected without complete individual analysis`}</p>
    {dataset.historicalProfileUnknownCount > 0 && <p>{`${dataset.historicalProfileUnknownCount} retained interviews lack their original profile definitions. Historical labels are not reconstructed.`}</p>}
    {!!dataset.ambiguousProfileFieldIds?.length && <p>Some profile fields changed meaning between revisions. Select a narrower revision to filter these fields.</p>}
  </div>;
}

interface FilterDraft { fieldId: string; operator: RecordedProfileFilter['operator']; value: string; minimum: string; maximum: string }

export function StudyDatasetSelector({ studyId, interviews, initialSelection = {}, onApply, disabled = false }: {
  studyId: string;
  interviews: StoredInterview[];
  initialSelection?: DatasetSelection;
  onApply: (selection: DatasetSelection, dataset: DatasetDescription) => void;
  disabled?: boolean;
}) {
  const prefix = useId();
  const [dataset, setDataset] = useState<DatasetDescription | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allRevisions, setAllRevisions] = useState(initialSelection.revisions === undefined);
  const [revisions, setRevisions] = useState<number[]>(initialSelection.revisions ?? []);
  const [allInterviews, setAllInterviews] = useState(initialSelection.interviewIds === undefined);
  const [ids, setIds] = useState<string[]>(initialSelection.interviewIds ?? []);
  const [filters, setFilters] = useState<RecordedProfileFilter[]>(initialSelection.filters ?? []);
  const [filter, setFilter] = useState<FilterDraft>({ fieldId: '', operator: 'equals', value: '', minimum: '', maximum: '' });
  const generation = useRef(0);
  const selectionKey = JSON.stringify(initialSelection);

  useEffect(() => {
    const applied = JSON.parse(selectionKey) as DatasetSelection;
    setAllRevisions(applied.revisions === undefined); setRevisions(applied.revisions ?? []);
    setAllInterviews(applied.interviewIds === undefined); setIds(applied.interviewIds ?? []);
    setFilters(applied.filters ?? []);
  }, [selectionKey]);

  useEffect(() => {
    const request = ++generation.current;
    setLoading(true);
    void describeStudyDataset(studyId).then(value => {
      if (generation.current === request) { setDataset(value); setError(null); }
    }).catch(reason => {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : 'The dataset could not be read.');
    }).finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current += 1; };
  }, [studyId]);

  const apply = async () => {
    const selection: DatasetSelection = {
      ...(!allRevisions ? { revisions } : {}),
      ...(!allInterviews ? { interviewIds: ids } : {}),
      ...(filters.length > 0 ? { filters } : {}),
    };
    const request = ++generation.current;
    setApplying(true); setError(null);
    try {
      const value = await describeStudyDataset(studyId, selection);
      if (generation.current !== request) return;
      setDataset(value); onApply(selection, value);
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : 'This selection could not be confirmed.');
    } finally { if (generation.current === request) setApplying(false); }
  };

  const addFilter = () => {
    if (!filter.fieldId) { setError('Choose a recorded profile field first.'); return; }
    let next: RecordedProfileFilter;
    if (filter.operator === 'number-between') {
      const minimum = Number(filter.minimum); const maximum = Number(filter.maximum);
      if (!filter.minimum.trim() || !filter.maximum.trim() || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) { setError('Enter an inclusive numeric range with the minimum no greater than the maximum.'); return; }
      next = { fieldId: filter.fieldId, operator: 'number-between', minimum, maximum };
    } else if (filter.operator === 'one-of') {
      const values = [...new Set(filter.value.split(',').map(value => value.trim()).filter(Boolean))];
      if (!values.length) { setError('Enter at least one recorded value.'); return; }
      next = { fieldId: filter.fieldId, operator: 'one-of', values };
    } else {
      if (!filter.value.trim()) { setError('Enter a recorded value.'); return; }
      next = { fieldId: filter.fieldId, operator: 'equals', value: filter.value.trim() };
    }
    setFilters(previous => [...previous.filter(entry => entry.fieldId !== next.fieldId), next]); setError(null); setFilter(previous => ({ ...previous, value: '', minimum: '', maximum: '' }));
  };

  const blocked = disabled || applying || loading;
  const toggle = <T,>(current: T[], value: T) => current.includes(value) ? current.filter(item => item !== value) : [...current, value];
  return <section className="border-y border-ink-300 py-4" aria-label="Research dataset">
    <h3 className="font-sans text-[15px] font-semibold text-ink-900">Choose the research dataset</h3>
    <p className="mt-2 max-w-measure text-[13px] text-ink-700">Only saved interviews in this study are evidence. Filters use recorded values; missing, vague and refused values remain unknown. Changes take effect only after you apply them to confirm coverage. Coverage is checked again when you ask; each answer records the exact sources used.</p>
    {loading ? <p className="mt-3 text-[13px] text-ink-500">Reading dataset…</p> : dataset && <>
      <fieldset disabled={blocked} className="mt-4 space-y-2">
        <legend><Label>Collection revisions</Label></legend>
        <label className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={allRevisions} onChange={event => setAllRevisions(event.target.checked)} />All retained revisions, including unrecorded revisions</label>
        {!allRevisions && <div className="flex flex-wrap gap-x-5 gap-y-2">{dataset.revisions.filter(entry => entry.revision !== null).map(entry => <label key={entry.revision} className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={revisions.includes(entry.revision!)} onChange={() => setRevisions(previous => toggle(previous, entry.revision!))} />{`Revision ${entry.revision} · ${entry.count} saved · ${entry.analyzedCount} analyzed`}</label>)}</div>}
      </fieldset>
      <fieldset disabled={blocked} className="mt-4 space-y-2">
        <legend><Label>Interview selection</Label></legend>
        <label className="flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={allInterviews} onChange={event => setAllInterviews(event.target.checked)} />All interviews in the chosen revisions</label>
        {!allInterviews && <div className="max-h-60 overflow-y-auto">{interviews.map(interview => <label key={interview.id} className="flex min-h-11 items-center gap-2 border-t border-ink-300 text-[13px]"><input type="checkbox" checked={ids.includes(interview.id)} onChange={() => setIds(previous => toggle(previous, interview.id))} /><Coordinate>{shortInterviewId(interview.id)}</Coordinate>{`revision ${interview.studyRevision ?? 'unrecorded'}`}</label>)}</div>}
      </fieldset>
      <fieldset disabled={blocked} className="mt-4">
        <legend><Label>Recorded profile filters</Label></legend>
        <p className="mt-2 text-[13px] text-ink-500">All added filters must match. Numeric ranges include both boundaries and do not infer a number from ambiguous responses.</p>
        {filters.length > 0 && <ul className="mt-2">{filters.map((entry, index) => <li key={index} className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-300 py-2 text-[13px]"><span>{`${entry.fieldId}: ${entry.operator === 'equals' ? entry.value : entry.operator === 'one-of' ? entry.values.join(', ') : `${entry.minimum}–${entry.maximum}`}`}</span><Button variant="quiet" onClick={() => setFilters(previous => previous.filter((_, item) => item !== index))}>Remove filter {index + 1}</Button></li>)}</ul>}
        {dataset.profileFields.length > 0 ? <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Recorded field" htmlFor={`${prefix}-field`}><select className="mt-2 w-full min-w-0" value={filter.fieldId} onChange={event => setFilter(previous => ({ ...previous, fieldId: event.target.value }))}><option value="">Choose a field</option>{dataset.profileFields.map(field => <option key={field.id} value={field.id}>{`${field.label} (${field.id})`}</option>)}</select></Field>
          <Field label="Match" htmlFor={`${prefix}-operator`}><select className="mt-2 w-full min-w-0" value={filter.operator} onChange={event => setFilter(previous => ({ ...previous, operator: event.target.value as FilterDraft['operator'] }))}><option value="equals">Equals recorded value</option><option value="one-of">One of the recorded values</option><option value="number-between">Inclusive numeric range</option></select></Field>
          {filter.operator === 'number-between' ? <><Field label="Minimum" htmlFor={`${prefix}-minimum`}><input className="mt-2 w-full min-w-0" type="number" value={filter.minimum} onChange={event => setFilter(previous => ({ ...previous, minimum: event.target.value }))} /></Field><Field label="Maximum" htmlFor={`${prefix}-maximum`}><input className="mt-2 w-full min-w-0" type="number" value={filter.maximum} onChange={event => setFilter(previous => ({ ...previous, maximum: event.target.value }))} /></Field></> : <Field label={filter.operator === 'one-of' ? 'Recorded values, separated by commas' : 'Recorded value'} htmlFor={`${prefix}-value`} className="sm:col-span-2"><input className="mt-2 w-full min-w-0" value={filter.value} onChange={event => setFilter(previous => ({ ...previous, value: event.target.value }))} /></Field>}
          <Button variant="quiet" onClick={addFilter} className="justify-self-start">Add profile filter</Button>
        </div> : <p className="mt-2 text-[13px] text-ink-500">No compatible original profile definitions are available for filtering. Conflicting definitions across revisions are omitted; demographics are not inferred.</p>}
      </fieldset>
      <Button variant="primary" onClick={() => void apply()} disabled={blocked} className="mt-4">{applying ? 'Confirming dataset…' : 'Apply dataset selection'}</Button>
      <div className="mt-4"><DatasetCoverage dataset={dataset} /></div>
    </>}
    {error && <Notice tone="error" role="status" className="mt-3"><p className="text-[13px]">{error}</p><p className="mt-1 text-[13px]">Narrow the revisions, interviews or filters if the selection is too large. No selection is silently truncated.</p></Notice>}
  </section>;
}
