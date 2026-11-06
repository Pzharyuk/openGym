import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReading, rewardsFor, sanitizeMeasure } from '../measure.js'

test('a reading keeps metric sites and drops a lecture that is not JSON', () => {
  const reading = parseReading('Sure. {"waist": 84.2, "weight": 81, "bodyFat": 18, "confidence": "low", "lesson": "Tape level at the navel.", "steps": ["Stand tall", "Breathe out", "Read the tape"], "note": "No tape in the photo."}')
  assert.equal(reading.waist, 84.2)
  assert.equal(reading.weight, 81)
  assert.equal(reading.confidence, 'low')
  assert.equal(reading.steps.length, 3)
  assert.equal(parseReading('not a lesson'), null)
})

test('rewards come from the check-ins, not from a claimed badge', () => {
  const doc = sanitizeMeasure({
    rewards: [{ id: 'month', at: 1 }],
    checks: [
      { id: 'a', day: '2026-09-01', t: 1, waist: 90, weight: 80 },
      { id: 'b', day: '2026-09-08', t: 2, waist: 89 },
      { id: 'c', day: '2026-09-15', t: 3, waist: 87 },
      { id: 'd', day: '2026-10-01', t: 4, waist: 86 }
    ]
  })
  const ids = doc.rewards.map(row => row.id)
  assert.ok(ids.includes('first'))
  assert.ok(ids.includes('four'))
  assert.ok(ids.includes('habit'))
  assert.ok(ids.includes('steady'))
  assert.ok(ids.includes('waist'))
  assert.ok(ids.includes('month'))
  assert.equal(ids.includes('eight'), false)
})

test('the same measurements on one day collapse to one check-in', () => {
  const doc = sanitizeMeasure({
    checks: [
      { id: 'a', day: '2026-11-06', t: 1, waist: 94, chest: 107, weight: 95 },
      { id: 'b', day: '2026-11-06', t: 2, waist: 94, chest: 107, weight: 95, photo: '' }
    ]
  })
  assert.equal(doc.checks.length, 1)
  assert.equal(doc.checks[0].id, 'a')
})

test('rewardsFor ignores a waist that never moved two centimeters', () => {
  const rewards = rewardsFor([
    { id: 'a', day: '2026-09-01', t: 1, waist: 80 },
    { id: 'b', day: '2026-09-20', t: 2, waist: 79 }
  ])
  assert.deepEqual(rewards.map(row => row.id), ['first'])
})
