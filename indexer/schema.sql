-- The indexer's whole database.
--
-- One row per transaction we recognise, plus one row per address that took
-- part in it. The second table is what makes "show me my activity" an index
-- lookup instead of a scan, and it is why the site will be able to answer that
-- question in milliseconds rather than by asking the chain.

CREATE TABLE IF NOT EXISTS activity (
  signature     TEXT    PRIMARY KEY,
  slot          INTEGER NOT NULL,
  block_offset  INTEGER NOT NULL,
  fee_payer     TEXT    NOT NULL,
  program       TEXT    NOT NULL,
  op            INTEGER,
  kind          TEXT    NOT NULL,
  label         TEXT    NOT NULL,
  ok            INTEGER NOT NULL,
  user_error    INTEGER,
  vm_error      INTEGER,
  block_time_ns TEXT,
  -- The node's fee for the transaction, as the decimal string it sent.
  fee           TEXT,
  -- The first 32 bytes of the instruction (base64), and the read-write and
  -- read-only accounts it names (JSON arrays), so a row can say who paid whom
  -- without going back to the chain.
  data          TEXT,
  rw            TEXT,
  ro            TEXT
);

CREATE INDEX IF NOT EXISTS activity_slot   ON activity( slot DESC, block_offset DESC );
CREATE INDEX IF NOT EXISTS activity_kind   ON activity( kind, slot DESC );
CREATE INDEX IF NOT EXISTS activity_payer  ON activity( fee_payer, slot DESC );

-- Every address a transaction touched, fee payer included. A wallet's history
-- is one index seek into this.
CREATE TABLE IF NOT EXISTS participant (
  signature TEXT    NOT NULL,
  address   TEXT    NOT NULL,
  writable  INTEGER NOT NULL,
  PRIMARY KEY ( signature, address )
);

CREATE INDEX IF NOT EXISTS participant_addr ON participant( address );

-- Where we have got to. One row, forever.
CREATE TABLE IF NOT EXISTS cursor (
  id   INTEGER PRIMARY KEY CHECK ( id = 1 ),
  slot INTEGER NOT NULL
);
