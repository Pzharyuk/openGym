import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeFuel, parseEstimate, readFuel, writeFuel } from '../fuel.js'

test('a delete tombstone drops the older copy and a newer edit wins', () => {
  const server = { meals: [{ id: 'a', day: '2026-11-05', t: 10, name: 'Bowl', kcal: 500, protein: 30, carbs: 40, fat: 12, items: [] }] }
  const deleted = mergeFuel(server, { tombs: [{ id: 'a', t: 20 }] })
  assert.equal(deleted.meals.length, 0)

  const edited = mergeFuel(
    { meals: [{ id: 'a', day: '2026-11-05', t: 10, name: 'Bowl', kcal: 500, protein: 1, carbs: 1, fat: 1, items: [] }], tombs: [{ id: 'a', t: 20 }] },
    { meals: [{ id: 'a', day: '2026-11-05', t: 30, name: 'Half bowl', kcal: 250, protein: 15, carbs: 20, fat: 6, items: [] }] }
  )
  assert.equal(edited.meals.length, 1)
  assert.equal(edited.meals[0].name, 'Half bowl')
})

test('water and targets keep the later edit, per day', () => {
  const merged = mergeFuel(
    { water: [{ day: '2026-11-05', glasses: 2, t: 1 }], target: { kcal: 2200, protein: 150, t: 1 } },
    { water: [{ day: '2026-11-05', glasses: 5, t: 2 }, { day: '2026-11-04', glasses: 8, t: 2 }], target: { kcal: 1900, protein: 160, t: 2 } }
  )
  assert.equal(merged.water.find(w => w.day === '2026-11-05').glasses, 5)
  assert.equal(merged.target.kcal, 1900)
})

test('parseEstimate sums a fenced model reply and drops junk', () => {
  const estimate = parseEstimate('sure\n```json\n{"name":"Eggs","items":[{"name":"Eggs","amount":"2","kcal":140,"protein":12,"carbs":1,"fat":10}],"kcal":140,"protein":12,"carbs":1,"fat":10,"confidence":"high","note":"plain"}\n```')
  assert.equal(estimate.name, 'Eggs')
  assert.equal(estimate.kcal, 140)
  assert.equal(estimate.items.length, 1)
  assert.equal(parseEstimate('no json here'), null)
})

test('fuel file round-trip never touches a workout state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-'))
  fs.writeFileSync(path.join(dir, 'state-u1.json'), '{"workouts":[1]}')
  const saved = writeFuel(dir, 'u1', {
    meals: [{ id: 'm1', day: '2026-11-05', t: 5, name: 'Rice', kcal: 300, protein: 6, carbs: 60, fat: 2, items: [], source: 'manual' }]
  }, 1)
  assert.equal(saved.rev, 1)
  assert.equal(readFuel(dir, 'u1').doc.meals[0].kcal, 300)
  assert.equal(fs.readFileSync(path.join(dir, 'state-u1.json'), 'utf8'), '{"workouts":[1]}')
  assert.equal(fs.existsSync(path.join(dir, 'fuel-u1.json')), true)
  fs.rmSync(dir, { recursive: true, force: true })
})
