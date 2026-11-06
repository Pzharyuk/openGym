/* A photo or short clip becomes a workout, then an Imagine clip of the movement.
   Catalog exercises use the same image-to-video path: the still becomes a short guide.
   AGPL-3.0-or-later, same terms as the rest of openGym. */
import fs from 'node:fs'
import path from 'node:path'

const PARTS = ['back', 'cardio', 'chest', 'lower arms', 'lower legs', 'neck', 'shoulders', 'upper arms', 'upper legs', 'waist']
const GEAR = ['assisted', 'band', 'barbell', 'body weight', 'cable', 'dumbbell', 'ez barbell', 'kettlebell', 'leverage machine', 'resistance band', 'smith machine', 'weighted']
const MUSCLES = ['trapezius', 'deltoids', 'chest', 'upper-back', 'biceps', 'triceps', 'forearm', 'abs', 'obliques', 'lower-back', 'gluteal', 'quadriceps', 'hamstring', 'calves']
const PART_FOR = { chest: 'chest', back: 'back', shoulders: 'shoulders', deltoids: 'shoulders', legs: 'upper legs', quadriceps: 'upper legs', hamstring: 'upper legs', gluteal: 'upper legs', arms: 'upper arms', biceps: 'upper arms', triceps: 'upper arms', core: 'waist', abs: 'waist', cardio: 'cardio' }

const PROMPT = `You turn a photo or a few frames of a video into one gym workout.
Return JSON only, no markdown:
{"name": string, "note": string, "moves": [{"name": string, "bodyPart": string, "equipment": string, "muscle": string, "sets": number, "reps": string, "cues": [string, string, string]}]}
bodyPart is one of: ${PARTS.join(', ')}.
equipment is one of: ${GEAR.join(', ')}.
muscle is one of: ${MUSCLES.join(', ')}.
Rules:
- One move per distinct exercise. At most 8.
- If the picture is one person doing one exercise, return that one move.
- sets is 2 to 5. reps is like "8" or "10-12" or "30 sec".
- cues are three short form lines a person can follow while the clip loops.
- If a correction is included, treat it as fact.`

const hits = new Map()
const clip = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function limited(uid, cap) {
  const now = Date.now()
  const key = uid + ':' + cap
  const arr = (hits.get(key) || []).filter(t => now - t < 3600000)
  if (arr.length >= cap) { hits.set(key, arr); return true }
  arr.push(now)
  hits.set(key, arr)
  return false
}

function oneOf(value, list, fallback) {
  const raw = clip(value, 40).toLowerCase()
  return list.includes(raw) ? raw : (PART_FOR[raw] && list.includes(PART_FOR[raw]) ? PART_FOR[raw] : fallback)
}

export function parseWorkout(text) {
  const start = String(text || '').indexOf('{')
  const end = String(text || '').lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw
  try { raw = JSON.parse(String(text).slice(start, end + 1)) } catch { return null }
  const moves = []
  for (const row of Array.isArray(raw?.moves) ? raw.moves : []) {
    const name = clip(row?.name, 80)
    if (!name || moves.length >= 8) continue
    const cues = []
    for (const cue of Array.isArray(row?.cues) ? row.cues : []) {
      const line = clip(cue, 80)
      if (line && cues.length < 3) cues.push(line)
    }
    moves.push({
      name,
      bodyPart: oneOf(row?.bodyPart, PARTS, 'waist'),
      equipment: oneOf(row?.equipment, GEAR, 'body weight'),
      muscle: oneOf(row?.muscle, MUSCLES, 'abs'),
      sets: num(row?.sets, 1, 6, 3),
      reps: clip(row?.reps, 16) || '10',
      cues
    })
  }
  if (!moves.length) return null
  return { name: clip(raw?.name, 80) || moves[0].name, note: clip(raw?.note, 240), moves }
}

function chatText(body) {
  const content = body?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('')
  return ''
}

async function postJSON(url, apiKey, body, ms) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms)
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, json }
}

function imagesOf(body) {
  const list = Array.isArray(body?.images) ? body.images : []
  const out = []
  for (const row of list) {
    if (typeof row !== 'string' || row.length > 500000 || out.length >= 3) continue
    if (/^data:image\/(jpeg|jpg|png|webp);/i.test(row)) out.push(row)
  }
  return out
}

async function analyze(body) {
  const images = imagesOf(body)
  const note = clip(body?.note, 400)
  const correction = clip(body?.correction, 400)
  if (!images.length && !note && !correction) return { status: 400, error: 'Add a photo or a short description.' }
  const apiKey = process.env.XAI_API_KEY || ''
  if (!apiKey) return { status: 503, error: 'Workout guides are unavailable right now.' }
  const parts = [PROMPT]
  if (note) parts.push('Note: ' + note)
  if (correction) parts.push('The user says this is wrong: ' + correction)
  const content = [{ type: 'text', text: parts.join('\n\n') }]
  for (const url of images) content.push({ type: 'image_url', image_url: { url } })
  try {
    const chat = await postJSON('https://api.x.ai/v1/chat/completions', apiKey, {
      model: 'grok-4.5',
      temperature: 0.2,
      max_tokens: 1200,
      messages: [{ role: 'user', content: images.length ? content : parts.join('\n\n') }]
    }, 45000)
    if (!chat.ok) return { status: 502, error: 'Could not read that. Try a clearer photo.' }
    const workout = parseWorkout(chatText(chat.json))
    if (!workout) return { status: 502, error: 'The workout came back unreadable. Try again.' }
    return { status: 200, workout }
  } catch {
    return { status: 502, error: 'Could not read that. Try again in a moment.' }
  }
}

function promptFor(move, fromStill) {
  const motion = (move.cues || []).filter(Boolean).join(', then ')
  const action = `one fluid repetition of the ${move.equipment} ${move.name}${motion ? '. The body moves through it in order: ' + motion : ''}.`
  const extra = move.extra ? ' The user says the last clip was wrong. Follow this and let it override the guess: ' + move.extra + '.' : ''
  const frame = 'One single continuous video from one camera. No collage, no storyboard, no comic strip, no stacked stills, no grid, no split screen, no repeated panels, no borders, no letterboxing, no titles, no captions, no logos, no cuts, no extra people.'
  if (fromStill) return `The attached photo is the first frame. Keep this person, this gym, and this framing, and animate them through ${action}${extra} Do not replace the person or redraw the scene. ${frame}`
  return `Bright gym, side view. One athletic adult in plain workout clothes performs ${action}${extra} ${frame}`
}

const GUIDE_ID = /^[0-9A-Za-z_-]{1,64}$/

function guidePath(dataDir, id) {
  return path.join(dataDir, 'guides', id + '.mp4')
}

async function imagineClip(move, image) {
  const apiKey = process.env.XAI_API_KEY || ''
  if (!apiKey) return { error: 'Workout guides are unavailable right now.' }
  const body = {
    model: 'grok-imagine-video-1.5',
    duration: 6,
    resolution: '720p',
    generate_audio: false,
    prompt: promptFor(move, !!image)
  }
  if (image) body.image = { url: image }
  let started = await postJSON('https://api.x.ai/v1/videos/generations', apiKey, body, 30000)
  const id = started.json && (started.json.request_id || started.json.id)
  if (!started.ok || !id) return { error: 'Could not start the form guide.' }

  const deadline = Date.now() + 90000
  let videoUrl = ''
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500))
    const res = await fetch('https://api.x.ai/v1/videos/' + id, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(20000)
    })
    const json = await res.json().catch(() => null)
    const status = json && json.status
    videoUrl = json?.video?.url || json?.video_url || ''
    if (status === 'done' && videoUrl) break
    if (status === 'failed' || status === 'expired') return { error: 'The form guide failed. You can still add the exercise.' }
  }
  if (!videoUrl) return { error: 'The guide is still rendering. Try again.' }
  const file = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) })
  if (!file.ok) return { url: videoUrl }
  const buf = Buffer.from(await file.arrayBuffer())
  if (buf.length < 1000 || buf.length > 8000000) return { url: videoUrl }
  return { url: videoUrl, buf }
}

async function renderVideo(body) {
  const name = clip(body?.name, 80)
  if (!name) return { status: 400, error: 'Name the exercise first.' }
  const image = typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length <= 700000 && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  const move = { name, equipment: clip(body?.equipment, 40) || 'body weight', cues: Array.isArray(body?.cues) ? body.cues.map(c => clip(c, 80)).filter(Boolean).slice(0, 3) : [], extra: clip(body?.prompt, 400) }
  try {
    const clipOut = await imagineClip(move, image)
    if (clipOut.error) return { status: 502, error: clipOut.error }
    if (!clipOut.buf) return { status: 200, url: clipOut.url }
    return { status: 200, url: clipOut.url, dataUrl: 'data:video/mp4;base64,' + clipOut.buf.toString('base64') }
  } catch {
    return { status: 502, error: 'The form guide failed. You can still add the exercise.' }
  }
}

async function catalogVideo(dataDir, body) {
  const id = clip(body?.id, 64)
  if (!GUIDE_ID.test(id)) return { status: 400, error: 'Unknown exercise.' }
  const file = guidePath(dataDir, id)
  const url = '/api/guide/clip?id=' + encodeURIComponent(id)
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) return { status: 200, url }
  } catch { /* generate it */ }
  const image = typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length <= 700000 && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  if (!image) return { status: 400, error: 'Need the exercise photo.' }
  const move = { name: clip(body?.name, 80) || 'the exercise', equipment: clip(body?.equipment, 40) || 'body weight', cues: [] }
  try {
    const clipOut = await imagineClip(move, image)
    if (clipOut.error || !clipOut.buf) return { status: 502, error: clipOut.error || 'Could not store the guide.' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.part'
    fs.writeFileSync(tmp, clipOut.buf)
    fs.renameSync(tmp, file)
    return { status: 200, url }
  } catch {
    return { status: 502, error: 'The form guide failed.' }
  }
}

export function guideRoutes({ json, readBody, readSession, dataDir }) {
  return {
    'POST /api/guide/analyze': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id, 20)) return json(res, 429, { error: 'Too many workouts. Try again in a little while.' })
      const result = await analyze(await readBody(req))
      if (result.workout) return json(res, 200, { ok: true, workout: result.workout })
      json(res, result.status, { error: result.error })
    },
    'POST /api/guide/video': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id, 8)) return json(res, 429, { error: 'Too many guides. Try again in a little while.' })
      const result = await renderVideo(await readBody(req))
      if (result.url || result.dataUrl) return json(res, 200, { ok: true, url: result.url, dataUrl: result.dataUrl })
      json(res, result.status, { error: result.error })
    },
    'GET /api/guide/catalog': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
      if (!GUIDE_ID.test(id)) return json(res, 404, { error: 'not found' })
      const file = guidePath(dataDir, id)
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' })
      json(res, 200, { ok: true, url: '/api/guide/clip?id=' + encodeURIComponent(id) })
    },
    'POST /api/guide/catalog': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id, 40)) return json(res, 429, { error: 'Too many guides. Try again in a little while.' })
      const result = await catalogVideo(dataDir, await readBody(req))
      if (result.url) return json(res, 200, { ok: true, url: result.url })
      json(res, result.status, { error: result.error })
    },
    'GET /api/guide/clip': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
      if (!GUIDE_ID.test(id)) return json(res, 404, { error: 'not found' })
      const file = guidePath(dataDir, id)
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' })
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=86400' })
      fs.createReadStream(file).pipe(res)
    }
  }
}
