import test from 'node:test'
import assert from 'node:assert/strict'
import { importSeeds } from '../server/importer.js'
import { createApp } from '../server/app.js'
import { memoryDb, makeDataDir, SEED_JAVA_CORE, SEED_JAVA_QUIZ, LEGACY_JS_BASICS } from './helpers.js'

// Boot the real Express app on an ephemeral port against an in-memory DB.
async function startServer(t, extraFiles = {}) {
  const { dir, cleanup } = await makeDataDir({
    'java/core.json': SEED_JAVA_CORE,
    'javascript/_subject.json': { title: 'JavaScript' },
    'javascript/basics.json': LEGACY_JS_BASICS,
    ...extraFiles,
  })
  t.after(cleanup)
  const db = memoryDb()
  await importSeeds(db, dir, { withState: true })

  const server = createApp({ db }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`

  return {
    db,
    api: async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: res.status, body: await res.json() }
    },
  }
}

test('GET /api/sections returns sorted sections with aggregates', async (t) => {
  const { api } = await startServer(t)
  const { status, body } = await api('GET', '/api/sections')
  assert.equal(status, 200)
  assert.deepEqual(body.map((s) => s.id), ['java/core', 'javascript/basics'])
  assert.deepEqual(body[0], {
    id: 'java/core',
    subject: 'java',
    subjectTitle: 'Java',
    title: 'Core Java',
    total: 2,
    answered: 0,
    evaluated: 0,
    followUps: 0,
    scored: 0,
    avgScore: null,
  })
})

test('GET /api/sections/:id returns the legacy section shape', async (t) => {
  const { api } = await startServer(t)
  const { status, body } = await api('GET', `/api/sections/${encodeURIComponent('javascript/basics')}`)
  assert.equal(status, 200)
  assert.equal(body.id, 'javascript/basics')
  assert.equal(body.title, 'Basics')
  assert.equal(body.description, 'Core language concepts.')
  assert.equal(body.subject, 'javascript')
  assert.equal(body.subjectTitle, 'JavaScript')
  // exact legacy question shape, optional flags included only when set
  assert.deepEqual(body.questions[0], {
    id: 'q1',
    question: 'What is the difference between let and var?',
    answer: 'let is block scoped, var is function scoped.',
    evaluation: { score: '8/10', verdict: 'Good', feedback: 'Missing hoisting.' },
    followUp: 'What is the temporal dead zone?',
    hidden: true,
  })
  assert.deepEqual(body.questions[2], {
    id: 'q3',
    question: 'What is a closure?',
    answer: '',
    evaluation: null,
    followUp: null,
    assistRequired: true,
    explanation: '<p>A closure captures its lexical scope.</p>',
  })

  const missing = await api('GET', '/api/sections/nope')
  assert.equal(missing.status, 404)
})

test('quiz questions expose type and options but never the answer key', async (t) => {
  const { api } = await startServer(t, { 'java/quiz.json': SEED_JAVA_QUIZ })
  const url = `/api/sections/${encodeURIComponent('java/quiz')}`

  const { status, body } = await api('GET', url)
  assert.equal(status, 200)
  assert.deepEqual(body.questions[0], {
    id: 'q1',
    question: 'Which of the following are JVM languages?',
    answer: '',
    evaluation: null,
    followUp: null,
    type: 'quiz',
    options: ['Kotlin', 'Rust', 'Scala', 'Go'],
  })

  // saving a selection round-trips like any other answer
  const saved = await api('PUT', `${url}/answers`, { answers: { q1: 'Kotlin\nScala' } })
  assert.equal(saved.body.questions[0].answer, 'Kotlin\nScala')
})

test('PUT /answers merges answers and returns the updated section', async (t) => {
  const { api } = await startServer(t)
  const { status, body } = await api('PUT', `/api/sections/${encodeURIComponent('java/core')}/answers`, {
    answers: { q1: 'The Java Virtual Machine.', q9: 'ignored' },
  })
  assert.equal(status, 200)
  assert.equal(body.questions[0].answer, 'The Java Virtual Machine.')
  assert.equal(body.questions[1].answer, '')
})

test('POST /clear-low-scores clears only below-threshold questions', async (t) => {
  const { api } = await startServer(t)
  const url = `/api/sections/${encodeURIComponent('javascript/basics')}/clear-low-scores`

  const none = await api('POST', url, { threshold: 6 })
  assert.deepEqual(none.body.clearedIds, []) // only score present is 8/10

  const all = await api('POST', url, { threshold: 9 })
  assert.deepEqual(all.body.clearedIds, ['q1'])
  assert.equal(all.body.section.questions[0].answer, '')
  assert.equal(all.body.section.questions[0].evaluation, null)

  const bad = await api('POST', url, { threshold: 'high' })
  assert.equal(bad.status, 400)
})

test('PUT /assist toggles the flag and validates input', async (t) => {
  const { api, db } = await startServer(t)
  const url = `/api/sections/${encodeURIComponent('java/core')}/assist`

  const on = await api('PUT', url, { questionId: 'q1', assistRequired: true })
  assert.equal(on.status, 200)
  assert.equal(on.body.questions[0].assistRequired, true)

  const off = await api('PUT', url, { questionId: 'q1', assistRequired: false })
  assert.equal(off.body.questions[0].assistRequired, undefined)

  assert.equal((await api('PUT', url, { questionId: 'q1' })).status, 400)
  assert.equal((await api('PUT', url, { questionId: 'q99', assistRequired: true })).status, 404)
})

test('PUT /hidden hides and unhides by threshold', async (t) => {
  const { api } = await startServer(t)
  const url = `/api/sections/${encodeURIComponent('javascript/basics')}/hidden`

  // q1 (8/10) is already hidden from migration, so hiding changes nothing new
  const hide = await api('PUT', url, { hidden: true, threshold: 6 })
  assert.deepEqual(hide.body.changedIds, [])

  const unhide = await api('PUT', url, { hidden: false })
  assert.deepEqual(unhide.body.changedIds, ['q1'])
  assert.equal(unhide.body.section.questions[0].hidden, undefined)

  assert.equal((await api('PUT', url, { hidden: 'yes' })).status, 400)
})

test('PUT /explanation-request keeps the explanation and validates input', async (t) => {
  const { api } = await startServer(t)
  const url = `/api/sections/${encodeURIComponent('javascript/basics')}/explanation-request`

  const examples = await api('PUT', url, { questionId: 'q3', mode: 'examples' })
  assert.equal(examples.status, 200)
  assert.equal(examples.body.questions[2].assistRequired, true)
  assert.equal(examples.body.questions[2].explanation, '<p>A closure captures its lexical scope.</p>')

  const expand = await api('PUT', url, { questionId: 'q3', mode: 'expand', context: 'more depth' })
  assert.equal(expand.status, 200)

  assert.equal((await api('PUT', url, { questionId: 'q3', mode: 'nope' })).status, 400)
  assert.equal((await api('PUT', url, { mode: 'examples' })).status, 400)
  assert.equal((await api('PUT', url, { questionId: 'q99', mode: 'examples' })).status, 404)
})

test('DELETE /explanation removes the explanation and validates input', async (t) => {
  const { api } = await startServer(t)
  const url = `/api/sections/${encodeURIComponent('javascript/basics')}/explanation`

  const removed = await api('DELETE', url, { questionId: 'q3' })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.questions[2].explanation, undefined)

  assert.equal((await api('DELETE', url, {})).status, 400)
  assert.equal((await api('DELETE', url, { questionId: 'q99' })).status, 404)
})

test('GET /activity aggregates answered_at into day and month buckets', async (t) => {
  // start from a topic with no pre-answered questions, so today's bucket is clean
  const { api } = await startServer(t)

  const empty = await api('GET', `/api/sections/${encodeURIComponent('java/core')}`)
  assert.equal(empty.status, 200)

  const before = await api('GET', '/api/activity')
  const today = new Date().toISOString().slice(0, 10)
  const baseline = before.body.days.find((d) => d.date === today)?.count ?? 0

  await api('PUT', `/api/sections/${encodeURIComponent('java/core')}/answers`, {
    answers: { q1: 'The Java Virtual Machine.' },
  })
  const { body } = await api('GET', '/api/activity')
  const day = body.days.find((d) => d.date === today)
  assert.equal(day.count, baseline + 1)
  const month = body.months.find((m) => m.date === today.slice(0, 7))
  assert.equal(month.count, baseline + 1)
})
