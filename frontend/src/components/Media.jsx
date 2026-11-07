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
  const [poster, setPoster] = useState('')
  const [clipUrl, setClipUrl] = useState('')
  const [guideError, setGuideError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const videoRef = useRef(null)
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)
  const userId = useStore(s => s.user?.id || '')
  const focused = useStore(s => {
    if (!minimizable) return true
    const active = s.S.active
    if (!active?.entries?.length) return true
    const cur = Number.isInteger(active.cur) ? active.cur : 0
    return active.entries[cur]?.id === ex?.id
  })
  const mini = minimizable && gifSize === 'mini'
  useEffect(() => {
    if (!focused || !userId || !ex?.img || compact || mini || (minimizable && gifSize === 'off')) return
    let gone = false
    const pull = async () => {
      const photo = await lookupPoster(ex).catch(() => '')
      if (!gone && photo) setPoster(photo)
      if (!ex.gif) return
      const clip = await lookupClip(ex).catch(() => '')
      if (gone) return
      if (clip) setClipUrl(clip)
    }
    pull()
    const timer = setInterval(pull, 20000)
    return () => { gone = true; clearInterval(timer) }
  }, [attempt, focused, userId, ex?.id, ex?.img, ex?.gif, compact, mini, minimizable, gifSize])
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
    <div className={'exmedia' + (clipUrl ? ' guide' : poster ? ' poster' : '') + (compact ? ' compact' : '') + (mini ? ' mini' : '') + (failed === 'all' && !clipUrl ? ' broken' : '')} id={id} onClick={onTap}>
      {clipUrl
        ? <video ref={videoRef} src={clipUrl} autoPlay muted loop playsInline style={{ objectFit: 'cover' }} onError={() => { guideReady.delete(ex.id); setClipUrl(''); setGuideError(t('The video guide did not play.')) }} />
        : poster
        ? <img decoding="async" draggable={false} src={poster} alt={exerciseNameFor(ex)} />
        : failed === 'all'
        ? <div className="exmedia-x"><Icon name="dumbbell" /></div>
        : <img decoding="async" draggable={false} src={showGif ? gifSrc(ex) : imgSrc(ex)} alt={exerciseNameFor(ex)} onError={onError} />}
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {!!guideError && !clipUrl && <button type="button" className="gifhint" onClick={e => { e.stopPropagation(); setAttempt(n => n + 1) }}>{t('Retry video')}</button>}
      {!mini && !failed && !clipUrl && !poster && !guideError && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

const posterReady = new Map()
const guideReady = new Map()

async function lookupPoster(ex) {
  if (posterReady.has(ex.id)) return posterReady.get(ex.id)
  try {
    const had = await api('/api/guide/poster?id=' + encodeURIComponent(ex.id))
    if (had?.url) { posterReady.set(ex.id, had.url); return had.url }
  } catch (e) {
    if (e.status !== 404) throw e
  }
  return ''
}

async function lookupClip(ex) {
  if (guideReady.has(ex.id)) return guideReady.get(ex.id)
  try {
    const had = await api('/api/guide/catalog?id=' + encodeURIComponent(ex.id))
    if (had?.url) { guideReady.set(ex.id, had.url); return had.url }
  } catch (e) {
    if (e.status !== 404) throw e
  }
  return ''
}

export function Thumb(p) {
  return p.ex?.custom ? <CustomThumb {...p} /> : <BuiltinThumb {...p} />
}
function BuiltinThumb({ ex }) {
  const userId = useStore(s => s?.user?.id || '')
  const [poster, setPoster] = useState('')
  const [broken, setBroken] = useState(null)
  useEffect(() => {
    if (!userId || !ex?.img) return
    let gone = false
    const known = posterReady.get(ex.id)
    if (known) { setPoster(known); return }
    const pull = () => lookupPoster(ex).then(url => { if (!gone && url) setPoster(url) }).catch(() => {})
    pull()
    const timer = setInterval(() => { if (!posterReady.has(ex.id)) pull() }, 30000)
    return () => { gone = true; clearInterval(timer) }
  }, [userId, ex?.id, ex?.img])
  const src = poster || (ex.img ? imgSrc(ex) : null)
  if (!src || broken === src) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" draggable={false} src={src} alt="" style={poster ? { background: '#111' } : undefined} onError={() => setBroken(src)} />
}
