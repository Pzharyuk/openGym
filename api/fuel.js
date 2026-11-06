/* Fuel — calorie log beside the workout profile, not inside it.
   Stored as ./data/fuel-<uid>.json. The workout document (state-<uid>.json)
   is never read or written here, so a meal cannot ride a profile sync.
   AGPL-3.0-or-later, same terms as the rest of openGym. */
import fs from 'node:fs'
import path from 'node:path'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_MEALS = 2000
const MAX_TOMBS = 400
const MAX_WATER = 800
const ESTIMATE_HOUR = 30

const PROMPT = `You estimate the nutrition of one meal from a photo and/or a short description.
Return JSON only, no markdown, with this exact shape:
{"name": string, "items": [{"name": string, "amount": string, "kcal": number, "protein": number, "carbs": number, "fat": number}], "kcal": number, "protein": number, "carbs": number, "fat": number, "confidence": "low"|"medium"|"high", "note": string}
Rules:
- Macros are grams. kcal is kilocalories. Use numbers, not strings.
- Meal kcal/protein/carbs/fat must equal the sum of items.
- Include only foods that are visible or described. Typical home or restaurant portions when size is unclear.
- If the photo is ambiguous, still estimate and set confidence to low. Say the assumption in note (one sentence).
- name is a short title, six words or fewer.
- If a previous estimate and a correction are included, treat the correction as fact. Change only what the user disputes. Drop foods they say they did not eat. Scale portions when they say half, a bite, or extra.`

const hits = new Map()

export function emptyFuel() {
  return { meals: [], water: [], tombs: [], target: { kcal: 2200, protein: 150, t: 0 } }
}

const num = (value, max, decimals = 1) => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  const rounded = decimals === 0 ? Math.round(n) : Math.round(n * 10) / 10
  return Math.min(max, rounded)
}

const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = clip(raw.name, 80)
  if (!name) return null
  return {
    name,
    amount: clip(raw.amount, 40),
    kcal: num(raw.kcal, 2500, 0),
    protein: num(raw.protein, 300),
    carbs: num(raw.carbs, 400),
    fat: num(raw.fat, 200)
  }
}

function sanitizeMeal(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = clip(raw.id, 40)
  const day = clip(raw.day, 10)
  if (!id || !DAY.test(day)) return null
  const items = Array.isArray(raw.items) ? raw.items.map(sanitizeItem).filter(Boolean).slice(0, 12) : []
  return {
    id,
    day,
    t: num(raw.t, 1e15, 0),
    name: clip(raw.name, 80) || 'Meal',
    items,
    kcal: num(raw.kcal, 8000, 0),
    protein: num(raw.protein, 500),
    carbs: num(raw.carbs, 800),
    fat: num(raw.fat, 400),
    note: clip(raw.note, 240),
    source: raw.source === 'manual' ? 'manual' : 'ai',
    adjusted: raw.adjusted === true,
    confidence: raw.confidence === 'low' || raw.confidence === 'high' ? raw.confidence : 'medium'
  }
}

export function sanitizeDoc(raw) {
  const meals = []
  const seen = new Set()
  for (const row of Array.isArray(raw?.meals) ? raw.meals : []) {
    const meal = sanitizeMeal(row)
    if (!meal || seen.has(meal.id)) continue
    seen.add(meal.id)
    meals.push(meal)
  }
  meals.sort((a, b) => b.t - a.t)
  if (meals.length > MAX_MEALS) meals.length = MAX_MEALS

  const tombs = []
  const tombSeen = new Set()
  for (const row of Array.isArray(raw?.tombs) ? raw.tombs : []) {
    const id = clip(row?.id, 40)
    if (!id || tombSeen.has(id)) continue
    tombSeen.add(id)
    tombs.push({ id, t: num(row?.t, 1e15, 0) })
  }
  tombs.sort((a, b) => b.t - a.t)
  if (tombs.length > MAX_TOMBS) tombs.length = MAX_TOMBS

  const dead = new Map(tombs.map(x => [x.id, x.t]))
  const kept = meals.filter(m => !dead.has(m.id) || m.t > dead.get(m.id))

  const water = []
  const days = new Set()
  for (const row of Array.isArray(raw?.water) ? raw.water : []) {
    const day = clip(row?.day, 10)
    if (!DAY.test(day) || days.has(day)) continue
    days.add(day)
    water.push({ day, glasses: Math.min(30, num(row?.glasses, 30, 0)), t: num(row?.t, 1e15, 0) })
  }
  water.sort((a, b) => (a.day < b.day ? 1 : -1))
  if (water.length > MAX_WATER) water.length = MAX_WATER

  const targetRaw = raw?.target && typeof raw.target === 'object' ? raw.target : {}
  const target = {
    kcal: Math.max(500, num(targetRaw.kcal ?? 2200, 8000, 0) || 2200),
    protein: num(targetRaw.protein ?? 150, 400, 0) || 0,
    t: num(targetRaw.t, 1e15, 0)
  }
  if (target.kcal < 500) target.kcal = 2200
  return { meals: kept, water, tombs, target }
}

export function mergeFuel(a, b) {
  const tombs = new Map()
  for (const row of [...(a?.tombs || []), ...(b?.tombs || [])]) {
    const id = clip(row?.id, 40)
    if (!id) continue
    const prev = tombs.get(id)
    const t = num(row?.t, 1e15, 0)
    if (!prev || t >= prev.t) tombs.set(id, { id, t })
  }
  const meals = new Map()
  for (const row of [...(a?.meals || []), ...(b?.meals || [])]) {
    const meal = sanitizeMeal(row)
    if (!meal) continue
    const prev = meals.get(meal.id)
    if (!prev || meal.t >= prev.t) meals.set(meal.id, meal)
  }
  const water = new Map()
  for (const row of [...(a?.water || []), ...(b?.water || [])]) {
    const day = clip(row?.day, 10)
    if (!DAY.test(day)) continue
    const next = { day, glasses: Math.min(30, num(row?.glasses, 30, 0)), t: num(row?.t, 1e15, 0) }
    const prev = water.get(day)
    if (!prev || next.t >= prev.t) water.set(day, next)
  }
  const ta = a?.target && typeof a.target === 'object' ? a.target : {}
  const tb = b?.target && typeof b.target === 'object' ? b.target : {}
  const target = num(tb.t, 1e15, 0) >= num(ta.t, 1e15, 0) ? tb : ta
  return sanitizeDoc({
    meals: [...meals.values()],
    water: [...water.values()],
    tombs: [...tombs.values()],
    target
  })
}

const safeUid = uid => String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '')
export const fuelPath = (dataDir, uid) => path.join(dataDir, 'fuel-' + safeUid(uid) + '.json')

function atomicWrite(file, content) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readFuel(dataDir, uid) {
  try {
    const raw = JSON.parse(fs.readFileSync(fuelPath(dataDir, uid), 'utf8'))
    const doc = sanitizeDoc(raw)
    const rev = Number.isInteger(raw?._rev) && raw._rev > 0 ? raw._rev : 0
    return { doc, rev }
  } catch {
    return { doc: emptyFuel(), rev: 0 }
  }
}

export function writeFuel(dataDir, uid, doc, rev) {
  const next = sanitizeDoc(doc)
  const stored = { ...next, _rev: rev }
  atomicWrite(fuelPath(dataDir, uid), JSON.stringify(stored))
  return { doc: next, rev }
}

export function parseEstimate(text) {
  const start = String(text || '').indexOf('{')
  const end = String(text || '').lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw
  try { raw = JSON.parse(String(text).slice(start, end + 1)) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const items = []
  if (Array.isArray(raw.items)) {
    for (const row of raw.items.slice(0, 12)) {
      const item = sanitizeItem(row)
      if (item) items.push(item)
    }
  }
  const summed = items.reduce((acc, item) => ({
    kcal: acc.kcal + item.kcal,
    protein: acc.protein + item.protein,
    carbs: acc.carbs + item.carbs,
    fat: acc.fat + item.fat
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 })
  const kcal = num(raw.kcal, 6000, 0) || summed.kcal
  const protein = num(raw.protein, 500) || Math.round(summed.protein * 10) / 10
  const carbs = num(raw.carbs, 800) || Math.round(summed.carbs * 10) / 10
  const fat = num(raw.fat, 400) || Math.round(summed.fat * 10) / 10
  if (kcal <= 0 && !items.length) return null
  const name = clip(raw.name, 80) || 'Meal'
  return {
    name,
    items: items.length ? items : [{ name, amount: '', kcal, protein, carbs, fat }],
    kcal, protein, carbs, fat,
    confidence: raw.confidence === 'low' || raw.confidence === 'high' ? raw.confidence : 'medium',
    note: clip(raw.note, 240)
  }
}

function chatText(body) {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('')
  return ''
}

function responsesText(body) {
  if (typeof body?.output_text === 'string' && body.output_text.trim()) return body.output_text
  const chunks = []
  for (const item of body?.output || []) {
    for (const part of item?.content || []) if (part?.text) chunks.push(part.text)
  }
  return chunks.join('\n')
}

async function postJSON(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, json }
}

function limited(uid) {
  const now = Date.now()
  const arr = (hits.get(uid) || []).filter(t => now - t < 3600000)
  if (arr.length >= ESTIMATE_HOUR) { hits.set(uid, arr); return true }
  arr.push(now)
  hits.set(uid, arr)
  return false
}

async function estimateMeal(body) {
  const description = clip(body?.description, 800)
  if (typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length > 1600000) {
    return { status: 400, error: 'That photo is too large. Try a closer crop.' }
  }
  const image = typeof body?.imageDataUrl === 'string' && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  if (body?.imageDataUrl && !image) return { status: 400, error: 'Use a JPEG, PNG, or WebP photo.' }
  const correction = clip(body?.correction, 400)
  const previous = clip(body?.previous, 4000)
  if (!description && !image && !correction) return { status: 400, error: 'Add a photo or describe the meal.' }
  const apiKey = process.env.XAI_API_KEY || ''
  if (!apiKey) return { status: 503, error: 'AI meal estimates are unavailable right now.' }

  const parts = [PROMPT]
  if (description) parts.push('Description: ' + description)
  else if (!correction) parts.push('No written description. Use the photo only.')
  if (previous && correction) {
    parts.push('Previous estimate JSON:\n' + previous)
    parts.push('The user says this is wrong: ' + correction)
  }
  const userText = parts.join('\n\n')
  const chatContent = [{ type: 'text', text: userText }]
  if (image) chatContent.push({ type: 'image_url', image_url: { url: image } })

  let textOut = ''
  try {
    const chat = await postJSON('https://api.x.ai/v1/chat/completions', apiKey, {
      model: 'grok-4.5',
      temperature: 0.2,
      max_tokens: 800,
      messages: [{ role: 'user', content: image ? chatContent : userText }]
    })
    if (chat.ok) textOut = chatText(chat.json)
    else if (image) {
      const fallback = await postJSON('https://api.x.ai/v1/responses', apiKey, {
        model: 'grok-4.7',
        input: [{ role: 'user', content: [{ type: 'input_text', text: userText }, { type: 'input_image', image_url: image, detail: 'high' }] }]
      })
      if (!fallback.ok) return { status: 502, error: 'Could not read that meal. Try describing it in a sentence.' }
      textOut = responsesText(fallback.json)
    } else return { status: 502, error: 'Could not estimate that meal. Try again in a moment.' }
  } catch {
    return { status: 502, error: 'Could not estimate that meal. Try again in a moment.' }
  }
  const estimate = parseEstimate(textOut)
  if (!estimate) return { status: 502, error: 'The estimate came back unreadable. Try again.' }
  return { status: 200, estimate }
}

export function fuelRoutes({ json, readBody, readSession, dataDir }) {
  return {
    'GET /api/fuel': (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const { doc, rev } = readFuel(dataDir, user.id)
      json(res, 200, { doc, rev })
    },
    'PUT /api/fuel': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const body = await readBody(req)
      if (!body.doc || typeof body.doc !== 'object' || Array.isArray(body.doc)) return json(res, 400, { error: 'doc required' })
      const cur = readFuel(dataDir, user.id)
      if (body.baseRev != null && body.baseRev !== cur.rev) {
        return json(res, 409, { error: 'conflict', rev: cur.rev, doc: cur.doc })
      }
      const saved = writeFuel(dataDir, user.id, body.doc, cur.rev + 1)
      json(res, 200, { ok: true, rev: saved.rev, doc: saved.doc })
    },
    'POST /api/fuel/estimate': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id)) return json(res, 429, { error: 'Too many estimates. Try again in a little while.' })
      const body = await readBody(req)
      const result = await estimateMeal(body)
      if (result.estimate) return json(res, 200, { ok: true, estimate: result.estimate })
      json(res, result.status, { error: result.error })
    }
  }
}
