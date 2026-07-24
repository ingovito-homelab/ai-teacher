---
name: aiteacher-quiz
description: Generate short multiselect quizzes for the AI Teacher app and write them into a seed JSON file under data/<subject>/, then import them into SQLite. Use when the user wants quiz-style (checkbox / multiple-choice) questions on a topic, instead of the open-ended questions aiteacher-questions writes. Triggers "aiteacher-quiz", "quiz me on <topic>", "generate a quiz for <topic>".
---

# AI Teacher — Quiz Writer

You create **multiselect quiz** questions for the AI Teacher app. The content
pipeline is the same as `aiteacher-questions` (subject → topic → questions,
seed JSON imported into SQLite with dedup), only the entry format differs:
quiz entries carry options and the answer key. The UI renders them as
checkboxes; the evaluator grades the selection against the key.

## Inputs to gather

Ask the user only for what is missing:
- **Subject** and **topic** — same rules as `aiteacher-questions` (kebab-case ids,
  reuse existing directories/files; list `data/` to check).
  Quizzes can live in the same topic file as open questions.
- **How many quizzes** (default 5 if unspecified).
- **Difficulty / focus** (optional).

## Quiz entry format

Quiz entries go into the topic file's `questions` array alongside plain-string
(open) entries:

```json
{
  "id": "parallelism",
  "title": "Parallelism",
  "questions": [
    "An open-ended question is just a string.",
    {
      "type": "quiz",
      "question": "Which of the following are true about java.util.concurrent locks?",
      "options": [
        "ReentrantLock supports fairness",
        "synchronized can be interrupted while waiting",
        "tryLock() can time out",
        "StampedLock is reentrant"
      ],
      "correct": [0, 2]
    }
  ]
}
```

Rules:
- `type` must be exactly `"quiz"`; `options` is 3–6 short strings; `correct` is a
  non-empty array of **0-based indices** into `options`. Entries with fewer than
  2 options or an empty/invalid `correct` are silently skipped by the importer —
  double-check the indices.
- Every quiz is multiselect: 1 to all options may be correct. Vary the number of
  correct options across the set so "always pick two" never becomes a pattern.
- Dedup key for quizzes is question text **plus options**, so the same stem with
  a new option set imports as a new question — but editing an already-imported
  quiz still creates a duplicate; don't rewrite imported entries.
- Question ids are assigned by the importer — do not invent them.
- Write valid JSON, 2-space indented, trailing newline.

## Writing good quizzes

- One concept per quiz; order the set easy → hard.
- Wrong options must be *plausible* — common misconceptions, near-misses, or
  true-sounding statements about a neighboring concept. No joke options.
- Keep options parallel in form and comparable in length (the longest option
  being correct is a well-known tell).
- Avoid "all of the above"/"none of the above" and negated stems ("which is NOT")
  unless the negation is the point being tested.
- The stem must be answerable without seeing the options removed — no
  "which of the following" trivia about arbitrary lists.

## Procedure

1. Resolve `data/<subject>/<topic>.json` (create directory/file
   for a new topic, same rules as `aiteacher-questions`).
2. **New topic:** create the file with `id`/`title`/`questions`.
   **Existing topic:** read it and append the quiz entries to `questions`;
   never modify existing entries.
3. Import into SQLite: run `npm run import` in the project root. Report new vs
   already-known counts. (If the import cannot be run, the questions are picked
   up automatically the next time the server starts.)
4. Tell the user the file path, the import result, and that the quizzes show up
   in the UI as checkbox questions under the topic (they may need "Reload
   sections"). Answers are graded by `/aiteacher-evaluate` against the stored
   answer key.
