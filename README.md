# AI Teacher

A small Vue app to study by answering questions and getting them graded by an agent.

Content is organized in three levels: **subject → topic → questions**
(e.g. Java → Parallelism → questions). A subject is a directory under `data/`,
a topic is a JSON file inside it. Deeper nesting is already supported by the
server (any directory depth works), the UI currently groups by the first level.

Loop:
1. **Agent writes questions** into a topic JSON (`/aiteacher-questions`).
2. **You answer** in the UI and click **Save answers**.
3. **Agent grades** the answers and adds a follow-up (`/aiteacher-evaluate`).
4. Click **Reload** in the UI to see the evaluation and follow-up.

The sidebar groups topics by subject; the dashboard shows per-subject and
per-topic progress.

## Run (Docker)

```bash
docker compose up --build
```

Open http://localhost:5173

`./data` is mounted into the container, so the agents (run on the host via the console)
and the UI read and write the same files.

## Agents (run manually in the console)

- `/aiteacher-questions` — generate a question set for a subject/topic.
- `/aiteacher-evaluate` — grade your answers and add follow-ups.

Both are skills in `.claude/skills/` and operate on `dev/ai-teacher/data/<subject>/<topic>.json`.

## Data layout

```
data/
  java/
    core.json           <- topic "Core Java"
    parallelism.json    <- topic "Parallelism"
  javascript/
    _subject.json       <- optional: { "title": "JavaScript" } (pretty subject name)
    basics.json
  system-design/
    fundamentals.json
```

- Subject display name defaults to Title Case of the directory name
  (`system-design` → "System Design"); override it with `_subject.json`.
- Files starting with `_` are metadata, never topics.
- The API addresses a topic by its path id, e.g. `java/parallelism`
  (URL-encoded in requests: `/api/sections/java%2Fparallelism`).

## Topic JSON format

```json
{
  "id": "parallelism",
  "title": "Parallelism",
  "description": "optional",
  "questions": [
    {
      "id": "q1",
      "question": "text",
      "answer": "",
      "evaluation": { "score": "8/10", "verdict": "Good", "feedback": "..." },
      "followUp": "a deeper question, or null"
    }
  ]
}
```

- `id` equals the topic filename without `.json`.
- The UI only ever writes the `answer` field (merged in, never clobbering agent output).
- Agents write `question`, `evaluation`, and `followUp`.

## Local dev without Docker

```bash
npm install
npm run build && npm start   # server on :3000
# or, with hot reload:
npm start & npm run dev      # UI on :5173, proxies /api to :3000
```
