# AI Teacher

A small Vue app to study by answering questions and getting them graded by an agent.

Content is organized in three levels: **subject → topic → questions**
(e.g. Java → Parallelism → questions). All state (answers, evaluations,
follow-ups, flags) lives in a **SQLite database** at `data/ai-teacher.db`
(built-in `node:sqlite`, WAL mode — needs Node ≥ 22.13 / the `node:24` image).
The JSON files under `data/<subject>/` are **seed files**: plain question lists
imported into the DB on server start (or via `npm run import`), deduplicated by
a content hash of the question text, so re-importing never duplicates anything.

Loop:
1. **Agent writes questions** into a seed JSON and imports them
   (`/aiteacher-questions` for open questions, `/aiteacher-quiz` for
   multiselect quizzes).
2. **You answer** in the UI and click **Save answers**.
3. **Agent grades** everything pending (`/aiteacher-evaluate`): answered-but-not-yet-evaluated
   questions and "assist" requests are exported from SQLite, graded, and written back.
4. Click **Reload** in the UI to see the evaluation and follow-up.

The sidebar groups topics by subject; the dashboard shows per-subject and
per-topic progress plus an answering-activity chart.

## Run (Docker)

```bash
docker compose -f compose.dev.yaml up --build
```

Open http://localhost:8088

`./data` is mounted into the container, so the host (agents, npm scripts) and
the server share the same SQLite file and seed JSONs.

## Agents (run manually in the console)

- `/aiteacher-questions` — generate an open-question set for a subject/topic
  (writes a seed JSON, then `npm run import`).
- `/aiteacher-quiz` — generate a multiselect quiz for a subject/topic
  (same pipeline, entries carry options + answer key).
- `/aiteacher-evaluate` — grade all pending answers and add follow-ups
  (`npm run export-pending` → grade → `npm run apply-evaluations`).

All three are skills in `.claude/skills/`.

## Scripts

```bash
npm run import                    # import seed JSONs into SQLite (hash-deduplicated)
npm run import -- --with-state    # one-off legacy migration: also carries
                                   # answers/evaluations from old full-schema files
npm run export-pending            # pending questions -> data/_pending.json
npm run apply-evaluations         # data/_evaluations.json -> SQLite, removes work files
npm test                          # node:test suite (importer, DB logic, API)
```

A question is **pending** when its answer is newer than its last evaluation
(answering a follow-up counts — it edits the same answer field), or when it is
flagged "assist required" and has no explanation yet. Toggling assist on clears
the previous explanation, i.e. requests a fresh one.

Note: `server.js` in this fork always imports with `--with-state`-equivalent
behavior, since the seed files here still carry real answer/evaluation state
(this app predates the SQLite migration). That's harmless to leave on
permanently — it only affects questions being inserted for the first time,
never rows already present in the DB.

## Data layout

```
data/
  ai-teacher.db         <- SQLite: the source of truth (git-ignored)
  java/
    core.json           <- seed for topic "Core Java"
    parallelism.json    <- seed for topic "Parallelism"
  javascript/
    _subject.json       <- optional: { "title": "JavaScript" } (pretty subject name)
    basics.json
  _pending.json         <- transient work file for the evaluator (git-ignored)
  _evaluations.json     <- transient work file for the evaluator (git-ignored)
```

- Subject display name defaults to Title Case of the directory name
  (`system-design` → "System Design"); override it with `_subject.json`.
- Files starting with `_` are metadata/work files, never topics.
- The API addresses a topic by its path id, e.g. `java/parallelism`
  (URL-encoded in requests: `/api/sections/java%2Fparallelism`).

## Seed JSON format

```json
{
  "id": "parallelism",
  "title": "Parallelism",
  "description": "optional",
  "questions": [
    "a question as a plain string",
    { "question": "the old object form is accepted too" },
    {
      "type": "quiz",
      "question": "Which of these are true about X?",
      "options": ["A", "B", "C", "D"],
      "correct": [0, 2]
    }
  ]
}
```

- `id` equals the topic filename without `.json`.
- Question ids (`q1`, `q2`, ...) are assigned by the importer.
- Old full-schema files (with `answer`/`evaluation`/`followUp` per question) still
  work as seeds — the state fields are ignored on import unless `--with-state`
  is used (see note above).
- Quiz entries (`type: "quiz"`) need 2+ `options` and a non-empty `correct`
  array of 0-based option indices; the UI renders them as checkboxes and never
  receives `correct` — only the evaluator does.

## Local dev without Docker

Requires Node ≥ 22.13 (for `node:sqlite`).

```bash
npm install
npm run build && npm start   # server on :3000
# or, with hot reload:
npm start & npm run dev      # UI on :5173, proxies /api to :3000
```
