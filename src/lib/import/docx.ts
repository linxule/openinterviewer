import { documentXml } from './docxZip';
import { paragraphs } from './docxXml';
import { fail, TranscriptImportError, type ImportedTranscript } from './types';

export async function parseDocx(bytes: Uint8Array): Promise<ImportedTranscript> {
  try { return paragraphs(await documentXml(bytes)); }
  catch (error) {
    if (error instanceof TranscriptImportError) throw error;
    return fail('MALFORMED_INPUT');
  }
}
