import { collector, fail, inputText, labelled, type ImportedTranscript } from './types';

function timestamp(value: string, srt: boolean): number {
  const pattern = srt ? /^(\d{2,}):(\d{2}):(\d{2}),(\d{3})$/ : /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/;
  const match = pattern.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) fail('MALFORMED_INPUT');
  const result = ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(result)) fail('MALFORMED_INPUT');
  return result;
}

function parse(input: string | Uint8Array, srt: boolean): ImportedTranscript {
  const text = inputText(input);
  const blocks = text.replace(/\n+$/, '').split(/\n[ \t]*\n/);
  const out = collector();
  if (!srt) {
    const header = blocks.shift()?.split('\n') ?? [];
    if (!/^WEBVTT(?:[ \t].*)?$/.test(header[0] ?? '') || header.some(line => line.includes('-->'))) fail('MALFORMED_INPUT');
    if (header.length > 1) out.warnings.add('VTT_METADATA_IGNORED');
  }
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (!srt && /^(?:NOTE(?:[ \t]|$)|STYLE$|REGION$)/.test(lines[0])) {
      out.warnings.add('VTT_METADATA_IGNORED');
      continue;
    }
    if (srt) {
      if (!/^\d+$/.test(lines.shift() ?? '')) fail('MALFORMED_INPUT');
    } else if (!lines[0].includes('-->')) lines.shift(); // optional cue identifier
    const timing = /^(\S+) --> (\S+)(?:[ \t]+(.+))?$/.exec(lines.shift() ?? '');
    if (!timing || (srt && timing[3])) fail('MALFORMED_INPUT');
    if (timing[3]) out.warnings.add('VTT_SETTINGS_IGNORED');
    const startMs = timestamp(timing[1], srt);
    const endMs = timestamp(timing[2], srt);
    if (endMs <= startMs) fail('MALFORMED_INPUT');
    const payload = lines.join('\n');
    // Multiple voices per cue are ambiguous: refuse rather than attribute to one.
    const voice = !srt && /^<v(?:\.[\w-]+)*[ \t]+([^<>\n]+)>([\s\S]*?)(?:<\/v>)?$/.exec(payload);
    if (!srt && /<\/?v(?:[\s.>])/.test(payload) && (!voice || /<\/?v(?:[\s.>])/.test(voice[2]))) fail('MALFORMED_INPUT');
    const turn = voice ? { speaker: voice[1].trim(), text: voice[2] } : labelled(payload);
    // Preserve all other markup literally, including injection-looking strings.
    // Decode only the six WebVTT escapes, after recognizing voice syntax.
    if (!srt) {
      const escapes: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };
      turn.text = turn.text.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, key: string) => escapes[key]);
      turn.speaker = turn.speaker.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, key: string) => escapes[key]);
    }
    if (/<[^>]+>/.test(turn.text)) out.warnings.add('LITERAL_MARKUP_PRESERVED');
    if (!voice && turn.speaker !== 'Unknown') out.warnings.add('SPEAKER_LABELS_INFERRED');
    out.add({ ...turn, startMs, endMs });
  }
  return out.finish();
}
export function parseWebVtt(input: string | Uint8Array): ImportedTranscript { return parse(input, false); }
export function parseSrt(input: string | Uint8Array): ImportedTranscript { return parse(input, true); }
