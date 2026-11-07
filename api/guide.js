/* A photo or short clip becomes a workout, then an Imagine clip of the movement.
   Catalog exercises use the same image-to-video path: the still becomes a short guide.
   AGPL-3.0-or-later, same terms as the rest of openGym. */
import fs from 'node:fs'
import path from 'node:path'
import { STARTER_GUIDES } from './starter-guides.js'

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
  const marked = ` Athletic adult, no shirt, athletic shorts only. The ${move.muscle || 'working'} muscle stays highlighted in solid red on the skin for the whole repetition. Do not add a shirt. No text.`
  const frame = 'One single continuous video from one camera. No collage, no storyboard, no comic strip, no stacked stills, no grid, no split screen, no repeated panels, no borders, no letterboxing, no titles, no captions, no logos, no cuts, no extra people.'
  if (fromStill) return `The attached photo is the first frame. Keep this person, this framing, the bare torso, and the red muscle highlight, and animate them through ${action}${extra}${marked} ${frame}`
  return `Bright gym, side view. One athletic adult with no shirt performs ${action}${extra}${marked} ${frame}`
}

const GUIDE_ID = /^[0-9A-Za-z_-]{1,64}$/

function guidePath(dataDir, id) {
  return path.join(dataDir, 'guides', id + '-m2.mp4')
}

function apiError(json, fallback) {
  const msg = json?.error?.message || json?.error || json?.message
  return typeof msg === 'string' && msg.trim() ? msg.trim().slice(0, 180) : fallback
}

async function imagineClip(move, image) {
  const apiKey = process.env.XAI_API_KEY || ''
  if (!apiKey) return { error: 'Workout guides are unavailable right now.' }
  const base = {
    duration: 8,
    resolution: '720p',
    generate_audio: false,
    prompt: promptFor(move, !!image)
  }
  if (image) base.image = { url: image }
  let started = await postJSON('https://api.x.ai/v1/videos/generations', apiKey, { ...base, model: 'grok-imagine-video-1.5' }, 30000)
  if (!started.ok) started = await postJSON('https://api.x.ai/v1/videos/generations', apiKey, { ...base, model: 'grok-imagine-video-1.5-lite', duration: 6 }, 30000)
  const id = started.json && (started.json.request_id || started.json.id)
  if (!started.ok || !id) return { error: apiError(started.json, 'Could not start the form guide.') }

  const deadline = Date.now() + 100000
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
    if (status === 'failed' || status === 'expired') return { error: apiError(json, 'The form guide failed. You can still add the exercise.') }
  }
  if (!videoUrl) return { error: 'The guide is still rendering. Try again.' }
  try {
    const file = await fetch(videoUrl, { signal: AbortSignal.timeout(20000) })
    if (!file.ok) return { url: videoUrl }
    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.length < 1000 || buf.length > 12000000) return { url: videoUrl }
    return { url: videoUrl, buf }
  } catch {
    return { url: videoUrl }
  }
}

async function renderVideo(body) {
  const name = clip(body?.name, 80)
  if (!name) return { status: 400, error: 'Name the exercise first.' }
  const image = typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length <= 700000 && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  const move = { name, equipment: clip(body?.equipment, 40) || 'body weight', muscle: clip(body?.muscle, 40), cues: Array.isArray(body?.cues) ? body.cues.map(c => clip(c, 80)).filter(Boolean).slice(0, 3) : [], extra: clip(body?.prompt, 400) }
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
  const move = { name: clip(body?.name, 80) || 'the exercise', equipment: clip(body?.equipment, 40) || 'body weight', muscle: clip(body?.muscle, 40), cues: [] }
  try {
    const clipOut = await imagineClip(move, image)
    if (clipOut.error) return { status: 502, error: clipOut.error }
    if (clipOut.buf) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.part'
      fs.writeFileSync(tmp, clipOut.buf)
      fs.renameSync(tmp, file)
      return { status: 200, url }
    }
    if (clipOut.url) return { status: 200, url: clipOut.url }
    return { status: 502, error: 'Could not store the guide.' }
  } catch {
    return { status: 502, error: 'The form guide failed.' }
  }
}

function posterPath(dataDir, id) {
  return path.join(dataDir, 'guides', id + '-m2.jpg')
}

function posterUrl(id) {
  return '/api/guide/photo?id=' + encodeURIComponent(id)
}

function imageBytes(json) {
  const rows = Array.isArray(json?.data) ? json.data : [json]
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const b64 = row.b64_json || row.b64
    if (typeof b64 === 'string' && b64.length > 100) return Buffer.from(b64, 'base64')
    const url = row.url || row.image_url
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return url
  }
  return null
}

const POSTER_PROMPT = 'Professional fitness photograph of this exact exercise and body position. One athletic adult, no shirt, athletic shorts only, so the working muscle is visible. Paint only that target muscle in a clear solid red highlight on the skin, like a fitness anatomy chart. Every other muscle stays natural skin tone. Clean bright gym, sharp focus, realistic. Fill the frame. No text, no watermark, no logo, no collage, no extra people.'

function stillPrompt(name, equipment, muscle) {
  const target = muscle ? ' Target muscle, in red: ' + muscle + '.' : ' Mark the single working muscle in red.'
  return POSTER_PROMPT + target + ' Exercise: ' + (equipment ? equipment + ' ' : '') + name + '.'
}

const posterJobs = new Map()

async function imagineStill(prompt, image) {
  const apiKey = process.env.XAI_API_KEY || ''
  if (!apiKey) return { error: 'Previews are unavailable right now.' }
  if (!image) {
    const res = await postJSON('https://api.x.ai/v1/images/generations', apiKey, {
      model: 'grok-imagine-image-2.0',
      prompt,
      aspect_ratio: '3:4',
      resolution: '1k'
    }, 60000)
    const got = res.ok ? imageBytes(res.json) : null
    if (Buffer.isBuffer(got) && got.length > 1000) return { buf: got }
    if (typeof got === 'string') {
      const file = await fetch(got, { signal: AbortSignal.timeout(20000) })
      if (file.ok) {
        const buf = Buffer.from(await file.arrayBuffer())
        if (buf.length > 1000) return { buf }
      }
    }
    return { error: apiError(res.json, 'Could not make the card.') }
  }
  const edited = {
    model: 'grok-imagine-image-2.0',
    prompt,
    aspect_ratio: '3:4',
    resolution: '1k',
    response_format: 'b64_json',
    image: { url: image, type: 'image_url' }
  }
  let res = await postJSON('https://api.x.ai/v1/images/edits', apiKey, edited, 60000)
  if (!res.ok) {
    const again = { ...edited }
    delete again.response_format
    res = await postJSON('https://api.x.ai/v1/images/edits', apiKey, again, 60000)
  }
  if (!res.ok) {
    res = await postJSON('https://api.x.ai/v1/images/generations', apiKey, {
      model: 'grok-imagine-image-2.0',
      prompt,
      aspect_ratio: '3:4',
      resolution: '1k'
    }, 60000)
  }
  const got = res.ok ? imageBytes(res.json) : null
  if (!got) return { error: apiError(res.json, 'Could not make the preview.') }
  if (Buffer.isBuffer(got)) return got.length > 1000 ? { buf: got } : { error: 'Could not make the preview.' }
  const file = await fetch(got, { signal: AbortSignal.timeout(20000) })
  if (!file.ok) return { error: 'Could not save the preview.' }
  const buf = Buffer.from(await file.arrayBuffer())
  return buf.length > 1000 ? { buf } : { error: 'Could not make the preview.' }
}

async function renderCard(body) {
  const name = clip(body?.name, 80)
  if (!name) return { status: 400, error: 'Name the exercise first.' }
  const equipment = clip(body?.equipment, 40) || ''
  const image = typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length <= 700000 && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  const still = await imagineStill(stillPrompt(name, equipment, clip(body?.muscle, 40)), image)
  if (still.error || !still.buf) return { status: 502, error: still.error || 'Could not make the card.' }
  return { status: 200, dataUrl: 'data:image/jpeg;base64,' + still.buf.toString('base64') }
}

async function professionalPoster(dataDir, body) {
  const id = clip(body?.id, 64)
  if (!GUIDE_ID.test(id)) return { status: 400, error: 'Unknown exercise.' }
  const file = posterPath(dataDir, id)
  try {
    if (fs.statSync(file).size > 1000) return { status: 200, url: posterUrl(id) }
  } catch { /* make it */ }
  const image = typeof body?.imageDataUrl === 'string' && body.imageDataUrl.length <= 700000 && /^data:image\/(jpeg|jpg|png|webp);/i.test(body.imageDataUrl)
    ? body.imageDataUrl
    : ''
  if (!image) return { status: 400, error: 'Need the exercise photo.' }
  if (posterJobs.has(id)) return posterJobs.get(id)
  const job = (async () => {
    const name = clip(body?.name, 80) || 'the exercise'
    const equipment = clip(body?.equipment, 40) || 'body weight'
    const still = await imagineStill(stillPrompt(name, equipment, clip(body?.muscle, 40)), image)
    if (still.error || !still.buf) return { status: 502, error: still.error || 'Could not make the preview.' }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.part'
    fs.writeFileSync(tmp, still.buf)
    fs.renameSync(tmp, file)
    return { status: 200, url: posterUrl(id), imageDataUrl: 'data:image/jpeg;base64,' + still.buf.toString('base64') }
  })()
  posterJobs.set(id, job)
  try { return await job } finally { posterJobs.delete(id) }
}

async function stockDataUrl(img) {
  const local = path.join(process.env.CATALOG_MEDIA || '/catalog-media/img', img)
  try { return 'data:image/jpeg;base64,' + fs.readFileSync(local).toString('base64') } catch { /* the public copy is the fallback */ }
  const origin = (process.env.ORIGIN || 'https://gym.onit.systems').replace(/\/$/, '')
  const res = await fetch(origin + '/img/' + img, { signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error('missing still')
  return 'data:image/jpeg;base64,' + Buffer.from(await res.arrayBuffer()).toString('base64')
}

export function premakeStarter(dataDir) {
  if (!process.env.XAI_API_KEY) return
  console.log('premaking', STARTER_GUIDES.length, 'starter previews')
  setTimeout(() => { void runPremake(dataDir) }, 20000)
}

async function runPremake(dataDir) {
  for (const ex of STARTER_GUIDES) {
    try {
      const stock = await stockDataUrl(ex.img)
      const hadPoster = fs.existsSync(posterPath(dataDir, ex.id))
      const poster = await professionalPoster(dataDir, { id: ex.id, name: ex.n, equipment: ex.eq, muscle: ex.m, imageDataUrl: stock })
      if (!hadPoster) {
        try { fs.unlinkSync(guidePath(dataDir, ex.id)) } catch { /* the clip will be made from the new photo */ }
      }
      let videoReady = false
      try { videoReady = fs.statSync(guidePath(dataDir, ex.id)).size > 1000 } catch { videoReady = false }
      if (videoReady) { console.log('premake', ex.id, 'poster', poster.status); continue }
      const imageDataUrl = poster.imageDataUrl || ('data:image/jpeg;base64,' + fs.readFileSync(posterPath(dataDir, ex.id)).toString('base64'))
      const result = await catalogVideo(dataDir, { id: ex.id, name: ex.n, equipment: ex.eq, muscle: ex.m, imageDataUrl })
      console.log('premake', ex.id, result.status, result.error || 'ok')
    } catch (e) {
      console.log('premake', ex.id, 'failed', e?.message || e)
    }
  }
  console.log('starter guides finished')
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
    },
    'POST /api/guide/card': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id, 40)) return json(res, 429, { error: 'Too many cards. Try again in a little while.' })
      const result = await renderCard(await readBody(req))
      if (result.dataUrl) return json(res, 200, { ok: true, dataUrl: result.dataUrl })
      json(res, result.status, { error: result.error })
    },
    'GET /api/guide/poster': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
      if (!GUIDE_ID.test(id) || !fs.existsSync(posterPath(dataDir, id))) return json(res, 404, { error: 'not found' })
      json(res, 200, { ok: true, url: posterUrl(id) })
    },
    'POST /api/guide/poster': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      if (limited(user.id, 40)) return json(res, 429, { error: 'Too many previews. Try again in a little while.' })
      const result = await professionalPoster(dataDir, await readBody(req))
      if (result.url) return json(res, 200, { ok: true, url: result.url })
      json(res, result.status, { error: result.error })
    },
    'GET /api/guide/photo': async (req, res) => {
      const user = readSession(req)
      if (!user) return json(res, 401, { error: 'not signed in' })
      const id = new URL(req.url, 'http://x').searchParams.get('id') || ''
      if (!GUIDE_ID.test(id)) return json(res, 404, { error: 'not found' })
      const file = posterPath(dataDir, id)
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' })
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
      fs.createReadStream(file).pipe(res)
    }
  }
}
