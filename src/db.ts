import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, chmodSync, openSync, closeSync } from 'node:fs'
import { STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

// Lock the DB file and its sidecars (WAL, SHM, rollback journal) down to
// owner-only. better-sqlite3 opens the main file with the process umask
// (typically 0o644), which leaves a TOCTOU window where any other local
// process -- malicious npm postinstall, rogue shell script, unrelated
// tool running under the operator's UID -- can open() it for read BEFORE
// we narrow the mode. The narrowed chmod would not revoke an already-
// opened fd. Defense in depth:
//   (1) Pre-create the main DB file via openSync('wx', 0o600) so better-
//       sqlite3 inherits the tight mode on fresh installs and the race
//       window is closed entirely.
//   (2) After Database() + PRAGMA wal, chmod the sidecars (WAL/SHM/
//       journal) -- they were created during the pragma call at umask.
//       This path also fixes older installs whose files sit at 0o644.
function tightenDbPermissions(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  for (const path of sidecars) {
    if (!existsSync(path)) continue
    try { chmodSync(path, 0o600) } catch (err) {
      logger.warn({ err, path }, 'Failed to tighten DB file permissions')
    }
  }
}

// dbPathOverride is for tests: pass ':memory:' (or a temp path) to open an
// isolated database instead of the real store/claudeclaw.db. The file-precreate
// (openSync 'wx') and tightenDbPermissions steps are SKIPPED for an override --
// they only make sense for a real on-disk store file, and ':memory:' has no path
// to chmod. This keeps tests idempotent and stops them polluting the prod DB.
export function initDatabase(dbPathOverride?: string): void {
  const useOverride = dbPathOverride !== undefined
  if (!useOverride) mkdirSync(STORE_DIR, { recursive: true })
  // Idempotent re-init: close a previous handle before opening a new one
  // so repeated calls (tests, hot-reload, recovery paths) do not leak
  // the old better-sqlite3 fd.
  if (db) {
    try { db.close() } catch { /* already closed */ }
  }
  const dbPath = useOverride ? dbPathOverride! : join(STORE_DIR, DB_FILENAME)
  // Step 1: close the TOCTOU window on fresh installs. openSync with 'wx'
  // + 0o600 creates the file ONLY if it doesn't exist and sets the strict
  // mode atomically. better-sqlite3 then opens the existing file rather
  // than creating one at the default umask. Skipped for a test override.
  if (!useOverride && !existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, 'wx', 0o600))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // EEXIST: a concurrent startup won the race and created it. The
      // tightenDbPermissions call below will correct its mode.
      if (code !== 'EEXIST') {
        logger.warn({ err, dbPath }, 'Pre-create of DB file failed, continuing; mode will be tightened post-open')
      }
    }
  }
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  if (!useOverride) tightenDbPermissions(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Migráció: message_count oszlop hozzáadása meglévő DB-hez
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0')
  } catch {
    // már létezik, rendben
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    )
  `)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)`)

  // --- Kanban ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
      assignee TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      project TEXT,
      due_date INTEGER,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `)
  // Migration: add project column to kanban_cards for installs created
  // before #89 (whose CREATE TABLE IF NOT EXISTS ran without `project`
  // and is a no-op on the next boot). Without this, createKanbanCard
  // and updateKanbanCard fail with `table kanban_cards has no column
  // named project` and no card can be saved.
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN project TEXT')
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN parent_id TEXT REFERENCES kanban_cards(id)')
  } catch {
    // column already exists
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_parent ON kanban_cards(parent_id)')
  // Migration: add dispatched_at to kanban_cards (kanban -> agent dispatch
  // once-only guard). Older installs created the table without it.
  try {
    db.exec('ALTER TABLE kanban_cards ADD COLUMN dispatched_at INTEGER')
  } catch {
    // column already exists
  }
  // Migration: add agent_id, category, auto_generated columns to memories
  try {
    db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'marveen'")
  } catch {
    // column already exists
  }
  try {
    db.exec("ALTER TABLE memories ADD COLUMN category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('user_pref','project','feedback','learning','shared','general'))")
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE memories ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0')
  } catch {
    // column already exists
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category)`)

  // --- Conversation-continuity ledger (deterministic; P0 2026-06-02) ---
  // A durable ROLLING TRANSCRIPT of every channel turn -- inbound user messages
  // AND outbound replies -- per agent_id + chat_id. On a respawn (a fresh
  // --channels session with no memory of the live conversation) the SessionStart
  // replay hook injects the last ~20 turns of context PLUS highlights the open
  // question (the most recent inbound with no later outbound), so the fresh
  // session continues exactly where the connection dropped -- ZERO agent
  // discretion. Generic across all three channel agents (marveen/dia/erno-ba);
  // agent_id is derived from the session cwd so each session only sees its own
  // chat. Written by the settings.json hooks (UserPromptSubmit capture +
  // PostToolUse outbound). UNIQUE(...) makes inbound capture idempotent; outbound
  // rows carry message_id=NULL so they are never deduped against each other.
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      message_id TEXT,
      text TEXT,
      ts TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(agent_id, chat_id, direction, message_id)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at)`)

  // Migration: hot/warm/cold/shared tier system with an enforced CHECK.
  // Rebuilds the table whenever its current schema doesn't include the
  // canonical CHECK -- covers both the legacy ('user_pref'...) and the
  // post-refactor-no-check states, and is idempotent on fresh DBs.
  try {
    const current = db.prepare("SELECT sql FROM sqlite_master WHERE name='memories'").get() as { sql: string } | undefined
    const hasCanonicalCheck = !!current?.sql?.match(/CHECK\s*\(\s*category\s+IN\s*\(\s*'hot'\s*,\s*'warm'\s*,\s*'cold'\s*,\s*'shared'\s*\)\s*\)/i)
    if (current?.sql && !hasCanonicalCheck) {
      // Preserve keywords if the column exists; older DBs rebuilt this table
      // before the keywords ADD COLUMN ran, so NULL out in that case.
      const cols = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]
      const keywordsExpr = cols.some(c => c.name === 'keywords') ? 'keywords' : 'NULL'
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT NOT NULL,
          topic_key TEXT,
          content TEXT NOT NULL,
          sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
          salience REAL NOT NULL DEFAULT 1.0,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          agent_id TEXT NOT NULL DEFAULT 'marveen',
          category TEXT NOT NULL DEFAULT 'warm' CHECK(category IN ('hot','warm','cold','shared')),
          auto_generated INTEGER NOT NULL DEFAULT 0,
          keywords TEXT
        );
        INSERT INTO memories_new SELECT id, chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id,
          CASE category
            WHEN 'hot' THEN 'hot'
            WHEN 'warm' THEN 'warm'
            WHEN 'cold' THEN 'cold'
            WHEN 'shared' THEN 'shared'
            WHEN 'user_pref' THEN 'warm'
            WHEN 'project' THEN 'warm'
            WHEN 'general' THEN 'warm'
            WHEN 'feedback' THEN 'cold'
            WHEN 'learning' THEN 'cold'
            ELSE 'warm'
          END,
          auto_generated,
          ${keywordsExpr}
        FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `)
      // Recreate FTS and triggers for new schema (now includes keywords)
      db.exec(`DROP TABLE IF EXISTS memories_fts`)
      db.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(content, keywords, content='memories', content_rowid='id')`)
      db.exec(`DROP TRIGGER IF EXISTS memories_ai`)
      db.exec(`DROP TRIGGER IF EXISTS memories_ad`)
      db.exec(`DROP TRIGGER IF EXISTS memories_au`)
      db.exec(`CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END`)
      db.exec(`CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); END`)
      db.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content, keywords) VALUES('delete', old.id, old.content, old.keywords); INSERT INTO memories_fts(rowid, content, keywords) VALUES (new.id, new.content, new.keywords); END`)
      db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, category)`)
    }
  } catch (err) {
    // Previously this silently swallowed every error which masked the
    // CHECK-constraint drop that Bug #2 described. Log loudly instead so
    // a broken migration is obvious in the dashboard log.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(msg)) {
      console.error('[db] memories migration failed:', msg)
    }
  }

  // If the table already has the new schema but no keywords column (edge case)
  try {
    db.exec('ALTER TABLE memories ADD COLUMN keywords TEXT')
  } catch {
    // column already exists
  }

  // Migration: embedding column for vector search
  try {
    db.exec('ALTER TABLE memories ADD COLUMN embedding TEXT')
  } catch {
    // column already exists
  }

  // Migration: data sovereignty columns (sensitivity, scope, ttl_days)
  try {
    db.exec("ALTER TABLE memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'technical' CHECK(sensitivity IN ('pii','sensitive','technical','public'))")
  } catch { /* column already exists */ }
  try {
    db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'local_only' CHECK(scope IN ('local_only','claude_code_ok','none'))")
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE memories ADD COLUMN ttl_days INTEGER')
  } catch { /* column already exists */ }
  try {
    db.exec('ALTER TABLE memories ADD COLUMN expires_at INTEGER')
  } catch { /* column already exists */ }

  // Daily logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_logs_date ON daily_logs(agent_id, date)`)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_status ON kanban_cards(status, archived_at)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kanban_comments_card ON kanban_comments(card_id)`)

  // --- Agent Messages ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','done','failed')),
      result TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      completed_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_messages_status ON agent_messages(status, to_agent)`)

  // --- Pending Channel Requests (Slack channel opt-in workflow) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_channel_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied'))
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_agent_channel ON pending_channel_requests(agent, channel_id) WHERE status = 'pending'`)
  try { db.exec('ALTER TABLE pending_channel_requests ADD COLUMN resolved_at INTEGER') } catch { /* already exists */ }

  // --- Task Run History ---
  // Log every scheduled-task firing so the dashboard overview's "tasksToday"
  // survives dashboard restarts. Replaces the old store/task-run-history.json
  // which had a plain read-modify-write race under concurrent/restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      agent TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_runs_ts ON task_runs(ts)`)

  // --- Pending Scheduled Task Retries ---
  // Busy-skipped scheduled tasks used to live in an in-memory Map. On a
  // dashboard restart (or crash), the queue was lost -- even though the
  // operator had asked for the task to run, it silently disappeared.
  // This table persists each busy-retry across restarts so nothing is
  // dropped. When a row crosses the alert threshold, the alerting layer
  // stamps alert_sent_at before each Telegram send and clears it on
  // delivery failure, yielding at-least-once delivery with no double-
  // alerting on concurrent ticks. The scheduler itself never abandons:
  // it keeps retrying until the session frees up or the operator
  // cancels from the UI.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_task_retries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      first_attempt INTEGER NOT NULL,
      last_attempt INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      last_reason TEXT,
      alert_sent_at INTEGER,
      UNIQUE(task_name, agent_name)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_retries_first_attempt ON pending_task_retries(first_attempt)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
      tmux_session TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      output TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bg_tasks_agent ON background_tasks(agent_id, status)`)

  // --- Token Usage Monitoring ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      content_preview TEXT,
      tool_name TEXT,
      task_title TEXT,
      project TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(timestamp)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_token_usage_agent_ts ON token_usage(agent, timestamp)`)
  // Deduplicate existing rows before creating unique index
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`)
  } catch {
    db.exec(`
      DELETE FROM token_usage WHERE id NOT IN (
        SELECT MIN(id) FROM token_usage
        GROUP BY agent, session_id, timestamp, input_tokens, output_tokens
      )
    `)
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_dedup ON token_usage(agent, session_id, timestamp, input_tokens, output_tokens)`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_cursors (
      file_path TEXT PRIMARY KEY,
      last_line INTEGER NOT NULL DEFAULT 0,
      last_size INTEGER NOT NULL DEFAULT 0
    )
  `)

  // --- Idea Box ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS idea_box (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'Egyéb',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','kanban','rejected')),
      source TEXT NOT NULL DEFAULT 'marveen',
      kanban_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_box_status ON idea_box(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_idea_box_category ON idea_box(category)`)

  // --- Workflow Recordings ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_recordings (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      trigger_keywords TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      run_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT NOT NULL DEFAULT 'marveen',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_workflow_agent ON workflow_recordings(agent_id)`)
  try { db.exec('ALTER TABLE workflow_recordings ADD COLUMN trigger_description TEXT') } catch { }
  try { db.exec('ALTER TABLE workflow_recordings ADD COLUMN embedding TEXT') } catch { }
  try { db.exec("ALTER TABLE workflow_recordings ADD COLUMN branch_stats_json TEXT NOT NULL DEFAULT '{}'") } catch { }

  // --- Session Contexts (Persistent Context Engine) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      top_memories_json TEXT NOT NULL DEFAULT '[]',
      kanban_snapshot_json TEXT NOT NULL DEFAULT '[]',
      open_decisions_json TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_ctx_agent ON session_contexts(agent_id, created_at)`)

  // --- Telegram History ---
  // (Recreated here: the prod DB had this table but its CREATE had been lost
  // from the code, so a fresh install would crash on saveTelegramMessage.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      user_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tgh_msg ON telegram_history(chat_id, message_id, direction)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tgh_chat_ts ON telegram_history(chat_id, ts)`)
  // Thread reconstruction: the inbound Telegram channel block does not surface
  // reply_to, so a terse follow-up ("részletezd ki") can attach to the wrong
  // thread. We persist reply_to when known (mostly on outbound threaded replies)
  // and reconstruct context by substance otherwise. See reconstructThreadContext.
  try { db.exec('ALTER TABLE telegram_history ADD COLUMN reply_to_message_id TEXT') } catch { /* exists */ }

  // --- Outbound Resend Queue ---
  // When the Telegram MCP stdio-pipe dies mid-conversation, outbound replies
  // fail silently and are lost. The agent enqueues a failed send here; the
  // channel-health-monitor claims pending rows after a successful reconnect
  // and re-injects them so the agent resends via the reply tool. dispatched_at
  // guards against re-injecting the same row on every monitor tick.
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      sent_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outq_pending ON outbound_queue(agent_id, status, dispatched_at)`)

  // --- Outbound Audit Log (data sovereignty) ---
  // Persistent, queryable record of every item the outbound DataGate
  // evaluated -- "what left the local environment, when, and why".
  // The gate previously only wrote to the app logger (ephemeral, not
  // queryable), so there was no after-the-fact answer to "did this PII
  // memory ever reach Claude?". One row per evaluated item.
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      memory_id TEXT,
      purpose TEXT NOT NULL,
      sensitivity TEXT,
      scope TEXT,
      allowed INTEGER NOT NULL,
      reason TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_audit_ts ON outbound_audit(ts)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbound_audit_allowed ON outbound_audit(allowed, ts)`)

  // --- Sales Q&A (Agrolánc tudásbázis) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_qa (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      context TEXT,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_qa_tags ON sales_qa(tags)`)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sales_qa_fts USING fts5(
      question, answer, context, tags,
      content='sales_qa',
      content_rowid='rowid'
    )
  `)
  db.exec(`CREATE TRIGGER IF NOT EXISTS sales_qa_ai AFTER INSERT ON sales_qa BEGIN
    INSERT INTO sales_qa_fts(rowid, question, answer, context, tags) VALUES (new.rowid, new.question, new.answer, COALESCE(new.context,''), new.tags);
  END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS sales_qa_ad AFTER DELETE ON sales_qa BEGIN
    INSERT INTO sales_qa_fts(sales_qa_fts, rowid, question, answer, context, tags) VALUES('delete', old.rowid, old.question, old.answer, COALESCE(old.context,''), old.tags);
  END`)
  db.exec(`CREATE TRIGGER IF NOT EXISTS sales_qa_au AFTER UPDATE ON sales_qa BEGIN
    INSERT INTO sales_qa_fts(sales_qa_fts, rowid, question, answer, context, tags) VALUES('delete', old.rowid, old.question, old.answer, COALESCE(old.context,''), old.tags);
    INSERT INTO sales_qa_fts(rowid, question, answer, context, tags) VALUES (new.rowid, new.question, new.answer, COALESCE(new.context,''), new.tags);
  END`)

  // --- Tool Call Log (auto-recorder) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_summary TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_log_session ON tool_call_log(session_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_log_ts ON tool_call_log(created_at)`)

  // --- Skill Usage Log ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      trigger_text TEXT,
      agent_id TEXT NOT NULL DEFAULT 'marveen',
      outcome TEXT CHECK(outcome IN ('positive','negative','neutral')) DEFAULT 'neutral',
      feedback_note TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_usage_skill ON skill_usage_log(skill_name, created_at)`)
  // Migration: which A/B variant produced this usage (null = not in an experiment)
  try { db.exec('ALTER TABLE skill_usage_log ADD COLUMN variant TEXT') } catch { /* exists */ }

  // --- A/B Skill Experiments ---
  // Run two variants of a skill in controlled alternation, measure outcomes
  // from skill_usage_log, promote the winner. Variant assignment is
  // deterministic (parity of recorded usages) so it is testable and even.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      hypothesis TEXT,
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done')),
      winner TEXT CHECK(winner IN ('A','B') OR winner IS NULL),
      created_at INTEGER NOT NULL,
      decided_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_exp_skill ON skill_experiments(skill_name, status)`)

  // --- Session Recordings (replay + regression harness) ---
  // Immutable fixtures: an ordered event list (inbound/tool/reply) captured
  // from a session, used to regression-diff future runs of the same scenario.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      scenario TEXT NOT NULL,
      events_json TEXT NOT NULL DEFAULT '[]',
      is_baseline INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_rec_scenario ON session_recordings(scenario, created_at)`)

  // --- Outbound Critic Samples (self-improving critic) ---
  // Accumulates what the outbound self-critic flagged, so getCriticSuggestions
  // can surface the most frequent triggers and inform new rule proposals.
  db.exec(`
    CREATE TABLE IF NOT EXISTS critic_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      channel TEXT NOT NULL,
      blocked INTEGER NOT NULL DEFAULT 0,
      rule TEXT,
      match_text TEXT,
      text_preview TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_critic_samples_rule ON critic_samples(rule)`)

  // --- Unified Triage Inbox ---
  // One prioritized queue across channels. urgency/intent/score come from the
  // triage classifier; status tracks whether the item still needs a response.
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('telegram','email','whatsapp','other')),
      external_id TEXT,
      sender TEXT,
      subject TEXT,
      preview TEXT NOT NULL DEFAULT '',
      urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('urgent','normal','low')),
      intent TEXT NOT NULL DEFAULT 'fyi' CHECK(intent IN ('question','request','fyi')),
      score INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
      received_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_inbox_status_score ON inbox_items(status, score, received_at)`)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_source_ext ON inbox_items(source, external_id) WHERE external_id IS NOT NULL`)
  // Migration: SLA escalation timestamp (set when an urgent stuck item is nudged)
  try { db.exec('ALTER TABLE inbox_items ADD COLUMN escalated_at INTEGER') } catch { /* exists */ }

  // One-shot migration from the old JSON file (which had a read-modify-write
  // race). Import rows if they exist, then rename the file so we don't keep
  // re-importing. Wrapped in a transaction so a crash mid-import is safe.
  migrateTaskRunsFromJson()
}

function migrateTaskRunsFromJson(): void {
  const legacyPath = join(STORE_DIR, 'task-run-history.json')
  if (!existsSync(legacyPath)) return
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM task_runs').get() as { c: number }).c
  if (existingCount > 0) {
    // Already migrated in a previous run. Rename the file out of the way if
    // still present so the migration doesn't keep re-running with zero effect.
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
    return
  }
  try {
    const raw = readFileSync(legacyPath, 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    const insert = db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)')
    const tx = db.transaction((rows: unknown[]) => {
      for (const e of rows) {
        if (!e || typeof e !== 'object') continue
        const { name, agent, ts } = e as { name?: unknown; agent?: unknown; ts?: unknown }
        if (typeof name !== 'string' || typeof agent !== 'string' || typeof ts !== 'number') continue
        insert.run(name, agent, ts)
      }
    })
    tx(arr)
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
  } catch { /* corrupt file, skip */ }
}

export function getDb(): Database.Database {
  return db
}

// --- Munkamenetek ---

export function getSession(chatId: string): { sessionId: string; messageCount: number } | undefined {
  const row = db
    .prepare('SELECT session_id, message_count FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; message_count: number } | undefined
  if (!row) return undefined
  return { sessionId: row.session_id, messageCount: row.message_count }
}

export function setSession(chatId: string, sessionId: string, messageCount = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at, message_count) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000), messageCount)
}

export function incrementSessionCount(chatId: string): number {
  db.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE chat_id = ?').run(chatId)
  const row = db.prepare('SELECT message_count FROM sessions WHERE chat_id = ?').get(chatId) as { message_count: number } | undefined
  return row?.message_count ?? 0
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
}

// --- Memória ---

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  agent_id: string
  category: string  // 'hot' | 'warm' | 'cold' | 'shared'
  auto_generated: number
  keywords: string | null
  embedding: string | null
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)'
  ).run(chatId, topicKey ?? null, content, sector, now, now)
}

// Build a safe FTS5 MATCH expression from a free-form user query.
//
// FTS5 treats AND / OR / NOT / NEAR as reserved operators only when uppercase
// and unquoted -- so we lowercase everything, which turns them into ordinary
// search terms. We also cap the number and length of tokens to bound query
// cost (the sanitizer previously allowed an arbitrary-length prefix expansion
// that could make a single request scan the entire index).
export function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

export function searchMemories(query: string, chatId: string, limit = 3): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    return db
      .prepare(
        `SELECT m.* FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE f.content MATCH ? AND m.chat_id = ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(terms, chatId, limit) as Memory[]
  } catch {
    return []
  }
}

export function recentMemories(chatId: string, limit = 5): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, id)
}

export function decayMemories(): void {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 86400
  // Gentler decay: 0.5% per day, only for memories older than 1 week
  // Never delete -- salience just goes lower but memories persist
  db.prepare('UPDATE memories SET salience = MAX(salience * 0.995, 0.01) WHERE created_at < ?').run(oneWeekAgo)
}

export function getMemoriesForChat(chatId: string, limit = 10): Memory[] {
  return db
    .prepare('SELECT * FROM memories WHERE chat_id = ? ORDER BY accessed_at DESC LIMIT ?')
    .all(chatId, limit) as Memory[]
}

export function saveAgentMemory(
  agentId: string,
  content: string,
  category: string,  // hot, warm, cold, shared
  keywords?: string,
  autoGenerated: boolean = false
): { id: number } {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords) VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?)'
  ).run(ALLOWED_CHAT_ID, null, content, 'semantic', now, now, agentId, category, autoGenerated ? 1 : 0, keywords ?? null)
  const id = Number(info.lastInsertRowid)

  // Fire-and-forget: generate embedding asynchronously
  generateEmbedding(content + (keywords ? ' ' + keywords : '')).then(emb => {
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id)
    }
  }).catch(() => {})

  return { id }
}

export function getAgentMemories(agentId: string, limit: number = 20): Memory[] {
  return db.prepare(
    "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') ORDER BY accessed_at DESC LIMIT ?"
  ).all(agentId, limit) as Memory[]
}

export function searchAgentMemories(agentId: string, query: string, limit: number = 10): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    return db.prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts f ON m.id = f.rowid
       WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')
       ORDER BY rank LIMIT ?`
    ).all(terms, agentId, limit) as Memory[]
  } catch {
    return db.prepare(
      "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?"
    ).all(agentId, `%${query}%`, `%${query}%`, limit) as Memory[]
  }
}

export function getMemoryStats(): { total: number; byAgent: Record<string, number>; byTier: Record<string, number>; withEmbedding: number } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as {c:number}).c
  const withEmbedding = (db.prepare('SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL').get() as {c:number}).c
  const agentRows = db.prepare('SELECT agent_id, COUNT(*) as c FROM memories GROUP BY agent_id').all() as {agent_id:string, c:number}[]
  const tierRows = db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as {category:string, c:number}[]
  const byAgent: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  for (const r of agentRows) byAgent[r.agent_id] = r.c
  for (const r of tierRows) byTier[r.category] = r.c
  return { total, byAgent, byTier, withEmbedding }
}

// --- Outbound Audit Log ---

export interface OutboundAuditEntry {
  memory_id: string | number | null
  purpose: string
  sensitivity: string | null
  scope: string | null
  allowed: boolean
  reason: string
}

export interface OutboundAuditRow {
  id: number
  ts: number
  memory_id: string | null
  purpose: string
  sensitivity: string | null
  scope: string | null
  allowed: number
  reason: string
}

// Batch-insert audit rows in a single transaction. Called by the DataGate
// for every evaluated outbound item when policy.log_outbound is true.
export function recordOutboundAudit(entries: OutboundAuditEntry[]): void {
  if (!entries.length) return
  const now = Math.floor(Date.now() / 1000)
  const insert = db.prepare(
    'INSERT INTO outbound_audit (ts, memory_id, purpose, sensitivity, scope, allowed, reason) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const tx = db.transaction((rows: OutboundAuditEntry[]) => {
    for (const e of rows) {
      insert.run(now, e.memory_id == null ? null : String(e.memory_id), e.purpose, e.sensitivity, e.scope, e.allowed ? 1 : 0, e.reason)
    }
  })
  tx(entries)
}

export function getOutboundAudit(opts: { limit?: number; allowed?: boolean; purpose?: string; since?: number } = {}): OutboundAuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
  const where: string[] = []
  const params: unknown[] = []
  if (opts.allowed !== undefined) { where.push('allowed = ?'); params.push(opts.allowed ? 1 : 0) }
  if (opts.purpose) { where.push('purpose = ?'); params.push(opts.purpose) }
  if (opts.since) { where.push('ts >= ?'); params.push(opts.since) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  params.push(limit)
  return db.prepare(`SELECT * FROM outbound_audit ${clause} ORDER BY ts DESC, id DESC LIMIT ?`).all(...params) as OutboundAuditRow[]
}

export function getOutboundAuditStats(): { total: number; allowed: number; blocked: number; byReason: Record<string, number> } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM outbound_audit').get() as { c: number }).c
  const allowed = (db.prepare('SELECT COUNT(*) as c FROM outbound_audit WHERE allowed = 1').get() as { c: number }).c
  const reasonRows = db.prepare('SELECT reason, COUNT(*) as c FROM outbound_audit GROUP BY reason ORDER BY c DESC').all() as { reason: string; c: number }[]
  const byReason: Record<string, number> = {}
  for (const r of reasonRows) byReason[r.reason] = r.c
  return { total, allowed, blocked: total - allowed, byReason }
}

export function updateMemory(id: number, content: string, category?: string, agentId?: string, keywords?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['content = ?', 'accessed_at = ?']
  const params: unknown[] = [content, now]
  if (category) { sets.push('category = ?'); params.push(category) }
  if (agentId) { sets.push('agent_id = ?'); params.push(agentId) }
  if (keywords !== undefined) { sets.push('keywords = ?'); params.push(keywords) }
  params.push(id)
  return db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

// --- Daily logs ---

export function appendDailyLog(agentId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().split('T')[0]
  db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)').run(agentId, today, content, now)
}

export function getDailyLog(agentId: string, date: string): { id: number; content: string; created_at: number }[] {
  return db.prepare('SELECT id, content, created_at FROM daily_logs WHERE agent_id = ? AND date = ? ORDER BY created_at ASC').all(agentId, date) as { id: number; content: string; created_at: number }[]
}

export function getDailyLogDates(agentId: string, limit: number = 14): string[] {
  return (db.prepare('SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?').all(agentId, limit) as { date: string }[]).map(r => r.date)
}

// --- Session Recall ---

export interface RecallResult {
  logs: { id: number; agent_id: string; date: string; content: string; created_at: number }[]
  memories: Memory[]
  dateRange: { from: string; to: string }
}

function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Budapest',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export function recallByDateRange(from: string, to: string, agentId?: string): RecallResult {
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = db.prepare(logSql).all(...logParams) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  const memSql = agentId
    ? "SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared') ORDER BY created_at ASC"
    : 'SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC'
  const memParams = agentId ? [fromTs, toTs, agentId] : [fromTs, toTs]
  const memories = db.prepare(memSql).all(...memParams) as Memory[]

  return { logs, memories, dateRange: { from, to } }
}

export function recallSearch(query: string, agentId?: string, limit = 50): RecallResult {
  const terms = buildFtsMatchExpression(query)
  let memories: Memory[] = []
  const escaped = escapeLike(query)
  if (terms) {
    try {
      const sql = agentId
        ? `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared') ORDER BY m.created_at DESC LIMIT ?`
        : `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`
      memories = agentId
        ? db.prepare(sql).all(terms, agentId, limit) as Memory[]
        : db.prepare(sql).all(terms, limit) as Memory[]
    } catch {
      const sql = agentId
        ? "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
      const pat = `%${escaped}%`
      memories = agentId
        ? db.prepare(sql).all(agentId, pat, pat, limit) as Memory[]
        : db.prepare(sql).all(pat, pat, limit) as Memory[]
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? db.prepare(logSql).all(logPat, agentId, limit) as RecallResult['logs']
    : db.prepare(logSql).all(logPat, limit) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories, dateRange: { from, to } }
}

// --- Background tasks ---

export interface BackgroundTask {
  id: string
  agent_id: string
  prompt: string
  status: 'running' | 'done' | 'failed' | 'timeout'
  tmux_session: string | null
  started_at: number
  finished_at: number | null
  output: string | null
}

export function createBackgroundTaskAtomic(id: string, agentId: string, prompt: string, tmuxSession: string, maxConcurrent: number): BackgroundTask | null {
  const now = Math.floor(Date.now() / 1000)
  const result = db.transaction(() => {
    const running = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
    if (running >= maxConcurrent) return null
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, agentId, prompt, 'running', tmuxSession, now)
    return { id, agent_id: agentId, prompt, status: 'running' as const, tmux_session: tmuxSession, started_at: now, finished_at: null, output: null }
  })()
  return result
}

export function getRunningBackgroundTasks(): BackgroundTask[] {
  return db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all() as BackgroundTask[]
}

export function finishBackgroundTask(id: string, status: 'done' | 'failed' | 'timeout', output: string | null): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
    .run(status, now, output, id)
}

export function getBackgroundTasks(agentId?: string, includeFinished = false): BackgroundTask[] {
  if (agentId) {
    const sql = includeFinished
      ? 'SELECT * FROM background_tasks WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50'
      : "SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC"
    return db.prepare(sql).all(agentId) as BackgroundTask[]
  }
  const sql = includeFinished
    ? 'SELECT * FROM background_tasks ORDER BY started_at DESC LIMIT 50'
    : "SELECT * FROM background_tasks WHERE status = 'running' ORDER BY started_at DESC"
  return db.prepare(sql).all() as BackgroundTask[]
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return db.prepare('SELECT * FROM background_tasks WHERE id = ?').get(id) as BackgroundTask | undefined
}

export function countRunningBackgroundTasks(agentId: string): number {
  return (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as { c: number }).c
}

export function markOrphanedTasksFailed(): number {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'")
    .run(now)
  return info.changes
}

// --- Ütemezett feladatok ---

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number
): void {
  db.prepare(
    'INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, chatId, prompt, schedule, nextRun, Math.floor(Date.now() / 1000))
}

export function getDueTasks(): ScheduledTask[] {
  const now = Math.floor(Date.now() / 1000)
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?")
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?'
  ).run(now, nextRun, result, id)
}

export function listTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  return db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id).changes > 0
}

export function pauseTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id).changes > 0
  )
}

export function resumeTask(id: string): boolean {
  return (
    db.prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id).changes > 0
  )
}

export function getTask(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined
}

export function updateTask(id: string, prompt: string, schedule: string, nextRun: number): boolean {
  return db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule = ?, next_run = ? WHERE id = ?').run(prompt, schedule, nextRun, id).changes > 0
}

// --- Kanban ---

export interface KanbanCard {
  id: string
  // Stable running number derived from the SQLite rowid (insertion order, never
  // reused) -- a human-friendly "#N" shown next to the 8-char hex id.
  seq?: number
  title: string
  description: string | null
  status: 'planned' | 'in_progress' | 'waiting' | 'done'
  assignee: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  project: string | null
  parent_id: string | null
  due_date: number | null
  sort_order: number
  created_at: number
  updated_at: number
  archived_at: number | null
  // Set the first time the card is moved to in_progress and the assigned agent
  // is woken (kanban -> agent dispatch). NULL = never dispatched; the once-only
  // guard so re-dragging a card does not re-prompt the agent.
  dispatched_at: number | null
}

export interface KanbanComment {
  id: number
  card_id: string
  author: string
  content: string
  created_at: number
}

export function listKanbanCards(): KanbanCard[] {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400
  // Auto-archive done cards older than 30 days
  db.prepare(
    "UPDATE kanban_cards SET archived_at = ? WHERE status = 'done' AND archived_at IS NULL AND updated_at < ?"
  ).run(Math.floor(Date.now() / 1000), thirtyDaysAgo)
  return db
    .prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE archived_at IS NULL ORDER BY sort_order ASC')
    .all() as KanbanCard[]
}

export function listKanbanCardsSummary(): { status: string; title: string; assignee: string | null; priority: string; id: string }[] {
  return db
    .prepare("SELECT id, title, status, assignee, priority FROM kanban_cards WHERE archived_at IS NULL ORDER BY status, sort_order ASC")
    .all() as any[]
}

export function getKanbanCard(id: string): KanbanCard | undefined {
  return db.prepare('SELECT rowid AS seq, * FROM kanban_cards WHERE id = ?').get(id) as KanbanCard | undefined
}

export function createKanbanCard(card: {
  id: string
  title: string
  description?: string
  status?: KanbanCard['status']
  assignee?: string
  priority?: KanbanCard['priority']
  project?: string
  parent_id?: string
  due_date?: number
}): void {
  const now = Math.floor(Date.now() / 1000)
  const status = card.status ?? 'planned'
  const maxRow = db.prepare(
    'SELECT MAX(sort_order) as m FROM kanban_cards WHERE status = ? AND archived_at IS NULL'
  ).get(status) as { m: number | null }
  const sortOrder = (maxRow?.m ?? -1) + 1

  db.prepare(
    `INSERT INTO kanban_cards (id, title, description, status, assignee, priority, project, parent_id, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    card.id, card.title, card.description ?? null, status,
    card.assignee ?? null, card.priority ?? 'normal',
    card.project ?? null, card.parent_id ?? null, card.due_date ?? null, sortOrder, now, now
  )
}

export function updateKanbanCard(id: string, fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>): boolean {
  const card = getKanbanCard(id)
  if (!card) return false
  const now = Math.floor(Date.now() / 1000)
  const f = { ...card, ...fields, updated_at: now }
  return db.prepare(
    `UPDATE kanban_cards SET title=?, description=?, status=?, assignee=?, priority=?, project=?, parent_id=?, due_date=?, sort_order=?, updated_at=?, archived_at=?
     WHERE id=?`
  ).run(f.title, f.description, f.status, f.assignee, f.priority, f.project, f.parent_id, f.due_date, f.sort_order, f.updated_at, f.archived_at, id).changes > 0
}

export function getChildCards(parentId: string): KanbanCard[] {
  return db.prepare('SELECT * FROM kanban_cards WHERE parent_id = ? AND archived_at IS NULL ORDER BY sort_order ASC').all(parentId) as KanbanCard[]
}

export function moveKanbanCard(id: string, status: KanbanCard['status'], sortOrder: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(
    'UPDATE kanban_cards SET status=?, sort_order=?, updated_at=? WHERE id=?'
  ).run(status, sortOrder, now, id).changes > 0
}

// Stamp the once-only kanban -> agent dispatch guard. Returns false if the
// card id does not exist.
export function markKanbanCardDispatched(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET dispatched_at=? WHERE id=?').run(now, id).changes > 0
}

export function archiveKanbanCard(id: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE kanban_cards SET archived_at=?, updated_at=? WHERE id=?').run(now, now, id).changes > 0
}

export function listKanbanProjects(): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT project FROM kanban_cards WHERE project IS NOT NULL AND project != '' AND archived_at IS NULL ORDER BY project"
  ).all() as Array<{ project: string }>
  return rows.map(r => r.project)
}

export function deleteKanbanCard(id: string): boolean {
  // Wrapped in a transaction to ensure atomicity: all three mutations
  // succeed together or none of them do. Steps in FK-safe order:
  //   1. Delete comments that reference this card (FK: kanban_comments.card_id).
  //   2. Null-out child cards that reference this card as their parent
  //      (FK: kanban_cards.parent_id). Setting parent_id = NULL keeps the
  //      children alive as root-level cards rather than leaving them with a
  //      dangling reference. FK enforcement is currently OFF by default
  //      (better-sqlite3 default), but the dangling parent_id is still a
  //      data bug -- orphaned children do not appear under any parent and
  //      are invisible in hierarchy views.
  //   3. Delete the card itself.
  return db.transaction((cardId: string) => {
    db.prepare('DELETE FROM kanban_comments WHERE card_id = ?').run(cardId)
    db.prepare('UPDATE kanban_cards SET parent_id = NULL WHERE parent_id = ?').run(cardId)
    return db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(cardId).changes > 0
  })(id) as boolean
}

export function getKanbanComments(cardId: string): KanbanComment[] {
  return db.prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as KanbanComment[]
}

export function addKanbanComment(cardId: string, author: string, content: string): KanbanComment {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(cardId, author, content, now)
  db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(now, cardId)
  return { id: Number(info.lastInsertRowid), card_id: cardId, author, content, created_at: now }
}

// --- Heartbeat helpers ---

export interface HeartbeatKanbanSummary {
  urgent: KanbanCard[]
  in_progress: KanbanCard[]
  waiting: KanbanCard[]
}

export function getHeartbeatKanbanSummary(): HeartbeatKanbanSummary {
  const urgent = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'")
    .all() as KanbanCard[]
  const in_progress = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'")
    .all() as KanbanCard[]
  const waiting = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'")
    .all() as KanbanCard[]
  return { urgent, in_progress, waiting }
}

// --- Agent Messages ---

export interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed'
  result: string | null
  created_at: number
  delivered_at: number | null
  completed_at: number | null
}

export function createAgentMessage(from: string, to: string, content: string): AgentMessage {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(from, to, content, 'pending', now)
  return {
    id: Number(info.lastInsertRowid),
    from_agent: from, to_agent: to, content, status: 'pending',
    result: null, created_at: now, delivered_at: null, completed_at: null,
  }
}

export function getPendingMessages(toAgent?: string): AgentMessage[] {
  if (toAgent) {
    return db.prepare("SELECT * FROM agent_messages WHERE status = 'pending' AND to_agent = ? ORDER BY created_at ASC")
      .all(toAgent) as AgentMessage[]
  }
  return db.prepare("SELECT * FROM agent_messages WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as AgentMessage[]
}

export function markMessageDelivered(id: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ?").run(now, id).changes > 0
}

export function markMessageDone(id: number, result?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ? WHERE id = ?").run(result ?? null, now, id).changes > 0
}

export function markMessageFailed(id: number, error?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ?").run(error ?? null, now, id).changes > 0
}

export function listAgentMessages(limit = 50): AgentMessage[] {
  return db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) as AgentMessage[]
}

export interface AgentActivityRow {
  agent: string
  last_active_at: number
  today_count: number
}

export function getAgentActivity(): AgentActivityRow[] {
  return db.prepare(`
    SELECT agent, MAX(last_msg) AS last_active_at, SUM(today_count) AS today_count
    FROM (
      SELECT to_agent AS agent,
             MAX(created_at) AS last_msg,
             SUM(CASE WHEN created_at >= strftime('%s', date('now')) THEN 1 ELSE 0 END) AS today_count
      FROM agent_messages GROUP BY to_agent
      UNION ALL
      SELECT from_agent AS agent,
             MAX(created_at) AS last_msg,
             SUM(CASE WHEN created_at >= strftime('%s', date('now')) THEN 1 ELSE 0 END) AS today_count
      FROM agent_messages GROUP BY from_agent
    )
    GROUP BY agent
    ORDER BY last_active_at DESC
  `).all() as AgentActivityRow[]
}

// System/automation participants that are not real conversation peers. They are
// excluded as THREAD rows in the dashboard sidebar (you don't chat with the
// heartbeat or the coordinator), but messages involving them still count toward
// the human/agent peer they are paired with (so a thread's count matches what
// getAgentConversation returns when you open it).
export const CHAT_SYSTEM_AGENTS = ['heartbeat', 'telegram-coordinator', 'channel-coordinator', 'system'] as const

const AGENT_MESSAGE_LIMIT_CAP = 200

// The actual last-N messages for ONE agent, filtered in SQL (NOT global-last-N
// then JS-filter -- that starved rarely-active agents' threads, dashboard bug
// 2026-06-03). `beforeId` pages older: pass the oldest id you already have to
// fetch the next-older batch (scroll-up pagination). Newest-first.
export function getAgentConversation(agent: string, limit = 50, beforeId?: number): AgentMessage[] {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 1), AGENT_MESSAGE_LIMIT_CAP)
  if (beforeId !== undefined && Number.isFinite(beforeId)) {
    return db.prepare(
      'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(agent, agent, beforeId, cap) as AgentMessage[]
  }
  return db.prepare(
    'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) ORDER BY created_at DESC, id DESC LIMIT ?'
  ).all(agent, agent, cap) as AgentMessage[]
}

export interface AgentThread {
  agent: string
  count: number
  lastMessage: AgentMessage | null
}

// One row per distinct conversation peer (from_agent OR to_agent), excluding
// CHAT_SYSTEM_AGENTS, each with its total message count and its most-recent
// message. Drives the dashboard sidebar. Recency is computed per-peer (max
// created_at) so a rarely-active peer's last message is never hidden behind the
// global recency window (the bug the JS-filter path had). Sorted newest-first.
export function getAgentConversationThreads(): AgentThread[] {
  const parties = db.prepare(`
    WITH parties AS (
      SELECT from_agent AS agent FROM agent_messages
      UNION
      SELECT to_agent AS agent FROM agent_messages
    )
    SELECT p.agent AS agent,
      (SELECT COUNT(*) FROM agent_messages m WHERE m.from_agent = p.agent OR m.to_agent = p.agent) AS count
    FROM parties p
  `).all() as { agent: string; count: number }[]

  const lastStmt = db.prepare(
    'SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  )

  const system = new Set<string>(CHAT_SYSTEM_AGENTS)
  const threads: AgentThread[] = []
  for (const p of parties) {
    if (!p.agent || system.has(p.agent)) continue
    const lastMessage = (lastStmt.get(p.agent, p.agent) as AgentMessage | undefined) ?? null
    threads.push({ agent: p.agent, count: p.count, lastMessage })
  }
  threads.sort((a, b) => {
    const ca = a.lastMessage?.created_at ?? 0
    const cb = b.lastMessage?.created_at ?? 0
    if (cb !== ca) return cb - ca
    return (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0) // tiebreak: newest id first
  })
  return threads
}

// --- Task Run History ---

export interface TaskRunEntry { name: string; agent: string; ts: number }

const TASK_RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function appendTaskRun(name: string, agent: string): void {
  const now = Date.now()
  db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)').run(name, agent, now)
  // Opportunistic TTL prune: cheap indexed DELETE, keeps the table bounded.
  db.prepare('DELETE FROM task_runs WHERE ts < ?').run(now - TASK_RUN_TTL_MS)
}

export function countTaskRunsBetween(fromTs: number, toTs?: number): number {
  if (toTs === undefined) {
    const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ?').get(fromTs) as { c: number }
    return row.c
  }
  const row = db.prepare('SELECT COUNT(*) as c FROM task_runs WHERE ts >= ? AND ts < ?').get(fromTs, toTs) as { c: number }
  return row.c
}

export function getAgentMessage(id: number): AgentMessage | undefined {
  return db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as AgentMessage | undefined
}

export function getActiveScheduledTaskCount(): { count: number; nextRun: number | null } {
  const row = db
    .prepare("SELECT COUNT(*) as count, MIN(next_run) as next_run FROM scheduled_tasks WHERE status = 'active'")
    .get() as { count: number; next_run: number | null }
  return { count: row.count, nextRun: row.next_run }
}

// --- Pending scheduled-task retries ------------------------------------

export interface PendingTaskRetryRow {
  id: number
  task_name: string
  agent_name: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  last_reason: string | null
  alert_sent_at: number | null
}

/**
 * Insert a busy-skipped scheduled task into the retry queue if and only if
 * no row exists for the (task_name, agent_name) pair. Returns true on
 * insert, false if a row already existed. Used for the first "busy" hit
 * from the cron loop.
 */
export function insertPendingTaskRetryIfNew(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    INSERT OR IGNORE INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(taskName, agentName, now, now, reason).changes > 0
}

/**
 * Update an existing retry row's last_attempt / attempt_count / last_reason.
 * Returns true if a row was updated, false if none existed (e.g. the
 * operator cancelled the row between a tick loading it and this call).
 * Used from the retry loop so a cancelled row isn't silently re-created.
 */
export function updatePendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): boolean {
  return db.prepare(`
    UPDATE pending_task_retries
       SET last_attempt = ?,
           attempt_count = attempt_count + 1,
           last_reason = ?
     WHERE task_name = ? AND agent_name = ?
  `).run(now, reason, taskName, agentName).changes > 0
}

/** Back-compat shim used by tests written against the original upsert
 * semantics. Internal code should use the explicit insert-if-new /
 * update-if-exists pair above. */
export function upsertPendingTaskRetry(
  taskName: string,
  agentName: string,
  now: number,
  reason: string,
): void {
  if (!updatePendingTaskRetry(taskName, agentName, now, reason)) {
    insertPendingTaskRetryIfNew(taskName, agentName, now, reason)
  }
}

/** Clear the alert timestamp so the next tick is free to re-alert. Used
 * when a Telegram send failed after we stamped the row optimistically. */
export function clearPendingTaskRetryAlert(taskName: string, agentName: string): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = NULL WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function listPendingTaskRetries(): PendingTaskRetryRow[] {
  return db
    .prepare('SELECT * FROM pending_task_retries ORDER BY first_attempt ASC')
    .all() as PendingTaskRetryRow[]
}

export function getPendingTaskRetry(taskName: string, agentName: string): PendingTaskRetryRow | undefined {
  return db
    .prepare('SELECT * FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .get(taskName, agentName) as PendingTaskRetryRow | undefined
}

export function deletePendingTaskRetry(taskName: string, agentName: string): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE task_name = ? AND agent_name = ?')
    .run(taskName, agentName).changes > 0
}

export function deletePendingTaskRetryById(id: number): boolean {
  return db
    .prepare('DELETE FROM pending_task_retries WHERE id = ?')
    .run(id).changes > 0
}

export function markPendingTaskRetryAlert(taskName: string, agentName: string, ts: number): boolean {
  return db
    .prepare('UPDATE pending_task_retries SET alert_sent_at = ? WHERE task_name = ? AND agent_name = ? AND alert_sent_at IS NULL')
    .run(ts, taskName, agentName).changes > 0
}

// --- Vector Search (Ollama + nomic-embed-text) ---

const EMBED_MODEL = 'nomic-embed-text'

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
    })
    const data = await resp.json() as { embedding?: number[] }
    return data.embedding || null
  } catch (err) {
    // Debug-level so it doesn't spam default INFO logs when Ollama isn't
    // running (the common case on most user machines). Enables "why does
    // hybrid search only return FTS results?" diagnostics without noise.
    logger.debug({ err, ollamaUrl: OLLAMA_URL }, 'Embedding generation failed (Ollama not running?)')
    return null
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function vectorSearch(agentId: string, queryEmbedding: number[], limit: number = 10): Memory[] {
  const rows = db.prepare(
    "SELECT * FROM memories WHERE embedding IS NOT NULL AND (agent_id = ? OR category = 'shared')"
  ).all(agentId) as Memory[]

  const scored = rows.map(m => {
    try {
      const emb = JSON.parse(m.embedding!) as number[]
      return { memory: m, score: cosineSimilarity(queryEmbedding, emb) }
    } catch {
      return { memory: m, score: 0 }
    }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.memory)
}

export async function hybridSearch(agentId: string, query: string, limit: number = 10): Promise<Memory[]> {
  const k = 60 // RRF constant

  // FTS5 results
  const ftsResults = searchAgentMemories(agentId, query, limit * 2)

  // Vector results
  const queryEmbedding = await generateEmbedding(query)
  const vecResults = queryEmbedding ? vectorSearch(agentId, queryEmbedding, limit * 2) : []

  // Reciprocal Rank Fusion
  const scores: Map<number, number> = new Map()
  const byId: Map<number, Memory> = new Map()

  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  vecResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  return ranked.slice(0, limit).map(([id]) => byId.get(id)!)
}

export async function backfillEmbeddings(): Promise<number> {
  const rows = db.prepare('SELECT id, content, keywords FROM memories WHERE embedding IS NULL').all() as { id: number; content: string; keywords: string | null }[]
  let count = 0
  for (const row of rows) {
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    const emb = await generateEmbedding(text)
    if (emb) {
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), row.id)
      count++
    }
    // Small delay to not overwhelm Ollama
    await new Promise(r => setTimeout(r, 100))
  }
  return count
}

// --- Pending Channel Requests ---

export interface PendingChannelRequest {
  id: number
  agent: string
  channel_id: string
  channel_name: string | null
  user_id: string | null
  requested_at: number
  status: 'pending' | 'approved' | 'denied'
}

export function upsertChannelRequest(agent: string, channelId: string, userId?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 86400
  const existing = db.prepare(
    "SELECT id FROM pending_channel_requests WHERE agent = ? AND channel_id = ? AND (status = 'pending' OR (status = 'denied' AND COALESCE(resolved_at, requested_at) > ?))"
  ).get(agent, channelId, sevenDaysAgo)
  if (existing) return false
  db.prepare(
    'INSERT INTO pending_channel_requests (agent, channel_id, user_id, requested_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(agent, channelId, userId ?? null, now, 'pending')
  return true
}

export function listPendingChannelRequests(agent: string): PendingChannelRequest[] {
  return db.prepare(
    "SELECT * FROM pending_channel_requests WHERE agent = ? AND status = 'pending' ORDER BY requested_at DESC"
  ).all(agent) as PendingChannelRequest[]
}

export function updateChannelRequestStatus(id: number, status: 'approved' | 'denied'): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(
    'UPDATE pending_channel_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = ?'
  ).run(status, now, id, 'pending').changes > 0
}

export function updateChannelRequestName(id: number, channelName: string): void {
  db.prepare('UPDATE pending_channel_requests SET channel_name = ? WHERE id = ?').run(channelName, id)
}

// --- Telegram History ---

export function saveTelegramMessage(
  chatId: string,
  messageId: string,
  direction: 'in' | 'out',
  text: string,
  userId?: string,
  ts?: number,
  replyToMessageId?: string,
): void {
  const now = ts ?? Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT OR IGNORE INTO telegram_history (chat_id, message_id, user_id, direction, text, ts, reply_to_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(chatId, messageId, userId ?? null, direction, text, now, replyToMessageId ?? null)
}

export interface TelegramHistoryRow {
  id: number
  chat_id: string
  message_id: string
  user_id: string | null
  direction: 'in' | 'out'
  text: string
  ts: number
  reply_to_message_id: string | null
}

export function getTelegramHistory(chatId: string, limit: number = 50): TelegramHistoryRow[] {
  return db.prepare(
    'SELECT * FROM telegram_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?'
  ).all(chatId, limit) as TelegramHistoryRow[]
}

export interface ThreadContext {
  // The most recent substantive message a terse follow-up most likely refers to.
  anchor: TelegramHistoryRow | null
  // Recent messages (chronological) that give the processing agent context.
  thread: TelegramHistoryRow[]
  // How the anchor was determined: an explicit reply_to link, or recency+substance.
  via: 'reply_to' | 'recency' | 'none'
}

// Reconstruct the most recent meaningful content-thread for a chat so a terse
// inbound follow-up gets anchored to real content instead of guessing.
//   - If reply_to is known (passed in, or stored on the latest inbound row),
//     the anchor is that target message (via='reply_to').
//   - Otherwise the anchor is the most recent message whose text is substantive
//     (length >= minMeaningfulLen), skipping trivial acks (via='recency').
// `thread` is the last `limit` messages in chronological order.
export function reconstructThreadContext(
  chatId: string,
  opts: { limit?: number; minMeaningfulLen?: number; replyToMessageId?: string | null } = {},
): ThreadContext {
  const limit = opts.limit ?? 10
  const minLen = opts.minMeaningfulLen ?? 25
  const recent = db.prepare(
    'SELECT * FROM telegram_history WHERE chat_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
  ).all(chatId, limit) as TelegramHistoryRow[]
  const thread = recent.slice().reverse() // chronological
  if (thread.length === 0) return { anchor: null, thread: [], via: 'none' }

  // Prefer an explicit reply_to link: the caller's, else the latest inbound row's.
  const latestInbound = [...thread].reverse().find(r => r.direction === 'in')
  const replyTo = opts.replyToMessageId ?? latestInbound?.reply_to_message_id ?? null
  if (replyTo) {
    const target = db.prepare(
      'SELECT * FROM telegram_history WHERE chat_id = ? AND message_id = ? LIMIT 1'
    ).get(chatId, replyTo) as TelegramHistoryRow | undefined
    if (target) return { anchor: target, thread, via: 'reply_to' }
  }

  // Recency + substance: the most recent message long enough to be a real topic,
  // skipping the just-arrived terse follow-up and trivial acks.
  const substantive = [...thread].reverse().find(r => r.text.trim().length >= minLen)
  if (substantive) return { anchor: substantive, thread, via: 'recency' }
  return { anchor: thread[thread.length - 1], thread, via: 'recency' }
}

// --- Outbound Resend Queue ---

export interface OutboundQueueRow {
  id: number
  agent_id: string
  chat_id: string
  text: string
  reply_to_message_id: string | null
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  last_error: string | null
  created_at: number
  dispatched_at: number | null
  sent_at: number | null
}

export function enqueueOutbound(item: {
  agentId: string
  chatId: string
  text: string
  replyToMessageId?: string | null
  error?: string | null
}): number {
  const now = Math.floor(Date.now() / 1000)
  const res = db.prepare(
    `INSERT INTO outbound_queue (agent_id, chat_id, text, reply_to_message_id, status, attempts, last_error, created_at)
     VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)`
  ).run(item.agentId, item.chatId, item.text, item.replyToMessageId ?? null, item.error ?? null, now)
  return res.lastInsertRowid as number
}

export function countPendingOutbound(agentId?: string): number {
  const row = agentId
    ? db.prepare("SELECT COUNT(*) c FROM outbound_queue WHERE status = 'pending' AND agent_id = ?").get(agentId)
    : db.prepare("SELECT COUNT(*) c FROM outbound_queue WHERE status = 'pending'").get()
  return (row as { c: number }).c
}

export function listOutbound(status?: 'pending' | 'sent' | 'failed', limit: number = 100): OutboundQueueRow[] {
  if (status) {
    return db.prepare('SELECT * FROM outbound_queue WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit) as OutboundQueueRow[]
  }
  return db.prepare('SELECT * FROM outbound_queue ORDER BY id DESC LIMIT ?').all(limit) as OutboundQueueRow[]
}

// Atomically claim undispatched pending rows for an agent: stamp dispatched_at
// in the same statement that selects them so concurrent monitor ticks cannot
// re-dispatch the same message. Returns the rows that were just claimed.
export function claimPendingOutbound(agentId: string): OutboundQueueRow[] {
  const now = Math.floor(Date.now() / 1000)
  const claim = db.transaction((): OutboundQueueRow[] => {
    const rows = db.prepare(
      "SELECT * FROM outbound_queue WHERE agent_id = ? AND status = 'pending' AND dispatched_at IS NULL ORDER BY id ASC"
    ).all(agentId) as OutboundQueueRow[]
    if (rows.length) {
      const stamp = db.prepare('UPDATE outbound_queue SET dispatched_at = ? WHERE id = ?')
      for (const r of rows) stamp.run(now, r.id)
    }
    return rows
  })
  return claim()
}

export function markOutboundSent(id: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  const res = db.prepare("UPDATE outbound_queue SET status = 'sent', sent_at = ? WHERE id = ?").run(now, id)
  return res.changes > 0
}

export function markOutboundFailed(id: number, error?: string): boolean {
  const res = db.prepare(
    "UPDATE outbound_queue SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE id = ?"
  ).run(error ?? null, id)
  return res.changes > 0
}

export function getOutboundQueueStats(): { pending: number; sent: number; failed: number } {
  const rows = db.prepare("SELECT status, COUNT(*) c FROM outbound_queue GROUP BY status").all() as { status: string; c: number }[]
  const stats = { pending: 0, sent: 0, failed: 0 }
  for (const r of rows) if (r.status in stats) (stats as Record<string, number>)[r.status] = r.c
  return stats
}

// --- Kanban Dispatcher ---

export interface KanbanDispatchCandidate {
  id: string
  title: string
  description: string | null
  assignee: string
  priority: 'high' | 'urgent'
}

export function getUndispatchedHighPriorityCards(): KanbanDispatchCandidate[] {
  return db.prepare(
    `SELECT id, title, description, assignee, priority
     FROM kanban_cards
     WHERE status = 'planned'
       AND priority IN ('high', 'urgent')
       AND assignee IS NOT NULL
       AND assignee != ''
       AND dispatched_at IS NULL
       AND archived_at IS NULL`
  ).all() as KanbanDispatchCandidate[]
}

// --- Idea Box ---

export interface IdeaBoxRow {
  id: string
  title: string
  description: string | null
  category: string
  status: 'new' | 'reviewed' | 'kanban' | 'rejected'
  source: string
  kanban_id: string | null
  created_at: number
  updated_at: number
}

export function listIdeas(opts?: { status?: string; category?: string }): IdeaBoxRow[] {
  let q = 'SELECT * FROM idea_box WHERE 1=1'
  const params: string[] = []
  if (opts?.status) { q += ' AND status = ?'; params.push(opts.status) }
  if (opts?.category) { q += ' AND category = ?'; params.push(opts.category) }
  q += ' ORDER BY created_at DESC'
  return db.prepare(q).all(...params) as IdeaBoxRow[]
}

export function createIdea(idea: Omit<IdeaBoxRow, 'created_at' | 'updated_at'>): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO idea_box (id, title, description, category, status, source, kanban_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(idea.id, idea.title, idea.description ?? null, idea.category, idea.status, idea.source, idea.kanban_id ?? null, now, now)
}

export function updateIdea(id: string, patch: Partial<Pick<IdeaBoxRow, 'title' | 'description' | 'category' | 'status' | 'kanban_id'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category) }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.kanban_id !== undefined) { sets.push('kanban_id = ?'); params.push(patch.kanban_id) }
  params.push(id)
  return db.prepare(`UPDATE idea_box SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteIdea(id: string): boolean {
  return db.prepare('DELETE FROM idea_box WHERE id = ?').run(id).changes > 0
}

export function listIdeaCategories(): string[] {
  return (db.prepare('SELECT DISTINCT category FROM idea_box ORDER BY category').all() as { category: string }[]).map(r => r.category)
}

// --- Tool Call Log ---

export function logToolCall(sessionId: string, toolName: string, inputSummary: string | null, success = true): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO tool_call_log (session_id, tool_name, input_summary, success, created_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, toolName, inputSummary, success ? 1 : 0, now)
}

export interface ToolCallLogRow {
  id: number
  session_id: string
  tool_name: string
  input_summary: string | null
  success: number
  created_at: number
}

export interface WorkflowCandidate {
  session_id: string
  tool_calls: ToolCallLogRow[]
  start_ts: number
  end_ts: number
  duration_minutes: number
}

export function getRecentToolCalls(sinceSecs: number): ToolCallLogRow[] {
  const cutoff = Math.floor(Date.now() / 1000) - sinceSecs
  return db.prepare('SELECT * FROM tool_call_log WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff) as ToolCallLogRow[]
}

export function analyzeWorkflowCandidates(sinceSecs = 3600, minToolCalls = 5, gapSecs = 300): WorkflowCandidate[] {
  const calls = getRecentToolCalls(sinceSecs)
  if (calls.length === 0) return []

  // Group by session_id, then split by time gaps > gapSecs
  const bySession: Map<string, ToolCallLogRow[]> = new Map()
  for (const c of calls) {
    if (!bySession.has(c.session_id)) bySession.set(c.session_id, [])
    bySession.get(c.session_id)!.push(c)
  }

  const candidates: WorkflowCandidate[] = []
  for (const [sessionId, sessionCalls] of bySession) {
    // Split into chunks by time gap
    const chunks: ToolCallLogRow[][] = []
    let current: ToolCallLogRow[] = [sessionCalls[0]]
    for (let i = 1; i < sessionCalls.length; i++) {
      if (sessionCalls[i].created_at - sessionCalls[i - 1].created_at > gapSecs) {
        chunks.push(current)
        current = []
      }
      current.push(sessionCalls[i])
    }
    chunks.push(current)

    for (const chunk of chunks) {
      if (chunk.length >= minToolCalls) {
        candidates.push({
          session_id: sessionId,
          tool_calls: chunk,
          start_ts: chunk[0].created_at,
          end_ts: chunk[chunk.length - 1].created_at,
          duration_minutes: Math.round((chunk[chunk.length - 1].created_at - chunk[0].created_at) / 60),
        })
      }
    }
  }

  return candidates
}

export function pruneToolCallLog(olderThanSecs = 86400): void {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSecs
  db.prepare('DELETE FROM tool_call_log WHERE created_at < ?').run(cutoff)
}

export interface WorkflowBranchStat {
  runs: number
  successes: number
}

export interface WorkflowRecordingRow {
  id: string
  name: string
  description: string | null
  trigger_keywords: string
  trigger_description: string | null
  embedding: string | null
  steps_json: string
  branch_stats_json: string
  run_count: number
  success_count: number
  agent_id: string
  created_at: number
  updated_at: number
}

export function listWorkflowRecordings(agent_id?: string): WorkflowRecordingRow[] {
  if (agent_id) {
    return db.prepare('SELECT * FROM workflow_recordings WHERE agent_id = ? ORDER BY updated_at DESC').all(agent_id) as WorkflowRecordingRow[]
  }
  return db.prepare('SELECT * FROM workflow_recordings ORDER BY updated_at DESC').all() as WorkflowRecordingRow[]
}

export function createWorkflowRecording(rec: Omit<WorkflowRecordingRow, 'created_at' | 'updated_at' | 'run_count' | 'success_count'>): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO workflow_recordings (id, name, description, trigger_keywords, trigger_description, embedding, steps_json, run_count, success_count, agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?)`
  ).run(rec.id, rec.name, rec.description ?? null, rec.trigger_keywords, rec.trigger_description ?? null, rec.steps_json, rec.agent_id, now, now)
  // Fire-and-forget: generate embedding for the trigger_description
  if (rec.trigger_description) {
    generateEmbedding(rec.trigger_description).then(emb => {
      if (emb) db.prepare('UPDATE workflow_recordings SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), rec.id)
    }).catch(() => { /* Ollama not running */ })
  }
}

export function updateWorkflowRecording(id: string, patch: Partial<Pick<WorkflowRecordingRow, 'name' | 'description' | 'trigger_keywords' | 'trigger_description' | 'steps_json' | 'run_count' | 'success_count'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.trigger_keywords !== undefined) { sets.push('trigger_keywords = ?'); params.push(patch.trigger_keywords) }
  if (patch.trigger_description !== undefined) {
    sets.push('trigger_description = ?'); params.push(patch.trigger_description)
    // Regenerate embedding when trigger_description changes
    if (patch.trigger_description) {
      generateEmbedding(patch.trigger_description).then(emb => {
        if (emb) db.prepare('UPDATE workflow_recordings SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), id)
      }).catch(() => { /* Ollama not running */ })
    }
  }
  if (patch.steps_json !== undefined) { sets.push('steps_json = ?'); params.push(patch.steps_json) }
  if (patch.run_count !== undefined) { sets.push('run_count = ?'); params.push(patch.run_count) }
  if (patch.success_count !== undefined) { sets.push('success_count = ?'); params.push(patch.success_count) }
  params.push(id)
  return db.prepare(`UPDATE workflow_recordings SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteWorkflowRecording(id: string): boolean {
  return db.prepare('DELETE FROM workflow_recordings WHERE id = ?').run(id).changes > 0
}

export function matchWorkflowRecordings(keywords: string): WorkflowRecordingRow[] {
  const words = keywords.toLowerCase().split(/\s+/).filter(Boolean)
  const all = db.prepare('SELECT * FROM workflow_recordings ORDER BY success_count DESC').all() as WorkflowRecordingRow[]
  return all.filter(r => {
    const kw = r.trigger_keywords.toLowerCase()
    return words.some(w => kw.includes(w))
  })
}

export interface WorkflowMatchResult {
  workflow: WorkflowRecordingRow
  score: number
  source: 'keyword' | 'vector' | 'both'
}

export async function matchWorkflowRecordingsSemantic(query: string, threshold = 0.6): Promise<WorkflowMatchResult[]> {
  const all = db.prepare('SELECT * FROM workflow_recordings ORDER BY success_count DESC').all() as WorkflowRecordingRow[]

  // Keyword match
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const keywordMatches = new Set(all.filter(r => {
    const kw = (r.trigger_keywords + ' ' + (r.trigger_description || '')).toLowerCase()
    return words.some(w => kw.includes(w))
  }).map(r => r.id))

  // Vector match
  const vectorMatches = new Map<string, number>()
  const queryEmb = await generateEmbedding(query)
  if (queryEmb) {
    for (const r of all) {
      if (!r.embedding) continue
      try {
        const emb = JSON.parse(r.embedding) as number[]
        const score = cosineSimilarity(queryEmb, emb)
        if (score >= threshold) vectorMatches.set(r.id, score)
      } catch { /* skip */ }
    }
  }

  const results: WorkflowMatchResult[] = []
  const seen = new Set<string>()

  for (const r of all) {
    const inKw = keywordMatches.has(r.id)
    const vecScore = vectorMatches.get(r.id)
    if (!inKw && vecScore === undefined) continue
    if (seen.has(r.id)) continue
    seen.add(r.id)
    results.push({
      workflow: r,
      score: vecScore ?? (inKw ? 1.0 : 0),
      source: inKw && vecScore !== undefined ? 'both' : inKw ? 'keyword' : 'vector',
    })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

export function recordWorkflowBranchRun(id: string, branchId: string, success: boolean): boolean {
  const rec = db.prepare('SELECT branch_stats_json FROM workflow_recordings WHERE id = ?').get(id) as { branch_stats_json: string } | undefined
  if (!rec) return false
  let stats: Record<string, WorkflowBranchStat> = {}
  try { stats = JSON.parse(rec.branch_stats_json || '{}') } catch { /* use empty */ }
  if (!stats[branchId]) stats[branchId] = { runs: 0, successes: 0 }
  stats[branchId].runs++
  if (success) stats[branchId].successes++
  const now = Math.floor(Date.now() / 1000)
  return db.prepare('UPDATE workflow_recordings SET branch_stats_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(stats), now, id).changes > 0
}

export async function backfillWorkflowEmbeddings(): Promise<number> {
  const rows = db.prepare('SELECT id, trigger_description FROM workflow_recordings WHERE embedding IS NULL AND trigger_description IS NOT NULL').all() as { id: string; trigger_description: string }[]
  let count = 0
  for (const row of rows) {
    const emb = await generateEmbedding(row.trigger_description)
    if (emb) {
      db.prepare('UPDATE workflow_recordings SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), row.id)
      count++
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return count
}

// --- Session Contexts ---

export interface SessionContextRow {
  id: number
  agent_id: string
  top_memories_json: string
  kanban_snapshot_json: string
  open_decisions_json: string
  summary: string | null
  created_at: number
}

export function saveSessionContext(agentId: string, data: {
  topMemories: unknown[]
  kanbanSnapshot: unknown[]
  openDecisions: unknown[]
  summary?: string
}): number {
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `INSERT INTO session_contexts (agent_id, top_memories_json, kanban_snapshot_json, open_decisions_json, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, JSON.stringify(data.topMemories), JSON.stringify(data.kanbanSnapshot), JSON.stringify(data.openDecisions), data.summary ?? null, now)
  return result.lastInsertRowid as number
}

export function getLatestSessionContext(agentId: string, limit = 3): SessionContextRow[] {
  return db.prepare('SELECT * FROM session_contexts WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit) as SessionContextRow[]
}

export function pruneSessionContexts(agentId: string, keepCount = 10): void {
  const rows = db.prepare('SELECT id FROM session_contexts WHERE agent_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?').all(agentId, keepCount) as { id: number }[]
  if (rows.length > 0) {
    db.prepare(`DELETE FROM session_contexts WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map(r => r.id))
  }
}

// ============================================================
// === Sales Q&A (Agrolánc tudásbázis) ===
// ============================================================

export interface SalesQARow {
  id: string
  question: string
  answer: string
  context: string | null
  tags: string
  source: string
  usage_count: number
  last_used_at: number | null
  created_at: number
  updated_at: number
}

export function listSalesQA(opts?: { q?: string; tag?: string; limit?: number }): SalesQARow[] {
  const limit = opts?.limit ?? 50
  if (opts?.q && opts.q.trim()) {
    const term = opts.q.trim().replace(/['"*]/g, '') + '*'
    return db.prepare(`
      SELECT s.* FROM sales_qa s
      JOIN sales_qa_fts ON sales_qa_fts.rowid = s.rowid
      WHERE sales_qa_fts MATCH ?
      ORDER BY usage_count DESC
      LIMIT ?
    `).all(term, limit) as SalesQARow[]
  }
  if (opts?.tag) {
    return db.prepare(`SELECT * FROM sales_qa WHERE tags LIKE ? ORDER BY usage_count DESC LIMIT ?`)
      .all(`%${opts.tag}%`, limit) as SalesQARow[]
  }
  return db.prepare('SELECT * FROM sales_qa ORDER BY usage_count DESC, updated_at DESC LIMIT ?').all(limit) as SalesQARow[]
}

export function createSalesQA(entry: Omit<SalesQARow, 'usage_count' | 'last_used_at' | 'created_at' | 'updated_at'>): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO sales_qa (id, question, answer, context, tags, source, usage_count, last_used_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
  `).run(entry.id, entry.question, entry.answer, entry.context ?? null, entry.tags, entry.source, now, now)
}

export function updateSalesQA(id: string, patch: Partial<Pick<SalesQARow, 'question' | 'answer' | 'context' | 'tags'>>): boolean {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.question !== undefined) { sets.push('question = ?'); params.push(patch.question) }
  if (patch.answer !== undefined) { sets.push('answer = ?'); params.push(patch.answer) }
  if (patch.context !== undefined) { sets.push('context = ?'); params.push(patch.context) }
  if (patch.tags !== undefined) { sets.push('tags = ?'); params.push(patch.tags) }
  if (sets.length === 0) return false
  sets.push('updated_at = ?'); params.push(Math.floor(Date.now() / 1000))
  params.push(id)
  return db.prepare(`UPDATE sales_qa SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteSalesQA(id: string): boolean {
  return db.prepare('DELETE FROM sales_qa WHERE id = ?').run(id).changes > 0
}

export function recordSalesQAUsage(id: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE sales_qa SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?').run(now, id)
}

// ============================================================
// === Skill Usage Log ===
// ============================================================

export interface SkillUsageRow {
  id: number
  skill_name: string
  trigger_text: string | null
  agent_id: string
  outcome: 'positive' | 'negative' | 'neutral'
  feedback_note: string | null
  created_at: number
}

export function logSkillUsage(skillName: string, agentId: string, triggerText?: string): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(db.prepare(
    `INSERT INTO skill_usage_log (skill_name, trigger_text, agent_id, outcome, created_at)
     VALUES (?, ?, ?, 'neutral', ?)`
  ).run(skillName, triggerText ?? null, agentId, now).lastInsertRowid)
}

export function updateSkillUsageOutcome(id: number, outcome: 'positive' | 'negative', note?: string): boolean {
  return db.prepare(
    'UPDATE skill_usage_log SET outcome = ?, feedback_note = ? WHERE id = ?'
  ).run(outcome, note ?? null, id).changes > 0
}

export function getSkillUsageStats(since?: number): { skill_name: string; total: number; positive: number; negative: number; neutral: number }[] {
  const cutoff = since ?? 0
  return db.prepare(`
    SELECT skill_name,
      COUNT(*) as total,
      SUM(CASE WHEN outcome='positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN outcome='negative' THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN outcome='neutral' THEN 1 ELSE 0 END) as neutral
    FROM skill_usage_log WHERE created_at >= ?
    GROUP BY skill_name ORDER BY total DESC
  `).all(cutoff) as { skill_name: string; total: number; positive: number; negative: number; neutral: number }[]
}

export function getNegativeSkillFeedback(skillName: string, limit = 10): SkillUsageRow[] {
  return db.prepare(
    `SELECT * FROM skill_usage_log WHERE skill_name = ? AND outcome = 'negative'
     ORDER BY created_at DESC LIMIT ?`
  ).all(skillName, limit) as SkillUsageRow[]
}

// --- A/B Skill Experiments ---

export interface SkillExperiment {
  id: number
  skill_name: string
  hypothesis: string | null
  variant_a: string
  variant_b: string
  status: 'active' | 'done'
  winner: 'A' | 'B' | null
  created_at: number
  decided_at: number | null
}

export interface VariantStats {
  variant: 'A' | 'B'
  total: number
  positive: number
  negative: number
  neutral: number
  positiveRate: number   // positive / total, 0 if no data
}

export function createSkillExperiment(skillName: string, variantA: string, variantB: string, hypothesis?: string): { id: number } {
  // Only one active experiment per skill: close any prior active one as undecided.
  db.prepare("UPDATE skill_experiments SET status='done', decided_at=unixepoch() WHERE skill_name=? AND status='active'").run(skillName)
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO skill_experiments (skill_name, hypothesis, variant_a, variant_b, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(skillName, hypothesis ?? null, variantA, variantB, 'active', now)
  return { id: Number(info.lastInsertRowid) }
}

export function getActiveSkillExperiment(skillName: string): SkillExperiment | undefined {
  return db.prepare("SELECT * FROM skill_experiments WHERE skill_name=? AND status='active' ORDER BY created_at DESC LIMIT 1")
    .get(skillName) as SkillExperiment | undefined
}

export function listSkillExperiments(): SkillExperiment[] {
  return db.prepare('SELECT * FROM skill_experiments ORDER BY created_at DESC').all() as SkillExperiment[]
}

/**
 * Deterministic, even A/B assignment: alternate by the parity of how many
 * variant-tagged usages this skill already has. Returns null if no active
 * experiment exists for the skill.
 */
export function assignSkillVariant(skillName: string): 'A' | 'B' | null {
  const exp = getActiveSkillExperiment(skillName)
  if (!exp) return null
  const n = (db.prepare('SELECT COUNT(*) as c FROM skill_usage_log WHERE skill_name=? AND variant IS NOT NULL').get(skillName) as { c: number }).c
  return n % 2 === 0 ? 'A' : 'B'
}

export function recordSkillVariantOutcome(
  skillName: string,
  variant: 'A' | 'B',
  outcome: 'positive' | 'negative' | 'neutral',
  triggerText?: string,
  note?: string
): number {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    `INSERT INTO skill_usage_log (skill_name, trigger_text, agent_id, outcome, feedback_note, variant, created_at)
     VALUES (?, ?, 'marveen', ?, ?, ?, ?)`
  ).run(skillName, triggerText ?? null, outcome, note ?? null, variant, now)
  return Number(info.lastInsertRowid)
}

function variantStats(skillName: string, variant: 'A' | 'B'): VariantStats {
  const r = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN outcome='positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN outcome='negative' THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN outcome='neutral' THEN 1 ELSE 0 END) as neutral
    FROM skill_usage_log WHERE skill_name=? AND variant=?
  `).get(skillName, variant) as { total: number; positive: number | null; negative: number | null; neutral: number | null }
  const total = r.total || 0
  const positive = r.positive || 0
  return {
    variant, total, positive,
    negative: r.negative || 0,
    neutral: r.neutral || 0,
    positiveRate: total > 0 ? positive / total : 0,
  }
}

export interface ExperimentResults {
  experiment: SkillExperiment
  a: VariantStats
  b: VariantStats
  suggestedWinner: 'A' | 'B' | null   // null if not enough data / tie
  confident: boolean                   // both variants have >= MIN_SAMPLE
}

const MIN_SAMPLE = 5

export function getSkillExperimentResults(id: number): ExperimentResults | undefined {
  const experiment = db.prepare('SELECT * FROM skill_experiments WHERE id=?').get(id) as SkillExperiment | undefined
  if (!experiment) return undefined
  const a = variantStats(experiment.skill_name, 'A')
  const b = variantStats(experiment.skill_name, 'B')
  const confident = a.total >= MIN_SAMPLE && b.total >= MIN_SAMPLE
  let suggestedWinner: 'A' | 'B' | null = null
  if (confident && a.positiveRate !== b.positiveRate) {
    suggestedWinner = a.positiveRate > b.positiveRate ? 'A' : 'B'
  }
  return { experiment, a, b, suggestedWinner, confident }
}

export function promoteSkillExperiment(id: number, winner: 'A' | 'B'): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE skill_experiments SET status='done', winner=?, decided_at=? WHERE id=?")
    .run(winner, now, id).changes > 0
}

// --- Session Recordings ---

export interface SessionRecordingRow {
  id: number
  name: string
  scenario: string
  events_json: string
  is_baseline: number
  created_at: number
}

export function saveSessionRecording(name: string, scenario: string, events: unknown[], isBaseline = false): { id: number } {
  const now = Math.floor(Date.now() / 1000)
  // Only one baseline per scenario: demote previous baselines.
  if (isBaseline) {
    db.prepare('UPDATE session_recordings SET is_baseline = 0 WHERE scenario = ?').run(scenario)
  }
  const info = db.prepare(
    'INSERT INTO session_recordings (name, scenario, events_json, is_baseline, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(name, scenario, JSON.stringify(events ?? []), isBaseline ? 1 : 0, now)
  return { id: Number(info.lastInsertRowid) }
}

export function listSessionRecordings(scenario?: string): SessionRecordingRow[] {
  if (scenario) {
    return db.prepare('SELECT * FROM session_recordings WHERE scenario = ? ORDER BY created_at DESC').all(scenario) as SessionRecordingRow[]
  }
  return db.prepare('SELECT * FROM session_recordings ORDER BY created_at DESC LIMIT 200').all() as SessionRecordingRow[]
}

export function getSessionRecording(id: number): SessionRecordingRow | undefined {
  return db.prepare('SELECT * FROM session_recordings WHERE id = ?').get(id) as SessionRecordingRow | undefined
}

export function getBaselineRecording(scenario: string): SessionRecordingRow | undefined {
  return db.prepare('SELECT * FROM session_recordings WHERE scenario = ? AND is_baseline = 1 ORDER BY created_at DESC LIMIT 1').get(scenario) as SessionRecordingRow | undefined
}

export function deleteSessionRecording(id: number): boolean {
  return db.prepare('DELETE FROM session_recordings WHERE id = ?').run(id).changes > 0
}

// --- Outbound Critic Samples (self-improving critic) ---

export interface CriticViolationSample { rule: string; match?: string }

export function recordCriticSample(channel: string, blocked: boolean, violations: CriticViolationSample[], textPreview: string): void {
  const now = Math.floor(Date.now() / 1000)
  const ins = db.prepare(
    'INSERT INTO critic_samples (ts, channel, blocked, rule, match_text, text_preview) VALUES (?, ?, ?, ?, ?, ?)'
  )
  if (!violations.length) {
    ins.run(now, channel, blocked ? 1 : 0, null, null, textPreview.slice(0, 200))
    return
  }
  const tx = db.transaction((vs: CriticViolationSample[]) => {
    for (const v of vs) ins.run(now, channel, blocked ? 1 : 0, v.rule, v.match ?? null, textPreview.slice(0, 200))
  })
  tx(violations)
}

export interface CriticSuggestions {
  total: number
  blocked: number
  byRule: Record<string, number>
  topMatches: { match: string; count: number }[]
}

export function getCriticSuggestions(): CriticSuggestions {
  const total = (db.prepare('SELECT COUNT(*) as c FROM critic_samples').get() as { c: number }).c
  const blocked = (db.prepare('SELECT COUNT(*) as c FROM critic_samples WHERE blocked = 1').get() as { c: number }).c
  const ruleRows = db.prepare("SELECT rule, COUNT(*) as c FROM critic_samples WHERE rule IS NOT NULL GROUP BY rule ORDER BY c DESC").all() as { rule: string; c: number }[]
  const matchRows = db.prepare("SELECT match_text as m, COUNT(*) as c FROM critic_samples WHERE match_text IS NOT NULL GROUP BY match_text ORDER BY c DESC LIMIT 10").all() as { m: string; c: number }[]
  const byRule: Record<string, number> = {}
  for (const r of ruleRows) byRule[r.rule] = r.c
  return { total, blocked, byRule, topMatches: matchRows.map(r => ({ match: r.m, count: r.c })) }
}

// --- Unified Triage Inbox ---

export interface InboxItem {
  id: number
  source: 'telegram' | 'email' | 'whatsapp' | 'other'
  external_id: string | null
  sender: string | null
  subject: string | null
  preview: string
  urgency: 'urgent' | 'normal' | 'low'
  intent: 'question' | 'request' | 'fyi'
  score: number
  status: 'open' | 'done'
  received_at: number
  created_at: number
}

export function addInboxItem(item: {
  source: InboxItem['source']
  external_id?: string | null
  sender?: string | null
  subject?: string | null
  preview: string
  urgency: InboxItem['urgency']
  intent: InboxItem['intent']
  score: number
  received_at?: number
}): { id: number; deduped: boolean } {
  const now = Math.floor(Date.now() / 1000)
  // Dedup on (source, external_id) when an external id is present.
  if (item.external_id) {
    const existing = db.prepare('SELECT id FROM inbox_items WHERE source = ? AND external_id = ?').get(item.source, item.external_id) as { id: number } | undefined
    if (existing) return { id: existing.id, deduped: true }
  }
  const info = db.prepare(
    `INSERT INTO inbox_items (source, external_id, sender, subject, preview, urgency, intent, score, status, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(item.source, item.external_id ?? null, item.sender ?? null, item.subject ?? null, item.preview,
    item.urgency, item.intent, item.score, item.received_at ?? now, now)
  return { id: Number(info.lastInsertRowid), deduped: false }
}

export function listInbox(status: 'open' | 'done' | 'all' = 'open', limit = 100): InboxItem[] {
  const lim = Math.min(Math.max(limit, 1), 500)
  if (status === 'all') {
    return db.prepare('SELECT * FROM inbox_items ORDER BY status ASC, score DESC, received_at DESC LIMIT ?').all(lim) as InboxItem[]
  }
  return db.prepare('SELECT * FROM inbox_items WHERE status = ? ORDER BY score DESC, received_at DESC LIMIT ?').all(status, lim) as InboxItem[]
}

export function setInboxStatus(id: number, status: 'open' | 'done'): boolean {
  return db.prepare('UPDATE inbox_items SET status = ? WHERE id = ?').run(status, id).changes > 0
}

// Unanswered inbound Telegram messages (no outbound reply after them) within
// the window -- the genuinely-pending items the triage inbox should ingest.
export function getUnansweredInboundTelegram(sinceTs: number): { chat_id: string; message_id: string; user_id: string | null; text: string; ts: number }[] {
  // Use the autoincrement id (insertion order) rather than ts to decide
  // "answered": replies in the SAME second as the inbound would be missed by a
  // ts comparison (seconds granularity), but id is monotonic so o.id > t.id is
  // exact.
  return db.prepare(
    `SELECT chat_id, message_id, user_id, text, ts FROM telegram_history t
     WHERE direction = 'in' AND ts >= ?
       AND NOT EXISTS (
         SELECT 1 FROM telegram_history o
         WHERE o.chat_id = t.chat_id AND o.direction = 'out' AND o.id > t.id
       )
     ORDER BY ts ASC`
  ).all(sinceTs) as { chat_id: string; message_id: string; user_id: string | null; text: string; ts: number }[]
}

// SLA: urgent items still open past the threshold and not yet escalated.
// If `claim` is true, stamps escalated_at so a caller (heartbeat) nudges once.
export function getInboxSlaBreaches(nowTs: number, urgentThresholdSec = 1800, claim = false): InboxItem[] {
  const cutoff = nowTs - urgentThresholdSec
  const rows = db.prepare(
    `SELECT * FROM inbox_items
     WHERE status = 'open' AND urgency = 'urgent' AND escalated_at IS NULL AND received_at <= ?
     ORDER BY received_at ASC`
  ).all(cutoff) as InboxItem[]
  if (claim && rows.length) {
    const stamp = db.prepare('UPDATE inbox_items SET escalated_at = ? WHERE id = ?')
    const tx = db.transaction((items: InboxItem[]) => { for (const it of items) stamp.run(nowTs, it.id) })
    tx(rows)
  }
  return rows
}

export function getInboxStats(): { open: number; urgent_open: number; bySource: Record<string, number> } {
  const open = (db.prepare("SELECT COUNT(*) as c FROM inbox_items WHERE status='open'").get() as { c: number }).c
  const urgentOpen = (db.prepare("SELECT COUNT(*) as c FROM inbox_items WHERE status='open' AND urgency='urgent'").get() as { c: number }).c
  const rows = db.prepare("SELECT source, COUNT(*) as c FROM inbox_items WHERE status='open' GROUP BY source").all() as { source: string; c: number }[]
  const bySource: Record<string, number> = {}
  for (const r of rows) bySource[r.source] = r.c
  return { open, urgent_open: urgentOpen, bySource }
}
