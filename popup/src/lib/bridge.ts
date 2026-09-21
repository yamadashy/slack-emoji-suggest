/**
 * The only place the popup touches `chrome.*`.
 *
 * Everything goes through here so `npm run dev` can render the popup in a
 * plain browser tab against the mock below -- which is how the design was
 * actually iterated on, without rebuilding the extension for every tweak.
 *
 * The API key is deliberately one-way: the popup can set it and can ask
 * whether one exists, but there is no call that returns it.
 */
export interface Status {
  /** null when the active tab is not a supported chat app. */
  workspace: string | null;
  workspaceName: string | null;
  enabled: boolean;
  emoji: { name: string; url: string | null }[];
  count: number;
  syncedAt: number | null;
  lastError: string | null;
  hasKey: boolean;
}

const hasChrome = typeof chrome !== "undefined" && !!chrome.runtime?.id;

function ask<T>(message: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (res: { ok?: boolean; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || "不明なエラーです。"));
      resolve(res as T);
    });
  });
}

/* ----------------------------------------------------------------- mock --- */

const MOCK_EMOJI = [
  "claude-code", "claude", "repomix", "devin", "github-copilot",
  "shipit", "squirrel", "piggy", "bowtie", "glitch_crab",
].map((name) => ({ name, url: null }));

let mock: Status = {
  workspace: "TFL6W9953",
  workspaceName: "yamadashy",
  enabled: true,
  emoji: MOCK_EMOJI,
  count: MOCK_EMOJI.length,
  syncedAt: Date.now() - 3 * 60 * 60 * 1000,
  lastError: null,
  hasKey: true,
};

export const bridge = {
  isLive: hasChrome,

  async getStatus(): Promise<Status> {
    if (!hasChrome) return { ...mock };
    return ask<Status>({ type: "getStatus" });
  },

  async setEnabled(workspace: string, enabled: boolean): Promise<void> {
    if (!hasChrome) {
      mock = { ...mock, enabled };
      return;
    }
    await ask({ type: "setEnabled", workspace, enabled });
  },

  async setApiKey(key: string): Promise<void> {
    if (!hasChrome) {
      mock = { ...mock, hasKey: true };
      return;
    }
    await ask({ type: "setApiKey", key });
  },

  async clearApiKey(): Promise<void> {
    if (!hasChrome) {
      mock = { ...mock, hasKey: false };
      return;
    }
    await ask({ type: "clearApiKey" });
  },

  async harvestNow(): Promise<void> {
    if (!hasChrome) {
      await new Promise((r) => setTimeout(r, 1200));
      mock = { ...mock, syncedAt: Date.now(), count: MOCK_EMOJI.length, lastError: null };
      return;
    }
    await ask({ type: "harvestNow" });
  },
};

/** "3 時間前" and friends. Relative time reads better than a timestamp here:
 *  nobody cares when exactly, only whether it was recent. */
export function relativeTime(ts: number | null): string | null {
  if (!ts) return null;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "たった今";
  if (mins < 60) return `${mins} 分前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 時間前`;
  return `${Math.round(hours / 24)} 日前`;
}
