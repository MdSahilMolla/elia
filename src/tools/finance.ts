import type { Tool } from './types.ts'

type FinanceAction = 'unit_economics' | 'runway' | 'scenario' | 'dcf'

interface FinanceRequest {
  action: FinanceAction
  currency?: string
  asOfDate?: string
  basis?: string
  source?: string
  assumptions?: string[]
  customers?: number
  arpa?: number
  grossMargin?: number
  monthlyChurn?: number
  cac?: number
  monthlyOperatingExpenses?: number
  cashBalance?: number
  monthlyRevenue?: number
  monthlyExpenses?: number
  startingRevenue?: number
  startingExpenses?: number
  months?: number
  revenueGrowthRate?: number
  expenseGrowthRate?: number
  cashFloor?: number
  baseFreeCashFlow?: number
  discountRate?: number
  terminalGrowthRate?: number
  forecastYears?: number
  netDebt?: number
  sharesOutstanding?: number
}

interface Disclosure {
  basis: string
  time: string
  assumptions: string[]
  sources: string[]
  confidence: string
  compliance: string
}

const DISCLAIMER = 'This is research and analysis only, not personalized financial advice.'

function numberValue(input: Record<string, unknown>, key: keyof FinanceRequest, options: { min?: number; max?: number } = {}): number {
  const value = input[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${String(key)} must be a finite number`)
  if (options.min !== undefined && value < options.min) throw new Error(`${String(key)} must be at least ${options.min}`)
  if (options.max !== undefined && value > options.max) throw new Error(`${String(key)} must be at most ${options.max}`)
  return value
}

function optionalNumber(input: Record<string, unknown>, key: keyof FinanceRequest, options: { min?: number; max?: number } = {}): number | undefined {
  if (input[key] === undefined) return undefined
  return numberValue(input, key, options)
}

function disclosure(input: Record<string, unknown>): Disclosure {
  const assumptions = Array.isArray(input.assumptions) ? input.assumptions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  return {
    basis: typeof input.basis === 'string' && input.basis.trim() ? input.basis.trim() : 'User-provided inputs; no external source supplied',
    time: typeof input.asOfDate === 'string' && input.asOfDate.trim() ? input.asOfDate.trim() : 'As-of date not supplied',
    assumptions: assumptions.length > 0 ? assumptions : ['Inputs are treated as nominal values in the stated currency and period.'],
    sources: typeof input.source === 'string' && input.source.trim() ? [input.source.trim()] : ['User-provided inputs'],
    confidence: 'Calculation arithmetic is deterministic; input accuracy, completeness, accounting policy, and forecast realism were not independently verified.',
    compliance: DISCLAIMER,
  }
}

function currency(input: Record<string, unknown>): string {
  return typeof input.currency === 'string' && input.currency.trim() ? input.currency.trim() : 'unspecified currency'
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000
}

function unitEconomics(input: Record<string, unknown>): string {
  const customers = numberValue(input, 'customers', { min: 0 })
  const arpa = numberValue(input, 'arpa', { min: 0 })
  const grossMargin = numberValue(input, 'grossMargin', { min: 0, max: 1 })
  const monthlyChurn = numberValue(input, 'monthlyChurn', { min: 0, max: 1 })
  const cac = numberValue(input, 'cac', { min: 0 })
  const monthlyOperatingExpenses = numberValue(input, 'monthlyOperatingExpenses', { min: 0 })
  const monthlyRevenue = customers * arpa
  const monthlyGrossProfit = monthlyRevenue * grossMargin
  const ltv = monthlyChurn > 0 ? arpa * grossMargin / monthlyChurn : null
  const ltvToCac = ltv !== null && cac > 0 ? ltv / cac : null
  const paybackMonths = arpa > 0 && grossMargin > 0 ? cac / (arpa * grossMargin) : null
  const breakEvenCustomers = arpa > 0 && grossMargin > 0 ? Math.ceil(monthlyOperatingExpenses / (arpa * grossMargin)) : null

  return JSON.stringify({
    action: 'unit_economics',
    currency: currency(input),
    inputs: { customers, arpa, grossMargin, monthlyChurn, cac, monthlyOperatingExpenses },
    outputs: {
      monthlyRevenue: round(monthlyRevenue),
      monthlyGrossProfit: round(monthlyGrossProfit),
      ltv: ltv === null ? null : round(ltv),
      ltvToCac: ltvToCac === null ? null : round(ltvToCac),
      cacPaybackMonths: paybackMonths === null ? null : round(paybackMonths),
      breakEvenCustomers,
    },
    interpretation: [
      ltv === null ? 'LTV is undefined because monthly churn is zero; do not treat this as infinite customer value.' : 'LTV uses ARPA × gross margin ÷ monthly churn.',
      'Break-even customers use monthly operating expenses ÷ gross profit per customer and round up to a whole customer.',
    ],
    disclosure: disclosure(input),
  }, null, 2)
}

function runway(input: Record<string, unknown>): string {
  const cashBalance = numberValue(input, 'cashBalance', { min: 0 })
  const monthlyRevenue = numberValue(input, 'monthlyRevenue', { min: 0 })
  const monthlyExpenses = numberValue(input, 'monthlyExpenses', { min: 0 })
  const netBurn = Math.max(0, monthlyExpenses - monthlyRevenue)
  const runwayMonths = netBurn > 0 ? cashBalance / netBurn : null

  return JSON.stringify({
    action: 'runway',
    currency: currency(input),
    inputs: { cashBalance, monthlyRevenue, monthlyExpenses },
    outputs: {
      netMonthlyBurn: round(netBurn),
      runwayMonths: runwayMonths === null ? null : round(runwayMonths),
      status: netBurn === 0 ? 'cash-positive-or-breakeven' : cashBalance === 0 ? 'no-cash-buffer' : 'burning-cash',
    },
    interpretation: [
      'Runway is cash balance divided by positive net monthly burn; it excludes financing, taxes, seasonality, one-time costs, and working-capital timing unless included in the inputs.',
      runwayMonths === null ? 'No finite runway is calculated because the supplied monthly revenue covers monthly expenses.' : 'This is a static monthly estimate, not a forecast of survival under changing conditions.',
    ],
    disclosure: disclosure(input),
  }, null, 2)
}

function dcf(input: Record<string, unknown>): string {
  const baseFreeCashFlow = numberValue(input, 'baseFreeCashFlow', { min: 0 })
  const discountRate = numberValue(input, 'discountRate', { min: 0.000001, max: 1 })
  const terminalGrowthRate = numberValue(input, 'terminalGrowthRate', { min: -1, max: 0.99 })
  const forecastYears = Math.round(numberValue(input, 'forecastYears', { min: 1, max: 20 }))
  const netDebt = optionalNumber(input, 'netDebt') ?? 0
  const sharesOutstanding = optionalNumber(input, 'sharesOutstanding', { min: 0 })
  if (discountRate <= terminalGrowthRate) throw new Error('discountRate must be greater than terminalGrowthRate for a finite terminal value')
  const growthRate = numberValue(input, 'revenueGrowthRate', { min: -1, max: 10 })
  const forecast: Array<{ year: number; freeCashFlow: number; discountFactor: number; presentValue: number }> = []
  let freeCashFlow = baseFreeCashFlow
  let presentValueOfForecast = 0
  for (let year = 1; year <= forecastYears; year++) {
    freeCashFlow *= 1 + growthRate
    const discountFactor = 1 / ((1 + discountRate) ** year)
    const presentValue = freeCashFlow * discountFactor
    presentValueOfForecast += presentValue
    forecast.push({ year, freeCashFlow: round(freeCashFlow), discountFactor: round(discountFactor), presentValue: round(presentValue) })
  }
  const terminalFreeCashFlow = freeCashFlow * (1 + terminalGrowthRate)
  const terminalValue = terminalFreeCashFlow / (discountRate - terminalGrowthRate)
  const presentValueOfTerminal = terminalValue / ((1 + discountRate) ** forecastYears)
  const enterpriseValue = presentValueOfForecast + presentValueOfTerminal
  const equityValue = enterpriseValue - netDebt
  const sensitivity = [-0.01, 0, 0.01].flatMap((discountDelta) => [-0.01, 0, 0.01].map((growthDelta) => {
    const rate = discountRate + discountDelta
    const terminalGrowth = terminalGrowthRate + growthDelta
    if (rate <= terminalGrowth || rate <= 0) return { discountRate: round(rate), terminalGrowthRate: round(terminalGrowth), equityValue: null, valuePerShare: null }
    const terminal = freeCashFlow * (1 + terminalGrowth) / (rate - terminalGrowth)
    const forecastValue = forecast.reduce((sum, period) => sum + period.freeCashFlow / ((1 + rate) ** period.year), 0)
    const value = forecastValue + terminal / ((1 + rate) ** forecastYears) - netDebt
    return { discountRate: round(rate), terminalGrowthRate: round(terminalGrowth), equityValue: round(value), valuePerShare: sharesOutstanding && sharesOutstanding > 0 ? round(value / sharesOutstanding) : null }
  }))
  return JSON.stringify({
    action: 'dcf',
    currency: currency(input),
    inputs: { baseFreeCashFlow, growthRate, discountRate, terminalGrowthRate, forecastYears, netDebt, sharesOutstanding: sharesOutstanding ?? null },
    outputs: {
      presentValueOfForecast: round(presentValueOfForecast),
      terminalValue: round(terminalValue),
      presentValueOfTerminal: round(presentValueOfTerminal),
      enterpriseValue: round(enterpriseValue),
      equityValue: round(equityValue),
      valuePerShare: sharesOutstanding && sharesOutstanding > 0 ? round(equityValue / sharesOutstanding) : null,
    },
    forecast,
    sensitivity,
    interpretation: ['DCF value is highly sensitive to discount rate, terminal growth, forecast growth, and the supplied free-cash-flow basis.', 'Terminal value uses the Gordon Growth formula and is finite only when discount rate exceeds terminal growth rate.'],
    disclosure: disclosure(input),
  }, null, 2)
}

function scenario(input: Record<string, unknown>): string {
  const startingCash = numberValue(input, 'cashBalance', { min: 0 })
  const startingRevenue = numberValue(input, 'startingRevenue', { min: 0 })
  const startingExpenses = numberValue(input, 'startingExpenses', { min: 0 })
  const months = Math.round(numberValue(input, 'months', { min: 1, max: 120 }))
  const revenueGrowthRate = numberValue(input, 'revenueGrowthRate', { min: -1, max: 10 })
  const expenseGrowthRate = numberValue(input, 'expenseGrowthRate', { min: -1, max: 10 })
  const cashFloor = optionalNumber(input, 'cashFloor', { min: 0 })

  let cash = startingCash
  let revenue = startingRevenue
  let expenses = startingExpenses
  let firstBelowFloor: number | null = null
  const periods: Array<Record<string, number | string>> = []

  for (let month = 1; month <= months; month++) {
    const netCashFlow = revenue - expenses
    cash += netCashFlow
    const status = cashFloor !== undefined && cash < cashFloor ? 'below-cash-floor' : cash < 0 ? 'negative-cash' : 'within-plan'
    if (firstBelowFloor === null && (status === 'below-cash-floor' || status === 'negative-cash')) firstBelowFloor = month
    periods.push({
      month,
      revenue: round(revenue),
      expenses: round(expenses),
      netCashFlow: round(netCashFlow),
      endingCash: round(cash),
      status,
    })
    revenue *= 1 + revenueGrowthRate
    expenses *= 1 + expenseGrowthRate
  }

  return JSON.stringify({
    action: 'scenario',
    currency: currency(input),
    inputs: { startingCash, startingRevenue, startingExpenses, months, revenueGrowthRate, expenseGrowthRate, cashFloor: cashFloor ?? null },
    outputs: {
      endingCash: periods.at(-1)?.endingCash ?? round(startingCash),
      firstBelowCashFloorMonth: firstBelowFloor,
      minimumEndingCash: periods.reduce((minimum, period) => Math.min(minimum, Number(period.endingCash)), startingCash),
    },
    periods,
    disclosure: disclosure(input),
  }, null, 2)
}

export function validateFinanceRequest(input: Record<string, unknown>): FinanceRequest {
  const action = input.action
  if (typeof action !== 'string' || !['unit_economics', 'runway', 'scenario', 'dcf'].includes(action)) throw new Error('action must be unit_economics, runway, scenario, or dcf')
  if (input.currency !== undefined && typeof input.currency !== 'string') throw new Error('currency must be a string')
  if (input.asOfDate !== undefined && typeof input.asOfDate !== 'string') throw new Error('asOfDate must be a string')
  if (input.basis !== undefined && typeof input.basis !== 'string') throw new Error('basis must be a string')
  if (input.source !== undefined && typeof input.source !== 'string') throw new Error('source must be a string')
  if (input.assumptions !== undefined && (!Array.isArray(input.assumptions) || input.assumptions.some((value) => typeof value !== 'string'))) throw new Error('assumptions must be an array of strings')
  return { action: action as FinanceAction, ...input } as FinanceRequest
}

export const financeTool: Tool = {
  name: 'finance',
  description: 'Perform deterministic finance analysis from supplied inputs: unit economics, runway, bounded scenarios, or DCF valuation with sensitivity cases. Always provide or clearly disclose basis, as-of date, assumptions, sources, calculation formulas, limitations, and the financial-analysis disclaimer. This tool does not fetch market data, make personalized investment decisions, or replace an accountant or licensed adviser.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['unit_economics', 'runway', 'scenario', 'dcf'] },
      currency: { type: 'string', description: 'Currency code or unit, such as USD or USD millions' },
      asOfDate: { type: 'string', description: 'Reference date or fiscal period' },
      basis: { type: 'string', description: 'Metric definitions and accounting basis' },
      source: { type: 'string', description: 'Source for the supplied inputs' },
      assumptions: { type: 'array', description: 'Explicit assumptions' },
      customers: { type: 'number' },
      arpa: { type: 'number', description: 'Average revenue per account per month' },
      grossMargin: { type: 'number', description: 'Gross margin as a decimal from 0 to 1' },
      monthlyChurn: { type: 'number', description: 'Monthly customer churn as a decimal from 0 to 1' },
      cac: { type: 'number', description: 'Customer acquisition cost' },
      monthlyOperatingExpenses: { type: 'number' },
      cashBalance: { type: 'number' },
      monthlyRevenue: { type: 'number' },
      monthlyExpenses: { type: 'number' },
      startingRevenue: { type: 'number' },
      startingExpenses: { type: 'number' },
      months: { type: 'number', description: 'Scenario horizon from 1 to 120 months' },
      revenueGrowthRate: { type: 'number', description: 'Monthly revenue growth as a decimal' },
      expenseGrowthRate: { type: 'number', description: 'Monthly expense growth as a decimal' },
      cashFloor: { type: 'number', description: 'Optional minimum cash threshold' },
      baseFreeCashFlow: { type: 'number', description: 'Base free cash flow for DCF' },
      discountRate: { type: 'number', description: 'DCF discount rate as a decimal' },
      terminalGrowthRate: { type: 'number', description: 'DCF terminal growth rate as a decimal' },
      forecastYears: { type: 'number', description: 'DCF forecast horizon from 1 to 20 years' },
      netDebt: { type: 'number', description: 'Net debt deducted from enterprise value' },
      sharesOutstanding: { type: 'number', description: 'Optional diluted shares outstanding' },
    },
    required: ['action'],
  },
  async execute(input) {
    const request = validateFinanceRequest(input)
    if (request.action === 'unit_economics') return unitEconomics(input)
    if (request.action === 'runway') return runway(input)
    if (request.action === 'dcf') return dcf(input)
    return scenario(input)
  },
}

export { unitEconomics, runway, scenario, dcf }
