CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS freefire_packages (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  diamonds INTEGER NOT NULL CHECK (diamonds > 0),
  supplier_usd REAL NOT NULL CHECK (supplier_usd > 0),
  usd_ars_rate REAL NOT NULL CHECK (usd_ars_rate > 0),
  final_price_ars INTEGER NOT NULL CHECK (final_price_ars > 0),
  supplier_url TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pines (
  id INTEGER PRIMARY KEY,
  paquete_id TEXT NOT NULL,
  codigo_pin TEXT NOT NULL UNIQUE,
  codigo_pin_hash TEXT NOT NULL UNIQUE,
  pin_iv TEXT NOT NULL,
  pin_auth_tag TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'disponible'
    CHECK (estado IN ('disponible', 'reservado', 'vendido')),
  order_id TEXT UNIQUE,
  fecha_venta TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (estado = 'disponible' AND order_id IS NULL AND fecha_venta IS NULL) OR
    (estado = 'reservado' AND order_id IS NOT NULL AND fecha_venta IS NULL) OR
    (estado = 'vendido' AND order_id IS NOT NULL AND fecha_venta IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS pines_available_package_idx
  ON pines (paquete_id, id) WHERE estado = 'disponible';

CREATE TABLE IF NOT EXISTS freefire_orders (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  package_label TEXT NOT NULL,
  diamonds INTEGER NOT NULL CHECK (diamonds > 0),
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  amount_ars INTEGER NOT NULL CHECK (amount_ars > 0),
  status TEXT NOT NULL CHECK (status IN (
    'payment_pending',
    'payment_error',
    'paid',
    'out_of_stock_pending_refund'
  )),
  fulfillment_status TEXT NOT NULL CHECK (fulfillment_status IN (
    'not_started',
    'assigned',
    'out_of_stock_pending_refund',
    'manual_required'
  )),
  access_token_hash TEXT NOT NULL,
  preference_id TEXT,
  payment_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  email_sent_at TEXT,
  email_sending_at TEXT
);

CREATE INDEX IF NOT EXISTS freefire_orders_created_at_idx
  ON freefire_orders (created_at DESC);

INSERT OR IGNORE INTO freefire_packages
  (id, label, diamonds, supplier_usd, usd_ars_rate, final_price_ars, supplier_url, updated_at)
VALUES
  ('latin-gm-305106', '100 + 10', 110, 0.73, 1535, 1221,
   'https://latingm.com/p/recarga-free-fire-chilez/', '2026-10-12T16:25:29.642Z'),
  ('latin-gm-305107', '310 + 31', 341, 2.17, 1535, 3431,
   'https://latingm.com/p/recarga-free-fire-chilez/', '2026-10-12T16:25:29.642Z'),
  ('latin-gm-305108', '520 + 52', 572, 3.68, 1535, 5749,
   'https://latingm.com/p/recarga-free-fire-chilez/', '2026-10-12T16:25:29.642Z'),
  ('latin-gm-305109', '1060 + 106', 1166, 6.82, 1535, 10569,
   'https://latingm.com/p/recarga-free-fire-chilez/', '2026-10-12T16:25:29.642Z'),
  ('latin-gm-305110', '2.180 + 218', 2398, 13.53, 1535, 20869,
   'https://latingm.com/p/recarga-free-fire-chilez/', '2026-10-12T16:25:29.642Z'),
  ('latin-gm-305111', '5.600 + 560', 6160, 34.45, 1535, 52981,
   'https://latingm.com/p/recarga-free-fire-chilez/', '2026-10-12T16:25:29.642Z');
