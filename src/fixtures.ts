/**
 * Synthetic, deterministic BOOKABLE_OUTCOME_SOURCE payloads.
 *
 * Everything here derives from the PUBLIC `@s360/contracts/app-platform`
 * conformance fixtures and helpers. This connector never imports an internal
 * Simply360 path, reads a database, or touches real provider/customer data.
 * The `no-internal-imports` ratchet enforces that at build time.
 */
import {
  BOOKABLE_OUTCOME_SOURCE_SCHEMA_VERSION,
  createBookableOutcomeAppointmentConformanceFixtureV1,
  createBookableOutcomeLodgingConformanceFixtureV1,
  buildBookableOutcomeSnapshotControlTotalsV1,
  calculateBookableOutcomeSnapshotOutcomesSha256,
  type BookableOutcomeEnvelopeV1,
  type BookableOutcomeSubmissionV1,
} from '@s360/contracts/app-platform';

export type DeltaSubmission = Extract<BookableOutcomeSubmissionV1, { mode: 'DELTA' }>;
export type SnapshotSubmission = Extract<BookableOutcomeSubmissionV1, { mode: 'COMPLETE_SNAPSHOT' }>;

/** The baseline lodging reservation, exactly as published for conformance. */
export const baselineLodgingOutcome = (): BookableOutcomeEnvelopeV1 => createBookableOutcomeLodgingConformanceFixtureV1();

/** The baseline non-lodging (professional appointment) outcome. */
export const baselineAppointmentOutcome = (): BookableOutcomeEnvelopeV1 =>
  createBookableOutcomeAppointmentConformanceFixtureV1();

/**
 * A "modify" of the baseline lodging reservation: newer version + ordering
 * evidence and a changed party/commercial fact, so the core ordering decider
 * treats it as APPLY_NEWER rather than a duplicate.
 */
export const modifiedLodgingOutcome = (): BookableOutcomeEnvelopeV1 => {
  const base = baselineLodgingOutcome();
  return {
    ...base,
    externalVersion: 'provider-revision-9',
    observedAt: '2026-07-18T13:00:00.000Z',
    sourceUpdatedAt: '2026-07-18T12:59:00.000Z',
    lifecycle: 'MODIFIED',
    partyFacts: {
      totalCount: 3,
      categories: [
        { categoryKey: 'adult', count: 2 },
        { categoryKey: 'child', count: 1 },
      ],
    },
    commercialFacts: {
      ...(base.commercialFacts ?? {
        currencyCode: 'GBP',
        totalAmountMinorUnits: 42_500,
        providerReportedPaymentStatus: 'UNKNOWN',
      }),
      totalAmountMinorUnits: 51_000,
    },
  };
};

/**
 * A provider "cancel" of the baseline lodging reservation. Cancellations are
 * required by the contract to carry `sourceUpdatedAt` ordering evidence.
 */
export const cancelledLodgingOutcome = (): BookableOutcomeEnvelopeV1 => {
  const base = baselineLodgingOutcome();
  return {
    ...base,
    externalVersion: 'provider-revision-12',
    observedAt: '2026-07-18T14:00:00.000Z',
    sourceUpdatedAt: '2026-07-18T13:59:00.000Z',
    lifecycle: 'CANCELLED',
  };
};

const deltaSubmission = (submissionKey: string, outcomes: BookableOutcomeEnvelopeV1[]): DeltaSubmission => ({
  schemaVersion: BOOKABLE_OUTCOME_SOURCE_SCHEMA_VERSION,
  submissionKey,
  mode: 'DELTA',
  outcomes,
});

/**
 * Build a COMPLETE_SNAPSHOT submission whose manifest hash + control totals are
 * computed with the same public authority the core validator uses, so the
 * connector never duplicates canonical hashing logic.
 */
export const buildSnapshotSubmission = async (
  submissionKey: string,
  snapshotKey: string,
  absenceSemantics: SnapshotSubmission['manifest']['absenceSemantics'],
  outcomes: BookableOutcomeEnvelopeV1[],
): Promise<SnapshotSubmission> => ({
  schemaVersion: BOOKABLE_OUTCOME_SOURCE_SCHEMA_VERSION,
  submissionKey,
  mode: 'COMPLETE_SNAPSHOT',
  outcomes,
  manifest: {
    snapshotKey,
    generatedAt: '2026-07-18T12:10:00.000Z',
    absenceSemantics,
    outcomesSha256: await calculateBookableOutcomeSnapshotOutcomesSha256(outcomes),
    controlTotals: buildBookableOutcomeSnapshotControlTotalsV1(outcomes),
  },
});

export const deltaFixtures = {
  newLodging: () => deltaSubmission('conformance/delta/lodging-new', [baselineLodgingOutcome()]),
  modifyLodging: () => deltaSubmission('conformance/delta/lodging-modify', [modifiedLodgingOutcome()]),
  cancelLodging: () => deltaSubmission('conformance/delta/lodging-cancel', [cancelledLodgingOutcome()]),
  newAppointment: () => deltaSubmission('conformance/delta/appointment-new', [baselineAppointmentOutcome()]),
};
