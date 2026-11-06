import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { uid } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { limitsFrom } from '../lib/media-limits.js'
import { mediaStore } from '../lib/media-store.js'
import { Button } from '../components/ui.jsx'
import { DEFAULT_GLYPH } from '../lib/glyphs.js'
import Icon from './Icon.jsx'

function resizeFrame(video) {
  const edge = 720
  const scale = Math.min(1, edge / Math.max(video.videoWidth || 1, video.videoHeight || 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round((video.videoWidth || 1) * scale))
  canvas.height = Math.max(1, Math.round((video.videoHeight || 1) * scale))
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.7)
}

function seek(video, time) {
  return new Promise(resolve => {
    const done = () => resolve(resizeFrame(video))
    video.onseeked = done
    try { video.currentTime = Math.min(time, (video.duration || time) - 0.05) } catch { done() }
  })
}

async function framesFrom(file) {
  if (file.type.startsWith('image/')) {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('photo'))
      reader.onload = () => resolve(String(reader.result || ''))
      reader.readAsDataURL(file)
    })
    return [data]
  }
  const url = URL.createObjectURL(file)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = url
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('video'))
    })
    const duration = Number.isFinite(video.duration) ? video.duration : 1
    const frames = []
    for (const time of [0.15, duration * 0.5, Math.max(0.3, duration * 0.85)]) frames.push(await seek(video, time))
    return frames.filter(Boolean)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function GuidePlayer({ move }) {
  const ref = useRef(null)
  const cues = move.cues || []
  const [step, setStep] = useState(0)
  const src = move.videoData || move.videoUrl

  useEffect(() => {
    const video = ref.current
    if (!video || !cues.length) return
    const onTime = () => {
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) return
      const index = Math.min(cues.length - 1, Math.floor((video.currentTime / duration) * cues.length))
      setStep(index)
    }
    video.addEventListener('timeupdate', onTime)
    return () => video.removeEventListener('timeupdate', onTime)
  }, [src, cues.length])

  const jump = index => {
    setStep(index)
    const video = ref.current
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return
    video.currentTime = (index / cues.length) * video.duration
    video.play().catch(() => {})
  }

  if (!src && !cues.length) return null
  return <div>
    {src && <video ref={ref} key={src} src={src} autoPlay muted loop playsInline onClick={event => { const video = event.currentTarget; if (video.paused) video.play(); else video.pause() }} style={{ width: 'calc(100% + 32px)', height: 'min(72vh, 640px)', margin: '-16px -16px 10px', objectFit: 'cover', objectPosition: 'center', display: 'block', background: '#000', borderRadius: 'var(--r-card) var(--r-card) 0 0' }} />}
    {!!cues.length && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      {cues.map((cue, index) => <button key={cue} type="button" onClick={() => jump(index)} style={{
        textAlign: 'start', border: 'none', borderRadius: 10, padding: '8px 10px', cursor: 'pointer',
        background: index === step ? 'var(--acc)' : 'var(--surface-3)',
        color: index === step ? 'var(--on-acc)' : 'inherit', fontWeight: index === step ? 650 : 500
      }}>{index + 1}. {cue}</button>)}
    </div>}
  </div>
}

function repsConfig(id, move) {
  const reps = String(move.reps || '10')
  const range = reps.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (/sec/i.test(reps) && !range) return { id, sets: move.sets || 3, sec: parseInt(reps, 10) || 30, weight: 0, mode: 'time' }
  const cfg = { id, sets: move.sets || 3, reps: range ? Number(range[2]) : (parseInt(reps, 10) || 10), weight: 0, mode: 'reps' }
  if (range && Number(range[1]) < cfg.reps) cfg.repsMin = Number(range[1])
  return cfg
}

function GuideForm({ close }) {
  const toast = useUI(s => s.toast)
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const fileRef = useRef(null)
  const [note, setNote] = useState('')
  const [frames, setFrames] = useState([])
  const [busy, setBusy] = useState('')
  const [workout, setWorkout] = useState(null)
  const [rendering, setRendering] = useState(-1)

  const pick = async e => {
    const files = [...(e.target.files || [])].slice(0, 3)
    e.target.value = ''
    if (!files.length) return
    setBusy('photo')
    try {
      const next = []
      for (const file of files) next.push(...await framesFrom(file))
      setFrames(next.slice(0, 3))
      setWorkout(null)
    } catch {
      toast(t('Use a photo or a short video.'))
    } finally { setBusy('') }
  }

  const analyze = async () => {
    if (!user) { toast(t('Sign in to build a workout from a photo.')); return }
    if (!frames.length && !note.trim()) { toast(t('Add a photo, a video, or a short note.')); return }
    setBusy('read')
    try {
      const result = await api('/api/guide/analyze', {
        method: 'POST',
        timeout: 90000,
        body: JSON.stringify({ images: frames, note: note.trim() || undefined })
      })
      const next = result.workout
      setWorkout(next)
      if (next?.moves?.[0]) void guide(0, next)
    } catch (e) {
      toast(e.message || t('Could not read that. Try a clearer photo.'))
    } finally { setBusy('') }
  }

  const guide = async (index, source = workout) => {
    const move = source?.moves?.[index]
    if (!move) return
    setRendering(index)
    try {
      const result = await api('/api/guide/video', {
        method: 'POST',
        timeout: 120000,
        body: JSON.stringify({
          name: move.name,
          equipment: move.equipment,
          cues: move.cues,
          imageDataUrl: frames[0] || undefined
        })
      })
      setWorkout(current => {
        if (!current) return current
        const moves = current.moves.map((row, i) => i === index ? { ...row, videoUrl: result.url, videoData: result.dataUrl } : row)
        return { ...current, moves }
      })
    } catch (e) {
      toast(e.message || t('The form guide failed. You can still add the exercise.'))
    } finally { setRendering(-1) }
  }

  const start = async () => {
    if (!workout?.moves?.length) return
    if (useStore.getState().S.active) { toast(t('Finish the current workout first')); return }
    setBusy('save')
    try {
      const created = []
      for (const move of workout.moves) {
        const id = 'c' + uid()
        const exercise = {
          id, n: move.name, bp: move.bodyPart, eq: move.equipment, custom: true,
          desc: (move.cues || []).join('\n'),
          tg: move.muscle, sm: [], primaries: [move.muscle], secondaries: [], muscleGroups: [move.muscle]
        }
        if (move.videoData) {
          try {
            const bin = Uint8Array.from(atob(move.videoData.split(',')[1] || ''), c => c.charCodeAt(0))
            const file = new File([bin], 'guide.mp4', { type: 'video/mp4' })
            const { ingestMediaFile } = await import('../lib/media-ingest.js')
            const out = await ingestMediaFile(file, limitsFrom(config))
            for (const blob of out.blobs) await mediaStore.put(blob.hash, blob.blob, { mime: blob.mime, pending: true })
            exercise.media = out.media
          } catch { /* the clip can still be opened from its link */ }
        }
        if (!exercise.media && move.videoUrl) exercise.url = move.videoUrl
        created.push({ exercise, cfg: repsConfig(id, move) })
      }
      const rid = 'r' + uid()
      useStore.getState().update(s => {
        s.customEx = [...(s.customEx || []), ...created.map(row => row.exercise)]
        s.routines.push({
          id: rid,
          name: workout.name || t('New workout'),
          emoji: DEFAULT_GLYPH,
          ex: created.map(row => row.cfg)
        })
      })
      const { syncMedia } = await import('../lib/media-sync.js')
      if (created.some(row => row.exercise.media)) syncMedia({ force: true })
      close()
      const { startFlow } = await import('../sheets.jsx')
      startFlow([rid])
    } catch (e) {
      toast(e.message || t('Could not add that workout.'))
    } finally { setBusy('') }
  }

  return <>
    <h3>{t('Workout from a photo')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('A photo or a short video becomes the exercises. Imagine makes a form clip, and each cue jumps to that part of the rep.')}</div>
    {!workout && <>
      <input className="input" placeholder={t('Optional note — hip thrust, or a push day')} value={note} onChange={e => setNote(e.target.value)} />
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="sm" icon="camera" onClick={() => fileRef.current?.click()}>{frames.length ? t('Photo added') : t('Photo or video')}</Button>
        <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={pick} />
        {frames[0] && <img alt="" src={frames[0]} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10 }} />}
      </div>
      <div style={{ height: 12 }} />
      <Button variant="primary" icon="sparkles" disabled={!!busy} onClick={analyze}>{busy ? t('Reading…') : t('Build workout')}</Button>
    </>}
    {workout && <>
      <input className="input" value={workout.name} onChange={e => setWorkout({ ...workout, name: e.target.value })} />
      {workout.note && <div className="muted small" style={{ margin: '8px 0' }}>{workout.note}</div>}
      {workout.moves.map((move, index) => <div key={index} className="card" style={{ marginTop: 10 }}>
        <GuidePlayer move={move} />
        {rendering === index && <div className="small muted" style={{ marginTop: 8 }}>{t('Rendering a 6 second guide…')}</div>}
        <div style={{ fontWeight: 600, marginTop: 8 }}>{move.name}</div>
        <div className="small muted">{move.sets} × {move.reps} · {t(move.equipment)}</div>
        <Button size="sm" variant="ghost" disabled={rendering >= 0} onClick={() => guide(index)}>{move.videoUrl || move.videoData ? t('Redo guide') : t('Form guide')}</Button>
      </div>)}
      <div style={{ height: 12 }} />
      <Button variant="primary" disabled={!!busy || rendering >= 0} onClick={start}>{busy === 'save' ? t('Adding…') : t('Add and start')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" onClick={() => setWorkout(null)}>{t('Use a different photo')}</Button>
    </>}
    <div style={{ height: 8 }} />
    <button className="btn ghost dim" onClick={close}><Icon name="xmark" /> {t('Close')}</button>
  </>
}

export function guideSheet() {
  useUI.getState().openSheet(close => <GuideForm close={close} />)
}
