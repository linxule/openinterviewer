// Synthetic values shared by the restart runner and its tests. None of these
// is a real credential; the Worker receives them as secret bindings only.
export const SECRETS = Object.freeze({
  ADMIN_PASSWORD: 'restart-lane-admin-password-0001',
  SESSION_SECRET: 'restart-lane-session-secret-00000000000001',
  PARTICIPANT_TOKEN_SECRET: 'restart-lane-participant-secret-0000000001',
  RATE_LIMIT_SALT: 'restart-lane-rate-limit-salt-000000000001',
  OPERATOR_TOKEN: 'restart-lane-operator-token-0000000000000001',
  OPENAI_API_KEY: 'sk-restart-lane-synthetic',
});

/** The study's explicit OpenAI model; the fixture reports serving this snapshot. */
export const STUDY_MODEL = 'gpt-5.6-sol';
export const SERVED_MODEL = 'gpt-5.6-sol-2026-09-01';

/** Lines the runner prints on stdout; everything else it prints is diagnostic. */
export const READY_PREFIX = 'RESTART-RUNNER-READY ';
export const FAILED_PREFIX = 'RESTART-RUNNER-FAILED ';
export const HELD_PREFIX = 'RESTART-RUNNER-HELD ';
