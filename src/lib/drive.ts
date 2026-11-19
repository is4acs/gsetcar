// Accès Google Drive côté serveur uniquement. Deux modes réels + un simulateur de développement.
//  - service_account : identité de service (adaptée à un Drive partagé, ou à des dossiers partagés
//    avec elle — attention : une identité de service n'a pas de quota de stockage propre dans « Mon Drive »).
//  - oauth : jeton de rafraîchissement d'un compte Google habilité sur les dossiers.
//  - mock : simulateur local sur disque, interdit en production.
import { importPKCS8, SignJWT } from "jose";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export class DriveError extends Error {
  constructor(message: string, public status: number) { super(message); }
  /** Erreurs d'accès ou de configuration : inutile de réessayer rapidement. */
  get blocking() { return this.status === 401 || this.status === 403 || this.status === 404 || this.status === 0; }
}

export type DriveFolder = { id: string; name: string; isFolder: boolean; trashed: boolean; canAddChildren: boolean };
export type DriveFile = { id: string; webViewLink: string | null; trashed: boolean };
export type NewFile = { id: string; name: string; parentId: string; mime: string; data: Buffer; appProperties?: Record<string, string> };

export interface DriveClient {
  getFolder(id: string): Promise<DriveFolder | null>;
  listChildFolders(parentId: string): Promise<{ id: string; name: string }[]>;
  createFolder(parentId: string, name: string): Promise<{ id: string }>;
  /** Réserve un identifiant de fichier avant l'envoi : rend la création rejouable sans doublon. */
  generateId(): Promise<string>;
  getFile(id: string): Promise<DriveFile | null>;
  /** Retourne null si un fichier porte déjà cet identifiant (envoi précédent déjà accepté par Drive). */
  createFile(file: NewFile): Promise<DriveFile | null>;
}

export function driveMode(): "service_account" | "oauth" | "mock" | "none" {
  const m = process.env.DRIVE_MODE;
  if (m === "mock") {
    if (process.env.VERCEL_ENV === "production") throw new DriveError("DRIVE_MODE=mock est interdit en production.", 0);
    return "mock";
  }
  if (m === "service_account" || m === "oauth") return m;
  return "none";
}

export function driveClient(): DriveClient {
  const mode = driveMode();
  if (mode === "mock") return new MockDrive();
  if (mode === "none") throw new DriveError("Connexion Drive non configurée (DRIVE_MODE).", 0);
  return new GoogleDrive(mode);
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

// ---------------------------------------------------------------------------------- Google

let cachedToken: { token: string; exp: number; mode: string } | null = null;

async function accessToken(mode: "service_account" | "oauth"): Promise<string> {
  if (cachedToken && cachedToken.mode === mode && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  let body: URLSearchParams;
  if (mode === "service_account") {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new DriveError("GOOGLE_SERVICE_ACCOUNT_JSON manquant.", 0);
    const key = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as { client_email: string; private_key: string };
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/drive" })
      .setProtectedHeader({ alg: "RS256" }).setIssuer(key.client_email).setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now).setExpirationTime(now + 3000).sign(await importPKCS8(key.private_key, "RS256"));
    body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  } else {
    const { GOOGLE_DRIVE_CLIENT_ID: id, GOOGLE_DRIVE_CLIENT_SECRET: secret, GOOGLE_DRIVE_REFRESH_TOKEN: refresh } = process.env;
    if (!id || !secret || !refresh) throw new DriveError("Identifiants OAuth Drive manquants.", 0);
    body = new URLSearchParams({ grant_type: "refresh_token", client_id: id, client_secret: secret, refresh_token: refresh });
  }
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new DriveError(`Authentification Drive refusée (${res.status}).`, res.status === 400 ? 401 : res.status);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, exp: Date.now() + json.expires_in * 1000, mode };
  return json.access_token;
}

class GoogleDrive implements DriveClient {
  constructor(private mode: "service_account" | "oauth") {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await accessToken(this.mode);
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45_000) });
    } catch (e) {
      throw new DriveError(`Drive injoignable : ${(e as Error).message}`, 503);
    }
    return res;
  }
  private async fail(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    let reason = text.slice(0, 300);
    try { reason = JSON.parse(text).error?.message ?? reason; } catch {}
    // 403 de quota (rateLimitExceeded…) : à réessayer, contrairement à un refus d'accès.
    const rate = res.status === 403 && /rate ?limit|quota/i.test(text) && !/storageQuota/i.test(text);
    throw new DriveError(`Drive ${res.status} : ${reason}`, rate ? 429 : res.status);
  }

  async getFolder(id: string) {
    const res = await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,name,mimeType,trashed,capabilities(canAddChildren)`);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res);
    const f = await res.json();
    return { id: f.id, name: f.name, isFolder: f.mimeType === "application/vnd.google-apps.folder", trashed: !!f.trashed, canAddChildren: !!f.capabilities?.canAddChildren };
  }
  async listChildFolders(parentId: string) {
    const out: { id: string; name: string }[] = [];
    let pageToken = "";
    do {
      const qs = new URLSearchParams({
        q: `'${parentId.replace(/'/g, "\\'")}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "nextPageToken,files(id,name)", orderBy: "createdTime", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      });
      if (pageToken) qs.set("pageToken", pageToken);
      const res = await this.call(`https://www.googleapis.com/drive/v3/files?${qs}`);
      if (!res.ok) await this.fail(res);
      const json = await res.json();
      out.push(...json.files);
      pageToken = json.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }
  async createFolder(parentId: string, name: string) {
    const res = await this.call("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" }),
    });
    if (!res.ok) await this.fail(res);
    return (await res.json()) as { id: string };
  }
  async generateId() {
    const res = await this.call("https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive");
    if (!res.ok) await this.fail(res);
    return ((await res.json()) as { ids: string[] }).ids[0];
  }
  async getFile(id: string) {
    const res = await this.call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id,webViewLink,trashed`);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res);
    const f = await res.json();
    return { id: f.id, webViewLink: f.webViewLink ?? null, trashed: !!f.trashed };
  }
  async createFile(file: NewFile) {
    const boundary = "gset" + randomBytes(12).toString("hex");
    const meta = { id: file.id, name: file.name, parents: [file.parentId], mimeType: file.mime, appProperties: file.appProperties };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${file.mime}\r\n\r\n`),
      file.data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const res = await this.call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink,trashed", {
      method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body,
    });
    if (res.status === 409) return null;
    if (!res.ok) await this.fail(res);
    const f = await res.json();
    return { id: f.id, webViewLink: f.webViewLink ?? null, trashed: false };
  }
}

// ---------------------------------------------------------------------------------- Simulateur

type MockIndex = { folders: Record<string, { name: string; parentId: string | null }>; files: Record<string, { name: string; parentId: string; mime: string; size: number }> };

/**
 * Simulateur Drive pour le développement et les tests. Tout identifiant de dossier inconnu est
 * accepté comme dossier existant. Pannes simulées via DRIVE_MOCK_FAIL :
 *   "down"          → toutes les opérations échouent (503)
 *   "create_lost"   → le fichier est créé mais la réponse est « perdue » (erreur après écriture)
 */
export class MockDrive implements DriveClient {
  private dir = process.env.DRIVE_MOCK_DIR || join(process.cwd(), ".drive-mock");
  private indexPath = join(this.dir, "index.json");
  private load(): MockIndex {
    if (!existsSync(this.indexPath)) return { folders: {}, files: {} };
    return JSON.parse(readFileSync(this.indexPath, "utf8"));
  }
  private save(idx: MockIndex) { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.indexPath, JSON.stringify(idx, null, 1)); }
  private check() { if (process.env.DRIVE_MOCK_FAIL === "down") throw new DriveError("Drive simulé indisponible.", 503); }

  async getFolder(id: string) {
    this.check();
    if (id.startsWith("absent")) return null;
    const idx = this.load();
    return { id, name: idx.folders[id]?.name ?? `Dossier simulé ${id.slice(0, 6)}`, isFolder: true, trashed: false, canAddChildren: !id.startsWith("lecture") };
  }
  async listChildFolders(parentId: string) {
    this.check();
    return Object.entries(this.load().folders).filter(([, f]) => f.parentId === parentId).map(([id, f]) => ({ id, name: f.name }));
  }
  async createFolder(parentId: string, name: string) {
    this.check();
    const idx = this.load();
    const id = "mockfolder_" + randomBytes(8).toString("hex");
    idx.folders[id] = { name, parentId };
    this.save(idx);
    return { id };
  }
  async generateId() { this.check(); return "mockfile_" + randomBytes(10).toString("hex"); }
  async getFile(id: string) {
    this.check();
    return this.load().files[id] ? { id, webViewLink: `https://drive.invalid/mock/${id}`, trashed: false } : null;
  }
  async createFile(file: NewFile) {
    this.check();
    const idx = this.load();
    if (idx.files[file.id]) return null;
    idx.files[file.id] = { name: file.name, parentId: file.parentId, mime: file.mime, size: file.data.length };
    this.save(idx);
    writeFileSync(join(this.dir, file.id), file.data);
    if (process.env.DRIVE_MOCK_FAIL === "create_lost") throw new DriveError("Réponse Drive perdue (simulation).", 503);
    return { id: file.id, webViewLink: `https://drive.invalid/mock/${file.id}`, trashed: false };
  }
  /** Pour les tests. */
  dump(): MockIndex { return this.load(); }
}
