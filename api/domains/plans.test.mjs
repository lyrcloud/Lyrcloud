import assert from 'node:assert/strict';
import test from 'node:test';
import { extendPlan, planLapsed, planOrderFrom, planPriceCents, planReference } from './plans.mjs';

test('Scale costs $29 a month or $290 a year; nothing else is sold', () => {
  assert.equal(planPriceCents('scale', 'month'), 2900);
  assert.equal(planPriceCents('scale', 'year'), 29000);
  assert.equal(planPriceCents('enterprise', 'month'), null);
  assert.equal(planPriceCents('scale', 'week'), null);
});

test('plan orders are told apart from domain orders by their reference', () => {
  const id = '0f3c9a2e-1b2c-4d5e-8f90-123456789abc';
  assert.equal(planOrderFrom(planReference(id)), id);
  assert.equal(planOrderFrom(id), null);
});

test('renewing adds on; lapsed Lyrpay plans fall back, staff-set plans never do', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  assert.equal(extendPlan({}, 'scale', 'month', now), '2026-12-27T12:00:00.000Z');
  assert.equal(extendPlan({ plan: 'scale', planPaidThrough: '2027-01-05T00:00:00.000Z' }, 'scale', 'year', now), '2028-01-05T00:00:00.000Z');
  assert.equal(planLapsed({ plan: 'scale', planSource: 'lyrpay', planPaidThrough: '2026-11-01T00:00:00Z' }, now), true);
  assert.equal(planLapsed({ plan: 'scale', planSource: 'lyrpay', planPaidThrough: '2026-12-01T00:00:00Z' }, now), false);
  assert.equal(planLapsed({ plan: 'enterprise' }, now), false);
});
