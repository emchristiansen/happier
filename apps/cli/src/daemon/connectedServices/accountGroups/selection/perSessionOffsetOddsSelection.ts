/**
 * Offset-odds weighting for the `per_session_softmax` account-group strategy.
 *
 * For each eligible scored member i with observed effective remaining percentage s_i and k_i live
 * reservations:
 *
 *   s'_i = s_i / (1 + k_i)
 *   w_i  = ( s'_i / (100 - s'_i + δ) ) ^ (1/τ)
 *   p_i  = w_i / Σ_j w_j          over the preference tier
 *
 * The tier is the set of members whose OBSERVED score is strictly above the soft threshold, or every
 * scored member when that set is empty. δ > 0 keeps the weight of a completely fresh member finite
 * ((100/δ)^(1/τ)); there is no probability cap. Weights are computed in log form for stability.
 */

export type PerSessionOffsetOddsCandidateInput = Readonly<{
  profileId: string;
  /** Observed effectiveRemainingPercent, in (0, 100]. */
  remainingPercent: number;
  /** Live pending/applied reservations on this member, excluding the decision being made. */
  reservationCount: number;
}>;

export type PerSessionOffsetOddsParameters = Readonly<{
  /** τ, dimensionless, finite and > 0. */
  temperature: number;
  /** δ, percentage points, finite and > 0. */
  offsetPercent: number;
  /** Existing soft-switch threshold, percentage points. */
  softSwitchRemainingPercent: number;
}>;

export type PerSessionOffsetOddsTraceEntry = Readonly<{
  profileId: string;
  remainingPercent: number;
  reservationCount: number;
  adjustedRemainingPercent: number;
  inTier: boolean;
  /** Unnormalized weight w_i; 0 outside the tier. */
  weight: number;
  probability: number;
}>;

export type PerSessionOffsetOddsProbabilities = Readonly<{
  tier: 'above_soft_threshold' | 'all_scored';
  temperature: number;
  offsetPercent: number;
  /** Candidate order is preserved; the draw walks this order. */
  trace: ReadonlyArray<PerSessionOffsetOddsTraceEntry>;
  probabilityByProfileId: ReadonlyMap<string, number>;
}>;

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0; received ${String(value)}`);
  }
}

export function computePerSessionOffsetOddsProbabilities(
  input: PerSessionOffsetOddsParameters & Readonly<{ candidates: ReadonlyArray<PerSessionOffsetOddsCandidateInput> }>,
): PerSessionOffsetOddsProbabilities {
  assertPositiveFinite('temperature', input.temperature);
  assertPositiveFinite('offsetPercent', input.offsetPercent);
  if (input.candidates.length === 0) {
    throw new RangeError('per-session offset-odds selection requires at least one scored candidate');
  }
  for (const candidate of input.candidates) {
    if (!Number.isFinite(candidate.remainingPercent) || candidate.remainingPercent <= 0 || candidate.remainingPercent > 100) {
      throw new RangeError(`candidate ${candidate.profileId} must have a known remaining percentage in (0, 100]`);
    }
    if (!Number.isInteger(candidate.reservationCount) || candidate.reservationCount < 0) {
      throw new RangeError(`candidate ${candidate.profileId} reservation count must be a non-negative integer`);
    }
  }

  const aboveThreshold = input.candidates.some((candidate) => candidate.remainingPercent > input.softSwitchRemainingPercent);
  const tier = aboveThreshold ? 'above_soft_threshold' as const : 'all_scored' as const;
  const inTier = (candidate: PerSessionOffsetOddsCandidateInput) =>
    !aboveThreshold || candidate.remainingPercent > input.softSwitchRemainingPercent;

  const scored = input.candidates.map((candidate) => {
    const adjusted = candidate.remainingPercent / (1 + candidate.reservationCount);
    const logit = (Math.log(adjusted) - Math.log(100 - adjusted + input.offsetPercent)) / input.temperature;
    return { candidate, adjusted, logit, inTier: inTier(candidate) };
  });
  const maxLogit = Math.max(...scored.filter((entry) => entry.inTier).map((entry) => entry.logit));
  const shifted = scored.map((entry) => (entry.inTier ? Math.exp(entry.logit - maxLogit) : 0));
  const total = shifted.reduce((sum, value) => sum + value, 0);

  const trace = scored.map((entry, index) => ({
    profileId: entry.candidate.profileId,
    remainingPercent: entry.candidate.remainingPercent,
    reservationCount: entry.candidate.reservationCount,
    adjustedRemainingPercent: entry.adjusted,
    inTier: entry.inTier,
    weight: entry.inTier ? Math.exp(entry.logit) : 0,
    probability: shifted[index]! / total,
  }));
  return {
    tier,
    temperature: input.temperature,
    offsetPercent: input.offsetPercent,
    trace,
    probabilityByProfileId: new Map(trace.map((entry) => [entry.profileId, entry.probability])),
  };
}

/**
 * Inverse-CDF draw. `uniformSample` must be in [0, 1); production callers pass a CSPRNG sample
 * (crypto.getRandomValues Uint32 / 2^32), tests inject it.
 */
export function drawPerSessionOffsetOddsCandidate(input: Readonly<{
  probabilities: PerSessionOffsetOddsProbabilities;
  uniformSample: number;
}>): string {
  if (!(input.uniformSample >= 0 && input.uniformSample < 1)) {
    throw new RangeError(`uniform sample must be in [0, 1); received ${String(input.uniformSample)}`);
  }
  const positive = input.probabilities.trace.filter((entry) => entry.probability > 0);
  let cumulative = 0;
  for (const entry of positive) {
    cumulative += entry.probability;
    if (input.uniformSample < cumulative) return entry.profileId;
  }
  // Floating-point residue when the sample is within rounding error of 1.
  return positive[positive.length - 1]!.profileId;
}

export function createCryptoUniformSample(): number {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0]! / 2 ** 32;
}
