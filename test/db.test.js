import test from 'node:test'
import assert from 'node:assert/strict'
import { importSeeds } from '../server/importer.js'
import {
  getSection,
  saveAnswers,
  clearLowScores,
  setAssistRequired,
  requestExplanationUpdate,
  setHidden,
  pendingQuestions,
  applyEvaluation,
  listSections,
} from '../server/db.js'
import { memoryDb, makeDataDir, SEED_JAVA_CORE, SEED_JAVA_QUIZ, LEGACY_JS_BASICS } from './helpers.js'

async function seededDb(t, files = { 'java/core.json': SEED_JAVA_CORE }, opts = {}) {
  const { dir, cleanup } = await makeDataDir(files)
  t.after(cleanup)
  const db = memoryDb()
  await importSeeds(db, dir, opts)
  return db
}

const answeredAt = (db, topic, qid) =>
  db.prepare('SELECT answered_at FROM questions WHERE topic_id = ? AND qid = ?').get(topic, qid)
    .answered_at

// Pretend the last evaluation happened an hour ago, so a fresh answered_at in
// the same test run is strictly newer despite millisecond timestamp precision.
const backdateEvaluation = (db) =>
  db.exec(
    `UPDATE questions SET evaluated_at = strftime('%Y-%m-%d %H:%M:%f', 'now', '-1 hour')
     WHERE evaluated_at IS NOT NULL`
  )

test('saveAnswers stamps answered_at only when the text changes', async (t) => {
  const db = await seededDb(t)

  saveAnswers(db, 'java/core', { q1: 'The Java Virtual Machine.' })
  const first = answeredAt(db, 'java/core', 'q1')
  assert.ok(first, 'answered_at set on first save')

  // The UI posts the full answers map on save — an unchanged answer must not
  // re-queue the question for evaluation.
  saveAnswers(db, 'java/core', { q1: 'The Java Virtual Machine.', q2: '' })
  assert.equal(answeredAt(db, 'java/core', 'q1'), first)

  saveAnswers(db, 'java/core', { q1: '' })
  assert.equal(answeredAt(db, 'java/core', 'q1'), null)

  // unknown qids and non-string values are ignored
  saveAnswers(db, 'java/core', { nope: 'x', q2: 42 })
  assert.equal(getSection(db, 'java/core').questions[1].answer, '')
})

test('pending lifecycle: answer -> evaluate -> re-answer', async (t) => {
  const db = await seededDb(t)

  assert.equal(pendingQuestions(db).length, 0)

  saveAnswers(db, 'java/core', { q1: 'The Java Virtual Machine.' })
  let pending = pendingQuestions(db)
  assert.deepEqual(pending.map((p) => `${p.topic}:${p.qid}`), ['java/core:q1'])
  assert.equal(pending[0].previousEvaluation, null)
  assert.equal(pending[0].currentFollowUp, null)

  assert.ok(
    applyEvaluation(db, {
      topic: 'java/core',
      qid: 'q1',
      evaluation: { score: '9/10', verdict: 'Excellent', feedback: 'Spot on.' },
      followUp: 'What does the JIT do?',
    })
  )
  assert.equal(pendingQuestions(db).length, 0)
  assert.deepEqual(getSection(db, 'java/core').questions[0].evaluation, {
    score: '9/10',
    verdict: 'Excellent',
    feedback: 'Spot on.',
  })

  // answering the follow-up appends to the same answer field -> pending again,
  // and the exported item carries the previous evaluation + current follow-up
  backdateEvaluation(db)
  saveAnswers(db, 'java/core', {
    q1: 'The Java Virtual Machine.\n----FOLLOW UP ANSWER-----\nIt compiles hot paths.',
  })
  pending = pendingQuestions(db)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].previousEvaluation.score, '9/10')
  assert.equal(pending[0].currentFollowUp, 'What does the JIT do?')
})

test('assist flag drives pending until an explanation is written', async (t) => {
  const db = await seededDb(t)

  assert.ok(setAssistRequired(db, 'java/core', 'q2', true))
  let pending = pendingQuestions(db)
  assert.deepEqual(pending.map((p) => p.qid), ['q2'])
  assert.equal(pending[0].assistRequired, true)

  assert.ok(
    applyEvaluation(db, { topic: 'java/core', qid: 'q2', explanation: '<p>GC basics.</p>' })
  )
  assert.equal(pendingQuestions(db).length, 0)
  const q2 = getSection(db, 'java/core').questions[1]
  assert.equal(q2.assistRequired, true) // flag stays until the user clears it
  assert.equal(q2.explanation, '<p>GC basics.</p>')

  // re-flagging asks for a fresh explanation: the old one is cleared -> pending
  assert.ok(setAssistRequired(db, 'java/core', 'q2', true))
  assert.equal(getSection(db, 'java/core').questions[1].explanation, undefined)
  assert.equal(pendingQuestions(db).length, 1)

  assert.ok(setAssistRequired(db, 'java/core', 'q2', false))
  assert.equal(pendingQuestions(db).length, 0)
  assert.equal(setAssistRequired(db, 'java/core', 'missing', true), false)
})

test('requestExplanationUpdate touches up an existing explanation without hiding it', async (t) => {
  const db = await seededDb(t)

  assert.ok(setAssistRequired(db, 'java/core', 'q2', true))
  assert.ok(
    applyEvaluation(db, { topic: 'java/core', qid: 'q2', explanation: '<p>GC basics.</p>' })
  )
  assert.equal(pendingQuestions(db).length, 0)

  // "add examples": the old explanation must stay visible while pending
  assert.ok(requestExplanationUpdate(db, 'java/core', 'q2', 'examples'))
  assert.equal(getSection(db, 'java/core').questions[1].explanation, '<p>GC basics.</p>')
  let pending = pendingQuestions(db)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].assistMode, 'examples')
  assert.equal(pending[0].currentExplanation, '<p>GC basics.</p>')
  assert.equal(pending[0].assistContext, undefined)

  // "expand deeper" with context
  assert.ok(requestExplanationUpdate(db, 'java/core', 'q2', 'expand', 'focus on generations'))
  pending = pendingQuestions(db)
  assert.equal(pending[0].assistMode, 'expand')
  assert.equal(pending[0].assistContext, 'focus on generations')

  // applying the new explanation clears the request, so it's no longer pending
  assert.ok(
    applyEvaluation(db, { topic: 'java/core', qid: 'q2', explanation: '<p>GC basics, deeper.</p>' })
  )
  assert.equal(pendingQuestions(db).length, 0)

  assert.equal(requestExplanationUpdate(db, 'java/core', 'missing', 'examples'), false)
})

test('clearLowScores resets state below the threshold', async (t) => {
  const db = await seededDb(t, { 'javascript/basics.json': LEGACY_JS_BASICS }, { withState: true })

  applyEvaluation(db, {
    topic: 'javascript/basics',
    qid: 'q2',
    evaluation: { score: '4/10', verdict: 'Partially correct', feedback: 'Too shallow.' },
    followUp: 'What are microtasks?',
  })

  const clearedIds = clearLowScores(db, 'javascript/basics', 6)
  assert.deepEqual(clearedIds, ['q2']) // q1 has 8/10, q3 unanswered

  const q2 = getSection(db, 'javascript/basics').questions[1]
  assert.equal(q2.answer, '')
  assert.equal(q2.evaluation, null)
  assert.equal(q2.followUp, null)
  assert.equal(pendingQuestions(db).length, 0, 'cleared question is no longer pending')
})

test('setHidden hides well-scored questions and unhides everything', async (t) => {
  const db = await seededDb(t, { 'javascript/basics.json': LEGACY_JS_BASICS }, { withState: true })

  // q1 already hidden (migrated flag), scores: q1=8/10, q2/q3 unevaluated
  assert.deepEqual(setHidden(db, 'javascript/basics', true, 6), [])

  applyEvaluation(db, {
    topic: 'javascript/basics',
    qid: 'q2',
    evaluation: { score: '7/10', verdict: 'Good', feedback: 'ok' },
  })
  assert.deepEqual(setHidden(db, 'javascript/basics', true, 6), ['q2'])
  assert.deepEqual(
    getSection(db, 'javascript/basics').questions.map((q) => !!q.hidden),
    [true, true, false]
  )

  assert.deepEqual(setHidden(db, 'javascript/basics', false, 6), ['q1', 'q2'])
  assert.deepEqual(
    getSection(db, 'javascript/basics').questions.map((q) => !!q.hidden),
    [false, false, false]
  )
})

test('listSections computes the same aggregates the JSON server did', async (t) => {
  const db = await seededDb(t, {
    'javascript/_subject.json': { title: 'JavaScript' },
    'javascript/basics.json': LEGACY_JS_BASICS,
    'java/core.json': SEED_JAVA_CORE,
  }, { withState: true })

  const sections = listSections(db)
  // sorted by subjectTitle, then title
  assert.deepEqual(sections.map((s) => s.id), ['java/core', 'javascript/basics'])

  const basics = sections[1]
  assert.equal(basics.subjectTitle, 'JavaScript')
  assert.equal(basics.total, 3)
  assert.equal(basics.answered, 2)
  assert.equal(basics.evaluated, 1)
  assert.equal(basics.followUps, 1)
  assert.equal(basics.scored, 1)
  assert.equal(basics.avgScore, 8)

  const core = sections[0]
  assert.equal(core.answered, 0)
  assert.equal(core.avgScore, null)
})

test('pending quiz questions carry options and the answer key', async (t) => {
  const db = await seededDb(t, { 'java/quiz.json': SEED_JAVA_QUIZ })

  saveAnswers(db, 'java/quiz', { q1: 'Kotlin\nRust' })
  const [pending] = pendingQuestions(db)
  assert.equal(pending.type, 'quiz')
  assert.deepEqual(pending.options, ['Kotlin', 'Rust', 'Scala', 'Go'])
  assert.deepEqual(pending.correctOptions, ['Kotlin', 'Scala'])

  // open questions keep the old export shape
  saveAnswers(db, 'java/quiz', { q2: 'An answer.' })
  const open = pendingQuestions(db).find((p) => p.qid === 'q2')
  assert.equal('type' in open, false)
  assert.equal('correctOptions' in open, false)
})

test('openDb migrates a pre-quiz questions table in place', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { openDb } = await import('../server/db.js')

  const dir = await mkdtemp(path.join(tmpdir(), 'ai-teacher-migrate-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'old.db')

  // the questions table as it looked before the quiz columns existed
  const old = new DatabaseSync(file)
  old.exec(`
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id TEXT NOT NULL, qid TEXT NOT NULL,
      question TEXT NOT NULL, question_hash TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      eval_score TEXT, eval_verdict TEXT, eval_feedback TEXT,
      follow_up TEXT, explanation TEXT,
      assist_required INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      answered_at TEXT, evaluated_at TEXT,
      UNIQUE(topic_id, qid), UNIQUE(topic_id, question_hash)
    )
  `)
  old.exec(`
    INSERT INTO questions (topic_id, qid, question, question_hash)
    VALUES ('java/core', 'q1', 'What is the JVM?', 'h1')
  `)
  old.close()

  const db = openDb(file)
  t.after(() => db.close())
  const row = db.prepare('SELECT type, options, correct FROM questions').get()
  assert.deepEqual({ ...row }, { type: 'open', options: null, correct: null })
})

test('applyEvaluation returns false for unknown questions or empty payloads', async (t) => {
  const db = await seededDb(t)
  assert.equal(applyEvaluation(db, { topic: 'java/core', qid: 'q99', evaluation: { score: '1/10' } }), false)
  assert.equal(applyEvaluation(db, { topic: 'java/core', qid: 'q1' }), false)
})
