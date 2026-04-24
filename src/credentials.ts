import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_DIR = path.join(os.homedir(), ".zero-token");

export function resolveDataDir() {
  return (process.env.ZERO_TOKEN_DATA_DIR || DEFAULT_DIR).replace(/^~(?=\/)/, os.homedir());
}

export function credentialsPath() {
  return path.join(resolveDataDir(), "credentials.json");
}

export type CredentialsFile = Record<string, string>;

export function loadCredentials(): CredentialsFile {
  const p = credentialsPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as CredentialsFile;
  } catch {
    return {};
  }
}

export function saveCredentials(data: CredentialsFile) {
  const p = credentialsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

export function setProviderCredential(api: string, credential: string) {
  const all = loadCredentials();
  all[api] = credential;
  saveCredentials(all);
}
