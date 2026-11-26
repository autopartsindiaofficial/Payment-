export interface PlanConfig {
  id: string;
  name: string;
  amountPaise: number;
  currency: 'INR';
  durationDays: number;
}

export const PLANS: Record<string, PlanConfig> = {
  yearly_premium: {
    id: 'yearly_premium',
    name: 'ChatMate Yearly Premium',
    amountPaise: 29900,
    currency: 'INR',
    durationDays: 365,
  },
};

export function getPlanById(planId: string): PlanConfig | null {
  if (!Object.prototype.hasOwnProperty.call(PLANS, planId)) {
    return null;
  }
  return PLANS[planId];
}
