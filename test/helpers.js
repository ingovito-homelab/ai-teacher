import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openDb } from '../server/db.js'

export function memoryDb() {
  return openDb(':memory:')
}

// Create a throwaway data dir from { 'java/core.json': {...}, ... } and
// return { dir, cleanup }.
export async function makeDataDir(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-teacher-test-'))
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(content, null, 2) + '\n')
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export const SEED_JAVA_CORE = {
  id: 'core',
  title: 'Core Java',
  description: 'Core Java concepts.',
  questions: [
    { id: 'q1', question: 'What is the JVM?', answer: '', evaluation: null, followUp: null },
    { id: 'q2', question: 'Explain garbage collection.', answer: '', evaluation: null, followUp: null },
  ],
}

export const SEED_JAVA_QUIZ = {
  id: 'quiz',
  title: 'Java Quiz',
  questions: [
    {
      type: 'quiz',
      question: 'Which of the following are JVM languages?',
      options: ['Kotlin', 'Rust', 'Scala', 'Go'],
      correct: [0, 2],
    },
    'An open question in the same topic.',
  ],
}

// Old full-schema topic file, used by the --with-state migration tests.
export const LEGACY_JS_BASICS = {
  id: 'basics',
  title: 'Basics',
  description: 'Core language concepts.',
  questions: [
    {
      id: 'q1',
      question: 'What is the difference between let and var?',
      answer: 'let is block scoped, var is function scoped.',
      evaluation: { score: '8/10', verdict: 'Good', feedback: 'Missing hoisting.' },
      followUp: 'What is the temporal dead zone?',
      hidden: true,
    },
    {
      id: 'q2',
      question: 'Explain the event loop.',
      answer: 'It processes macrotasks and microtasks.',
      evaluation: null,
      followUp: null,
    },
    {
      id: 'q3',
      question: 'What is a closure?',
      answer: '',
      evaluation: null,
      followUp: null,
      assistRequired: true,
      explanation: '<p>A closure captures its lexical scope.</p>',
    },
  ],
}
