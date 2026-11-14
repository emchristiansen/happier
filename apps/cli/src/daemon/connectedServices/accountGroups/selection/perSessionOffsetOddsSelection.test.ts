import { describe, expect, it } from 'vitest';

import scenarioFixtures from './__fixtures__/perSessionOffsetOddsScenarios.json';
import {
  computePerSessionOffsetOddsProbabilities,
  drawPerSessionOffsetOddsCandidate,
  type PerSessionOffsetOddsCandidateInput,
} from './perSessionOffsetOddsSelection';

const defaults = { temperature: 1.5, offsetPercent: 10, softSwitchRemainingPercent: 15 } as const;

function unreserved(scores: ReadonlyArray<number>): PerSessionOffsetOddsCandidateInput[] {
  return scores.map((score, index) => ({ profileId: `m${index}`, remainingPercent: score, reservationCount: 0 }));
}

function probabilityVector(scores: ReadonlyArray<number>, counts?: ReadonlyArray<number>, overrides?: Partial<typeof defaults>) {
  const candidates = scores.map((score, index) => ({
    profileId: `m${index}`,
    remainingPercent: score,
    reservationCount: counts?.[index] ?? 0,
  }));
  const result = computePerSessionOffsetOddsProbabilities({ candidates, ...defaults, ...overrides });
  return candidates.map((candidate) => result.probabilityByProfileId.get(candidate.profileId) ?? 0);
}

describe('per-session offset-odds probabilities (T3, T22, T23)', () => {
  it.each(scenarioFixtures.scenarios.map((scenario) => [scenario.id, scenario] as const))(
    'matches the approved simulation vector for scenario %s within 1e-9',
    (_id, scenario) => {
      const vector = probabilityVector(scenario.scores);
      expect(vector).toHaveLength(scenario.probabilities.length);
      vector.forEach((probability, index) => {
        expect(Math.abs(probability - scenario.probabilities[index]!)).toBeLessThanOrEqual(1e-9);
      });
    },
  );

  it('reproduces the full-precision F1 boundary probabilities with zero reservation counts', () => {
    const f1 = scenarioFixtures.scenarios.find((scenario) => scenario.id === 'F1')!;
    for (const [fraction, expected] of Object.entries(scenarioFixtures.f1BoundaryFreshProbability)) {
      const scores = [...f1.scores.slice(0, -1), Number(fraction) * 100];
      const vector = probabilityVector(scores);
      expect(Math.abs(vector[vector.length - 1]! - expected)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('sums to one and keeps a completely fresh unreserved member finite', () => {
    const result = computePerSessionOffsetOddsProbabilities({ candidates: unreserved([100, 50]), ...defaults });
    const total = [...result.probabilityByProfileId.values()].reduce((sum, value) => sum + value, 0);
    expect(Math.abs(total - 1)).toBeLessThanOrEqual(1e-12);
    const fresh = result.trace.find((entry) => entry.profileId === 'm0')!;
    expect(fresh.weight).toBeCloseTo((100 / 10) ** (1 / 1.5), 12);
    expect(Number.isFinite(fresh.weight)).toBe(true);
  });

  it('applies reservation counts to the adjusted score', () => {
    const result = computePerSessionOffsetOddsProbabilities({
      candidates: [{ profileId: 'fresh', remainingPercent: 100, reservationCount: 1 }],
      ...defaults,
    });
    expect(result.trace[0]!.adjustedRemainingPercent).toBe(50);
    expect(result.trace[0]!.weight).toBeCloseTo((50 / 60) ** (1 / 1.5), 12);
    expect(probabilityVector([60, 60], [0, 1])).toEqual([
      expect.closeTo(0.6846951757131877, 12),
      expect.closeTo(0.3153048242868123, 12),
    ]);
  });

  it('gives equal adjusted scores equal probability regardless of observed scores', () => {
    const vector = probabilityVector([100, 50], [1, 0], { offsetPercent: 1e-9 });
    expect(vector[0]).toBeCloseTo(0.5, 9);
    expect(vector[1]).toBeCloseTo(0.5, 9);
  });

  it('is strictly increasing in a member score with fixed counts and at least two tier members', () => {
    const low = probabilityVector([40, 60])[0]!;
    const high = probabilityVector([41, 60])[0]!;
    expect(high).toBeGreaterThan(low);
    expect(probabilityVector([42])).toEqual([1]);
  });

  it('selects the largest adjusted score, not the largest observed score, at low temperature', () => {
    const vector = probabilityVector([100, 75], [1, 0], { temperature: 0.25 });
    expect(vector[1]!).toBeGreaterThan(vector[0]!);
  });

  it('prefers the soft-threshold tier using observed scores before count adjustment', () => {
    const result = computePerSessionOffsetOddsProbabilities({
      candidates: [
        { profileId: 'reserved', remainingPercent: 20, reservationCount: 3 },
        { profileId: 'thin', remainingPercent: 10, reservationCount: 0 },
      ],
      ...defaults,
    });
    expect(result.tier).toBe('above_soft_threshold');
    expect(result.probabilityByProfileId.get('reserved')).toBe(1);
    expect(result.probabilityByProfileId.get('thin')).toBe(0);
  });

  it('uses every scored member when none is above the soft threshold', () => {
    const result = computePerSessionOffsetOddsProbabilities({ candidates: unreserved([10, 5]), ...defaults });
    expect(result.tier).toBe('all_scored');
    expect(result.probabilityByProfileId.get('m0')! + result.probabilityByProfileId.get('m1')!).toBeCloseTo(1, 12);
  });

  it('applies no cap: a sole preferred member receives probability one', () => {
    const e1 = scenarioFixtures.scenarios.find((scenario) => scenario.id === 'E1')!;
    const vector = probabilityVector(e1.scores);
    expect(vector[vector.length - 1]).toBe(1);
  });

  it('rejects non-positive or non-finite parameters', () => {
    for (const bad of [{ offsetPercent: 0 }, { offsetPercent: -1 }, { temperature: 0 }, { temperature: Number.NaN }]) {
      expect(() => computePerSessionOffsetOddsProbabilities({ candidates: unreserved([50]), ...defaults, ...bad })).toThrow();
    }
  });

  it('rejects candidates without a positive known score', () => {
    expect(() => computePerSessionOffsetOddsProbabilities({
      candidates: [{ profileId: 'zero', remainingPercent: 0, reservationCount: 0 }],
      ...defaults,
    })).toThrow();
  });
});

describe('per-session offset-odds draw', () => {
  it('maps the injected uniform sample onto cumulative probability in stable candidate order', () => {
    const probabilities = computePerSessionOffsetOddsProbabilities({ candidates: unreserved([50, 50]), ...defaults });
    expect(drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: 0 })).toBe('m0');
    expect(drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: 0.4999 })).toBe('m0');
    expect(drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: 0.5 })).toBe('m1');
    expect(drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: 0.9999999 })).toBe('m1');
  });

  it('never selects a zero-probability member', () => {
    const probabilities = computePerSessionOffsetOddsProbabilities({ candidates: unreserved([10, 50]), ...defaults });
    for (const sample of [0, 0.3, 0.999999]) {
      expect(drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: sample })).toBe('m1');
    }
  });

  it('rejects samples outside [0, 1)', () => {
    const probabilities = computePerSessionOffsetOddsProbabilities({ candidates: unreserved([50]), ...defaults });
    expect(() => drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: 1 })).toThrow();
    expect(() => drawPerSessionOffsetOddsCandidate({ probabilities, uniformSample: -0.1 })).toThrow();
  });
});
