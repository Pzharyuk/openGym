// Progress check-ins on this device, synced through /api/measure when signed in.
// Lengths are centimeters and weight is kilograms. The view converts for display.
import { api } from './api.js'

const DAY = /^\d{4}-\d{2}-\d{2}$/
export const SITES = [
  ['chest', 'Chest', 'cm'],
  ['waist', 'Waist', 'cm'],
  ['hips', 'Hips', 'cm'],
  ['neck', 'Neck', 'cm'],
  ['shoulders', 'Shoulders', 'cm'],
  ['arm', 'Arm', 'cm'],
  ['thigh', 'Thigh', 'cm'],
  ['calf', 'Calf', 'cm'],
  ['weight', 'Weight', 'kg'],
  ['bodyFat', 'Body fat', '%']
]
export const REWARDS = [
  ['first', 'First measure', 'One check-in on the books.'],
  ['four', 'Four check-ins', 'Four times with the tape.'],
  ['eight', 'Eight check-ins', 'Eight lessons in.'],
  ['month', 'A month of measuring', 'The first and latest are 28 days apart.'],
  ['habit', 'Weekly habit', 'Three check-ins, none more than 10 days apart.'],
  ['steady', 'Same tape, three times', 'Waist recorded three times.'],
  ['waist', 'Waist down', 'Waist is at least 2 cm under the first reading.']
]

const num = (value, max, decimals = 1) => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  const rounded = decimals === 0 ? Math.round(n) : Math.round(n * 10) / 10
  return Math.min(max, rounded)
}
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function daySpan(a, b) {
  const ms = Date.parse(b) - Date.parse(a)
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0
}

export function rewardsFor(checks) {
  const sorted = [...checks].sort((a, b) => a.t - b.t)
  const earned = []
  const award = (id, at) => { if (!earned.some(row => row.id === id)) earned.push({ id, at }) }
  if (sorted.length) award('first', sorted[0].t)
  if (sorted.length >= 4) award('four', sorted[3].t)
  if (sorted.length >= 8) award('eight', sorted[7].t)
  if (sorted.length >= 2 && daySpan(sorted[0].day, sorted.at(-1).day) >= 28) award('month', sorted.at(-1).t)
  for (let i = 2; i < sorted.length; i++) {
    if (daySpan(sorted[i - 2].day, sorted[i - 1].day) <= 10 && daySpan(sorted[i - 1].day, sorted[i].day) <= 10) {
      award('habit', sorted[i].t)
      break
    }
  }
  const taped = sorted.filter(row => row.waist > 0)
  if (taped.length >= 3) award('steady', taped[2].t)
  if (taped.length >= 2 && taped[0].waist - taped.at(-1).waist >= 2) award('waist', taped.at(-1).t)
  return earned
}

function sitesOf(raw) {
  const out = {}
  for (const [key] of SITES) {
    if (key === 'weight') out.weight = num(raw?.weight, 400)
    else if (key === 'bodyFat') out.bodyFat = num(raw?.bodyFat, 70)
    else out[key] = num(raw?.[key], 250)
  }
  return out
}

function sanitizeCheck(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 40)
  const day = text(raw.day, 10)
  if (!id || !DAY.test(day)) return null
  const photo = typeof raw.photo === 'string' && /^data:image\/(jpeg|jpg|png|webp);/i.test(raw.photo) && raw.photo.length <= 180000 ? raw.photo : ''
  const steps = []
  for (const step of Array.isArray(raw.steps) ? raw.steps : []) {
    const line = text(step, 140)
    if (line && steps.length < 3) steps.push(line)
  }
  return {
    id, day, t: num(raw.t, 1e15, 0), ...sitesOf(raw), photo,
    lesson: text(raw.lesson, 500), steps, note: text(raw.note, 240),
    confidence: raw.confidence === 'low' || raw.confidence === 'high' ? raw.confidence : 'medium',
    adjusted: raw.adjusted === true
  }
}

export function sanitizeMeasure(raw) {
  const checks = []
  const seen = new Set()
  for (const row of Array.isArray(raw?.checks) ? raw.checks : []) {
    const check = sanitizeCheck(row)
    if (!check || seen.has(check.id)) continue
    seen.add(check.id)
    checks.push(check)
  }
  checks.sort((a, b) => a.t - b.t)
  if (checks.length > 120) checks.splice(0, checks.length - 120)
  return { checks, rewards: rewardsFor(checks) }
}

export function mergeMeasure(a, b) {
  const map = new Map()
  for (const row of [...(a?.checks || []), ...(b?.checks || [])]) {
    const check = sanitizeCheck(row)
    if (!check) continue
    const prev = map.get(check.id)
    if (!prev || check.t >= prev.t) map.set(check.id, check)
  }
  return sanitizeMeasure({ checks: [...map.values()] })
}

const keyOf = uid => 'opengym-measure:' + (uid || 'guest')

export function loadMeasure(uid) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(uid)) || 'null')
    if (!raw || typeof raw !== 'object') return emptyLocal()
    const doc = sanitizeMeasure(raw)
    doc.rev = num(raw.rev, 1e15, 0)
    doc.dirty = raw.dirty === true
    doc.localGen = num(raw.localGen, 1e15, 0)
    return doc
  } catch {
    return emptyLocal()
  }
}

function emptyLocal() {
  return { ...sanitizeMeasure({}), rev: 0, dirty: false, localGen: 0 }
}

function saveLocal(uid, doc) {
  localStorage.setItem(keyOf(uid), JSON.stringify(doc))
  return doc
}

let gen = 0
export function commitMeasure(uid, recipe) {
  const cur = loadMeasure(uid)
  const next = sanitizeMeasure(recipe(cur))
  next.rev = cur.rev || 0
  next.dirty = !!uid
  next.localGen = ++gen
  saveLocal(uid, next)
  if (uid) void pushMeasure(uid)
  return next
}

let pushing = null
let pushAgain = false
export async function pushMeasure(uid) {
  if (!uid) return
  if (pushing) { pushAgain = true; return pushing }
  pushing = (async () => {
    let guard = 0
    while (guard++ < 4) {
      const snap = loadMeasure(uid)
      if (!snap.dirty) return
      const sentGen = snap.localGen || 0
      try {
        const r = await api('/api/measure', { method: 'PUT', body: JSON.stringify({ baseRev: snap.rev || 0, doc: snap }) })
        const cur = loadMeasure(uid)
        const fresh = sanitizeMeasure(r.doc || cur)
        fresh.rev = r.rev
        fresh.dirty = (cur.localGen || 0) !== sentGen
        fresh.localGen = cur.localGen
        saveLocal(uid, fresh)
        if (fresh.dirty) continue
        return
      } catch (e) {
        if (e.status === 409 && e.data?.doc) {
          const cur = loadMeasure(uid)
          const merged = mergeMeasure(e.data.doc, cur)
          merged.rev = e.data.rev
          merged.dirty = true
          merged.localGen = cur.localGen
          saveLocal(uid, merged)
          continue
        }
        return
      }
    }
  })()
  try { return await pushing }
  finally {
    pushing = null
    if (pushAgain) { pushAgain = false; return pushMeasure(uid) }
  }
}

export async function pullMeasure(uid) {
  if (!uid) return loadMeasure(null)
  try {
    const r = await api('/api/measure')
    const local = loadMeasure(uid)
    const merged = mergeMeasure(r.doc, local.dirty ? local : r.doc)
    merged.rev = r.rev
    merged.dirty = local.dirty
    merged.localGen = local.localGen
    saveLocal(uid, merged)
    if (local.dirty) void pushMeasure(uid)
    return loadMeasure(uid)
  } catch {
    return loadMeasure(uid)
  }
}

export function latestSite(doc, key) {
  for (let i = doc.checks.length - 1; i >= 0; i--) if (doc.checks[i][key] > 0) return doc.checks[i]
  return null
}
