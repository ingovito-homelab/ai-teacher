# AI Teacher — migracja JSON → SQLite

## Kontekst

Dziś jedynym magazynem danych są pliki `data/<subject>/<topic>.json` — serwer (`server.js`)
czyta i nadpisuje całe pliki przez `fs/promises`, a skille `aiteacher-questions` /
`aiteacher-evaluate` edytują te same pliki bezpośrednio na hoście. To działa, ale:

- każdy zapis to przepisanie całego pliku (ryzyko utraty danych przy równoczesnym zapisie
  host ↔ kontener),
- brak rozdzielenia „treść pytań" (generowana) od „stan użytkownika" (odpowiedzi, oceny),
- ewaluacja wymaga ręcznego wskazywania plików tematu.

Cel: **SQLite jako jedyne źródło prawdy dla stanu**, a JSON zostaje wyłącznie jako
**seed z listą pytań**, importowany na starcie serwera z deduplikacją po hashu treści pytania.
Ewaluacja nadal przez AI (skill na hoście), ale zasilana skryptem, który wyciąga z SQLite
wszystkie pytania odpowiedziane-a-nieocenione lub z włączonym „request assist".

## Decyzje

| Decyzja | Wybór | Uzasadnienie |
|---|---|---|
| Silnik | wbudowany **`node:sqlite`** (`DatabaseSync`) | zero natywnych zależności; `better-sqlite3` nie buduje się na hostowym Node 26 (znany problem z projektu Side/), a skrypty ewaluacyjne muszą chodzić na hoście |
| Docker | **ten sam kontener** | SQLite jest embedded — osobny kontener nie ma sensu; podbijamy tylko bazę do `node:24-alpine` (node:sqlite wymaga Node ≥ 22.13) |
| Plik bazy | `data/ai-teacher.db` (+ WAL) | istniejący bind-mount `./data:/app/data` zostaje bez zmian; host (skrypty/skille) i kontener (serwer) współdzielą bazę — WAL załatwia równoczesny dostęp |
| Seedy | `data/<subject>/<topic>.json` — bez zmian ścieżek | skill `aiteacher-questions` dalej pisze tam pliki; importer czyta z nich tylko `title`/`description`/`questions[].question` |
| Dedup | `sha256(znormalizowana treść pytania)`, unikalny per temat | normalizacja: trim + zbicie białych znaków; `UNIQUE(topic_id, question_hash)` — ponowny import niczego nie dubluje |
| API frontendu | **bez zmian kontraktu** | `src/api.js`, `App.vue`, `QuestionCard.vue` nie wymagają żadnych zmian |

## Schemat bazy

```sql
CREATE TABLE IF NOT EXISTS subjects (
  id    TEXT PRIMARY KEY,          -- slug katalogu, np. 'java'
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,    -- section id, np. 'java/core'
  subject_id  TEXT NOT NULL REFERENCES subjects(id),
  title       TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id        TEXT NOT NULL REFERENCES topics(id),
  qid             TEXT NOT NULL,             -- 'q1'… — id widoczne w API/froncie
  question        TEXT NOT NULL,
  question_hash   TEXT NOT NULL,             -- sha256 znormalizowanej treści
  answer          TEXT NOT NULL DEFAULT '',
  eval_score      TEXT,                      -- '7/10'
  eval_verdict    TEXT,
  eval_feedback   TEXT,
  follow_up       TEXT,
  explanation     TEXT,                      -- HTML dla assist
  assist_required INTEGER NOT NULL DEFAULT 0,
  hidden          INTEGER NOT NULL DEFAULT 0,
  answered_at     TEXT,                      -- ustawiane przy zapisie odpowiedzi
  evaluated_at    TEXT,                      -- ustawiane przy zapisie oceny
  UNIQUE(topic_id, qid),
  UNIQUE(topic_id, question_hash)
);
```

`answered_at` / `evaluated_at` zastępują ręczne wskazywanie co ocenić:
**pending = `answer != '' AND (evaluated_at IS NULL OR answered_at > evaluated_at)`
OR `assist_required = 1 AND explanation IS NULL`.**
Konwencja markera `----FOLLOW UP ANSWER-----` w polu `answer` zostaje bez zmian —
dopisanie odpowiedzi na follow-up aktualizuje `answered_at`, więc pytanie samo wraca do puli pending.

## Nowe pliki

| Plik | Rola |
|---|---|
| `server/db.js` | otwarcie bazy (`DATA_DIR/ai-teacher.db`), `PRAGMA journal_mode=WAL`, idempotentne `CREATE TABLE IF NOT EXISTS`, przygotowane statementy |
| `server/importer.js` | skan `data/**/*.json` (pomija `_`/`.` i sam plik `.db`), upsert subjects/topics, INSERT pytań z pominięciem istniejących hashy; `qid` = kolejny wolny `qN` w temacie |
| `scripts/import.js` | CLI: `npm run import` — ten sam importer uruchamiany ręcznie na hoście; flaga `--with-state` do jednorazowej migracji legacy (przenosi też `answer`, `evaluation`, `followUp`, `hidden`, `assistRequired`, `explanation` z obecnych JSON-ów) |
| `scripts/export-pending.js` | CLI: wyciąga z SQLite pytania pending (patrz wyżej) i zapisuje `data/_pending.json` — wsad dla skilla ewaluacyjnego (topic id, qid, question, answer, dotychczasowa ocena, flaga assist) |
| `scripts/apply-evaluations.js` | CLI: czyta `data/_evaluations.json` (wynik pracy skilla) i zapisuje do bazy `eval_*`, `follow_up`, `explanation`, ustawia `evaluated_at`; po sukcesie kasuje oba pliki robocze |

Pliki robocze z prefiksem `_` — importer je ignoruje (istniejąca konwencja).

## Zmiany w istniejących plikach

1. **`server.js`** — wymiana warstwy I/O na `server/db.js`, kontrakt API bez zmian:
   - `GET /api/sections` — agregaty (`total/answered/evaluated/followUps/scored/avgScore`) jednym zapytaniem SQL; `parseScore` z `src/score.js` zostaje do średniej (lub liczona w JS po pobraniu wierszy — bez zmiany wyniku),
   - `GET /api/sections/:id` — rekonstrukcja obecnego kształtu JSON (`evaluation: {score,verdict,feedback} | null`, `followUp`, `assistRequired`/`hidden` tylko gdy true, `explanation`),
   - `PUT /api/sections/:id/answers` — `UPDATE questions SET answer=?, answered_at=datetime('now')`,
   - `POST /api/sections/:id/clear-low-scores` — reset `answer/eval_*/follow_up/answered_at/evaluated_at` dla score < threshold,
   - `PUT /api/sections/:id/assist`, `PUT /api/sections/:id/hidden` — proste UPDATE-y,
   - na starcie serwera: `initDb()` + `runImport()` (seed JSON-ów).
2. **`package.json`** — skrypty: `import`, `export-pending`, `apply-evaluations`; brak nowych zależności.
3. **`Dockerfile`** — baza `node:24-alpine` (wymóg `node:sqlite`); reszta bez zmian.
4. **`docker-compose.yml`** — bez zmian (bind-mount `./data` obsługuje i seedy, i `.db`).
5. **Skille** (`ai-learning-game/.claude/skills/`):
   - `aiteacher-questions/SKILL.md` — dalej pisze `data/<subject>/<topic>.json`, ale w uproszczonym formacie seedu (bez pól `answer/evaluation/followUp` — importer i tak by je zignorował); na końcu instrukcja: uruchom `npm run import` (albo poinformuj, że serwer zaimportuje przy restarcie),
   - `aiteacher-evaluate/SKILL.md` — nowy przepływ: (1) `npm run export-pending`, (2) oceń pytania z `data/_pending.json` wg dotychczasowych reguł (score/verdict/feedback/followUp, explanation dla assist), zapisz `data/_evaluations.json`, (3) `npm run apply-evaluations`. Znika ręczne wskazywanie tematu — skill zawsze ocenia całą pulę pending ze wszystkich przedmiotów.
6. **`README.md`** — opis nowej architektury danych i skryptów.

## Kolejność wdrożenia

1. `server/db.js` + schemat.
2. `server/importer.js` + `scripts/import.js` (z `--with-state`).
3. Jednorazowa migracja: `node scripts/import.js --with-state` na kopii `data/` → weryfikacja liczby pytań/odpowiedzi.
4. Refaktor `server.js` na SQLite (endpoint po endpoincie, porównując odpowiedzi API przed/po).
5. Skrypty `export-pending` / `apply-evaluations`.
6. Aktualizacja obu SKILL.md i README.
7. Dockerfile → `node:24-alpine`, rebuild, test w kontenerze.

## Weryfikacja

- `node scripts/import.js --with-state` na kopii danych → liczby: pytania per temat, odpowiedzi
  niepuste, oceny — zgodne z JSON-ami (policzyć `jq` vs `SELECT COUNT(*)`).
- Ponowny `npm run import` → 0 nowych wierszy (dedup działa).
- Dopisanie nowego pytania do seedu + import → dokładnie 1 nowy wiersz.
- `npm run build && npm start` → UI: lista przedmiotów/tematów, agregaty, zapis odpowiedzi,
  clear-low-scores, toggle assist/hidden — porównanie z zachowaniem sprzed migracji.
- `export-pending` po udzieleniu odpowiedzi w UI → pytanie pojawia się w `_pending.json`;
  po `apply-evaluations` znika z puli, ocena widoczna w UI.
- Docker: `docker compose up --build` → to samo na porcie 8088; równolegle skrypt na hoście
  czyta bazę (WAL) bez błędów `database is locked`.
