/**
 * What pulled you away from a block. The keys are what is stored, and what the CHECK on
 * interruptions.reason in migration 5 allows; the labels are what a person reads. This is
 * the one place the list is written: the route checks a request against it and the stats
 * name each reason from it. The web keeps a mirror in web/src/lib/interruptions.ts, so the
 * two have to change together. Adding a reason also needs a migration, because SQLite
 * cannot alter the CHECK of a table that has shipped.
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

/** The keys alone, in the shape zod's enum wants: a tuple with at least one in it. */
export const INTERRUPTION_REASON_KEYS = INTERRUPTION_REASONS.map((r) => r.key) as [
  InterruptionReason,
  ...InterruptionReason[],
];
