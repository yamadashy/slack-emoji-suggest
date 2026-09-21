import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { bridge, relativeTime, type Status } from "@/lib/bridge";

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  async function refresh() {
    try {
      setStatus(await bridge.getStatus());
      setFailed(null);
    } catch (err) {
      setFailed((err as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="w-[360px] p-4 text-[13px]">
      <header className="mb-3 flex items-center gap-2 px-1">
        <span aria-hidden className="text-[17px] leading-none">
          ✨
        </span>
        <h1 className="text-[15px] font-semibold tracking-tight">Slack Emoji Suggest</h1>
      </header>

      {failed && <Note>うまく読み込めませんでした。拡張機能を読み込み直してみてください。</Note>}

      {status && !status.workspace && (
        <Note>Slack のタブを開くと、そのワークスペースの設定がここに出ます。</Note>
      )}

      {status?.workspace && <Workspace status={status} onChange={refresh} />}

      {status && <ApiKey hasKey={status.hasKey} onSaved={refresh} />}

      <p className="text-muted-foreground mt-3 px-1 text-[11px] leading-relaxed">
        メッセージの本文は、そのメッセージにカーソルを合わせたときと、絵文字を選ぶときだけ送っています。
      </p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Card className="text-muted-foreground rounded-2xl px-4 py-3 text-[12px] leading-relaxed shadow-none">
      {children}
    </Card>
  );
}

function Workspace({ status, onChange }: { status: Status; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = status.workspaceName || status.workspace;
  const when = relativeTime(status.syncedAt);
  const preview = status.emoji.filter((e) => e.url).slice(0, 8);
  const extra = status.count - preview.length;

  async function toggle(enabled: boolean) {
    await bridge.setEnabled(status.workspace!, enabled);
    onChange();
  }

  async function harvest() {
    setBusy(true);
    setError(null);
    try {
      await bridge.harvestNow();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-0 rounded-2xl px-4 py-3.5 shadow-none transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{name}</div>
          <div className="text-muted-foreground text-[11px]">
            {status.enabled ? "このワークスペースで使っています" : "お休み中です"}
          </div>
        </div>
        <Switch
          checked={status.enabled}
          onCheckedChange={toggle}
          aria-label="このワークスペースで使う"
        />
      </div>

      {status.enabled && (
        <>
          <Separator className="my-3" />

          {status.count > 0 ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                {preview.map((e) => (
                  <img
                    key={e.name}
                    src={e.url!}
                    alt={e.name}
                    title={`:${e.name}:`}
                    className="size-[18px] rounded-[3px] object-contain"
                  />
                ))}
                {extra > 0 && (
                  <span className="text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                    +{extra}
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-[12px] leading-snug">
                カスタム絵文字 {status.count} 個を覚えています
                {when && (
                  <>
                    <br />
                    <span className="opacity-70">{when}に更新しました</span>
                  </>
                )}
              </div>
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={harvest}
                  disabled={busy}
                  className="h-7 rounded-lg px-2.5 text-[12px] font-normal"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                  もう一度集める
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="text-muted-foreground text-[12px] leading-relaxed">
                <span aria-hidden>🙂</span> まだ絵文字を覚えていません。Slack で絵文字を一度開くと、
                そのあと静かに集めます。
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={harvest}
                disabled={busy}
                className="h-7 rounded-lg px-2.5 text-[12px] font-normal"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                いま集める
              </Button>
            </div>
          )}

          {(error || status.lastError) && (
            <div className="mt-2">
              <p className="text-destructive text-[11.5px] leading-relaxed">
                {error ? "Slack のタブを開いてから、もう一度お試しください。" : "うまく集められませんでした。"}
              </p>
              <button
                type="button"
                onClick={() => setDetail((d) => !d)}
                className="text-muted-foreground mt-0.5 text-[11px] underline underline-offset-2"
              >
                くわしく
              </button>
              {detail && (
                <p className="text-muted-foreground mt-1 text-[11px] break-all">
                  {error || status.lastError}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ApiKey({ hasKey, onSaved }: { hasKey: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(!hasKey);
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  async function save() {
    if (value.trim() === "") return;
    await bridge.setApiKey(value.trim());
    setValue("");
    setSaved(true);
    setOpen(false);
    onSaved();
  }

  async function remove() {
    await bridge.clearApiKey();
    setSaved(false);
    setOpen(true);
    onSaved();
  }

  return (
    <Card className="mt-2.5 gap-0 rounded-2xl px-4 py-2.5 shadow-none">
      {hasKey && !open ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[12px]">
            <Check className="size-3.5 opacity-70" />
            {saved ? "保存しました" : "API キーは設定済みです"}
          </span>
          <span className="inline-flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="text-muted-foreground text-[11.5px] underline underline-offset-2"
            >
              変更
            </button>
            <button
              type="button"
              onClick={remove}
              className="text-muted-foreground text-[11.5px] underline underline-offset-2"
            >
              削除
            </button>
          </span>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[12px] leading-relaxed">
            {hasKey ? "新しい API キーを入れてください。" : "はじめに API キーを入れてください。"}
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={value}
              autoComplete="off"
              placeholder="TypeSafe Jev の API キー"
              onChange={(e) => setValue(e.target.value)}
              className="h-8 rounded-lg text-[12px]"
            />
            <Button size="sm" onClick={save} className="h-8 rounded-lg px-3 text-[12px]">
              保存
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
