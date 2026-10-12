/**
 * What pulled you away from a block: a mirror of INTERRUPTION_REASONS in
 * server/src/lib/interruptions.ts, which is the list that counts. The keys are what the API
 * takes and returns and the labels are what the screen says, so the two lists have to change
 * together.
 */
export const INTERRUPTION_REASONS = [
  { key: 'chat', label: 'Slack / chat' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'person', label: 'Someone stopped by' },
  { key: 'phone', label: 'Phone call' },
  { key: 'email', label: 'Email' },
  { key: 'other', label: 'Something else' },
] as const;

export type InterruptionReason = (typeof INTERRUPTION_REASONS)[number]['key'];
