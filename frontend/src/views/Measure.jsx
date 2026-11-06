import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { fmtDate, fmtNum, todayISO, uid } from '../lib/format.js'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { resizePhoto } from '../lib/fuel.js'
import { REWARDS, SITES, commitMeasure, latestSite, loadMeasure, pullMeasure } from '../lib/measure.js'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, TextArea, TextField } from '../components/ui.jsx'

const toShow = (key, value, unit) => {
  if (!value) return 0
  if (key === 'bodyFat') return value
  if (key === 'weight') return unit === 'lb' ? value * 2.2046226218 : value
  return unit === 'lb' ? value / 2.54 : value
}
const fromShow = (key, value, unit) => {
  if (key === 'bodyFat') return value
  if (key === 'weight') return unit === 'lb' ? value / 2.2046226218 : value
  return unit === 'lb' ? value * 2.54 : value
}
const unitOf = (key, unit) => key === 'bodyFat' ? '%' : key === 'weight' ? (unit === 'lb' ? 'lb' : 'kg') : (unit === 'lb' ? 'in' : 'cm')

function blank(note) {
  const row = { lesson: '', steps: [], note: note || '', confidence: 'medium', photo: '', adjusted: false, correction: '' }
  for (const [key] of SITES) row[key] = 0
  return row
}

export default function Measure() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const user = useStore(s => s.user)
  const unit = useStore(s => s.S.unit)
  const uid_ = user?.id || null
  const [doc, setDoc] = useState(() => loadMeasure(uid_))
  const [site, setSite] = useState('waist')
  const [photo, setPhoto] = useState('')
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    let gone = false
    pullMeasure(uid_).then(next => { if (!gone && next) setDoc(next) })
    return () => { gone = true }
  }, [uid_])

  const change = recipe => setDoc(commitMeasure(uid_, recipe))
  const earned = new Set((doc.rewards || []).map(row => row.id))
  const latest = doc.checks.at(-1)
  const points = doc.checks.filter(row => row[site] > 0).map(row => ({ t: row.t || Date.parse(row.day), y: toShow(site, row[site], unit), d: row.day }))

  const onPhoto = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try { setPhoto(await resizePhoto(file, 720, 0.62)) }
    catch { toast(t('Use a JPEG or PNG photo.')) }
  }

  const teach = async (correction = '') => {
    if (!uid_) { toast(t('Sign in to use the measuring teacher.')); return }
    if (!photo && !note.trim() && !correction) { toast(t('Add a photo, or describe what you measured.')); return }
    setBusy(true)
    try {
      const previous = latest ? JSON.stringify(SITES.reduce((acc, [key]) => { acc[key] = latest[key]; return acc }, {})) : ''
      const r = await api('/api/measure/read', {
        method: 'POST',
        timeout: 90000,
        body: JSON.stringify({
          imageDataUrl: photo || undefined,
          note: note.trim() || undefined,
          correction: correction.trim() || undefined,
          previous: previous || undefined
        })
      })
      setDraft({ ...blank(''), ...r.reading, photo, adjusted: !!correction, correction: '' })
    } catch (e) {
      toast(e.message || t('Could not read that photo. Try again in a moment.'))
    } finally { setBusy(false) }
  }

  const save = () => {
    if (!draft) return
    if (!SITES.some(([key]) => draft[key] > 0)) { toast(t('Add at least one measurement.')); return }
    const row = {
      id: draft.id || uid(),
      day: draft.day || todayISO(),
      t: Date.now(),
      photo: draft.photo || photo,
      lesson: draft.lesson || '',
      steps: draft.steps || [],
      note: draft.note || '',
      confidence: draft.confidence || 'medium',
      adjusted: !!draft.adjusted
    }
    for (const [key] of SITES) row[key] = draft[key] || 0
    const before = new Set((doc.rewards || []).map(item => item.id))
    const next = change(d => ({ ...d, checks: [...d.checks.filter(item => item.id !== row.id), row] }))
    const fresh = (next.rewards || []).filter(item => !before.has(item.id))
    setDraft(null)
    setPhoto('')
    setNote('')
    toast(fresh.length ? t('Check-in saved. Reward: {0}', t(REWARDS.find(item => item[0] === fresh[0].id)?.[1] || 'Reward')) : t('Check-in saved'))
  }

  return <div className="narrow">
    <div className="hdr">
      <div>
        <h1>{t('Measure')}</h1>
        <div className="sub">{t('A photo, a tape, and the graph of both.')}</div>
      </div>
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
    </div>

    <div className="card">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {SITES.map(([key, label]) => <button key={key} type="button" className={'tag' + (site === key ? ' acc' : '')} onClick={() => setSite(key)}>{t(label)}</button>)}
      </div>
      <LineChart points={points} unit={unitOf(site, unit)} color="var(--blue)" />
      {latestSite(doc, site) && <div className="small muted" style={{ marginTop: 8 }}>
        {t('Latest')} {fmtNum(toShow(site, latestSite(doc, site)[site], unit))} {unitOf(site, unit)} · {fmtDate(latestSite(doc, site).day, true)}
      </div>}
    </div>

    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('Rewards')}</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {REWARDS.map(([id, name, detail]) => {
          const on = earned.has(id)
          return <div key={id} className="row" style={{ gap: 10, opacity: on ? 1 : 0.45 }}>
            <span className="lrow-i" style={{ background: on ? 'var(--orange)' : 'var(--surface-3)' }}><Icon name="medal" /></span>
            <div>
              <div style={{ fontWeight: 650 }}>{t(name)}</div>
              <div className="small muted">{t(detail)}</div>
            </div>
          </div>
        })}
      </div>
    </div>

    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('New check-in')}</h2>
      <div className="muted small" style={{ marginBottom: 8 }}>{t('A photo is enough. The teacher guesses the tape numbers. You can fix any of them before saving.')}</div>
      <TextArea rows={2} value={note} placeholder={t('Optional — 180 cm, or my waist was 84')} onChange={e => setNote(e.target.value)} />
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="sm" icon="camera" onClick={() => fileRef.current?.click()}>{photo ? t('Photo added') : t('Progress photo')}</Button>
        <input ref={fileRef} type="file" accept="image/*" capture="user" hidden onChange={onPhoto} />
        {photo && <img alt="" src={photo} style={{ width: 44, height: 56, objectFit: 'cover', borderRadius: 10 }} />}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" icon="sparkles" disabled={busy} onClick={() => teach()}>{busy ? t('Guessing…') : t('Guess from photo')}</Button>
        <Button size="sm" onClick={() => setDraft({ ...blank(note.trim()), photo })}>{t('Enter the tape')}</Button>
      </div>
    </div>

    {draft && <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('Guessed measurements')}</h2>
      {draft.photo && <img alt="" src={draft.photo} style={{ width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 12 }} />}
      <div className="muted small" style={{ margin: '8px 0' }}>{t('Visual guess, not a tape. Correct anything that looks wrong.')}</div>
      {draft.lesson && <p style={{ marginBottom: 8 }}>{draft.lesson}</p>}
      {!!draft.steps?.length && <ol className="small" style={{ marginTop: 0 }}>
        {draft.steps.map(step => <li key={step}>{step}</li>)}
      </ol>}
      {draft.note && <div className="muted small">{draft.note}</div>}
      {draft.confidence && <div className="small muted" style={{ margin: '6px 0 8px' }}>{t('Confidence')}: {t(draft.confidence)}</div>}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {SITES.map(([key, label]) => <label key={key} className="small muted">{t(label)} {unitOf(key, unit)}
          <NumberField aria-label={t(label)} value={Math.round(toShow(key, draft[key], unit) * 10) / 10} onChange={n => setDraft({ ...draft, [key]: fromShow(key, n || 0, unit), adjusted: true })} style={{ width: 72, marginInlineStart: 6 }} />
        </label>)}
      </div>
      <TextField aria-label={t('What the teacher got wrong')} placeholder={t('Waist is 82, not 88')} value={draft.correction || ''} onChange={e => setDraft({ ...draft, correction: e.target.value })} style={{ marginTop: 8 }} />
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" icon="check" onClick={save}>{t('Save check-in')}</Button>
        <Button size="sm" icon="sparkles" disabled={busy || !draft.correction?.trim()} onClick={() => teach(draft.correction)}>{t('Fix with the teacher')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
      </div>
    </div>}

    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('History')}</h2>
      {!doc.checks.length && <div className="muted small">{t('No check-ins yet.')}</div>}
      {[...doc.checks].reverse().map(row => <button key={row.id} type="button" onClick={() => setDraft({ ...row, correction: '' })} style={{ display: 'block', width: '100%', textAlign: 'start', background: 'none', border: 'none', color: 'inherit', padding: '8px 0', borderTop: '1px solid var(--sep)', cursor: 'pointer' }}>
        <div className="row" style={{ gap: 10 }}>
          {row.photo && <img alt="" src={row.photo} style={{ width: 36, height: 48, objectFit: 'cover', borderRadius: 8 }} />}
          <div>
            <div style={{ fontWeight: 650 }}>{fmtDate(row.day, true)}{row.adjusted ? ' · ' + t('adjusted') : ''}</div>
            <div className="small muted">{SITES.filter(([key]) => row[key] > 0).map(([key, label]) => t(label) + ' ' + fmtNum(toShow(key, row[key], unit)) + unitOf(key, unit)).join(' · ')}</div>
          </div>
        </div>
      </button>)}
    </div>
  </div>
}
