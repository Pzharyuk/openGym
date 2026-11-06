// Fuel diary on this device, synced through /api/fuel when signed in.
// Kept out of the workout profile on purpose: a meal must not ride PUT /api/data.
// mergeFuel stays in step with api/fuel.js — the server is the one that enforces it.
import { api } from './api.js'
import { todayISO } from './format.js'

export const WATER_GLASSES = 8
const DAY = /^\d{4}-\d{2}-\d{2}$/

const num = (value, max, decimals = 1) => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  const rounded = decimals === 0 ? Math.round(n) : Math.round(n * 10) / 10
  return Math.min(max, rounded)
}
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function sanitizeMeal(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id, 40)
  const day = text(raw.day, 10)
  if (!id || !DAY.test(day)) return null
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 12).map(row => {
    const name = text(row?.name, 80)
    if (!name) return null
    return { name, amount: text(row?.amount, 40), kcal: num(row?.kcal, 2500, 0), protein: num(row?.protein, 300), carbs: num(row?.carbs, 400), fat: num(row?.fat, 200) }
  }).filter(Boolean) : []
  return {
    id, day, t: num(raw.t, 1e15, 0), name: text(raw.name, 80) || 'Meal', items,
    kcal: num(raw.kcal, 8000, 0), protein: num(raw.protein, 500), carbs: num(raw.carbs, 800), fat: num(raw.fat, 400),
    note: text(raw.note, 240), source: raw.source === 'manual' ? 'manual' : 'ai', adjusted: raw.adjusted === true,
    confidence: raw.confidence === 'low' || raw.confidence === 'high' ? raw.confidence : 'medium'
  }
}

export function sanitizeDoc(raw) {
  const meals = []
  const seen = new Set()
  for (const row of raw?.meals || []) {
    const meal = sanitizeMeal(row)
    if (!meal || seen.has(meal.id)) continue
    seen.add(meal.id)
    meals.push(meal)
  }
  meals.sort((a, b) => b.t - a.t)
  const tombs = []
  const tombSeen = new Set()
  for (const row of raw?.tombs || []) {
    const id = text(row?.id, 40)
    if (!id || tombSeen.has(id)) continue
    tombSeen.add(id)
    tombs.push({ id, t: num(row?.t, 1e15, 0) })
  }
  const dead = new Map(tombs.map(x => [x.id, x.t]))
  const kept = meals.filter(m => !dead.has(m.id) || m.t > dead.get(m.id))
  const water = []
  const days = new Set()
  for (const row of raw?.water || []) {
    const day = text(row?.day, 10)
    if (!DAY.test(day) || days.has(day)) continue
    days.add(day)
    water.push({ day, glasses: Math.min(30, num(row?.glasses, 30, 0)), t: num(row?.t, 1e15, 0) })
  }
  const targetRaw = raw?.target && typeof raw.target === 'object' ? raw.target : {}
  return {
    meals: kept.slice(0, 2000),
    water: water.slice(0, 800),
    tombs: tombs.slice(0, 400),
    target: {
      kcal: Math.max(500, num(targetRaw.kcal ?? 2200, 8000, 0) || 2200),
      protein: num(targetRaw.protein ?? 150, 400, 0),
      t: num(targetRaw.t, 1e15, 0)
    }
  }
}

export function mergeFuel(a, b) {
  const meals = new Map()
  for (const row of [...(a?.meals || []), ...(b?.meals || [])]) {
    const meal = sanitizeMeal(row)
    if (!meal) continue
    const prev = meals.get(meal.id)
    if (!prev || meal.t >= prev.t) meals.set(meal.id, meal)
  }
  const water = new Map()
  for (const row of [...(a?.water || []), ...(b?.water || [])]) {
    const day = textOf(row?.day)
    if (!DAY.test(day)) continue
    const next = { day, glasses: Math.min(30, num(row?.glasses, 30, 0)), t: num(row?.t, 1e15, 0) }
    const prev = water.get(day)
    if (!prev || next.t >= prev.t) water.set(day, next)
  }
  const tombs = new Map()
  for (const row of [...(a?.tombs || []), ...(b?.tombs || [])]) {
    const id = typeof row?.id === 'string' ? row.id.trim().slice(0, 40) : ''
    if (!id) continue
    const t = num(row?.t, 1e15, 0)
    const prev = tombs.get(id)
    if (!prev || t >= prev.t) tombs.set(id, { id, t })
  }
  const target = num(b?.target?.t, 1e15, 0) >= num(a?.target?.t, 1e15, 0) ? b?.target : a?.target
  return sanitizeDoc({ meals: [...meals.values()], water: [...water.values()], tombs: [...tombs.values()], target })
}

const textOf = day => (typeof day === 'string' ? day.trim().slice(0, 10) : '')

const keyOf = uid => 'opengym-fuel:' + (uid || 'guest')

export function emptyDoc() {
  return { ...sanitizeDoc({}), rev: 0, dirty: false, localGen: 0 }
}

export function loadFuel(uid) {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(uid)) || 'null')
    if (!raw || typeof raw !== 'object') return emptyDoc()
    const doc = sanitizeDoc(raw)
    doc.rev = num(raw.rev, 1e15, 0)
    doc.dirty = raw.dirty === true
    doc.localGen = num(raw.localGen, 1e15, 0)
    return doc
  } catch {
    return emptyDoc()
  }
}

function saveLocal(uid, doc) {
  localStorage.setItem(keyOf(uid), JSON.stringify(doc))
  return doc
}

let gen = 0
export function commitFuel(uid, recipe) {
  const cur = loadFuel(uid)
  const next = sanitizeDoc(recipe(cur))
  next.rev = cur.rev || 0
  next.dirty = !!uid
  next.localGen = ++gen
  saveLocal(uid, next)
  if (uid) void pushFuel(uid)
  return next
}

let pushing = null
let pushAgain = false

export async function pushFuel(uid) {
  if (!uid) return
  if (pushing) { pushAgain = true; return pushing }
  pushing = (async () => {
    let guard = 0
    while (guard++ < 4) {
      const snap = loadFuel(uid)
      if (!snap.dirty) return
      const sentGen = snap.localGen || 0
      try {
        const r = await api('/api/fuel', { method: 'PUT', body: JSON.stringify({ baseRev: snap.rev || 0, doc: snap }) })
        const cur = loadFuel(uid)
        cur.rev = r.rev
        if ((cur.localGen || 0) === sentGen) cur.dirty = false
        saveLocal(uid, cur)
        if ((cur.localGen || 0) !== sentGen) continue
        return
      } catch (e) {
        if (e.status === 409 && e.data?.doc) {
          const cur = loadFuel(uid)
          const merged = mergeFuel(e.data.doc, cur)
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
    if (pushAgain) { pushAgain = false; return pushFuel(uid) }
  }
}

export async function pullFuel(uid) {
  if (!uid) return loadFuel(null)
  try {
    const r = await api('/api/fuel')
    const local = loadFuel(uid)
    const merged = mergeFuel(r.doc, local.dirty ? local : r.doc)
    const latest = loadFuel(uid)
    const base = latest.localGen !== local.localGen ? mergeFuel(merged, latest) : merged
    base.rev = r.rev || 0
    base.localGen = latest.localGen || 0
    const changed = JSON.stringify(sanitizeDoc(base)) !== JSON.stringify(sanitizeDoc(r.doc)) || latest.localGen !== local.localGen
    base.dirty = changed
    saveLocal(uid, base)
    if (changed) void pushFuel(uid)
    return loadFuel(uid)
  } catch {
    return loadFuel(uid)
  }
}

export function todayFuelSummary(uid, day = todayISO()) {
  const meals = loadFuel(uid).meals.filter(m => m.day === day)
  return { count: meals.length, kcal: meals.reduce((s, m) => s + (m.kcal || 0), 0) }
}

export function prevDay(iso) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() - 1)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export function foodStreak(meals, today = todayISO()) {
  const days = new Set((meals || []).map(m => m.day))
  let cursor = days.has(today) ? today : prevDay(today)
  if (!days.has(cursor)) return 0
  let n = 0
  while (days.has(cursor)) { n++; cursor = prevDay(cursor) }
  return n
}

export function resizePhoto(file, maxEdge = 1024, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.width * scale))
      canvas.height = Math.max(1, Math.round(img.height * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo')) }
    img.src = url
  })
}
