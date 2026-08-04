// ===== MPG engine =====
// Fuelly-compatible logic:
//  - "reset": establishes an odometer baseline; no MPG for that row.
//  - "partial": gallons accumulate; MPG deferred to the next full fill.
//  - "full": MPG = (odometer - lastFullOdometer) / (accumulated partial gallons + this fill's gallons)
// Entries must be processed sorted by odometer per vehicle.
export function computeMpg(logs) {
  const byVehicle = {}
  for (const l of logs) (byVehicle[l.vehicle_id] ||= []).push(l)
  const out = new Map()
  for (const vid of Object.keys(byVehicle)) {
    const sorted = [...byVehicle[vid]].sort((a, b) => a.odometer - b.odometer)
    let prevFullOdo = null
    let partialAccum = 0
    for (const e of sorted) {
      let mpg = null
      let miles = null
      if (e.fill_type === 'reset') {
        prevFullOdo = e.odometer
        partialAccum = 0
      } else if (e.fill_type === 'partial') {
        partialAccum += Number(e.gallons)
      } else {
        if (prevFullOdo != null && e.odometer > prevFullOdo) {
          miles = e.odometer - prevFullOdo
          const gal = partialAccum + Number(e.gallons)
          if (gal > 0) mpg = miles / gal
        }
        prevFullOdo = e.odometer
        partialAccum = 0
      }
      out.set(e.id, { mpg, miles })
    }
  }
  return out
}

// Aggregate stats per vehicle from fuel logs
export function fuelStats(logs, vehicleId) {
  const vlogs = logs.filter(l => l.vehicle_id === vehicleId).sort((a, b) => a.odometer - b.odometer)
  if (vlogs.length === 0) return null
  const first = vlogs[0], last = vlogs[vlogs.length - 1]
  const miles = last.odometer - first.odometer
  // gallons that PRODUCED those miles = all fills after the first entry
  const galUsed = vlogs.slice(1).reduce((s, l) => s + Number(l.gallons), 0)
  const totalSpend = vlogs.reduce((s, l) => s + Number(l.total_cost || 0), 0)
  const totalGal = vlogs.reduce((s, l) => s + Number(l.gallons), 0)
  const aggMpg = (miles > 0 && galUsed > 0) ? miles / galUsed : null
  const avgCpg = totalGal > 0 ? totalSpend / totalGal : null
  const costPerMile = (aggMpg && avgCpg) ? avgCpg / aggMpg : null
  // date span for annualization
  const days = (new Date(last.filled_at) - new Date(first.filled_at)) / 86400000
  const milesPerYear = (days >= 14 && miles > 0) ? miles / days * 365.25 : null
  return {
    fills: vlogs.length, miles, galUsed, totalSpend, totalGal,
    aggMpg, avgCpg, costPerMile, milesPerYear,
    lastOdo: last.odometer, lastDate: last.filled_at,
  }
}

// Current odometer = highest reading we've seen anywhere. extraOdo lets the
// caller feed in a telemetry-derived reading (OBD/GPS trip distance anchored
// to the last human-entered odometer, from telemetry_odometer() server-side) —
// so driving the car advances maintenance countdowns between fill-ups.
export function currentOdometer(vehicle, fuelLogs, serviceLogs, extraOdo = 0) {
  let max = Math.max(vehicle.base_odometer || 0, extraOdo || 0)
  for (const l of fuelLogs) if (l.vehicle_id === vehicle.id && l.odometer > max) max = l.odometer
  for (const s of serviceLogs) if (s.vehicle_id === vehicle.id && (s.odometer || 0) > max) max = s.odometer
  return max
}

// ===== Maintenance status =====
// Returns { status: 'overdue'|'due-soon'|'ok'|'baseline', dueMiles, dueDate, remainMiles, remainDays }
export function maintenanceStatus(item, currentOdo, today = new Date()) {
  const hasBaseline = item.last_done_miles != null || item.last_done_date != null
  if (!hasBaseline) return { status: 'baseline' }

  let remainMiles = null, dueMiles = null
  if (item.interval_miles && item.last_done_miles != null) {
    dueMiles = item.last_done_miles + item.interval_miles
    remainMiles = dueMiles - currentOdo
  }
  let remainDays = null, dueDate = null
  if (item.interval_months && item.last_done_date) {
    const d = new Date(item.last_done_date)
    d.setMonth(d.getMonth() + item.interval_months)
    dueDate = d
    remainDays = Math.round((d - today) / 86400000)
  }

  const overdue = (remainMiles != null && remainMiles <= 0) || (remainDays != null && remainDays <= 0)
  const soon = (remainMiles != null && remainMiles <= 1000) || (remainDays != null && remainDays <= 30)
  return {
    status: overdue ? 'overdue' : soon ? 'due-soon' : 'ok',
    dueMiles, dueDate, remainMiles, remainDays,
  }
}

// ===== TCO =====
export function tco(vehicle, fuelLogs, serviceLogs) {
  const fs = fuelStats(fuelLogs, vehicle.id)
  const svc = serviceLogs.filter(s => s.vehicle_id === vehicle.id)
  const svcSpend = svc.reduce((s, x) => s + Number(x.cost || 0), 0)
  const fuelSpend = fs ? fs.totalSpend : 0
  const miles = fs ? fs.miles : 0
  return {
    fuelSpend, svcSpend, totalSpend: fuelSpend + svcSpend,
    miles,
    costPerMile: miles > 0 ? (fuelSpend + svcSpend - (fs ? Number(fuelLogs.filter(l=>l.vehicle_id===vehicle.id).sort((a,b)=>a.odometer-b.odometer)[0]?.total_cost||0) : 0)) / miles : null,
  }
}

// Annualized total of a vehicle's fixed costs (insurance, registration, ...)
export function fixedCostsAnnual(fixedCosts, vehicleId) {
  return fixedCosts
    .filter(c => c.vehicle_id === vehicleId)
    .reduce((s, c) => s + Number(c.amount) * (c.period === 'month' ? 12 : 1), 0)
}

// Full TCO rollup: fuel + service + fixed, normalized to $/mile.
// - fuelCPM comes from fuelStats (avg $/gal ÷ aggregate MPG)
// - svcCPM spreads service spend over the observed fuel-log miles
// - fixedCPM spreads annualized fixed costs over the observed miles/year rate
// Components can be null independently when there isn't enough data; totals
// sum whatever is available so the number firms up as history accumulates.
export function tcoRollup(vehicle, fuelLogs, serviceLogs, fixedCosts) {
  const fs = fuelStats(fuelLogs, vehicle.id)
  const svcSpend = serviceLogs
    .filter(s => s.vehicle_id === vehicle.id)
    .reduce((s, x) => s + Number(x.cost || 0), 0)
  const fixedAnnual = fixedCostsAnnual(fixedCosts, vehicle.id)

  const miles = fs?.miles || 0
  const milesPerYear = fs?.milesPerYear || null
  const fuelCPM = fs?.costPerMile ?? null
  const svcCPM = miles > 0 ? svcSpend / miles : null
  const fixedCPM = (milesPerYear && fixedAnnual > 0) ? fixedAnnual / milesPerYear : null

  const parts = [fuelCPM, svcCPM, fixedCPM].filter(v => v != null)
  const totalCPM = parts.length ? parts.reduce((a, b) => a + b, 0) : null
  const annualEst = (totalCPM != null && milesPerYear) ? totalCPM * milesPerYear : null

  return {
    fuelSpend: fs?.totalSpend || 0, svcSpend, fixedAnnual,
    miles, milesPerYear,
    fuelCPM, svcCPM, fixedCPM, totalCPM, annualEst,
  }
}

// Rolling usage rate from logged fuel history (null until ≥14 days of history)
export function milesPerDay(fuelLogs, vehicleId) {
  const fs = fuelStats(fuelLogs, vehicleId)
  return fs?.milesPerYear ? fs.milesPerYear / 365.25 : null
}

// Project every tracked interval to a calendar date. Mile-based intervals are
// converted through the vehicle's rolling miles/day; date-based intervals are
// exact. Returns entries sorted soonest-first; overdue items pin to today.
export function forecastMaintenance(vehicles, fuelLogs, serviceLogs, maintItems, today = new Date(), extraOdos = {}) {
  const out = []
  for (const v of vehicles) {
    const odo = currentOdometer(v, fuelLogs, serviceLogs, extraOdos[v.id])
    const mpd = milesPerDay(fuelLogs, v.id)
    for (const m of maintItems.filter(i => i.vehicle_id === v.id)) {
      const st = maintenanceStatus(m, odo, today)
      if (st.status === 'baseline') continue
      if (st.status === 'overdue') {
        out.push({ vehicle: v, item: m, st, dueDate: new Date(today), overdue: true, basis: 'overdue now' })
        continue
      }
      let dueDate = null, basis = null
      if (st.remainDays != null) {
        dueDate = new Date(today.getTime() + st.remainDays * 86400000)
        basis = 'calendar'
      }
      if (st.remainMiles != null && mpd) {
        const d = new Date(today.getTime() + (st.remainMiles / mpd) * 86400000)
        if (!dueDate || d < dueDate) { dueDate = d; basis = `~${Math.round(mpd)} mi/day` }
      }
      if (dueDate) out.push({ vehicle: v, item: m, st, dueDate, overdue: false, basis })
    }
  }
  return out.sort((a, b) => a.dueDate - b.dueDate)
}

// ===== formatting =====
export const fmt = {
  money: v => v == null ? '—' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  money0: v => v == null ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'),
  mpg: v => v == null ? '—' : Number(v).toFixed(1),
  num: v => v == null ? '—' : Number(v).toLocaleString('en-US'),
  gal: v => v == null ? '—' : Number(v).toFixed(3),
  cpm: v => v == null ? '—' : '$' + Number(v).toFixed(3),
  date: v => v == null ? '—' : v,
}
