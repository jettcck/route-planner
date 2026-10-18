/**
 * 备份与恢复面板。
 *
 * 交互顺序（对应「重要操作前先看清单」的产品原则）：
 *  1. 导出：选择数据段 →（可选）加密口令 → 生成 .routebackup
 *  2. 导入：选文件 → 解析校验 → **展示概要（天数/条目数）** → 用户确认后才覆盖
 *  3. 快照：列出最近 5 个本地快照，按时间回滚
 *
 * 这里不直接读写业务状态：所有覆盖动作都经由父组件传入的 onRestore 回调，
 * 由 App 统一做「整包校验 → 写入 → 失败回滚」。
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Clock3, Download, FileArchive, KeyRound, Lock, ShieldCheck, Trash2, Upload } from "lucide-react";
import {
  ALL_SECTIONS,
  MAX_BACKUP_BYTES,
  MAX_SNAPSHOTS,
  SECTION_LABELS,
  backupFileName,
  buildBackupData,
  deleteSnapshot,
  encryptBackup,
  listSnapshots,
  parseBackupFile,
  readSnapshot,
  sha256Hex,
  summarizeBackup,
  type BackupSection,
  type BackupSummary,
  type SnapshotMeta,
} from "./backup";
import { downloadText } from "./share";

export type BackupSource = {
  trip: unknown;
  plannerInput: unknown;
  weather: unknown;
  expenses: unknown;
  checkIns: unknown;
  prepState: unknown;
  packing: unknown;
};

type Props = {
  appVersion: string;
  buildSource: () => BackupSource;
  /** 目的地，仅用于生成可读文件名 */
  destination: string;
  /** 恢复入口：App 负责校验、写入与失败回滚；返回错误信息或空串 */
  onRestore: (data: Record<string, unknown>, sections: BackupSection[], origin: string) => Promise<string>;
};

type Stage =
  | { kind: "idle" }
  | { kind: "preview"; summary: BackupSummary; data: Record<string, unknown> | null; sections: BackupSection[]; origin: string; needsPassphrase: boolean; text: string }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

export function BackupPanel({ appVersion, buildSource, destination, onRestore }: Props) {
  const [selected, setSelected] = useState<BackupSection[]>([...ALL_SECTIONS]);
  const [encrypt, setEncrypt] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [passphrase2, setPassphrase2] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>(() => listSnapshots());
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<string>("");

  useEffect(() => {
    setSnapshots(listSnapshots());
  }, []);

  const toggleSection = (section: BackupSection) => {
    setSelected((previous) =>
      previous.includes(section) ? previous.filter((item) => item !== section) : [...previous, section],
    );
  };

  async function handleExport() {
    if (!selected.length) {
      setStage({ kind: "error", message: "至少选择一项要备份的数据" });
      return;
    }
    if (encrypt) {
      if (passphrase.length < 8) {
        setStage({ kind: "error", message: "加密口令至少 8 位" });
        return;
      }
      if (passphrase !== passphrase2) {
        setStage({ kind: "error", message: "两次输入的口令不一致" });
        return;
      }
    }
    setBusy(true);
    try {
      const source = buildSource();
      const { sections, data } = buildBackupData({ ...source, sections: selected });
      const createdAt = new Date().toISOString();
      const meta = { appVersion, source: "android", sections };
      let text: string;
      if (encrypt) {
        const encrypted = await encryptBackup(meta, data, passphrase);
        text = JSON.stringify({ ...encrypted, format: "route-backup", encrypted: true }, null, 2);
      } else {
        const plain = {
          format: "route-backup",
          encrypted: false,
          schemaVersion: 4,
          appVersion,
          createdAt,
          source: "android",
          sections,
          data,
          checksum: await sha256Hex(stable(data)),
        };
        text = JSON.stringify(plain, null, 2);
      }
      await downloadText(backupFileName(destination), text, "application/octet-stream");
      setStage({
        kind: "done",
        message: encrypt
          ? `已导出加密备份（${sections.length} 项数据）。请牢记口令：它不会被保存，丢失后无法恢复。`
          : `已导出备份（${sections.length} 项数据）。文件未加密，请勿放到公开网盘。`,
      });
      setPassphrase("");
      setPassphrase2("");
    } catch (reason) {
      setStage({ kind: "error", message: `导出失败：${reason instanceof Error ? reason.message : String(reason)}` });
    } finally {
      setBusy(false);
    }
  }

  async function loadBackupText(text: string, fileName: string, passphraseValue?: string) {
    setBusy(true);
    try {
      if (!text) throw new Error("文件为空");
      const parsed = await parseBackupFile(text, passphraseValue);
      const summary = summarizeBackup(parsed.file, parsed.data, parsed.file.encrypted);
      setPendingFile(fileName);
      setStage({
        kind: "preview",
        summary,
        data: parsed.data,
        sections: parsed.file.sections as BackupSection[],
        origin: `导入 ${fileName}`,
        needsPassphrase: parsed.needsPassphrase,
        text,
      });
    } catch (reason) {
      setStage({ kind: "error", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File) {
    if (file.size > MAX_BACKUP_BYTES) {
      setStage({ kind: "error", message: `备份文件不能超过 ${Math.round(MAX_BACKUP_BYTES / 1024 / 1024)} MB` });
      return;
    }
    const text = await file.text();
    setPassphrase("");
    await loadBackupText(text, file.name);
  }

  async function confirmRestore(passphraseValue?: string) {
    if (stage.kind !== "preview") return;
    if (stage.needsPassphrase) {
      await loadBackupText(stage.text, pendingFile, passphraseValue);
      return;
    }
    if (!stage.data) return;
    setBusy(true);
    try {
      const error = await onRestore(stage.data, stage.sections, stage.origin);
      if (error) {
        setStage({ kind: "error", message: error });
        return;
      }
      setStage({ kind: "done", message: `${stage.origin} 已完成恢复` });
      setSnapshots(listSnapshots());
    } catch (reason) {
      setStage({ kind: "error", message: `恢复失败：${reason instanceof Error ? reason.message : String(reason)}` });
    } finally {
      setBusy(false);
    }
  }

  async function restoreSnapshot(meta: SnapshotMeta) {
    const payload = readSnapshot(meta.id);
    if (!payload) {
      setStage({ kind: "error", message: "该快照已不可读（可能已被清理），请选择其他快照" });
      setSnapshots(listSnapshots());
      return;
    }
    setBusy(true);
    try {
      const error = await onRestore(payload.data, payload.sections, `快照 ${formatTime(meta.createdAt)}`);
      if (error) {
        setStage({ kind: "error", message: error });
        return;
      }
      setStage({ kind: "done", message: `已回滚到 ${formatTime(meta.createdAt)} 的快照` });
      setSnapshots(listSnapshots());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backup-panel">
      <section className="backup-section" aria-label="导出备份">
        <div className="backup-section__head">
          <div>
            <strong>导出备份</strong>
            <small>生成 .routebackup 文件，可在新手机上完整恢复</small>
          </div>
        </div>
        <div className="backup-chips">
          {ALL_SECTIONS.map((section) => (
            <label key={section} className={`backup-chip${selected.includes(section) ? " active" : ""}`}>
              <input
                type="checkbox"
                checked={selected.includes(section)}
                onChange={() => toggleSection(section)}
              />
              <span>{SECTION_LABELS[section]}</span>
            </label>
          ))}
        </div>
        <label className="ui-switch backup-encrypt">
          <input type="checkbox" checked={encrypt} onChange={(event) => setEncrypt(event.target.checked)} />
          <span>用口令加密（推荐）</span>
        </label>
        {encrypt ? (
          <div className="backup-passphrase">
            <label className="field">
              <span>加密口令</span>
              <input
                type="password"
                value={passphrase}
                autoComplete="new-password"
                placeholder="至少 8 位，仅你和家人知道"
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            <label className="field">
              <span>再输一次</span>
              <input
                type="password"
                value={passphrase2}
                autoComplete="new-password"
                placeholder="再次输入同一口令"
                onChange={(event) => setPassphrase2(event.target.value)}
              />
            </label>
            <p className="backup-warn">
              <AlertTriangle size={14} /> 口令不会被保存。忘记口令后，加密备份无法恢复。
            </p>
          </div>
        ) : (
          <p className="backup-warn">
            <AlertTriangle size={14} /> 未加密的备份是明文，包含行程与记账金额，请勿上传到公开位置。
          </p>
        )}
        <button className="primary-action backup-submit" type="button" disabled={busy} onClick={() => void handleExport()}>
          <Download size={16} /> {busy ? "正在生成…" : "导出 .routebackup"}
        </button>
      </section>

      <section className="backup-section" aria-label="导入备份">
        <div className="backup-section__head">
          <div>
            <strong>导入备份</strong>
            <small>选择文件后会先显示数据概要，确认后才覆盖本机数据</small>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          // 只写 MIME 类型，不写 ".routebackup" 扩展名：
          // Android 的 DocumentsUI 把 accept 里的扩展名换算成 MIME 后，
          // 自定义扩展名（.routebackup）无对应 MIME，会让文件在选择器里
          // 变成 enabled="false" 的灰项，用户根本点不动。
          // 备份文件本质是 JSON，用 application/json + 通配即可选中；
          // 真正的格式校验在 parseBackupFile 里做（format 字段与 schemaVersion）。
          accept="application/json,text/plain,text/*,.json,application/octet-stream"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.currentTarget.value = "";
          }}
        />
        <button className="ghost-action backup-submit" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>
          <Upload size={16} /> 选择备份文件
        </button>

        {stage.kind === "preview" ? (
          <div className="backup-preview" role="status">
            <div className="backup-preview__head">
              <FileArchive size={16} />
              <strong>{pendingFile || "备份文件"}</strong>
              {stage.summary.encrypted ? <span className="backup-badge"><Lock size={12} /> 已加密</span> : <span className="backup-badge is-plain">未加密</span>}
            </div>
            <dl className="backup-preview__meta">
              <div><dt>创建时间</dt><dd>{formatTime(stage.summary.createdAt)}</dd></div>
              <div><dt>来源版本</dt><dd>{stage.summary.appVersion || "未知"}</dd></div>
              <div><dt>格式版本</dt><dd>v{stage.summary.schemaVersion}</dd></div>
            </dl>
            {stage.needsPassphrase ? (
              <div className="backup-passphrase">
                <p className="backup-warn"><KeyRound size={14} /> 该备份已加密，请输入导出时设置的口令。</p>
                <label className="field">
                  <span>口令</span>
                  <input
                    type="password"
                    value={passphrase}
                    autoComplete="off"
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </label>
                <button
                  className="primary-action backup-submit"
                  type="button"
                  disabled={busy || !passphrase}
                  onClick={() => void confirmRestore(passphrase)}
                >
                  解密并预览
                </button>
              </div>
            ) : (
              <>
                <div className="backup-counts">
                  {stage.summary.counts.length
                    ? stage.summary.counts.map((item) => (
                        <div key={item.label}>
                          <strong>{item.count}</strong>
                          <span>{item.label}</span>
                        </div>
                      ))
                    : <p className="backup-warn">该备份不含任何数据段。</p>}
                </div>
                <p className="backup-confirm-note">
                  <ShieldCheck size={14} /> 恢复前会自动把本机当前数据存为快照，误操作可回滚。
                </p>
                <div className="backup-actions">
                  <button className="ghost-action" type="button" disabled={busy} onClick={() => setStage({ kind: "idle" })}>
                    取消
                  </button>
                  <button className="primary-action" type="button" disabled={busy} onClick={() => void confirmRestore()}>
                    {busy ? "正在恢复…" : "确认覆盖并恢复"}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {stage.kind === "done" ? <p className="backup-result is-ok" role="status">{stage.message}</p> : null}
        {stage.kind === "error" ? <p className="backup-result is-err" role="alert">{stage.message}</p> : null}
      </section>

      <section className="backup-section" aria-label="本地快照">
        <div className="backup-section__head">
          <div>
            <strong>本机快照</strong>
            <small>重要修改后自动留档，最多保留最近 {MAX_SNAPSHOTS} 个</small>
          </div>
        </div>
        {snapshots.length === 0 ? (
          <p className="backup-empty">还没有快照。生成或导入行程后会自动创建。</p>
        ) : (
          <ul className="snapshot-list">
            {snapshots.map((meta) => {
              const available = readSnapshot(meta.id) !== null;
              return (
                <li key={meta.id} className={available ? "" : "is-missing"}>
                  <div className="snapshot-main">
                    <Clock3 size={14} />
                    <div>
                      <strong>{formatTime(meta.createdAt)}</strong>
                      <small>
                        {meta.sections.map((section) => SECTION_LABELS[section] ?? section).join(" · ")}
                        {meta.size ? ` · ${Math.max(1, Math.round(meta.size / 1024))} KB` : ""}
                      </small>
                    </div>
                  </div>
                  <div className="snapshot-actions">
                    <button
                      type="button"
                      className="ghost-action"
                      disabled={busy || !available}
                      onClick={() => void restoreSnapshot(meta)}
                    >
                      {available ? "恢复" : "不可用"}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      title="删除该快照"
                      aria-label="删除该快照"
                      onClick={() => {
                        deleteSnapshot(meta.id);
                        setSnapshots(listSnapshots());
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** 与 backup.ts 中一致的稳定序列化，用于明文包的 checksum。 */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未知时间";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
