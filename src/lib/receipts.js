import { supabase } from './supabase.js'
import { downscaleImage, blobToBase64 } from './images.js'
import { localToday } from './calc.js'

// Downscale images before OCR/upload: receipts photographed at 12MP waste
// tokens and storage. ~1600px long edge is plenty for receipt text.
const MAX_EDGE = 1600

// Normalize the file once: returns { blob, mediaType, ext }
export async function prepareReceiptFile(file) {
  if (file.type === 'application/pdf') {
    return { blob: file, mediaType: 'application/pdf', ext: 'pdf' }
  }
  const blob = await downscaleImage(file, MAX_EDGE)
  return { blob, mediaType: 'image/jpeg', ext: 'jpg' }
}

export async function uploadReceipt(prepared, vehicleId) {
  const { data: { user } } = await supabase.auth.getUser()
  const path = `${user.id}/${vehicleId}/${Date.now()}.${prepared.ext}`
  const { error } = await supabase.storage.from('receipts')
    .upload(path, prepared.blob, { contentType: prepared.mediaType })
  if (error) throw error
  return path
}

export async function ocrReceipt(prepared) {
  const data = await blobToBase64(prepared.blob)
  const { data: result, error } = await supabase.functions.invoke('ocr-receipt', {
    body: { media_type: prepared.mediaType, data },
  })
  if (error) throw error
  if (result?.error) throw new Error(result.error)
  return result
}

export async function receiptUrl(path) {
  const { data, error } = await supabase.storage.from('receipts')
    .createSignedUrl(path, 300)
  if (error) throw error
  return data.signedUrl
}

// Map an OCR extraction to the service-log form fields. Pure — regression-tested.
export function extractionToService(x) {
  const parts = (x.line_items || [])
    .filter(li => li.description)
    .map(li => {
      let s = li.description
      if (li.part_number) s += ` (${li.part_number})`
      if (li.quantity && li.quantity > 1) s += ` x${li.quantity}`
      return s
    })
    .join('; ')
  return {
    serviced_at: x.receipt_date || localToday(),
    odometer: x.odometer != null ? String(x.odometer) : '',
    service_type: x.service_type || 'Other',
    parts,
    cost: x.total != null ? String(x.total) : '',
    shop: x.vendor || '',
    notes: [x.notes, x.payment_method ? `Paid: ${x.payment_method}` : null]
      .filter(Boolean).join(' · '),
  }
}

// Map an OCR extraction to the fuel fill-up form fields. Pure — regression-tested.
// Fuel receipts rarely itemize gallons in the structured extraction, so we do NOT
// guess gallons: the form's own auto-derive (total + $/gal → gallons) handles it.
export function extractionToFuel(x) {
  return {
    filled_at: x.receipt_date || localToday(),
    odometer: x.odometer != null ? String(x.odometer) : '',
    total_cost: x.total != null ? String(x.total) : '',
    brand: x.vendor || '',
    location: x.location || '',
  }
}

// Does this PostgREST/Postgres error mean the receipts.fuel_log_id column is
// missing (migration 0014 not yet applied)? Pure — lets callers degrade the
// insert gracefully (save the receipt row unlinked rather than losing it).
export function isMissingFuelLogIdColumn(error) {
  const m = `${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`
  return /fuel_log_id/.test(m) &&
    /(column|does not exist|schema cache|could not find|find the)/i.test(m)
}

// Insert a receipts row linked to a fuel_logs row. If the fuel_log_id column is
// missing, retry without it so the receipt is still saved (just unlinked).
// Returns { error, linked, degraded }.
export async function insertFuelReceipt(row) {
  const { error } = await supabase.from('receipts').insert(row)
  if (error && isMissingFuelLogIdColumn(error)) {
    const { fuel_log_id, ...rest } = row
    const { error: retryErr } = await supabase.from('receipts').insert(rest)
    if (retryErr) return { error: retryErr, linked: false, degraded: false }
    return { error: null, linked: false, degraded: true }
  }
  if (error) return { error, linked: false, degraded: false }
  return { error: null, linked: true, degraded: false }
}
