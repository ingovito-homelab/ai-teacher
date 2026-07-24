// Apply the evaluator's results from data/_evaluations.json back to SQLite,
// then remove both work files (_evaluations.json and _pending.json).
//
// Expected file shape:
//   {
//     "evaluations": [
//       {
//         "topic": "java/core",
//         "qid": "q1",
//         "evaluation": { "score": "7/10", "verdict": "Good", "feedback": "..." },
//         "followUp": "...",            // optional
//         "explanation": "<p>...</p>"   // optional, assist-flagged questions only
//       }
//     ]
//   }
//
//   node scripts/apply-evaluations.js
import { readFile, rm } from 'node:fs/promises'
import { openDb, applyEvaluation } from '../server/db.js'
import { DB_FILE, PENDING_FILE, EVALUATIONS_FILE } from './lib.js'

let payload
try {
  payload = JSON.parse(await readFile(EVALUATIONS_FILE, 'utf-8'))
} catch (err) {
  console.error(`cannot read ${EVALUATIONS_FILE}: ${err.message}`)
  process.exit(1)
}

const evaluations = payload?.evaluations
if (!Array.isArray(evaluations) || !evaluations.length) {
  console.error(`${EVALUATIONS_FILE} has no "evaluations" array — nothing to apply`)
  process.exit(1)
}

const db = openDb(DB_FILE)
let applied = 0
const failed = []
for (const e of evaluations) {
  if (typeof e?.topic !== 'string' || typeof e?.qid !== 'string') {
    failed.push(e)
    continue
  }
  if (applyEvaluation(db, e)) applied++
  else failed.push(e)
}
db.close()

console.log(`applied ${applied}/${evaluations.length} evaluation(s) to ${DB_FILE}`)
if (failed.length) {
  console.error('not applied (unknown topic/qid or empty payload):')
  for (const e of failed) console.error(`  - ${e?.topic ?? '?'} ${e?.qid ?? '?'}`)
  process.exit(1)
}

await rm(EVALUATIONS_FILE, { force: true })
await rm(PENDING_FILE, { force: true })
console.log('work files removed; reload the UI to see the new evaluations')
