-- ============================================================
-- Agbota Segun — database schema
-- Idempotent: safe to run on every boot / redeployment.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- profiles (users) ----------
CREATE TABLE IF NOT EXISTS profiles (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'streamer' CHECK (role IN ('streamer', 'owner')),
  avatar_file_id BIGINT,
  bio           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One account per email, enforced by the database itself (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_unique ON profiles (lower(email));
CREATE INDEX IF NOT EXISTS profiles_role_idx ON profiles (role);

-- ---------- files (persistent binary storage inside PostgreSQL) ----------
CREATE TABLE IF NOT EXISTS files (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'attachment',
  data          BYTEA NOT NULL,
  is_public     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_owner_idx ON files (owner_id);
CREATE INDEX IF NOT EXISTS files_kind_idx ON files (kind);

-- ---------- sessions ----------
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ---------- products ----------
CREATE TABLE IF NOT EXISTS products (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  price_note    TEXT,
  tier          TEXT NOT NULL DEFAULT 'single' CHECK (tier IN ('single', 'combo', 'custom')),
  tagline       TEXT,
  description   TEXT NOT NULL,
  includes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  audience      TEXT,
  platforms     JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_active_idx ON products (is_active, sort_order);

-- ---------- orders ----------
CREATE TABLE IF NOT EXISTS orders (
  id             BIGSERIAL PRIMARY KEY,
  reference      TEXT NOT NULL UNIQUE,
  user_id        BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  payment_method TEXT CHECK (payment_method IN ('bitcoin', 'paypal')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
                 CHECK (payment_status IN ('pending', 'submitted', 'confirmed', 'rejected')),
  status         TEXT NOT NULL DEFAULT 'pending_payment'
                 CHECK (status IN ('pending_payment','payment_submitted','payment_confirmed','in_progress','delivered','completed','cancelled')),
  notes          TEXT,
  delivery_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

-- ---------- order_items ----------
CREATE TABLE IF NOT EXISTS order_items (
  id            BIGSERIAL PRIMARY KEY,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    BIGINT REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);

-- ---------- conversations ----------
CREATE TABLE IF NOT EXISTS conversations (
  id               BIGSERIAL PRIMARY KEY,
  user_id          BIGINT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  last_message_at  TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_last_msg_idx ON conversations (last_message_at DESC NULLS LAST);

-- ---------- messages ----------
CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  sender_role      TEXT NOT NULL CHECK (sender_role IN ('streamer', 'owner')),
  body             TEXT,
  kind             TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'file', 'voice', 'system')),
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_unread_idx ON messages (conversation_id, sender_role, read_at);

-- ---------- message_attachments ----------
CREATE TABLE IF NOT EXISTS message_attachments (
  id            BIGSERIAL PRIMARY KEY,
  message_id    BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id       BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('image', 'file', 'voice')),
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_attachments_message_idx ON message_attachments (message_id);

-- ---------- payment_submissions ----------
CREATE TABLE IF NOT EXISTS payment_submissions (
  id             BIGSERIAL PRIMARY KEY,
  order_id       BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  method         TEXT NOT NULL CHECK (method IN ('bitcoin', 'paypal')),
  reference      TEXT,
  amount_cents   INTEGER,
  proof_file_id  BIGINT REFERENCES files(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'confirmed', 'rejected')),
  admin_note     TEXT,
  reviewed_at    TIMESTAMPTZ,
  reviewed_by    BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_submissions_order_idx ON payment_submissions (order_id);
CREATE INDEX IF NOT EXISTS payment_submissions_user_idx ON payment_submissions (user_id);
CREATE INDEX IF NOT EXISTS payment_submissions_status_idx ON payment_submissions (status);

-- ---------- reviews ----------
CREATE TABLE IF NOT EXISTS reviews (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  order_id      BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    BIGINT REFERENCES products(id) ON DELETE SET NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          TEXT,
  is_published  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One review per order.
CREATE UNIQUE INDEX IF NOT EXISTS reviews_order_unique ON reviews (order_id);
CREATE INDEX IF NOT EXISTS reviews_published_idx ON reviews (is_published, created_at DESC);

-- ---------- notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  link          TEXT,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, read_at);

-- ---------- proof_items (Proof of Work — owner uploaded only) ----------
CREATE TABLE IF NOT EXISTS proof_items (
  id            BIGSERIAL PRIMARY KEY,
  category      TEXT NOT NULL CHECK (category IN
                 ('client_conversations','strategy_delivery','channel_progress','creator_analysis','positive_feedback','payout_revenue')),
  title         TEXT NOT NULL,
  caption       TEXT,
  file_id       BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_published  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proof_items_category_idx ON proof_items (category, sort_order);
CREATE INDEX IF NOT EXISTS proof_items_published_idx ON proof_items (is_published, sort_order);

-- ---------- contact_messages (public contact form) ----------
CREATE TABLE IF NOT EXISTS contact_messages (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  subject       TEXT,
  body          TEXT NOT NULL,
  handled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_messages_created_idx ON contact_messages (created_at DESC);

-- ---------- deferred foreign key for avatar ----------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'profiles_avatar_file_fk'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_avatar_file_fk
      FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL;
  END IF;
END$$;
