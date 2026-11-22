import { InvalidCursorError } from "./errors";

// The ledger cursor is the wallet version of the last entry returned, encoded in base64url. It
// is opaque to clients: versions are assigned under the wallet lock, so they order the ledger
// without depending on any instance's clock.

const VERSION = /^[1-9]\d{0,9}$/;
const MAX_VERSION = 2_147_483_647;

export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(String(walletVersion), "utf8").toString("base64url");
}

/** The wallet version a cursor stands for; `InvalidCursorError` unless this service issued it. */
export function decodeLedgerCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const version = Number(decoded);
  // Buffer decoding skips invalid characters, so only an exact round trip proves the origin.
  if (!VERSION.test(decoded) || version > MAX_VERSION || encodeLedgerCursor(version) !== cursor) {
    throw new InvalidCursorError();
  }
  return version;
}
