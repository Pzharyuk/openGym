/* Progress measurements beside the workout profile, not inside it.
   Stored as ./data/measure-<uid>.json. A photo is a lesson, not a medical scan.
   AGPL-3.0-or-later, same terms as the rest of openGym. */
import fs from 'node:fs'
import path from 'node:path'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_CHECKS = 120
const HOUR = 20
const SITES = ['chest', 'waist', 'hips', 'neck', 'shoulders', 'arm', 'thigh', 'calf']

const hits = new Map()
const num = (value, max, decimals = 1) => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  const rounded = decimals === 0 ? Math.round(n) : Math.round(n * 10) / 10
  return Math.min(max, rounded)
}
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

const PROMPT = `You are a measuring teacher. A person sent a photo of themselves, and maybe a note.
Guess every measurement from what you can see. A tape in the frame is a reading. A mirror selfie with no tape is still a guess, not a blank.
Return JSON only, no markdown:
{"chest": number, "waist": number, "hips": number, "neck": number, "shoulders": number, "arm": number, "thigh": number, "calf": number, "weight": number, "bodyFat": number, "confidence": "low"|"medium"|"high", "lesson": string, "steps": [string, string, string], "note": string}
Rules:
- Lengths are centimeters. weight is kilograms. bodyFat is a percent. Numbers, not strings.
- Fill every field with your best visual guess. Use 0 only for a site that is out of frame.
- No tape means confidence low. A clear tape on one site can be medium. Do not claim high unless a tape reading is visible.
- Keep guesses in a normal adult range unless the photo or note clearly says otherwise. If they give a height or a past measurement, use it.
- lesson is two sentences: what you assumed, and where a tape would go to check the least certain site.
- steps are three short checks they can do with a tape.
- note is one sentence naming the guess you are least sure about.
- If a correction is included, treat it as fact and only change what they dispute.`

export function emptyMeasure() {
  return { checks: [], rewards: [] }
}

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
  for (const key of SITES) out[key] = num(raw?.[key], 250)
  out.weight = num(raw?.weight, 400)
  out.bodyFat = num(raw?.bodyFat, 70)
  return out
}

function sanitizeCheck(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = clip(raw.id, 40)
  const day = clip(raw.day, 10)
  if (!id || !DAY.test(day)) return null
  const photo = typeof raw.photo === 'string' && /^data:image\/(jpeg|jpg|png|webp);/i.test(raw.photo) && raw.photo.length <= 180000
    ? raw.photo
    : ''
  const steps = []
  for (const step of Array.isArray(raw.steps) ? raw.steps : []) {
    const line = clip(step, 140)
    if (line && steps.length < 3) steps.push(line)
  }
  return {
    id,
    day,
    t: num(raw.t, 1e15, 0),
    ...sitesOf(raw),
    photo,
    lesson: clip(raw.lesson, 500),
    steps,
    note: clip(raw.note, 240),
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
  if (checks.length > MAX_CHECKS) checks.splice(0, checks.length - MAX_CHECKS)
  return { checks, rewards: rewardsFor(checks) }
}

export function parseReading(text) {
  const start = String(text || '').indexOf('{')
  const end = String(text || '').lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw
  try { raw = JSON.parse(String(text).slice(start, end + 1)) } catch { return null }
  const sites = sitesOf(raw)
  if (!Object.values(sites).some(n => n > 0) && !clip(raw?.lesson, 20)) return null
  const steps = []
  for (const step of Array.isArray(raw?.steps) ? raw.steps : []) {
    const line = clip(step, 140)
    if (line && steps.length < 3) steps.push(line)
  }
  return {
    ...sites,
    confidence: raw?.confidence === 'high' || raw?.confidence === 'low' ? raw.confidence : 'medium',
    lesson: clip(raw?.lesson, 500),
    steps,
    note: clip(raw?.note, 240)
  }
}

const safeUid = uid => String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '')
export const measurePath = (dataDir, uid) => path.join(dataDir, 'measure-' + safeUid(uid) + '.json')

function atomicWrite(file, content) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readMeasure(dataDir, uid) {
  try {
    const raw = JSON.parse(fs.readFileSync(measurePath(dataDir, uid), 'utf8'))
    const doc = sanitizeMeasure(raw)
    const rev = Number.isInteger(raw?._rev) && raw._rev > 0 ? raw._rev : 0
    return { doc, rev }
  } catch {
    return { doc: emptyMeasure(), rev: 0 }
  }
}

export function writeMeasure(dataDir, uid, doc, rev) {
  const next = sanitizeMeasure(doc)
  atomicWrite(measurePath(dataDir, uid), JSON.stringify({ ...next, _rev: rev }))
  return { doc: next, rev }
}

function limited(uid) {
  const now = Date.now()
  const arr = (hits.get(uid) || []).filter(t => now - t < 3600000)
  if (arr.length >= HOUR) { hits.set(uid, arr); return true }
  arr.push(now)
  hits.set(uid, arr)
  return false
}

function chatText(body) {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('')
  return ''
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

async function teach(body) {
  const note = clip(body?.note, 400)
  const correction = clip(body?.correction, 400)
  const previous = clip(body?.previous, 2000)
  const image = typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length <= 700000 && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  if (body?.imageDataUrl && !image) return { status: 400, error: 'Use a JPEG, PNG, or WebP photo.' }
  if (!image && !note && !correction) return { status: 400, error: 'Add a photo, or describe what you measured.' }
  const apiKey = process.env.XAI_API_KEY || ''
  if (!apiKey) return { status: 503, error: 'The measuring teacher is unavailable right now.' }
  const unit = body?.unit === 'lb' ? 'lb' : 'kg'
  const parts = [PROMPT]
  parts.push(unit === 'lb'
    ? 'Write lesson, steps, and note in pounds and inches. The JSON numbers themselves stay centimeters and kilograms.'
    : 'Write lesson, steps, and note in kilograms and centimeters. The JSON numbers are those units too.')
  if (note) parts.push('Note: ' + note)
  if (previous && correction) {
    parts.push('Previous check-in JSON:\n' + previous)
    parts.push('The user says this is wrong: ' + correction)
  } else if (previous) parts.push('Previous check-in JSON:\n' + previous)
  const userText = parts.join('\n\n')
  const content = [{ type: 'text', text: userText }]
  if (image) content.push({ type: 'image_url', image_url: { url: image } })
  try {
    const chat = await postJSON('https://api.x.ai/v1/chat/completions', apiKey, {
      model: 'grok-4.5',
      temperature: 0.2,
      max_tokens: 900,
      messages: [{ role: 'user', content: image ? content : userText }]
    })
    if (!chat.ok) return { status: 502, error: 'Could not read that photo. Try a clearer one, or type the tape numbers.' }
    const reading = parseReading(chatText(chat.json))
    if (!reading) return { status: 502, error: 'The lesson came back unreadable. Try again.' }
    return { status: 200, reading }
  } catch {
    return { status: 502, error: 'Could not read that photo. Try again in a moment.' }
  }
}

export function measureRoutes({ json, readBody, readSession, dataDir }) {
  return {
    'GET /api/measure': (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const { doc, rev } = readMeasure(dataDir, user.id)
      json(res, 200, { doc, rev })
    },
    'PUT /api/measure': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const body = await readBody(req)
      if (!body.doc || typeof body.doc !== 'object' || Array.isArray(body.doc)) return json(res, 400, { error: 'doc required' })
      const cur = readMeasure(dataDir, user.id)
      if (body.baseRev != null && body.baseRev !== cur.rev) return json(res, 409, { error: 'conflict', rev: cur.rev, doc: cur.doc })
      const saved = writeMeasure(dataDir, user.id, body.doc, cur.rev + 1)
      json(res, 200, { ok: true, rev: saved.rev, doc: saved.doc })
    },
    'POST /api/measure/read': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id)) return json(res, 429, { error: 'Too many lessons. Try again in a little while.' })
      const result = await teach(await readBody(req))
      if (result.reading) return json(res, 200, { ok: true, reading: result.reading })
      json(res, result.status, { error: result.error })
    }
  }
}
