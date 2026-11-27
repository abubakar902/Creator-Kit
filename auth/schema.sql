PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 uid TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
 photo_url TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user' CHECK(role IN('user','admin')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','banned')),
 advanced_access TEXT NOT NULL DEFAULT 'pending' CHECK(advanced_access IN('pending','approved','revoked')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_advanced_access ON users(advanced_access);
CREATE TABLE IF NOT EXISTS invite_codes (
 id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
 access_level TEXT NOT NULL DEFAULT 'advanced' CHECK(access_level='advanced'),
 created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 max_uses INTEGER NOT NULL DEFAULT 1 CHECK(max_uses BETWEEN 1 AND 100),
 uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked'))
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_status ON invite_codes(status,expires_at);
CREATE TABLE IF NOT EXISTS admin_audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_uid TEXT NOT NULL, target_uid TEXT,
 action TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at);

-- Minimal per-user analytics: successful tool action names and timestamps only.
-- Never store prompts, generated content, media, tokens, or uploaded file details.
CREATE TABLE IF NOT EXISTS user_activity (
 id TEXT PRIMARY KEY,
 uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
 action TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_activity_uid_created
 ON user_activity(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_uid_action_created
 ON user_activity(uid, action, created_at DESC);
