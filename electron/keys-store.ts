import fs from "node:fs";

/** Tolerate UTF-8 BOM written by external tools (e.g. PowerShell Set-Content). */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pluggable secret protection.
 *
 * Injected rather than imported so this module can be tested without an
 * Electron runtime, and so the store degrades predictably when the OS keychain
 * is unavailable (Linux without a keyring, headless CI, …).
 */
export interface SecretCrypto {
  /** False ⇒ the store falls back to plaintext and says so. */
  available(): boolean;
  /** Returns an opaque, storable string. */
  encrypt(plain: string): string;
  /** Throws when the payload cannot be decrypted (wrong machine, corrupt file). */
  decrypt(payload: string): string;
}

/** The shape Electron's `safeStorage` exposes (subset we rely on). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Adapts Electron's `safeStorage` (OS keychain / DPAPI / libsecret) into a
 * `SecretCrypto`. Values are stored base64 so the JSON file stays text.
 */
export function createSafeStorageCrypto(safeStorage: SafeStorageLike): SecretCrypto {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain).toString("base64"),
    decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, "base64")),
  };
}

/** Plaintext passthrough, used when no keychain is available. */
export const PLAINTEXT_CRYPTO: SecretCrypto = {
  available: () => false,
  encrypt: (plain) => plain,
  decrypt: (payload) => payload,
};

interface StoreFileV2 {
  version: 2;
  /** `enc: true` ⇒ value is a base64 ciphertext, false ⇒ plaintext. */
  keys: Record<string, { value: string; enc: boolean }>;
}

/** Legacy on-disk shape: a flat env-var → plaintext map. */
type StoreFileV1 = Record<string, string>;

export interface KeyStatus {
  envVar: string;
  configured: boolean;
  source: "env" | "store";
}

/**
 * API keys persisted under userData (never inside the repo).
 *
 * File format history:
 * - v1: `{"SENSENOVA_API_KEY": "sk-…"}` — plaintext, still readable.
 * - v2: `{"version":2,"keys":{"…":{"value":"<b64>","enc":true}}}` — encrypted
 *   through the OS keychain when one is available.
 *
 * A v1 file is migrated on the next write, and a value that failed to decrypt
 * (e.g. the file was copied from another machine) is reported as missing rather
 * than crashing the settings screen.
 */
export class KeysStore {
  constructor(
    private file: string,
    private crypto: SecretCrypto = PLAINTEXT_CRYPTO,
  ) {}

  /** True when values written from now on are encrypted at rest. */
  isEncryptedAtRest(): boolean {
    try {
      return this.crypto.available();
    } catch {
      return false;
    }
  }

  private readAll(): StoreFileV2["keys"] {
    if (!fs.existsSync(this.file)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripBom(fs.readFileSync(this.file, "utf8"))) as unknown;
    } catch {
      return {};
    }
    if (this.isV2(parsed)) return parsed.keys;
    if (parsed !== null && typeof parsed === "object") {
      // v1 migration on read: keep the plaintext, mark it as such.
      const out: StoreFileV2["keys"] = {};
      for (const [k, v] of Object.entries(parsed as StoreFileV1)) {
        if (typeof v === "string") out[k] = { value: v, enc: false };
      }
      return out;
    }
    return {};
  }

  private isV2(value: unknown): value is StoreFileV2 {
    return (
      value !== null &&
      typeof value === "object" &&
      (value as { version?: unknown }).version === 2 &&
      typeof (value as { keys?: unknown }).keys === "object" &&
      (value as { keys?: unknown }).keys !== null
    );
  }

  private writeAll(keys: StoreFileV2["keys"]): void {
    const payload: StoreFileV2 = { version: 2, keys };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), "utf8");
  }

  /** Reads a key: process env wins, then the store (decrypting when needed). */
  get(envVar: string): string {
    if (process.env[envVar]) return process.env[envVar]!;
    const entry = this.readAll()[envVar];
    if (!entry) return "";
    if (!entry.enc) return entry.value;
    try {
      return this.crypto.decrypt(entry.value);
    } catch {
      // Copied from another machine / keychain reset: treat as absent.
      return "";
    }
  }

  status(envVars: string[]): KeyStatus[] {
    return envVars.map((v) => ({
      envVar: v,
      configured: Boolean(process.env[v] || this.get(v)),
      source: process.env[v] ? ("env" as const) : ("store" as const),
    }));
  }

  /** Returns false for a malformed variable name; a blank value clears the key. */
  set(envVar: string, value: string): boolean {
    const v = value.trim();
    if (!/^[A-Z0-9_]+$/.test(envVar)) return false;
    const keys = this.readAll();
    if (!v) {
      delete keys[envVar];
    } else if (this.isEncryptedAtRest()) {
      keys[envVar] = { value: this.crypto.encrypt(v), enc: true };
    } else {
      keys[envVar] = { value: v, enc: false };
    }
    this.writeAll(keys);
    return true;
  }

  /** How many stored values are still plaintext (shown in the settings panel). */
  plaintextCount(): number {
    return Object.values(this.readAll()).filter((e) => !e.enc).length;
  }
}
