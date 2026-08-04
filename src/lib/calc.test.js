import { describe, it, expect } from 'vitest'
import { computeMpg, fuelStats, currentOdometer, maintenanceStatus, tco, fixedCostsAnnual, tcoRollup, milesPerDay, forecastMaintenance } from './calc.js'
import { seedFuel } from './seed.js'

// Build fuel logs from the real seed data so the tests regress against the
// exact GX460 entries the verified reference values came from (see CLAUDE.md).
const logs = seedFuel.map((f, i) => ({ ...f, id: i + 1, vehicle_id: f.key }))
const gx460 = logs.filter(l => l.vehicle_id === 'gx460')

describe('computeMpg — verified GX460 reference sequence', () => {
  it('matches the per-fill MPG sequence: null, 13.81, 12.96, 12.60, 15.06, 12.52', () => {
    const mpg = computeMpg(logs)
    const seq = gx460.map(l => {
      const v = mpg.get(l.id).mpg
      return v == null ? null : Number(v.toFixed(2))
    })
    expect(seq).toEqual([null, 13.81, 12.96, 12.60, 15.06, 12.52])
  })

  it('reset rows produce no MPG and set the baseline', () => {
    const mpg = computeMpg(logs)
    expect(mpg.get(gx460[0].id)).toEqual({ mpg: null, miles: null })
    // first full after reset uses the reset odometer as baseline
    expect(mpg.get(gx460[1].id).miles).toBe(90449 - 90191)
  })

  it('partial fills accumulate gallons into the next full fill', () => {
    const synthetic = [
      { id: 'a', vehicle_id: 'x', odometer: 1000, fill_type: 'reset', gallons: 10 },
      { id: 'b', vehicle_id: 'x', odometer: 1100, fill_type: 'partial', gallons: 4 },
      { id: 'c', vehicle_id: 'x', odometer: 1200, fill_type: 'full', gallons: 6 },
    ]
    const mpg = computeMpg(synthetic)
    expect(mpg.get('b').mpg).toBeNull()
    // 200 mi since last full-baseline / (4 partial + 6 this fill) = 20 MPG
    expect(mpg.get('c').mpg).toBeCloseTo(20, 5)
  })

  it('processes entries by odometer order regardless of input order', () => {
    const shuffled = [...logs].reverse()
    const mpg = computeMpg(shuffled)
    expect(Number(mpg.get(gx460[1].id).mpg.toFixed(2))).toBe(13.81)
  })
})

describe('fuelStats — verified GX460 aggregates', () => {
  const s = fuelStats(logs, 'gx460')

  it('1061 mi on 78.351 gal = 13.54 MPG aggregate', () => {
    expect(s.miles).toBe(1061)
    expect(s.galUsed).toBeCloseTo(78.351, 3)
    expect(Number(s.aggMpg.toFixed(2))).toBe(13.54)
  })

  it('total spend $397.01, avg $4.150/gal, $0.306/mi', () => {
    expect(s.totalSpend).toBeCloseTo(397.01, 2)
    expect(Number(s.avgCpg.toFixed(3))).toBe(4.150)
    expect(Number(s.costPerMile.toFixed(3))).toBe(0.306)
  })

  it('returns null for a vehicle with no logs', () => {
    expect(fuelStats(logs, 'nope')).toBeNull()
  })
})

describe('currentOdometer — always derived, never stored', () => {
  const vehicle = { id: 'gx460', base_odometer: 90191 }

  it('takes the max across base, fuel logs, and service logs', () => {
    expect(currentOdometer(vehicle, logs, [])).toBe(91252)
    const svc = [{ vehicle_id: 'gx460', odometer: 91500 }]
    expect(currentOdometer(vehicle, logs, svc)).toBe(91500)
  })

  it('falls back to base_odometer with no logs', () => {
    expect(currentOdometer(vehicle, [], [])).toBe(90191)
  })
})

describe('maintenanceStatus thresholds', () => {
  const today = new Date('2026-07-20')

  it('baseline when no last_done set', () => {
    expect(maintenanceStatus({ interval_miles: 7500 }, 91252, today).status).toBe('baseline')
  })

  it('overdue when miles-remaining <= 0', () => {
    const item = { interval_miles: 7500, last_done_miles: 83000 }
    const r = maintenanceStatus(item, 91252, today)
    expect(r.status).toBe('overdue')
    expect(r.remainMiles).toBe(83000 + 7500 - 91252)
  })

  it('due-soon when <= 1000 mi remaining', () => {
    const item = { interval_miles: 7500, last_done_miles: 84500 }
    expect(maintenanceStatus(item, 91252, today).status).toBe('due-soon')
  })

  it('due-soon when <= 30 days remaining', () => {
    const item = { interval_months: 12, last_done_date: '2025-08-01' }
    expect(maintenanceStatus(item, 91252, today).status).toBe('due-soon')
  })

  it('overdue by date wins over ok-by-miles', () => {
    const item = { interval_miles: 7500, last_done_miles: 91000, interval_months: 1, last_done_date: '2026-05-01' }
    expect(maintenanceStatus(item, 91252, today).status).toBe('overdue')
  })

  it('ok when comfortably inside both windows', () => {
    const item = { interval_miles: 7500, last_done_miles: 91000, interval_months: 6, last_done_date: '2026-07-01' }
    expect(maintenanceStatus(item, 91252, today).status).toBe('ok')
  })
})

describe('tco', () => {
  it('sums fuel + service spend and derives cost per mile over logged miles', () => {
    const svc = [{ vehicle_id: 'gx460', cost: 100 }]
    const t = tco({ id: 'gx460' }, logs, svc)
    expect(t.fuelSpend).toBeCloseTo(397.01, 2)
    expect(t.svcSpend).toBe(100)
    expect(t.totalSpend).toBeCloseTo(497.01, 2)
    expect(t.miles).toBe(1061)
    // cost/mi excludes the baseline fill's cost (it bought no logged miles)
    expect(t.costPerMile).toBeCloseTo((397.01 + 100 - 65.46) / 1061, 4)
  })
})

describe('fixedCostsAnnual', () => {
  const costs = [
    { vehicle_id: 'gx460', name: 'Insurance', amount: 120, period: 'month' },
    { vehicle_id: 'gx460', name: 'Registration', amount: 76.25, period: 'year' },
    { vehicle_id: 'is350', name: 'Insurance', amount: 90, period: 'month' },
  ]

  it('annualizes monthly and yearly amounts per vehicle', () => {
    expect(fixedCostsAnnual(costs, 'gx460')).toBeCloseTo(120 * 12 + 76.25, 2)
    expect(fixedCostsAnnual(costs, 'is350')).toBe(1080)
    expect(fixedCostsAnnual(costs, 'fj80')).toBe(0)
  })
})

describe('tcoRollup — the keep-vs-replace number', () => {
  const svc = [{ vehicle_id: 'gx460', cost: 250 }]
  const costs = [{ vehicle_id: 'gx460', name: 'Insurance', amount: 1200, period: 'year' }]

  it('combines fuel, service, and fixed $/mi components', () => {
    const t = tcoRollup({ id: 'gx460' }, logs, svc, costs)
    expect(t.fuelCPM).toBeCloseTo(0.306, 3)
    expect(t.svcCPM).toBeCloseTo(250 / 1061, 4)
    // fixed $/mi = annual fixed ÷ observed miles/yr rate
    expect(t.fixedCPM).toBeCloseTo(1200 / t.milesPerYear, 6)
    expect(t.totalCPM).toBeCloseTo(t.fuelCPM + t.svcCPM + t.fixedCPM, 6)
    expect(t.annualEst).toBeCloseTo(t.totalCPM * t.milesPerYear, 4)
  })

  it('miles/yr annualization from the GX460 21-day window is ~18.4k', () => {
    const t = tcoRollup({ id: 'gx460' }, logs, [], [])
    // 1061 mi over 21 days (Jun 26 → Jul 17) × 365.25
    expect(t.milesPerYear).toBeCloseTo(1061 / 21 * 365.25, 1)
  })

  it('degrades gracefully with no data', () => {
    const t = tcoRollup({ id: 'fj80-x' }, [], [], [])
    expect(t.totalCPM).toBeNull()
    expect(t.annualEst).toBeNull()
    expect(t.fixedAnnual).toBe(0)
  })

  it('fixed-only vehicle still reports fixedAnnual without a CPM', () => {
    const t = tcoRollup({ id: 'is350' }, [], [], [{ vehicle_id: 'is350', name: 'Insurance', amount: 100, period: 'month' }])
    expect(t.fixedAnnual).toBe(1200)
    expect(t.fixedCPM).toBeNull()   // no miles/yr rate yet
  })
})

describe('forecastMaintenance — mileage-to-calendar projection', () => {
  const today = new Date('2026-07-20')
  const vehicle = { id: 'gx460', base_odometer: 90191 }
  // seed GX460 history: 1061 mi over 21 days → ~50.5 mi/day
  const mpd = milesPerDay(logs, 'gx460')

  it('derives the rolling miles/day rate from fuel history', () => {
    expect(mpd).toBeCloseTo(1061 / 21, 1)
  })

  it('projects a mile-based interval to a date via the rate', () => {
    // due in ~505 miles → ~10 days out
    const item = { id: 'm1', vehicle_id: 'gx460', name: 'Oil', interval_miles: 7500, last_done_miles: 91252 + 505 - 7500 }
    const [f] = forecastMaintenance([vehicle], logs, [], [item], today)
    const days = (f.dueDate - today) / 86400000
    expect(days).toBeGreaterThan(8)
    expect(days).toBeLessThan(12)
    expect(f.overdue).toBe(false)
    expect(f.basis).toContain('mi/day')
  })

  it('uses the exact calendar date when it is sooner than the mileage projection', () => {
    const item = { id: 'm2', vehicle_id: 'gx460', name: 'Brake Fluid', interval_miles: 50000, last_done_miles: 91000, interval_months: 1, last_done_date: '2026-06-25' }
    const [f] = forecastMaintenance([vehicle], logs, [], [item], today)
    expect(f.basis).toBe('calendar')
    expect(f.dueDate.toISOString().slice(0, 10)).toBe('2026-07-25')
  })

  it('pins overdue items to today and sorts them first', () => {
    const items = [
      { id: 'a', vehicle_id: 'gx460', name: 'Way out', interval_miles: 7500, last_done_miles: 91000 },
      { id: 'b', vehicle_id: 'gx460', name: 'Late', interval_miles: 5000, last_done_miles: 85000 },
    ]
    const fs = forecastMaintenance([vehicle], logs, [], items, today)
    expect(fs[0].item.name).toBe('Late')
    expect(fs[0].overdue).toBe(true)
    expect(fs[0].dueDate.toISOString().slice(0, 10)).toBe('2026-07-20')
  })

  it('skips baseline items and vehicles without a usage rate keep calendar-only projections', () => {
    const noHistory = { id: 'fj', base_odometer: 286589 }
    const items = [
      { id: 'c', vehicle_id: 'fj', name: 'No baseline', interval_miles: 4000 },
      { id: 'd', vehicle_id: 'fj', name: 'Miles only, no rate', interval_miles: 4000, last_done_miles: 286589 },
      { id: 'e', vehicle_id: 'fj', name: 'Dated', interval_months: 2, last_done_date: '2026-07-01' },
    ]
    const fs = forecastMaintenance([noHistory], [], [], items, today)
    expect(fs).toHaveLength(1)
    expect(fs[0].item.name).toBe('Dated')
  })
})

describe('telemetry odometer floor', () => {
  const vehicle = { id: 'gx460', base_odometer: 90191 }

  it('extraOdo raises the derived odometer when it exceeds logs', () => {
    expect(currentOdometer(vehicle, logs, [], 92000)).toBe(92000)
  })

  it('logged readings still win over a stale telemetry value', () => {
    expect(currentOdometer(vehicle, logs, [], 90500)).toBe(91252)
  })

  it('forecast dates tighten as telemetry miles accrue', () => {
    const today = new Date('2026-07-20')
    const item = { id: 'm', vehicle_id: 'gx460', name: 'Oil', interval_miles: 7500, last_done_miles: 85000 }
    const without = forecastMaintenance([vehicle], logs, [], [item], today)
    const withTel = forecastMaintenance([vehicle], logs, [], [item], today, { gx460: 92200 })
    // 85000+7500=92500 due; at telemetry 92200 only 300 mi remain vs 1248 before
    expect(withTel[0].st.remainMiles).toBe(300)
    expect(without[0].st.remainMiles).toBe(1248)
  })
})
