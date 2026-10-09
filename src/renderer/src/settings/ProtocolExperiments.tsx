import { DisclosureSummary } from '../DisclosureSummary'
import { useEffect, useRef, useState } from "react";
import {
  EXPERIMENT_MAX_SENDS,
  type ExperimentState,
  type ProtocolExperimentSnapshot,
  type ProtocolExperimentTurn,
} from "../../../domain/protocol-experiment";

const EMPTY: ProtocolExperimentSnapshot = { revision: 0, sessions: [] };
const labels: Record<ExperimentState, string> = {
  ready: "待发送",
  preparing: "准备登录态",
  running: "正在生成",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已停止",
  interrupted: "已中断",
};
const integer = (value?: number): string =>
  value === undefined ? "—" : new Intl.NumberFormat("zh-CN").format(value);
export function ProtocolExperiments({
  active,
  onAccounts,
  onNative,
}: {
  active: boolean;
  onAccounts: () => void;
  onNative?: () => void;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [selected, setSelected] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<"create" | "send" | "cancel" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const actionLock = useRef(false);
  const row =
    snapshot.sessions.find((item) => item.id === selected) ??
    snapshot.sessions.at(-1);
  const draft = row ? (drafts[row.id] ?? "") : "";
  const update = (next: ProtocolExperimentSnapshot): void =>
    setSnapshot((previous) =>
      next.revision >= previous.revision ? next : previous,
    );
  useEffect(() => {
    if (!active) return;
    const api = window.sgDesktop;
    if (!api?.getProtocolExperiments) {
      setError("当前版本未接入协议实验后端。");
      return;
    }
    let alive = true;
    const off = api.onProtocolExperiments?.((next) => {
      if (alive) update(next);
    });
    void api
      .getProtocolExperiments()
      .then((next) => {
        if (alive) {
          update(next);
          setError("");
        }
      })
      .catch(() => {
        if (alive) setError("无法读取隔离实验记录，原文件保留。");
      });
    return () => {
      alive = false;
      off?.();
    };
  }, [active]);
  async function perform(kind: "create" | "send" | "cancel"): Promise<void> {
    if (actionLock.current) return;
    const api = window.sgDesktop;
    if (
      !api?.createProtocolExperiment ||
      !api.sendProtocolExperiment ||
      !api.cancelProtocolExperiment
    ) {
      setError("当前版本未接入协议实验后端。");
      return;
    }
    actionLock.current = true;
    setPending(kind);
    setError("");
    const target = row?.id;
    try {
      const next =
        kind === "create"
          ? await api.createProtocolExperiment()
          : kind === "send" && target
            ? await api.sendProtocolExperiment({
                sessionId: target,
                text: draft.trim(),
              })
            : target
              ? await api.cancelProtocolExperiment(target)
              : undefined;
      if (next) {
        update(next);
        if (kind === "create") setSelected(next.sessions.at(-1)?.id ?? "");
        if (kind === "send" && target)
          setDrafts((previous) => ({ ...previous, [target]: "" }));
      }
    } catch (value) {
      setError(
        value instanceof Error ? value.message : "操作未完成，没有自动重发。",
      );
    } finally {
      actionLock.current = false;
      setPending(null);
    }
  }
  const generating = row?.state === "running" || row?.state === "preparing";
  return (
    <div className="wire-workbench">
      <div className="wire-modes" aria-label="会话入口">
        <div className="wire-mode is-selected">
          <strong>
            协议直连 <small>实验</small>
          </strong>
          <span>独立会话 · 不依赖 Cursor 客户端</span>
        </div>
        <button
          type="button"
          className="wire-mode"
          onClick={onNative}
          disabled={!onNative}
        >
          <strong>
            Cursor 工作台 <span aria-hidden="true">↗</span>
          </strong>
          <span>保留原生会话、批量编排与 MCP</span>
        </button>
      </div>
      <div className="wire-intro">
        <p>
          用极短对话验证真实传输与记账。仅支持 <strong>Auto · Ask</strong>
          ，不执行工具、不读取工作区，不会自动重试或切换后端。
        </p>
        <p>
          新建绑定拾光当前选中的已保存账号，
          <strong>只有点击发送才发起模型请求</strong>
          。遵循账号现有权限和收费设置，不改额度桶。
          <button type="button" onClick={onAccounts}>
            查看账号
          </button>
        </p>
      </div>
      <div className="wire-toolbar">
        <label>
          实验会话
          <select
            aria-label="选择实验会话"
            value={row?.id ?? ""}
            disabled={!snapshot.sessions.length}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!snapshot.sessions.length ? (
              <option value="">尚未创建</option>
            ) : (
              snapshot.sessions.map((item, index) => (
                <option key={item.id} value={item.id}>
                  实验 {index + 1} · {item.accountLabel} · {labels[item.state]}
                </option>
              ))
            )}
          </select>
        </label>
        <button
          type="button"
          className="protocol-button"
          disabled={
            !!pending ||
            !!snapshot.busySessionId ||
            snapshot.sessions.length >= 20
          }
          onClick={() => void perform("create")}
        >
          {pending === "create" ? "正在绑定…" : "+ 新建实验"}
        </button>
      </div>
      {error ? (
        <p className="protocol-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}
      {!row ? (
        <div className="protocol-empty wire-empty">
          <strong>一条短消息，核实完整往返</strong>
          <p>
            先新建隔离会话，再输入简短提示词。结果、原始 token 回报、checkpoint
            和账本分别保留，不把“收到文字”当作完整成功。
          </p>
          <span>
            每个会话最多 {EXPERIMENT_MAX_SENDS}{" "}
            次发送，失败也计入实验次数。停止接收不保证免除已产生用量。
          </span>
        </div>
      ) : (
        <>
          <div className="wire-session-heading">
            <div>
              <strong>{row.accountLabel}</strong>
              <span>固定绑定 · Auto · 独立存储</span>
            </div>
            <span className="wire-state" role="status">
              {labels[row.state]} · {row.attempts.length}/{EXPERIMENT_MAX_SENDS}{" "}
              次发送
            </span>
          </div>
          <div className="wire-transcript" aria-label="隔离实验结果">
            {row.attempts.length ? (
              row.attempts.map((turn, index) =>
                index === row.attempts.length - 1 ? (
                  <ExperimentTurn key={turn.id} turn={turn} index={index} />
                ) : (
                  <details className="wire-previous" key={turn.id}>
                    <DisclosureSummary>
                      第 {index + 1} 次 · {labels[turn.state]}{" "}
                      <span>{turn.prompt}</span>
                    </DisclosureSummary>
                    <ExperimentTurn turn={turn} index={index} />
                  </details>
                ),
              )
            ) : (
              <p className="wire-awaiting">
                已绑定账号，还没有发送请求。可输入“仅回复 OK”。
              </p>
            )}
          </div>
          <form
            className="wire-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (!snapshot.busySessionId && !pending && draft.trim())
                void perform("send");
            }}
          >
            <label htmlFor="wire-prompt">极短提示词</label>
            <textarea
              id="wire-prompt"
              value={draft}
              maxLength={256}
              rows={3}
              placeholder="例如：仅回复 OK"
              disabled={
                generating || row.attempts.length >= EXPERIMENT_MAX_SENDS
              }
              onChange={(event) =>
                setDrafts((previous) => ({
                  ...previous,
                  [row.id]: event.target.value,
                }))
              }
            />
            <div>
              <span>{draft.length}/256 · 发送消耗正常额度</span>
              {generating ? (
                <button
                  type="button"
                  className="protocol-button"
                  disabled={cancelling}
                  onClick={() => {
                    // Cancellation remains available while the send promise is pending.
                    if (
                      !cancelling &&
                      window.sgDesktop?.cancelProtocolExperiment
                    ) {
                      setCancelling(true);
                      void window.sgDesktop
                        .cancelProtocolExperiment(row.id)
                        .then(update)
                        .catch(() => setError("停止请求未确认；不会重复发送。"))
                        .finally(() => setCancelling(false));
                    }
                  }}
                >
                  {cancelling ? "停止中…" : "停止"}
                </button>
              ) : (
                <button
                  type="submit"
                  className="protocol-button protocol-button--primary"
                  disabled={
                    !!pending ||
                    !!snapshot.busySessionId ||
                    !draft.trim() ||
                    row.attempts.length >= EXPERIMENT_MAX_SENDS
                  }
                >
                  {snapshot.busySessionId === row.id
                    ? "核对账本…"
                    : "发送短消息"}
                  <span aria-hidden="true">↑</span>
                </button>
              )}
            </div>
          </form>
        </>
      )}
      <p className="wire-boundary">
        这不是已有 Cursor 会话的迁移，也没有接管主工作台。当前已验证 Free / Auto
        纯文本；其他模型、Pro / On-demand、文件与工具仍不宣称完整支持。
      </p>
    </div>
  );
}
function ExperimentTurn({
  turn,
  index,
}: {
  turn: ProtocolExperimentTurn;
  index: number;
}): React.JSX.Element {
  const usage = turn.usage,
    bill = turn.ledger;
  const metrics: Array<[string, number | undefined, number | undefined]> = [
    [
      "Input 总数",
      usage?.input_tokens,
      bill ? bill.input + bill.cacheRead + bill.cacheWrite : undefined,
    ],
    ["未缓存 Input", undefined, bill?.input],
    ["Output", usage?.output_tokens, bill?.output],
    ["Cache Read", usage?.cache_read_tokens, bill?.cacheRead],
    ["Cache Write", usage?.cache_write_tokens, bill?.cacheWrite],
    ["Reasoning", usage?.reasoning_tokens, undefined],
  ];
  return (
    <article className="wire-turn">
      <header>
        <strong>第 {index + 1} 次</strong>
        <span>{labels[turn.state]}</span>
      </header>
      <p className="wire-prompt">{turn.prompt}</p>
      <div className="wire-answer">
        {turn.text ||
          (turn.state === "running" || turn.state === "preparing"
            ? "等待服务端回应…"
            : "没有完整答案。")}
      </div>
      {turn.thinking ? (
        <details className="wire-thinking">
          <DisclosureSummary>查看思考内容</DisclosureSummary>
          <p>{turn.thinking}</p>
        </details>
      ) : null}
      {turn.error ? (
        <p className="protocol-feedback is-error" role="alert">
          {turn.error}
          <span className="wire-error-note">
            没有自动重发；若请求已经发出，可能仍计入正常用量。
          </span>
        </p>
      ) : null}
      <details className="wire-evidence" open={turn.state === "completed"}>
        <DisclosureSummary>
          传输与记账证据{" "}
          <span>
            {turn.checkpointCount} checkpoint · KV {turn.kvGets} 读 /{" "}
            {turn.kvSets} 写
          </span>
        </DisclosureSummary>
        <div className="protocol-token-table">
          <div className="protocol-token-table__head">
            <span>Token</span>
            <span>服务端原始回报</span>
            <span>匹配账本</span>
          </div>
          {metrics.map(([name, stream, ledger]) => (
            <div key={name}>
              <span>{name}</span>
              <strong>{integer(stream)}</strong>
              <strong>{integer(ledger)}</strong>
            </div>
          ))}
        </div>
        <p className="protocol-record-note">
          当前 Auto 实测 Input
          含缓存。账本按未缓存输入与缓存分拆；缺失字段显示“—”，不补成 0。
        </p>
        {bill ? (
          <div className="wire-receipt">
            <strong>账本已唯一匹配</strong>
            <span>
              {bill.model} · 订阅 {bill.productId ?? "未返回"}
              {bill.chargedCents !== undefined
                ? ` · 记账 ${(bill.chargedCents / 100).toFixed(6)} USD`
                : ""}
            </span>
            <small>
              由会话标识、时间与 token 校验；这是额度记账值，不等同银行卡扣款。
            </small>
          </div>
        ) : (
          <p className="protocol-record-note">
            {turn.ledgerNote ??
              (turn.state === "completed"
                ? "尚未确认账本归属。"
                : "生成未完整结束，不作额度归属判断。")}
          </p>
        )}
      </details>
    </article>
  );
}
