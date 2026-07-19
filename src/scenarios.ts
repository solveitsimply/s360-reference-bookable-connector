/**
 * The BOOKABLE_OUTCOME_SOURCE conformance scenarios, expressed purely in terms
 * of the public submission contract. Each scenario is a sequence of ingress
 * posts plus the server decision the reference connector expects. They are the
 * executable form of the Phase 3 conformance obligations:
 *
 *   - baseline complete snapshot (incl. an authoritative empty result)
 *   - webhook-style deltas: new / modify / cancel
 *   - replay of the same submission key (expect NO_OP)
 *   - same key, different content (expect 409 quarantine)
 *   - cross-installation isolation (documented; needs two installations)
 */
import {
  type BookableOutcomeSubmissionV1,
} from '@s360/contracts/app-platform';

import { BookableOutcomeConnectorClient, operationForSubmission, type IngressOperation, type IngressResult } from './client.js';
import {
  baselineAppointmentOutcome,
  baselineLodgingOutcome,
  buildSnapshotSubmission,
  deltaFixtures,
  modifiedLodgingOutcome,
} from './fixtures.js';

export interface ScenarioStep {
  label: string;
  submission: BookableOutcomeSubmissionV1;
  operation: IngressOperation;
  /** Human-readable server decision this reference connector expects. */
  expect: string;
}

export interface Scenario {
  name: string;
  description: string;
  /** False when the scenario documents behaviour that needs >1 installation. */
  liveExecutable: boolean;
  build: () => Promise<ScenarioStep[]>;
  notes?: string;
}

const step = (label: string, submission: BookableOutcomeSubmissionV1, expect: string): ScenarioStep => ({
  label,
  submission,
  operation: operationForSubmission(submission),
  expect,
});

/** Re-key a delta submission while keeping its outcome content. */
const rekeyDelta = (submissionKey: string, source: ReturnType<typeof deltaFixtures.newLodging>): BookableOutcomeSubmissionV1 => ({
  ...source,
  submissionKey,
});

export const scenarios: Record<string, Scenario> = {
  'baseline-snapshot': {
    name: 'baseline-snapshot',
    description: 'Complete RETAIN_MISSING snapshot with a lodging reservation and a professional appointment.',
    liveExecutable: true,
    build: async () => [
      step(
        'mixed complete snapshot',
        await buildSnapshotSubmission('conformance/snapshot/mixed', 'conformance/mixed', 'RETAIN_MISSING', [
          baselineLodgingOutcome(),
          baselineAppointmentOutcome(),
        ]),
        'ACCEPT_NEW; plan creates/links both outcomes; control totals verified',
      ),
    ],
  },
  'authoritative-empty-snapshot': {
    name: 'authoritative-empty-snapshot',
    description: 'Authoritative empty CANCEL_MISSING snapshot — an empty result is a valid tombstone signal, not a partial page.',
    liveExecutable: true,
    build: async () => [
      step(
        'empty complete snapshot',
        await buildSnapshotSubmission('conformance/snapshot/empty', 'conformance/empty', 'CANCEL_MISSING', []),
        'ACCEPT_NEW; authoritative empty result accepted (missing outcomes may be cancelled per absenceSemantics)',
      ),
    ],
  },
  'delta-new': {
    name: 'delta-new',
    description: 'Webhook-style delta introducing a new confirmed lodging reservation.',
    liveExecutable: true,
    build: async () => [step('new lodging delta', deltaFixtures.newLodging(), 'ACCEPT_NEW; plan action CREATE')],
  },
  'delta-modify': {
    name: 'delta-modify',
    description: 'Webhook-style delta modifying the same reservation with newer version/ordering evidence.',
    liveExecutable: true,
    build: async () => [
      step('new lodging delta', deltaFixtures.newLodging(), 'ACCEPT_NEW; plan action CREATE'),
      step('modify lodging delta', deltaFixtures.modifyLodging(), 'ACCEPT_NEW; ordering decision APPLY_NEWER (UPDATE)'),
    ],
  },
  'delta-cancel': {
    name: 'delta-cancel',
    description: 'Webhook-style delta cancelling the reservation (carries required sourceUpdatedAt ordering evidence).',
    liveExecutable: true,
    build: async () => [
      step('new lodging delta', deltaFixtures.newLodging(), 'ACCEPT_NEW; plan action CREATE'),
      step('cancel lodging delta', deltaFixtures.cancelLodging(), 'ACCEPT_NEW; plan action CANCEL (owned record only)'),
    ],
  },
  'replay-noop': {
    name: 'replay-noop',
    description: 'Replaying the identical submission key with identical content is a NO_OP retry.',
    liveExecutable: true,
    build: async () => {
      const first = deltaFixtures.newLodging();
      return [
        step('first submit', first, 'ACCEPT_NEW'),
        step('identical replay (same key, same content)', { ...first }, 'NO_OP_RETRY; prior outcome returned, no duplicate'),
      ];
    },
  },
  'idempotency-conflict': {
    name: 'idempotency-conflict',
    description: 'Same submission key with different content must be quarantined and rejected with HTTP 409.',
    liveExecutable: true,
    build: async () => {
      const collisionKey = 'conformance/idempotency/collision';
      const contentA = rekeyDelta(collisionKey, deltaFixtures.newLodging());
      const contentB: BookableOutcomeSubmissionV1 = {
        ...rekeyDelta(collisionKey, deltaFixtures.newLodging()),
        mode: 'DELTA',
        outcomes: [modifiedLodgingOutcome()],
      };
      return [
        step('submit content A', contentA, 'ACCEPT_NEW'),
        step('submit content B under the same key', contentB, 'QUARANTINE_IDEMPOTENCY_CONFLICT; HTTP 409'),
      ];
    },
  },
  'cross-installation-isolation': {
    name: 'cross-installation-isolation',
    description:
      'Two sibling installations may submit overlapping external keys with different credentials; neither may read, mutate, reconcile, cancel or uninstall the other. Requires a second installation grant, so it is documented rather than executed by a single-credential run.',
    liveExecutable: false,
    notes:
      'Provision a second installation (its own s360_inst_at_ token). Submit deltaFixtures.newLodging() through BOTH clients. Each server-derived source identity (teamIntegration + externalOutcomeKey) differs, so the same external key yields two independent outcomes with no cross-read or cross-cancel. Verified end-to-end only once a second grant is seeded.',
    build: async () => [],
  },
};

export interface ScenarioRunResult {
  scenario: string;
  liveExecutable: boolean;
  steps: Array<{ label: string; expect: string; result?: IngressResult; skipped?: string }>;
}

/** Execute a scenario against a live ingress (used by the Lambda /run route). */
export const runScenario = async (
  client: BookableOutcomeConnectorClient,
  name: string,
): Promise<ScenarioRunResult> => {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`Unknown scenario: ${name}`);
  const built = await scenario.build();
  const steps: ScenarioRunResult['steps'] = [];
  for (const s of built) {
    if (!scenario.liveExecutable) {
      steps.push({ label: s.label, expect: s.expect, skipped: 'requires additional installation grant' });
      continue;
    }
    const result = await client.postSubmission(s.submission, s.operation);
    steps.push({ label: s.label, expect: s.expect, result });
  }
  return { scenario: name, liveExecutable: scenario.liveExecutable, steps };
};

export const scenarioNames = (): string[] => Object.keys(scenarios);
