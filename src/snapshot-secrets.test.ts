import { describe, expect, it } from "vitest";
import { isSecretLikeFile } from "../electron/agents/sensenova-api";

/**
 * The workspace snapshot is shipped to a third-party LLM endpoint. Anything not
 * matched here is, in effect, published — so this list is the contract that
 * keeps user credentials out of the prompt.
 */
describe("isSecretLikeFile", () => {
  it("matches the .env family", () => {
    for (const f of [".env", ".env.local", ".env.production", ".env.example"]) {
      expect(isSecretLikeFile(f), f).toBe(true);
    }
  });

  it("matches npm / git / net credential files", () => {
    for (const f of [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmrc", ".netrc", ".git-credentials"]) {
      expect(isSecretLikeFile(f), f).toBe(true);
    }
  });

  it("matches key and certificate material", () => {
    for (const f of ["server.pem", "private.key", "cert.p12", "bundle.pfx", "app.jks", "id_rsa", "id_ed25519.pub"]) {
      expect(isSecretLikeFile(f), f).toBe(true);
    }
  });

  it("matches credentials / secrets / token-named files", () => {
    for (const f of ["credentials.json", "secret.txt", "secrets.yaml", "api-key.txt", "api_key.json", "access-token", "refresh_token.json", "password.txt", "private-key.pem"]) {
      expect(isSecretLikeFile(f), f).toBe(true);
    }
  });

  it("matches nested paths (basename decides) and is case-insensitive", () => {
    expect(isSecretLikeFile("config/.env")).toBe(true);
    expect(isSecretLikeFile("deep/nested/dir/.ENV.LOCAL")).toBe(true);
    expect(isSecretLikeFile("keys/SERVER.PEM")).toBe(true);
  });

  it("leaves ordinary source and docs alone", () => {
    for (const f of ["src/index.js", "README.md", "package.json", "tests/a.test.js", "docs/design.md", "tsconfig.json"]) {
      expect(isSecretLikeFile(f), f).toBe(false);
    }
  });

  it("does not over-match names that merely contain a keyword as a word part", () => {
    // "tokenizer.js" contains "token" but is not a credential file.
    expect(isSecretLikeFile("src/tokenizer.js")).toBe(false);
    expect(isSecretLikeFile("src/secretsanta.js")).toBe(false);
  });
});
