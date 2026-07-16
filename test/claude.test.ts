import { describe, it, expect } from 'vitest';
import { isRateLimitError, shouldCheckRateLimit } from '../src/claude.js';

describe('isRateLimitError', () => {
  it('returns false for a successful run', () => {
    const parsed = { type: 'result', subtype: 'success', is_error: false, result: 'all good' };

    expect(isRateLimitError(parsed, '')).toBe(false);
  });

  it('returns false for a generic (non rate-limit) error', () => {
    const parsed = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['budget exceeded'],
    };

    expect(isRateLimitError(parsed, '')).toBe(false);
  });

  it('detects a rate-limit subtype', () => {
    const parsed = { type: 'result', subtype: 'error_rate_limit', is_error: true };

    expect(isRateLimitError(parsed, '')).toBe(true);
  });

  it('detects a "usage limit" phrase in errors', () => {
    const parsed = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      errors: ['You have hit your usage limit for this period'],
    };

    expect(isRateLimitError(parsed, '')).toBe(true);
  });

  it('detects an HTTP 429 status mentioned in stderr', () => {
    const parsed = { type: 'result', subtype: 'error', is_error: true };

    expect(isRateLimitError(parsed, 'request failed with status 429')).toBe(true);
  });

  it('detects "too many requests" in the result field', () => {
    const parsed = {
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Error: too many requests, please slow down',
    };

    expect(isRateLimitError(parsed, '')).toBe(true);
  });

  it('is case-insensitive', () => {
    const parsed = { type: 'result', subtype: 'error', is_error: true, errors: ['RATE_LIMIT'] };

    expect(isRateLimitError(parsed, '')).toBe(true);
  });

  it('returns false when parsed JSON is undefined (e.g. invalid JSON output)', () => {
    expect(isRateLimitError(undefined, '')).toBe(false);
  });

  it('still detects a rate limit reported only via stderr when JSON is undefined', () => {
    expect(isRateLimitError(undefined, 'Error: rate_limit_exceeded')).toBe(true);
  });
});

describe('shouldCheckRateLimit', () => {
  it('returns false for a successful run, even if its summary mentions rate limits', () => {
    // Regression case: reviewing this repo's own rate-limit-detection code produced a
    // successful summary mentioning "rate limit" and "429", which used to be misclassified
    // as an actual rate limit because the check ran unconditionally.
    const parsed = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Reviewed the rate limit (429) detection changes, no blocking issues found.',
    };

    expect(shouldCheckRateLimit(parsed)).toBe(false);
  });

  it('returns true when the run errored', () => {
    const parsed = { type: 'result', subtype: 'error', is_error: true };

    expect(shouldCheckRateLimit(parsed)).toBe(true);
  });

  it('returns true when parsed JSON is undefined', () => {
    expect(shouldCheckRateLimit(undefined)).toBe(true);
  });
});
