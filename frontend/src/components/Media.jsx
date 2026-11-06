import { useEffect, useRef, useState } from 'react'
import { imgSrc, gifSrc } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t, exerciseNameFor } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import CustomMedia, { CustomThumb } from './CustomMedia.jsx'

// An exercise's picture, wherever one shows. A custom exercise goes to CustomMedia.jsx — its own
// photo, GIF, video or link, from the local media store — and never through imgSrc/gifSrc, which
// name files of the shipped dataset (a stray img/gif on a custom exercise, written by a fork, is
// ignored). The split is by component, not by branch, so each side keeps its own hooks in order.
export default function Media(p) {
  return p.ex?.custom ? <CustomMedia {...p} /> : <BuiltinMedia {...p} />
}

// Big autoplaying animation; tap toggles to the still frame. `compact` shrinks it (superset cards).
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12). Settings can also turn workout media off entirely
// (gifSize 'off') — then nothing renders here and the exercise card closes up, exactly like
// an exercise without media. Any other/legacy value behaves as 'full'.
function BuiltinMedia({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const [failed, setFailed] = useState(null)
  const [clipUrl, setClipUrl] = useState('')
  const [making, setMaking] = useState(false)
  const videoRef = useRef(null)
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  const userId = useStore(s => s.user?.id || '')
  const mini = minimizable && gifSize === 'mini'
  useEffect(() => {
    if (!userId || !ex?.img || !ex?.gif || compact || mini || (minimizable && gifSize === 'off')) return
    let gone = false
    setMaking(true)
    catalogGuide(ex).then(url => { if (!gone && url) setClipUrl(url) }).catch(() => {}).finally(() => { if (!gone) setMaking(false) })
    return () => { gone = true }
  }, [userId, ex?.id, ex?.img, compact, mini, minimizable, gifSize])
  if (!ex.gif) return null
  if (minimizable && gifSize === 'off') return null
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }
  const showGif = playing && failed == null
  const onError = () => setFailed(showGif ? 'gif' : 'all')
  const onTap = () => {
    if (clipUrl && videoRef.current) {
      const video = videoRef.current
      if (video.paused) video.play().catch(() => {})
      else video.pause()
      return
    }
    if (failed) { setFailed(null); setPlaying(true); return }
    setPlaying(p => !p)
  }
  return (
    <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '') + (failed === 'all' && !clipUrl ? ' broken' : '')} id={id} onClick={onTap}>
      {clipUrl
        ? <video ref={videoRef} src={clipUrl} autoPlay muted loop playsInline style={{ objectFit: 'cover' }} />
        : failed === 'all'
        ? <div className="exmedia-x"><Icon name="dumbbell" /></div>
        : <img decoding="async" draggable={false} src={showGif ? gifSrc(ex) : imgSrc(ex)} alt={exerciseNameFor(ex)} onError={onError} />}
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {making && !clipUrl && <span className="gifhint">{t('Video guide…')}</span>}
      {!mini && !failed && !making && !clipUrl && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

const guideReady = new Map()
const guidePending = new Map()
let guideTail = Promise.resolve()

function catalogGuide(ex) {
  if (guideReady.has(ex.id)) return Promise.resolve(guideReady.get(ex.id))
  if (guidePending.has(ex.id)) return guidePending.get(ex.id)
  const job = guideTail.then(() => makeCatalogGuide(ex))
  guideTail = job.then(() => {}, () => {})
  guidePending.set(ex.id, job)
  job.finally(() => guidePending.delete(ex.id))
  return job
}

function stillData(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const edge = 768
      const scale = Math.min(1, edge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale))
      canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', 0.72))
    }
    img.onerror = () => reject(new Error('still'))
    img.src = src
  })
}

async function makeCatalogGuide(ex) {
  try {
    const had = await api('/api/guide/catalog?id=' + encodeURIComponent(ex.id))
    if (had?.url) { guideReady.set(ex.id, had.url); return had.url }
  } catch (e) {
    if (e.status !== 404) throw e
  }
  const imageDataUrl = await stillData(imgSrc(ex))
  const made = await api('/api/guide/catalog', {
    method: 'POST',
    timeout: 120000,
    body: JSON.stringify({ id: ex.id, name: ex.n, equipment: ex.eq, imageDataUrl })
  })
  guideReady.set(ex.id, made.url)
  return made.url
}

// A still that will not load (offline and never cached, a lapsed session on a gated instance, a
// CDN hiccup) gets the same neutral tile as an exercise without media, instead of the browser's
// broken-image glyph in a list of them (#281). The failure is remembered per image, so a list
// that re-renders does not ask again; a new exercise in the same slot tries its own.
export function Thumb(p) {
  return p.ex?.custom ? <CustomThumb {...p} /> : <BuiltinThumb {...p} />
}
function BuiltinThumb({ ex }) {
  const src = ex.img ? imgSrc(ex) : null
  const [broken, setBroken] = useState(null)
  if (!src || broken === src) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" draggable={false} src={src} alt="" onError={() => setBroken(src)} />
}
