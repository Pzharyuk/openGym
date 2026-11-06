import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { fmtDate, fmtNum, todayISO, uid } from '../lib/format.js'
import { t, dateLocale } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import {
  WATER_GLASSES, caloriePlan, commitFuel, foodStreak, healthScore, loadFuel, prevDay, pullFuel, resizePhoto
} from '../lib/fuel.js'
import { lastBW } from '../lib/history.js'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, TextArea, TextField } from '../components/ui.jsx'

const sum = (meals, key) => meals.reduce((n, m) => n + (Number(m[key]) || 0), 0)
const round = n => Math.round(n)

function advice(meals, target) {
  if (!meals.length) return t('Log a meal and the day adds up here.')
  const kcal = round(sum(meals, 'kcal'))
  const protein = round(sum(meals, 'protein'))
  const left = target.kcal - kcal
  const proteinLine = t('Protein {0} of {1} g.', protein, target.protein)
  if (left > 400) return t('{0} kcal left. Room for another meal. {1}', left, proteinLine)
  if (left >= 0) return t('On track. {0} kcal left. {1}', left, proteinLine)
  return t('{0} kcal over the target. {1}', -left, proteinLine)
}

function blankDraft(name) {
  return {
    id: null, name: name || '', items: [], kcal: 0, protein: 0, carbs: 0, fat: 0,
    fiber: 0, sugar: 0, satFat: 0, sodium: 0, cholesterol: 0, potassium: 0,
    note: '', confidence: 'medium', source: 'manual', adjusted: false, correction: ''
  }
}

const ITEM_FIELDS = [
  ['kcal', 'kcal', ''],
  ['protein', 'Protein', 'g'],
  ['carbs', 'Carbs', 'g'],
  ['fat', 'Fat', 'g'],
  ['fiber', 'Fiber', 'g'],
  ['sugar', 'Sugar', 'g'],
  ['satFat', 'Sat fat', 'g'],
  ['sodium', 'Sodium', 'mg'],
  ['cholesterol', 'Chol', 'mg'],
  ['potassium', 'Potassium', 'mg']
]

function scoreLabel(score) {
  if (score >= 80) return 'Great'
  if (score >= 60) return 'Good'
  if (score >= 40) return 'Fair'
  return 'Poor'
}

function scoreColor(score) {
  if (score >= 80) return 'var(--green)'
  if (score >= 60) return 'var(--blue)'
  if (score >= 40) return 'var(--orange)'
  return 'var(--red)'
}

function macroLine(item) {
  const n = key => Math.round(Number(item[key]) || 0)
  return [
    n('kcal') + ' kcal',
    t('Protein') + ' ' + n('protein') + 'g',
    t('Carbs') + ' ' + n('carbs') + 'g',
    t('Fat') + ' ' + n('fat') + 'g',
    t('Fiber') + ' ' + n('fiber') + 'g',
    t('Sugar') + ' ' + n('sugar') + 'g',
    t('Sat fat') + ' ' + n('satFat') + 'g',
    t('Sodium') + ' ' + n('sodium') + 'mg',
    t('Chol') + ' ' + n('cholesterol') + 'mg',
    t('Potassium') + ' ' + n('potassium') + 'mg'
  ].join(' · ')
}

function gramsIn(amount) {
  const match = String(amount || '').match(/(\d+(?:\.\d+)?)\s*g\b/i)
  return match ? Math.round(Number(match[1])) : 0
}

function servingWords(amount) {
  return String(amount || '')
    .replace(/\d+(?:\.\d+)?\s*oz\b/gi, '')
    .replace(/\(?\d+(?:\.\d+)?\s*g\)?/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,·\-–\s]+|[,·\-–\s]+$/g, '')
    .trim()
}

function stampItem(item) {
  if (item.base) return item
  const portion = item.portion > 0 ? item.portion : 1
  const base = {}
  for (const [key] of ITEM_FIELDS) base[key] = Math.round(((Number(item[key]) || 0) / portion) * 10) / 10
  const grams = item.grams > 0 ? item.grams : (portion === 1 ? gramsIn(item.amount) : 0)
  return { ...item, base, grams, portion, serving: item.serving || servingWords(item.amount) }
}

function portionAmount(item, portion) {
  if (item.grams > 0) {
    const g = Math.round(item.grams * portion)
    const oz = Math.round((g / 28.3495) * 10) / 10
    const qty = oz >= 0.1 ? oz + ' oz (' + g + 'g)' : g + 'g'
    return [qty, item.serving].filter(Boolean).join(' ').slice(0, 40)
  }
  if (portion === 1) return (item.serving || item.amount || '').slice(0, 40)
  const label = portion === 0.25 ? '1/4' : portion === 0.5 ? '1/2' : portion === 0.75 ? '3/4' : portion === 1.5 ? '1 1/2' : String(portion)
  const base = item.serving || item.amount || ''
  return ((base ? base + ' · ' : '') + label + '×').slice(0, 40)
}

function scaleItem(item, portion) {
  const nextPortion = Math.min(8, Math.max(0.1, Math.round(portion * 100) / 100))
  const next = { ...item, portion: nextPortion }
  for (const [key] of ITEM_FIELDS) {
    const raw = (item.base?.[key] || 0) * nextPortion
    next[key] = key === 'kcal' || key === 'sodium' || key === 'cholesterol' || key === 'potassium' ? Math.round(raw) : Math.round(raw * 10) / 10
  }
  next.amount = portionAmount(item, nextPortion)
  next.score = healthScore(next)
  return next
}

const PORTIONS = [[0.25, '1/4'], [0.5, '1/2'], [0.75, '3/4'], [1, '1'], [1.5, '1 1/2'], [2, '2']]

function retotal(draft, items) {
  const sumKey = key => items.reduce((n, item) => n + (Number(item[key]) || 0), 0)
  return {
    ...draft,
    items,
    kcal: Math.round(sumKey('kcal')),
    protein: sumKey('protein'),
    carbs: sumKey('carbs'),
    fat: sumKey('fat'),
    fiber: sumKey('fiber'),
    sugar: sumKey('sugar'),
    satFat: sumKey('satFat'),
    sodium: Math.round(sumKey('sodium')),
    cholesterol: Math.round(sumKey('cholesterol')),
    potassium: Math.round(sumKey('potassium')),
    adjusted: true
  }
}

export default function Fuel() {
  const nav = useNavigate()
  const toast = useUI(s => s.toast)
  const user = useStore(s => s.user)
  const body = useStore(s => s.S)
  const update = useStore(s => s.update)
  const unit = body.unit === 'lb' ? 'lb' : 'kg'
  const profile = profileInputs(body)
  const plan = caloriePlan(profile)
  const uid_ = user?.id || null
  const [day, setDay] = useState(todayISO())
  const [doc, setDoc] = useState(() => loadFuel(uid_))
  const [description, setDescription] = useState('')
  const [photo, setPhoto] = useState('')
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const today = todayISO()

  useEffect(() => {
    let gone = false
    pullFuel(uid_).then(next => { if (!gone && next) setDoc(next) })
    return () => { gone = true }
  }, [uid_])

  const change = recipe => setDoc(commitFuel(uid_, recipe))
  const meals = doc.meals.filter(m => m.day === day)
  const glasses = doc.water.find(w => w.day === day)?.glasses || 0
  const streak = foodStreak(doc.meals, today)
  const yesterday = prevDay(day)
  const yesterdayMeals = doc.meals.filter(m => m.day === yesterday)

  const setWater = index => {
    const n = index + 1
    const glassesNext = glasses === n ? index : n
    change(d => ({
      ...d,
      water: [...d.water.filter(w => w.day !== day), { day, glasses: glassesNext, t: Date.now() }]
    }))
  }

  const setTarget = (key, value) => {
    change(d => ({ ...d, target: { ...d.target, [key]: value, locked: true, t: Date.now() } }))
  }

  useEffect(() => {
    const saved = doc?.target
    if (!saved?.heightCm || body.heightCm) return
    update(s => {
      s.heightCm = saved.heightCm
      if (!s.age && saved.age) s.age = saved.age
      const bw = lastBW(s)
      if (!s.targetW && saved.lossLb && bw) {
        const loss = s.unit === 'lb' ? saved.lossLb : saved.lossLb / 2.2046226218
        const goal = Math.round((bw.w - loss) * 10) / 10
        if (goal > 20) s.targetW = goal
      }
    })
  }, [body.heightCm, doc?.target?.heightCm])

  useEffect(() => {
    if (!plan || doc.target.locked) return
    if (plan.kcal === doc.target.kcal && plan.protein === doc.target.protein) return
    change(d => ({ ...d, target: { ...d.target, kcal: plan.kcal, protein: plan.protein, t: Date.now() } }))
  }, [plan?.kcal, plan?.protein, doc.target.locked])

  const onPhoto = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try { setPhoto(await resizePhoto(file)) }
    catch { toast(t('Use a JPEG or PNG photo.')) }
  }

  const estimate = async (correction = '') => {
    if (!uid_) { toast(t('Sign in to use the meal estimate.')); return }
    if (!description.trim() && !photo && !correction) { toast(t('Add a photo or describe the meal.')); return }
    setBusy(true)
    try {
      const previous = draft ? JSON.stringify({
        name: draft.name, items: draft.items, kcal: draft.kcal, protein: draft.protein, carbs: draft.carbs, fat: draft.fat,
        fiber: draft.fiber, sugar: draft.sugar, satFat: draft.satFat, sodium: draft.sodium, cholesterol: draft.cholesterol, potassium: draft.potassium, note: draft.note
      }) : ''
      const r = await api('/api/fuel/estimate', {
        method: 'POST',
        body: JSON.stringify({
          description: description.trim(),
          imageDataUrl: photo || undefined,
          correction: correction.trim() || undefined,
          previous: correction.trim() ? previous : undefined
        })
      })
      setDraft({
        id: draft?.id || null,
        ...r.estimate,
        items: (r.estimate.items || []).map(stampItem),
        source: 'ai',
        adjusted: !!correction.trim(),
        correction: ''
      })
    } catch (e) {
      toast(e.message || t('Could not estimate that meal. Try again in a moment.'))
    } finally { setBusy(false) }
  }

  const saveDraft = () => {
    if (!draft?.name?.trim()) { toast(t('Name the meal first.')); return }
    const now = Date.now()
    const meal = {
      id: draft.id || uid(),
      day,
      t: now,
      name: draft.name.trim(),
      items: draft.items || [],
      kcal: round(draft.kcal || 0),
      protein: draft.protein || 0,
      carbs: draft.carbs || 0,
      fat: draft.fat || 0,
      fiber: draft.fiber || 0,
      sugar: draft.sugar || 0,
      satFat: draft.satFat || 0,
      sodium: draft.sodium || 0,
      cholesterol: draft.cholesterol || 0,
      potassium: draft.potassium || 0,
      note: draft.note || '',
      source: draft.source === 'manual' ? 'manual' : 'ai',
      adjusted: !!draft.adjusted,
      confidence: draft.confidence || 'medium'
    }
    change(d => ({ ...d, meals: [...d.meals.filter(m => m.id !== meal.id), meal] }))
    setDraft(null)
    setDescription('')
    setPhoto('')
    toast(draft.id ? t('Meal updated') : t('Meal logged'))
  }

  const removeMeal = meal => {
    const now = Date.now()
    change(d => ({
      ...d,
      meals: d.meals.filter(m => m.id !== meal.id),
      tombs: [...d.tombs, { id: meal.id, t: now }]
    }))
    if (draft?.id === meal.id) setDraft(null)
  }

  const copyYesterday = () => {
    if (!yesterdayMeals.length) return
    const now = Date.now()
    const copies = yesterdayMeals.map(m => ({ ...m, id: uid(), day, t: now, adjusted: true, source: 'manual' }))
    change(d => ({ ...d, meals: [...d.meals, ...copies] }))
    toast(t('Copied yesterday'))
  }

  const heading = day === today
    ? t('Today')
    : new Date(day + 'T12:00:00').toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'short' })

  return <div className="narrow">
    <div className="hdr">
      <div>
        <h1>{t('Fuel')}</h1>
        <div className="sub">{fmtDate(today, true)}</div>
      </div>
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="iconbtn" style={{ width: 30, height: 30 }} onClick={() => setDay(prevDay(day))} aria-label={t('Previous day')}><Icon name="chevronLeft" /></button>
        <div className="small muted" style={{ fontWeight: 500 }}>{heading}</div>
        <button className="iconbtn" style={{ width: 30, height: 30 }} disabled={day === today} onClick={() => setDay(today < day ? day : nextDay(day))} aria-label={t('Next day')}><Icon name="chevronRight" /></button>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <div className="big">{round(sum(meals, 'kcal'))}</div>
        <span className="muted">/ {doc.target.kcal} kcal</span>
      </div>
      <div className="row" style={{ gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
        <Macro label={t('Protein')} value={sum(meals, 'protein')} />
        <Macro label={t('Carbs')} value={sum(meals, 'carbs')} />
        <Macro label={t('Fat')} value={sum(meals, 'fat')} />
        <Macro label={t('Fiber')} value={sum(meals, 'fiber')} />
        <Macro label={t('Sugar')} value={sum(meals, 'sugar')} />
        <Macro label={t('Sodium')} value={sum(meals, 'sodium')} unit="mg" />
        <Macro label={t('Sat fat')} value={sum(meals, 'satFat')} />
        <Macro label={t('Chol')} value={sum(meals, 'cholesterol')} unit="mg" />
        <Macro label={t('Potassium')} value={sum(meals, 'potassium')} unit="mg" />
      </div>
      <div className="muted small" style={{ marginTop: 10 }}>{advice(meals, doc.target)}</div>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <Icon name="flame" style={{ color: 'var(--orange)', fontSize: 16 }} />
        <span className="small">{t(streak === 1 ? '{0} day logged' : '{0} days logged', streak)}</span>
      </div>
      <div className="small muted" style={{ marginTop: 12 }}>{planLine(profile, plan, doc.target.locked)}</div>
      <div style={{ marginTop: 8 }}><Button size="sm" variant="ghost" onClick={() => nav('/settings')}>{t('Height, age, and goal weight are in Settings')}</Button></div>
      <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="small muted">{t('Target')}
          <NumberField aria-label={t('Calorie target')} value={doc.target.kcal} decimal={false} onChange={n => setTarget('kcal', Math.max(500, n || 0))} style={{ width: 72, marginInlineStart: 6 }} />
        </label>
        <label className="small muted">{t('Protein')}
          <NumberField aria-label={t('Protein target')} value={doc.target.protein} decimal={false} onChange={n => setTarget('protein', n || 0)} style={{ width: 56, marginInlineStart: 6 }} />
          <span> g</span>
        </label>
        {doc.target.locked && plan && <Button size="sm" variant="ghost" onClick={() => change(d => ({ ...d, target: { ...d.target, kcal: plan.kcal, protein: plan.protein, locked: false, t: Date.now() } }))}>{t('Recalculate')}</Button>}
      </div>
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{t('Water')}</h2>
        <span className="small muted">{glasses}/{WATER_GLASSES}</span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {Array.from({ length: WATER_GLASSES }, (_, i) => {
          const on = i < glasses
          return <button key={i} type="button" aria-label={t('Glass {0}', i + 1)} aria-pressed={on} onClick={() => setWater(i)}
            style={{ width: 40, height: 44, border: 'none', borderRadius: 20, background: on ? 'var(--blue)' : 'var(--surface-3)', color: on ? '#fff' : 'var(--label-3)' }}>
            <Icon name="drop" style={{ margin: '0 auto' }} />
          </button>
        })}
      </div>
    </div>

    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('Add a meal')}</h2>
      <TextArea rows={2} value={description} placeholder={t('Chicken bowl, or what is on the plate')} onChange={e => setDescription(e.target.value)} />
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="sm" icon="camera" onClick={() => fileRef.current?.click()}>{photo ? t('Photo added') : t('Photo')}</Button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
        {photo && <img alt="" src={photo} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10 }} />}
        {photo && <Button size="sm" variant="ghost" onClick={() => setPhoto('')}>{t('Remove photo')}</Button>}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" icon="sparkles" disabled={busy} onClick={() => estimate()}>{busy ? t('Reading…') : t('Estimate')}</Button>
        <Button size="sm" onClick={() => setDraft(blankDraft(description.trim()))}>{t('Log without AI')}</Button>
        <Button size="sm" variant="ghost" disabled={!yesterdayMeals.length} onClick={copyYesterday}>{t('Copy yesterday')}</Button>
      </div>
    </div>

    {draft && <div className="card">
      <h2 style={{ marginTop: 0 }}>{draft.id ? t('Edit meal') : t('Review before saving')}</h2>
      <TextField aria-label={t('Meal name')} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value, adjusted: true })} />
      {!!draft.items?.length && <div style={{ marginTop: 8 }}>
        {draft.items.map((item, i) => <div key={i} style={{ padding: '8px 0', borderTop: '1px solid var(--sep)' }}>
          <div className="row between" style={{ gap: 8 }}>
            <span style={{ fontWeight: 600, minWidth: 0 }}>{item.name}{item.amount ? ' · ' + item.amount : ''}</span>
            <span className="tag" style={{ color: scoreColor(item.score), fontWeight: 700 }}>{item.score} · {t(scoreLabel(item.score))}</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="small muted">{t('Portion')}</span>
            {PORTIONS.map(([value, label]) => <button key={value} type="button" className={'chip' + ((item.portion || 1) === value ? ' on' : '')} onClick={() => {
              const items = draft.items.map((row, index) => index === i ? scaleItem(stampItem(row), value) : row)
              setDraft(retotal(draft, items))
            }}>{label}</button>)}
            {item.grams > 0 && <label className="small muted">{t('g')}
              <NumberField aria-label={t('Grams')} value={Math.round(item.grams * (item.portion || 1))} decimal={false} onChange={n => {
                if (!n) return
                const items = draft.items.map((row, index) => index === i ? scaleItem(stampItem(row), n / row.grams) : row)
                setDraft(retotal(draft, items))
              }} style={{ width: 64, marginInlineStart: 6 }} />
            </label>}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            {ITEM_FIELDS.map(([key, label, unit]) => <Field key={key} label={t(label) + (unit ? ' ' + unit : '')} value={item[key]} onChange={n => {
              const items = draft.items.map((row, index) => {
                if (index !== i) return row
                const stamped = stampItem(row)
                const next = { ...stamped, [key]: n, base: { ...stamped.base, [key]: (Number(n) || 0) / (stamped.portion || 1) } }
                return { ...next, score: healthScore(next) }
              })
              setDraft(retotal(draft, items))
            }} />)}
          </div>
        </div>)}
      </div>}
      {!draft.items?.length && <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        {ITEM_FIELDS.map(([key, label, unit]) => <Field key={key} label={t(label) + (unit ? ' ' + unit : '')} value={draft[key]} onChange={n => setDraft({ ...draft, [key]: n, adjusted: true })} />)}
      </div>}
      {draft.note && <div className="muted small" style={{ marginTop: 8 }}>{draft.note}</div>}
      <TextField aria-label={t('What the estimate got wrong')} placeholder={t('What it got wrong — half the rice, no sauce')} value={draft.correction || ''} onChange={e => setDraft({ ...draft, correction: e.target.value })} style={{ marginTop: 8 }} />
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <Button variant="primary" icon="check" onClick={saveDraft}>{t('Save')}</Button>
        <Button size="sm" icon="sparkles" disabled={busy || !draft.correction?.trim()} onClick={() => estimate(draft.correction)}>{t('Fix with AI')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
      </div>
    </div>}

    <div className="card">
      <h2 style={{ marginTop: 0 }}>{t('Meals')}</h2>
      {!meals.length && <div className="muted small">{t('Nothing logged for this day yet.')}</div>}
      {meals.map(meal => <div key={meal.id} className="row between" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--sep)' }}>
        <button type="button" onClick={() => setDraft({ ...meal, correction: '', items: (meal.items || []).map(stampItem) })} style={{ background: 'none', border: 'none', color: 'inherit', textAlign: 'start', padding: 0, cursor: 'pointer', minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>{meal.name}{meal.adjusted ? ' · ' + t('adjusted') : ''}</div>
          <div className="small muted">{macroLine(meal)}</div>
          {!!meal.items?.length && meal.items.map((item, index) => <div key={item.name + index} style={{ marginTop: 8 }}>
            <div className="row between" style={{ gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{item.name}{item.amount ? ' · ' + item.amount : ''}</span>
              <span style={{ color: scoreColor(item.score), fontWeight: 700 }}>{t('Health')} {item.score} · {t(scoreLabel(item.score))}</span>
            </div>
            <div className="small muted">{macroLine(item)}</div>
          </div>)}
        </button>
        <button className="iconbtn" aria-label={t('Delete')} onClick={() => removeMeal(meal)}><Icon name="trash" /></button>
      </div>)}
    </div>
  </div>
}

function profileInputs(S) {
  const unit = S.unit === 'lb' ? 'lb' : 'kg'
  const bw = lastBW(S)
  const kg = bw ? (unit === 'lb' ? bw.w / 2.2046226218 : bw.w) : 0
  const delta = bw && S.targetW && bw.w > S.targetW ? bw.w - S.targetW : 0
  return {
    unit, bw, kg,
    heightCm: Number(S.heightCm) || 0,
    age: Number(S.age) || 0,
    sex: S.body === 'female' ? 'f' : 'm',
    lossLb: unit === 'lb' ? delta : delta * 2.2046226218
  }
}

function planLine(profile, plan, locked) {
  const { unit, bw } = profile
  if (!bw) return t('Log a weigh-in and the target can use your weight.')
  const weight = t('Using {0} {1} from your last weigh-in.', fmtNum(bw.w), unit)
  if (!profile.heightCm) return weight + ' ' + t('Set your height in Settings.')
  if (!plan) return weight
  if (locked) return weight + ' ' + t('Target is edited by hand.')
  if (!plan.weekly) return weight + ' ' + t('Maintenance is {0} kcal. Protein {1} g.', plan.kcal, plan.protein)
  const pace = unit === 'lb' ? plan.weekly : Math.round(plan.weekly / 2.2046226218 * 10) / 10
  return weight + ' ' + t('About {0} {1} a week, held at or above {2} kcal.', pace, unit, plan.floor)
}

function nextDay(iso) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + 1)
  const next = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  return next > todayISO() ? todayISO() : next
}

function Macro({ label, value, unit = 'g' }) {
  return <div><div className="small muted">{label}</div><div style={{ fontWeight: 600 }}>{round(value)}{unit}</div></div>
}

function Field({ label, value, onChange }) {
  return <label className="small muted">{label}
    <NumberField aria-label={label} value={value || 0} onChange={onChange} style={{ width: 64, marginInlineStart: 6 }} />
  </label>
}
