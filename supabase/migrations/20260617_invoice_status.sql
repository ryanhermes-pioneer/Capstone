CREATE TABLE IF NOT EXISTS invoice_status (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client     TEXT NOT NULL,
  month      TEXT NOT NULL,
  year       INT  NOT NULL DEFAULT 2026,
  sent       BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at    TIMESTAMPTZ,
  sent_by    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client, month, year)
);

ALTER TABLE invoice_status ENABLE ROW LEVEL SECURITY;

-- anon can read (landing page progress); authenticated users can write
CREATE POLICY "anon_select_invoice_status"
  ON invoice_status FOR SELECT USING (true);

CREATE POLICY "auth_write_invoice_status"
  ON invoice_status FOR INSERT WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth_update_invoice_status"
  ON invoice_status FOR UPDATE USING (auth.role() = 'authenticated');
