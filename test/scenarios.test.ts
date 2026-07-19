/**
 * Locally testable conformance logic: every scenario submission is contract-valid
 * (snapshot hashes + control totals verified by the public authority), and the
 * public idempotency/ordering deciders classify our fixtures the way the scenario
 * descriptions claim. No network is required for these.
 */
import {
  calculateBookableOutcomeContentSha256,
  calculateBookableOutcomeSubmissionSha256,
  decideBookableOutcomeOrderingV1,
  decideBookableOutcomeSubmissionReplayV1,
  validateBookableOutcomeSubmissionV1,
  type BookableOutcomeVersionEvidenceV1,
} from '@s360/contracts/app-platform';
import { describe, expect, it } from 'vitest';

import {
  baselineLodgingOutcome,
  cancelledLodgingOutcome,
  deltaFixtures,
  modifiedLodgingOutcome,
} from '../src/fixtures.js';
import { scenarios } from '../src/scenarios.js';

const versionEvidence = async (
  outcome: ReturnType<typeof baselineLodgingOutcome>,
): Promise<BookableOutcomeVersionEvidenceV1> => ({
  externalVersion: outcome.externalVersion ?? null,
  sourceUpdatedAt: outcome.sourceUpdatedAt ?? null,
  contentSha256: await calculateBookableOutcomeContentSha256(outcome),
});

describe('scenario submissions are contract-valid', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name} builds only conformant submissions`, async () => {
      const steps = await scenario.build();
      for (const s of steps) {
        await expect(validateBookableOutcomeSubmissionV1(s.submission)).resolves.toBeDefined();
      }
    });
  }
});

describe('idempotency decider matches scenario expectations', () => {
  it('identical replay is a NO_OP', async () => {
    const submission = deltaFixtures.newLodging();
    const hash = await calculateBookableOutcomeSubmissionSha256(submission);
    expect(decideBookableOutcomeSubmissionReplayV1(hash, hash)).toBe('NO_OP_RETRY');
  });

  it('same key, different content is quarantined', async () => {
    const contentA = await calculateBookableOutcomeSubmissionSha256(deltaFixtures.newLodging());
    const contentB = await calculateBookableOutcomeSubmissionSha256(deltaFixtures.modifyLodging());
    expect(contentA).not.toEqual(contentB);
    expect(decideBookableOutcomeSubmissionReplayV1(contentA, contentB)).toBe('QUARANTINE_IDEMPOTENCY_CONFLICT');
  });

  it('a brand new key is accepted', async () => {
    const hash = await calculateBookableOutcomeSubmissionSha256(deltaFixtures.newLodging());
    expect(decideBookableOutcomeSubmissionReplayV1(null, hash)).toBe('ACCEPT_NEW');
  });
});

describe('ordering decider matches delta scenario expectations', () => {
  it('modify with newer version applies as newer', async () => {
    const base = await versionEvidence(baselineLodgingOutcome());
    const modified = await versionEvidence(modifiedLodgingOutcome());
    expect(decideBookableOutcomeOrderingV1(base, modified)).toBe('APPLY_NEWER');
  });

  it('cancel with newer version applies as newer', async () => {
    const base = await versionEvidence(baselineLodgingOutcome());
    const cancelled = await versionEvidence(cancelledLodgingOutcome());
    expect(decideBookableOutcomeOrderingV1(base, cancelled)).toBe('APPLY_NEWER');
  });

  it('re-applying the identical baseline is a duplicate no-op', async () => {
    const base = await versionEvidence(baselineLodgingOutcome());
    expect(decideBookableOutcomeOrderingV1(base, base)).toBe('NO_OP_DUPLICATE');
  });
});
