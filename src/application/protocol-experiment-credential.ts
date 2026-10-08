import { createHash } from "node:crypto";
import type { CursorAccountVault } from "./cursor-account-vault";
import type { CursorDesktopTokenExchangePort } from "../infrastructure/cursor/cursor-desktop-token-exchanger";
import type { ExperimentCredential } from "./protocol-experiment-service";

interface Claims {
  sub: string;
  type: string;
  expiresAt: number;
}
function claims(token: string): Claims {
  try {
    const value = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { sub?: unknown; type?: unknown; exp?: unknown };
    if (
      typeof value.sub !== "string" ||
      !value.sub ||
      typeof value.type !== "string" ||
      typeof value.exp !== "number" ||
      !Number.isFinite(value.exp)
    )
      throw new Error();
    return { sub: value.sub, type: value.type, expiresAt: value.exp * 1000 };
  } catch {
    throw new Error("已保存账号的登录态无效，请在账号页重新导入。");
  }
}
export function experimentAccountLabel(label: string): string {
  return (
    label
      .replace(
        /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,
        (email) => `${email.slice(0, 2)}…@${email.split("@")[1]}`,
      )
      .slice(0, 80) || "已保存账号"
  );
}
/** Only normal session/PKCE authentication. No IDE files, device identity or
 * vault changes. Cache lives in memory and is invalidated when the source changes. */
export class ProtocolExperimentCredentialResolver {
  private cached = new Map<
    string,
    { fingerprint: string; expiresAt: number; value: ExperimentCredential }
  >();
  private inFlight = new Map<string, Promise<ExperimentCredential>>();
  constructor(
    private readonly vault: Pick<CursorAccountVault, "list" | "credential">,
    private readonly exchanger: CursorDesktopTokenExchangePort,
    private readonly isolatedEndpointPath: string,
    private readonly now: () => number = Date.now,
  ) {}
  async resolve(accountId?: string): Promise<ExperimentCredential> {
    const account = this.vault
      .list()
      .find((row) => (accountId ? row.id === accountId : row.active));
    if (!account)
      throw new Error(
        accountId
          ? "会话绑定的账号已被移除，不能自动换号。"
          : "请先在账号页选中一个已保存账号。",
      );
    const raw = this.vault.credential(account.id);
    const bare = raw.trim().replace(/^user_[A-Za-z0-9]+::/, "");
    const source = claims(bare);
    if (
      !["web", "session"].includes(source.type) ||
      source.expiresAt <= this.now() + 1000
    )
      throw new Error(
        "该账号登录态过期或类型不支持，请重新导入；实验不会自动登录或换号。",
      );
    const fingerprint = createHash("sha256").update(raw).digest("hex");
    const cached = this.cached.get(account.id);
    if (
      cached?.fingerprint === fingerprint &&
      cached.expiresAt > this.now() + 60000
    )
      return { ...cached.value, label: experimentAccountLabel(account.label) };
    const key = `${account.id}:${fingerprint}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key)!;
    const operation = (async () => {
      const pair = await this.exchanger.resolve(raw, this.isolatedEndpointPath);
      const runtime = claims(pair.accessToken);
      if (
        runtime.type !== "session" ||
        runtime.sub !== source.sub ||
        runtime.expiresAt <= this.now() + 1000
      )
        throw new Error(
          "正常登录兑换结果与绑定账号不一致或已过期，未发出模型请求。",
        );
      if (this.vault.credential(account.id) !== raw)
        throw new Error("账号登录态在准备期间发生变化，请重新创建实验会话。");
      const value = {
        accountId: account.id,
        label: experimentAccountLabel(account.label),
        accessToken: pair.accessToken,
        subject: runtime.sub,
      };
      this.cached.set(account.id, {
        fingerprint,
        expiresAt: runtime.expiresAt,
        value,
      });
      return value;
    })().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }
  clear(): void {
    this.cached.clear();
  }
}
