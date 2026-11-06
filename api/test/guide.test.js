import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkout } from '../guide.js'

test('parseWorkout keeps a real move and drops an unknown body part onto the list', () => {
  const workout = parseWorkout(JSON.stringify({
    name: 'Hip thrust',
    note: 'bench',
    moves: [{ name: 'Hip thrust', bodyPart: 'upper legs', equipment: 'barbell', muscle: 'gluteal', sets: 3, reps: '8-12', cues: ['Brace', 'Drive the hips', 'Pause'] }]
  }))
  assert.equal(workout.moves[0].bodyPart, 'upper legs')
  assert.equal(workout.moves[0].equipment, 'barbell')
  assert.equal(workout.moves[0].cues.length, 3)
  assert.equal(parseWorkout('nope'), null)
})
