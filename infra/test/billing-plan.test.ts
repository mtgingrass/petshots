import {
  activeBillingSources,
  normalizePlanFile,
  withDerivedPlan,
} from '../lambda/api';

describe('App Store billing plan model', () => {
  test('preserves a bare paid plan as a manual tester override', () => {
    const plan = withDerivedPlan({ plan: 'paid' });
    expect(plan.manualPaid).toBe(true);
    expect(plan.plan).toBe('paid');
    expect(plan.billingSource).toBe('manual');
    expect(plan.billingSources).toEqual(['manual']);
  });

  test('normalizes a legacy bare paid plan as manual access', () => {
    const plan = normalizePlanFile({ plan: 'paid' });
    expect(plan.manualPaid).toBe(true);
    expect(activeBillingSources(plan)).toEqual(['manual']);
  });

  test('grants paid access for an active App Store entitlement', () => {
    const plan = withDerivedPlan({
      billing: {
        apple: {
          active: true,
          status: 'active',
          updatedAt: '2026-07-15T00:00:00.000Z',
          expiresAt: '2099-07-15T00:00:00.000Z',
        },
      },
    });
    expect(plan.plan).toBe('paid');
    expect(plan.billingSource).toBe('apple');
    expect(plan.billingSources).toEqual(['apple']);
  });

  test('downgrades when the App Store entitlement expires', () => {
    const plan = withDerivedPlan({
      manualPaid: false,
      billing: {
        apple: { active: false, status: 'expired', updatedAt: '2026-07-15T00:00:00.000Z' },
      },
    });
    expect(plan.plan).toBe('free');
    expect(plan.billingSource).toBeUndefined();
    expect(plan.billingSources).toBeUndefined();
  });

  test('keeps an explicit manual tester override after an entitlement expires', () => {
    const plan = withDerivedPlan({
      manualPaid: true,
      billing: {
        apple: { active: false, status: 'expired', updatedAt: '2026-07-15T00:00:00.000Z' },
      },
    });
    expect(plan.plan).toBe('paid');
    expect(plan.billingSource).toBe('manual');
    expect(plan.billingSources).toEqual(['manual']);
  });

  test('tester preview can force free even while an App Store entitlement is active', () => {
    const plan = withDerivedPlan({
      testerPlan: 'free',
      billing: {
        apple: {
          active: true,
          status: 'active',
          updatedAt: '2026-07-15T00:00:00.000Z',
          expiresAt: '2099-07-15T00:00:00.000Z',
        },
      },
    });
    expect(plan.plan).toBe('free');
    expect(plan.billingSources).toBeUndefined();
  });

  test('tester preview can force paid without creating a purchase entitlement', () => {
    const plan = withDerivedPlan({ testerPlan: 'paid', manualPaid: false });
    expect(plan.plan).toBe('paid');
    expect(plan.billingSource).toBe('manual');
    expect(plan.billingSources).toEqual(['manual']);
  });

  test('does not grant access from a stale active flag after expiration', () => {
    const plan = withDerivedPlan({
      billing: {
        apple: {
          active: true,
          status: 'active',
          updatedAt: '2000-01-01T00:00:00.000Z',
          expiresAt: '2000-02-01T00:00:00.000Z',
        },
      },
    });
    expect(plan.plan).toBe('free');
    expect(activeBillingSources(plan)).toEqual([]);
  });
});
