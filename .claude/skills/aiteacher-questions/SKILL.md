---
name: aiteacher-questions
description: Generate a set of study questions for the AI Teacher app and write them into a seed JSON file under data/<subject>/, then import them into SQLite. Use when the user wants a new question set / topic, or to add questions to an existing topic. Triggers "aiteacher-questions", "write questions for <topic>".
---

# AI Teacher — Question Writer

You create question sets for the AI Teacher app. Content is organized as
**subject → topic → questions**. The **SQLite database**
(`data/ai-teacher.db`) is the source of truth for all state
(answers, evaluations, follow-ups, flags). The JSON files at
`data/<subject>/<topic>.json` are **seed files**: they only carry
the list of questions and are imported into the DB with content-hash
deduplication, so importing the same file twice never duplicates anything.

## Inputs to gather

Ask the user only for what is missing:
- **Subject** — the main area (e.g. "Java", "System Design", "Angular"). Kebab-case
  directory name: `java`, `system-design`, `angular`.
- **Topic** — the concrete topic within the subject (e.g. "Parallelism"). Kebab-case
  file name: `parallelism`.
- **How many questions** (default 8 if unspecified).
- **Difficulty / focus** (optional).
- Whether this is a **new topic** or **adding to an existing** one.

Derive kebab-case ids from the titles (e.g. "System Design" -> `system-design`).
Reuse an existing subject directory when one fits; list `data/` to check.

## Seed file format

```json
{
  "id": "<topic-id>",
  "title": "<Human Topic Title>",
  "description": "<one-line summary, optional>",
  "questions": [
    "<the question text>",
    "<another question>"
  ]
}
```

Rules:
- `id` of the file object must equal the topic filename without `.json`.
- `questions` entries are plain strings. (Objects with a `question` field are
  also accepted — that's how pre-migration files look; never write the old
  `answer`/`evaluation`/`followUp` fields in new content, the importer ignores them.)
- Multiselect quiz entries (`{ "type": "quiz", ... }`) may sit in the same array —
  they are written by the `aiteacher-quiz` skill; use that skill when the user
  wants quizzes instead of open-ended questions.
- Question ids (`q1`, `q2`, ...) are assigned by the importer — do not invent them.
- Write valid JSON, 2-space indented, trailing newline.

Optional subject metadata: `data/<subject>/_subject.json` with `{ "title": "..." }`
sets the display name of the subject. Only needed when Title Case derived from the
directory name is wrong (e.g. `javascript` -> "JavaScript"). Files starting with `_`
are never treated as topics.

## Procedure

1. Resolve the subject and topic ids and the path
   `data/<subject>/<topic>.json`. Create the subject directory if new;
   add `_subject.json` only when the derived title needs fixing.
2. **New topic:** create the file with the format above.
   **Existing topic:** read the current file and append the new question strings to
   its `questions` array (keep whatever entry format the file already uses for the
   old entries; do not modify them). Rewriting an already-imported question is
   pointless — dedup works on question text, so edits create a *new* question.
3. Write good questions: open-ended, concept-testing, one idea each, ordered easy→hard.
   Avoid pure yes/no questions.
4. Import into SQLite: run `npm run import` in the project root. It prints how many
   questions were new vs already known — report those numbers. (If the import cannot
   be run, tell the user the questions will be picked up automatically the next time
   the server starts.)
5. Tell the user the file path, the import result, and that the topic appears in the
   UI under its subject (they may need "Reload sections").
