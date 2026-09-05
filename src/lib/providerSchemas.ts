// Provider-neutral JSON Schemas for strict structured output. Every object is
// closed and every property is required. Domain-level optional values are
// represented as explicit nulls so adapters and final validators agree.

export type ProviderJsonSchema = Record<string, unknown>;

const stringArray = {
  type: 'array',
  items: { type: 'string' },
  maxItems: 100,
} as const;

export const interviewResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    questionAddressed: { type: ['integer', 'null'], minimum: 0 },
    phaseTransition: {
      type: ['string', 'null'],
      enum: ['background', 'core-questions', 'exploration', 'feedback', 'wrap-up', null],
    },
    profileUpdates: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fieldId: { type: 'string' },
          value: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['extracted', 'vague', 'refused'] },
        },
        required: ['fieldId', 'value', 'status'],
      },
    },
    shouldConclude: { type: 'boolean' },
  },
  required: [
    'message',
    'questionAddressed',
    'phaseTransition',
    'profileUpdates',
    'shouldConclude',
  ],
} as const satisfies ProviderJsonSchema;

export const synthesisResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    statedPreferences: stringArray,
    revealedPreferences: stringArray,
    themes: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          theme: { type: 'string' },
          frequency: { type: 'number', minimum: 0 },
          evidenceRefs: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                quote: { type: 'string', maxLength: 2000 },
                turnIndex: { type: 'integer', minimum: 1 },
              },
              required: ['quote', 'turnIndex'],
            },
          },
        },
        required: ['theme', 'frequency', 'evidenceRefs'],
      },
    },
    contradictions: stringArray,
    keyInsights: stringArray,
    bottomLine: { type: 'string' },
  },
  required: [
    'statedPreferences',
    'revealedPreferences',
    'themes',
    'contradictions',
    'keyInsights',
    'bottomLine',
  ],
} as const satisfies ProviderJsonSchema;

export const aggregateSynthesisResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commonThemes: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          theme: { type: 'string' },
          frequency: { type: 'number', minimum: 0 },
          quoteRefs: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                interviewIndex: { type: 'integer', minimum: 1 },
                turnIndex: { type: 'integer', minimum: 1 },
                quote: { type: 'string', maxLength: 2000 },
              },
              required: ['interviewIndex', 'turnIndex', 'quote'],
            },
          },
        },
        required: ['theme', 'frequency', 'quoteRefs'],
      },
    },
    divergentViews: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          viewA: { type: 'string' },
          viewB: { type: 'string' },
        },
        required: ['topic', 'viewA', 'viewB'],
      },
    },
    keyFindings: stringArray,
    researchImplications: stringArray,
    bottomLine: { type: 'string' },
  },
  required: [
    'commonThemes',
    'divergentViews',
    'keyFindings',
    'researchImplications',
    'bottomLine',
  ],
} as const satisfies ProviderJsonSchema;

export const followupStudyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    researchQuestion: { type: 'string' },
    coreQuestions: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 50,
    },
  },
  required: ['name', 'researchQuestion', 'coreQuestions'],
} as const satisfies ProviderJsonSchema;
