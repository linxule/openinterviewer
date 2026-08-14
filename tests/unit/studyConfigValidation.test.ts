import { describe, expect, it } from 'vitest';
import {
  readStudyMutationBody,
  STUDY_MUTATION_MAX_BYTES,
  validateStudyConfig,
  validateStudyConfigForCreate,
  validateStudyConfigUpdate,
} from '@/lib/studyConfigValidation';
import { makeStudyConfig } from '../fixtures/models';

describe('validateStudyConfig', () => {
  it('accepts a complete bounded configuration', () => {
    const config = makeStudyConfig({
      linksEnabled: true,
      linkExpiration: '30days',
      enableReasoning: false,
    });

    expect(validateStudyConfig(config)).toEqual({ ok: true, config });
  });

  it('rejects unknown top-level and nested profile fields', () => {
    expect(validateStudyConfig({
      ...makeStudyConfig(),
      injected: true,
    })).toMatchObject({ ok: false });

    const config = makeStudyConfig();
    expect(validateStudyConfig({
      ...config,
      profileSchema: [{ ...config.profileSchema[0], injected: true }],
    })).toMatchObject({ ok: false, error: 'Invalid profile schema' });
  });

  it('bounds required strings, arrays, and nested profile values', () => {
    expect(validateStudyConfig(makeStudyConfig({ name: ' ' }))).toMatchObject({ ok: false });
    expect(validateStudyConfig(makeStudyConfig({
      coreQuestions: Array.from({ length: 51 }, () => 'Question?'),
    }))).toMatchObject({ ok: false });
    expect(validateStudyConfig(makeStudyConfig({
      profileSchema: [{
        id: 'role',
        label: 'Role',
        extractionHint: 'Role hint',
        required: true,
        options: Array.from({ length: 21 }, (_, index) => `Option ${index}`),
      }],
    }))).toMatchObject({ ok: false, error: 'Invalid profile schema' });
    expect(validateStudyConfig(makeStudyConfig({
      profileSchema: [
        { id: 'role', label: 'Role', extractionHint: 'Role hint', required: true },
        { id: 'role', label: 'Duplicate', extractionHint: 'Duplicate ID', required: false },
      ],
    }))).toMatchObject({ ok: false, error: 'Invalid profile schema' });
  });

  it('enforces provider/model compatibility and enums', () => {
    expect(validateStudyConfig(makeStudyConfig({
      aiProvider: 'claude',
      aiModel: 'gemini-2.5-flash',
    }))).toMatchObject({
      ok: false,
      error: 'AI model is not compatible with the selected provider',
    });
    expect(validateStudyConfig(makeStudyConfig({
      aiProvider: 'gemini',
      aiModel: 'unlisted-model',
    }))).toMatchObject({ ok: false });
    expect(validateStudyConfig({
      ...makeStudyConfig(),
      linkExpiration: 'tomorrow',
    })).toMatchObject({ ok: false, error: 'Invalid link expiration' });
    expect(validateStudyConfig({
      ...makeStudyConfig(),
      aiBehavior: 'unbounded',
    })).toMatchObject({ ok: false, error: 'Invalid AI behavior' });
  });

  it('requires bounded server IDs and timestamps', () => {
    expect(validateStudyConfig(makeStudyConfig({ id: '../study' }))).toMatchObject({
      ok: false,
      error: 'Invalid study ID',
    });
    expect(validateStudyConfig(makeStudyConfig({ createdAt: Number.MAX_SAFE_INTEGER + 1 }))).toMatchObject({
      ok: false,
      error: 'Invalid study creation timestamp',
    });
  });
});

describe('server-owned StudyConfig fields', () => {
  it('replaces create placeholders before strict validation', () => {
    const input = makeStudyConfig({ id: '../client-value', createdAt: -1 });
    const result = validateStudyConfigForCreate(input, { id: 'server-id', createdAt: 123 });

    expect(result).toMatchObject({
      ok: true,
      config: { id: 'server-id', createdAt: 123 },
    });
  });

  it('rejects update attempts to change server-owned identity', () => {
    const current = makeStudyConfig({ id: 'server-id', createdAt: 123 });

    expect(validateStudyConfigUpdate(current, { id: 'other-id' }, undefined)).toMatchObject({
      ok: false,
      error: 'Study ID is server-owned and cannot be changed',
    });
    expect(validateStudyConfigUpdate(current, { createdAt: 456 }, undefined)).toMatchObject({
      ok: false,
      error: 'Study creation timestamp is server-owned and cannot be changed',
    });
  });

  it('merges partial edits, ignores embedded link status, and validates the result', () => {
    const current = makeStudyConfig({
      id: 'server-id',
      createdAt: 123,
      linksEnabled: false,
    });
    const result = validateStudyConfigUpdate(current, {
      name: 'Updated study',
      linksEnabled: true,
    }, undefined);

    expect(result).toMatchObject({
      ok: true,
      config: { name: 'Updated study', linksEnabled: false },
    });
    expect(validateStudyConfigUpdate(current, { injected: true }, undefined)).toMatchObject({
      ok: false,
      error: 'Invalid study configuration fields',
    });
  });
});

describe('readStudyMutationBody', () => {
  it('accepts only the operation-specific top-level fields', async () => {
    const createRequest = new Request('http://localhost/api/studies', {
      method: 'POST',
      body: JSON.stringify({ config: makeStudyConfig() }),
    });
    await expect(readStudyMutationBody(createRequest, 'create')).resolves.toMatchObject({
      ok: true,
      body: { config: expect.any(Object) },
    });

    const unknownFieldRequest = new Request('http://localhost/api/studies', {
      method: 'POST',
      body: JSON.stringify({ config: makeStudyConfig(), confirmed: true }),
    });
    await expect(readStudyMutationBody(unknownFieldRequest, 'create')).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Invalid request body fields',
    });
  });

  it('rejects invalid control types and oversized JSON before parsing', async () => {
    const invalidControlRequest = new Request('http://localhost/api/studies/id', {
      method: 'PUT',
      body: JSON.stringify({ linksEnabled: 'yes' }),
    });
    await expect(readStudyMutationBody(invalidControlRequest, 'update')).resolves.toMatchObject({
      ok: false,
      status: 400,
    });

    const oversizedRequest = new Request('http://localhost/api/studies', {
      method: 'POST',
      headers: { 'Content-Length': String(STUDY_MUTATION_MAX_BYTES + 1) },
      body: '{}',
    });
    await expect(readStudyMutationBody(oversizedRequest, 'create')).resolves.toEqual({
      ok: false,
      status: 413,
      error: 'Request body is too large',
    });
  });
});
