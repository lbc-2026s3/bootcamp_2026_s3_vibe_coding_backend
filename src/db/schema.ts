import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type TransferRow = {
  id: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number | null;
  from_address: string;
  to_address: string;
  value: string;
  token_address: string;
};

export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      block_timestamp INTEGER,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      value TEXT NOT NULL,
      token_address TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_address);
    CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_address);
    CREATE INDEX IF NOT EXISTS idx_transfers_block ON transfers(block_number);
  `);

  return db;
}

export function getSyncState(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM sync_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function insertTransfer(db: Database.Database, row: TransferRow): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO transfers
        (id, tx_hash, log_index, block_number, block_timestamp, from_address, to_address, value, token_address)
       VALUES
        (@id, @tx_hash, @log_index, @block_number, @block_timestamp, @from_address, @to_address, @value, @token_address)`,
    )
    .run(row);
  return result.changes > 0;
}

export function getTransfersForAddress(
  db: Database.Database,
  address: string,
  limit = 100,
): TransferRow[] {
  const normalized = address.toLowerCase();
  return db
    .prepare(
      `SELECT id, tx_hash, log_index, block_number, block_timestamp, from_address, to_address, value, token_address
       FROM transfers
       WHERE from_address = ? OR to_address = ?
       ORDER BY block_number DESC, log_index DESC
       LIMIT ?`,
    )
    .all(normalized, normalized, limit) as TransferRow[];
}
