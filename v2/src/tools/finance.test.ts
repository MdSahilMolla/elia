import { expect, test } from 'bun:test'
import { financeTool } from './finance.ts'

test('finance unit economics returns traceable calculations and disclosures', async () => {
  const result = JSON.parse(await financeTool.execute({
    action: 'unit_economics',
    currency: 'USD',
    asOfDate: '2026-08-22',
    basis: 'Monthly recurring revenue; gross margin excludes sales commissions',
    source: 'User-provided operating model',
    customers: 100,
    arpa: 50,
    grossMargin: 0.8,
    monthlyChurn: 0.05,
    cac: 200,
    monthlyOperatingExpenses: 10_000,
    assumptions: ['Churn is measured monthly and remains constant.'],
  })) as { outputs: { monthlyRevenue: number; ltv: number; ltvToCac: number; cacPaybackMonths: number; breakEvenCustomers: number }; disclosure: { basis: string; time: string; sources: string[]; compliance: string } }

  expect(result.outputs.monthlyRevenue).toBe(5_000)
  expect(result.outputs.ltv).toBe(800)
  expect(result.outputs.ltvToCac).toBe(4)
  expect(result.outputs.cacPaybackMonths).toBe(5)
  expect(result.outputs.breakEvenCustomers).toBe(250)
  expect(result.disclosure.basis).toContain('Monthly recurring revenue')
  expect(result.disclosure.time).toBe('2026-08-22')
  expect(result.disclosure.sources).toEqual(['User-provided operating model'])
  expect(result.disclosure.compliance).toContain('not personalized financial advice')
})

test('finance runway reports a non-finite runway only when net burn is zero', async () => {
  const result = JSON.parse(await financeTool.execute({ action: 'runway', cashBalance: 100_000, monthlyRevenue: 20_000, monthlyExpenses: 20_000 })) as { outputs: { netMonthlyBurn: number; runwayMonths: number | null; status: string } }
  expect(result.outputs.netMonthlyBurn).toBe(0)
  expect(result.outputs.runwayMonths).toBeNull()
  expect(result.outputs.status).toBe('cash-positive-or-breakeven')
})

test('finance scenario exposes each period and cash-floor breach', async () => {
  const result = JSON.parse(await financeTool.execute({
    action: 'scenario',
    cashBalance: 1_000,
    startingRevenue: 100,
    startingExpenses: 500,
    months: 3,
    revenueGrowthRate: 0,
    expenseGrowthRate: 0,
    cashFloor: 0,
  })) as { periods: Array<{ month: number; endingCash: number; status: string }>; outputs: { firstBelowCashFloorMonth: number | null } }
  expect(result.periods).toHaveLength(3)
  expect(result.periods[0]?.endingCash).toBe(600)
  expect(result.periods[2]?.endingCash).toBe(-200)
  expect(result.outputs.firstBelowCashFloorMonth).toBe(3)
  expect(result.periods[2]?.status).toBe('below-cash-floor')
})

test('finance DCF returns enterprise/equity value and sensitivity cases', async () => {
  const result = JSON.parse(await financeTool.execute({
    action: 'dcf',
    currency: 'USD millions',
    asOfDate: '2026-08-22',
    basis: 'Unlevered free cash flow; nominal annual values',
    source: 'User-provided forecast',
    baseFreeCashFlow: 100,
    revenueGrowthRate: 0.05,
    discountRate: 0.1,
    terminalGrowthRate: 0.02,
    forecastYears: 5,
    netDebt: 50,
    sharesOutstanding: 10,
  })) as { outputs: { enterpriseValue: number; equityValue: number; valuePerShare: number }; forecast: unknown[]; sensitivity: unknown[] }
  expect(result.forecast).toHaveLength(5)
  expect(result.sensitivity).toHaveLength(9)
  expect(result.outputs.enterpriseValue).toBeGreaterThan(0)
  expect(result.outputs.equityValue).toBe(result.outputs.enterpriseValue - 50)
  expect(result.outputs.valuePerShare).toBeCloseTo(result.outputs.equityValue / 10, 6)
})

test('finance rejects invalid percentage and non-finite inputs', async () => {
  await expect(financeTool.execute({ action: 'unit_economics', customers: 10, arpa: 10, grossMargin: 1.2, monthlyChurn: 0.1, cac: 10, monthlyOperatingExpenses: 10 })).rejects.toThrow('grossMargin must be at most 1')
  await expect(financeTool.execute({ action: 'runway', cashBalance: Number.NaN, monthlyRevenue: 10, monthlyExpenses: 20 })).rejects.toThrow('cashBalance must be a finite number')
  await expect(financeTool.execute({ action: 'dcf', baseFreeCashFlow: 100, revenueGrowthRate: 0.05, discountRate: 0.02, terminalGrowthRate: 0.03, forecastYears: 5 })).rejects.toThrow('discountRate must be greater than terminalGrowthRate')
})
