import test from 'node:test'
import assert from 'node:assert/strict'
import { importSeeds } from '../server/importer.js'
import { getSection, pendingQuestions } from '../server/db.js'
import { memoryDb, makeDataDir, SEED_JAVA_CORE, SEED_JAVA_QUIZ, LEGACY_JS_BASICS } from './helpers.js'

test('imports subjects, topics and questions from seed files', async (t) => {
  const { dir, cleanup } = await makeDataDir({
    'java/core.json': SEED_JAVA_CORE,
    'javascript/_subject.json': { title: 'JavaScript' },
    'javascript/basics.json': { title: 'Basics', questions: ['What is a closure?'] },
  })
  t.after(cleanup)
  const db = memoryDb()

  const stats = await importSeeds(db, dir)
  assert.equal(stats.topics, 2)
  assert.equal(stats.inserted, 3)
  assert.equal(stats.skipped, 0)

  const core = getSection(db, 'java/core')
  assert.equal(core.title, 'Core Java')
  assert.equal(core.description, 'Core Java concepts.')
  assert.equal(core.subject, 'java')
  assert.equal(core.subjectTitle, 'Java') // derived from slug
  assert.deepEqual(core.questions.map((q) => q.id), ['q1', 'q2'])
  assert.deepEqual(core.questions[0], {
    id: 'q1',
    question: 'What is the JVM?',
    answer: '',
    evaluation: null,
    followUp: null,
  })

  // plain-string seed entries and _subject.json title override
  const basics = getSection(db, 'javascript/basics')
  assert.equal(basics.subjectTitle, 'JavaScript')
  assert.deepEqual(basics.questions.map((q) => q.id), ['q1'])
  assert.equal(basics.questions[0].question, 'What is a closure?')
})

test('re-import is idempotent thanks to the content hash', async (t) => {
  const { dir, cleanup } = await makeDataDir({ 'java/core.json': SEED_JAVA_CORE })
  t.after(cleanup)
  const db = memoryDb()

  await importSeeds(db, dir)
  const stats = await importSeeds(db, dir)
  assert.equal(stats.inserted, 0)
  assert.equal(stats.skipped, 2)
  assert.equal(getSection(db, 'java/core').questions.length, 2)
})

test('dedup ignores whitespace and case differences', async (t) => {
  const first = await makeDataDir({ 'java/core.json': SEED_JAVA_CORE })
  t.after(first.cleanup)
  const db = memoryDb()
  await importSeeds(db, first.dir)

  const second = await makeDataDir({
    'java/core.json': {
      title: 'Core Java',
      questions: ['  what is   the JVM?  ', 'A genuinely new question?'],
    },
  })
  t.after(second.cleanup)
  const stats = await importSeeds(db, second.dir)
  assert.equal(stats.inserted, 1)
  assert.equal(stats.skipped, 1)
})

test('new questions get the next free qid; conflicting seed ids are reassigned', async (t) => {
  const first = await makeDataDir({ 'java/core.json': SEED_JAVA_CORE })
  t.after(first.cleanup)
  const db = memoryDb()
  await importSeeds(db, first.dir)

  const second = await makeDataDir({
    'java/core.json': {
      title: 'Core Java',
      questions: [
        // seed reuses id "q1" for a different question — must not clobber the existing q1
        { id: 'q1', question: 'What are records in Java?' },
        'What is the JIT compiler?',
      ],
    },
  })
  t.after(second.cleanup)
  await importSeeds(db, second.dir)

  const core = getSection(db, 'java/core')
  assert.deepEqual(core.questions.map((q) => q.id), ['q1', 'q2', 'q3', 'q4'])
  assert.equal(core.questions[0].question, 'What is the JVM?')
  assert.equal(core.questions[2].question, 'What are records in Java?')
  assert.equal(core.questions[3].question, 'What is the JIT compiler?')
})

test('--with-state migrates answers, evaluations and flags', async (t) => {
  const { dir, cleanup } = await makeDataDir({ 'javascript/basics.json': LEGACY_JS_BASICS })
  t.after(cleanup)
  const db = memoryDb()

  await importSeeds(db, dir, { withState: true })
  const [q1, q2, q3] = getSection(db, 'javascript/basics').questions

  assert.equal(q1.answer, 'let is block scoped, var is function scoped.')
  assert.deepEqual(q1.evaluation, { score: '8/10', verdict: 'Good', feedback: 'Missing hoisting.' })
  assert.equal(q1.followUp, 'What is the temporal dead zone?')
  assert.equal(q1.hidden, true)

  assert.equal(q2.answer, 'It processes macrotasks and microtasks.')
  assert.equal(q2.evaluation, null)

  assert.equal(q3.assistRequired, true)
  assert.equal(q3.explanation, '<p>A closure captures its lexical scope.</p>')

  // pending after migration: only q2 (answered, never evaluated).
  // q1 is answered+evaluated, q3 has assist but the explanation already exists.
  assert.deepEqual(pendingQuestions(db).map((p) => p.qid), ['q2'])
})

test('without --with-state answers and evaluations are NOT imported', async (t) => {
  const { dir, cleanup } = await makeDataDir({ 'javascript/basics.json': LEGACY_JS_BASICS })
  t.after(cleanup)
  const db = memoryDb()

  await importSeeds(db, dir)
  const [q1] = getSection(db, 'javascript/basics').questions
  assert.equal(q1.answer, '')
  assert.equal(q1.evaluation, null)
  assert.equal(q1.followUp, null)
  assert.equal(pendingQuestions(db).length, 0)
})

test('imports multiselect quiz entries alongside open questions', async (t) => {
  const { dir, cleanup } = await makeDataDir({ 'java/quiz.json': SEED_JAVA_QUIZ })
  t.after(cleanup)
  const db = memoryDb()

  const stats = await importSeeds(db, dir)
  assert.equal(stats.inserted, 2)

  const [quiz, open] = getSection(db, 'java/quiz').questions
  assert.equal(quiz.type, 'quiz')
  assert.deepEqual(quiz.options, ['Kotlin', 'Rust', 'Scala', 'Go'])
  assert.equal('correct' in quiz, false, 'the answer key must not reach the UI')
  assert.equal(open.type, undefined)
  assert.equal(open.options, undefined)

  // re-import stays idempotent for quizzes too
  const again = await importSeeds(db, dir)
  assert.equal(again.inserted, 0)
  assert.equal(again.skipped, 2)
})

test('same quiz stem with a different option set is a new question', async (t) => {
  const first = await makeDataDir({ 'java/quiz.json': SEED_JAVA_QUIZ })
  t.after(first.cleanup)
  const db = memoryDb()
  await importSeeds(db, first.dir)

  const second = await makeDataDir({
    'java/quiz.json': {
      title: 'Java Quiz',
      questions: [
        {
          type: 'quiz',
          question: 'Which of the following are JVM languages?',
          options: ['Clojure', 'C', 'Groovy'],
          correct: [0, 2],
        },
      ],
    },
  })
  t.after(second.cleanup)
  const stats = await importSeeds(db, second.dir)
  assert.equal(stats.inserted, 1)
  assert.equal(getSection(db, 'java/quiz').questions.length, 3)
})

test('malformed quiz entries are skipped', async (t) => {
  const { dir, cleanup } = await makeDataDir({
    'java/quiz.json': {
      title: 'Java Quiz',
      questions: [
        { type: 'quiz', question: 'No options at all?' },
        { type: 'quiz', question: 'One option only?', options: ['A'], correct: [0] },
        { type: 'quiz', question: 'No valid correct index?', options: ['A', 'B'], correct: [5] },
        { type: 'quiz', question: 'A valid one?', options: ['A', 'B'], correct: [1] },
      ],
    },
  })
  t.after(cleanup)
  const db = memoryDb()

  const stats = await importSeeds(db, dir)
  assert.equal(stats.inserted, 1)
  assert.equal(getSection(db, 'java/quiz').questions[0].question, 'A valid one?')
})

test('files and dirs starting with "_" or "." are never topics', async (t) => {
  const { dir, cleanup } = await makeDataDir({
    'java/core.json': SEED_JAVA_CORE,
    '_pending.json': { questions: [{ question: 'work file, not a topic' }] },
    'java/_subject.json': { title: 'Java SE' },
  })
  t.after(cleanup)
  const db = memoryDb()

  const stats = await importSeeds(db, dir)
  assert.equal(stats.topics, 1)
  assert.equal(getSection(db, '_pending'), null)
  assert.equal(getSection(db, 'java/core').subjectTitle, 'Java SE')
})
