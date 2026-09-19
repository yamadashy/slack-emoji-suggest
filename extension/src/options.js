/**
 * The options page: the API key, the workspace emoji, and the candidate lists.
 *
 * The key field is write-only by design -- a saved key is never read back into
 * the DOM, only its presence is reported. Storage keys are provider- and
 * site-neutral (`provider`, `apiKeys.<id>`, `candidates`, `customEmoji`,
 * `customEmojiSyncedAt`, `customEmojiDescriptions`) so swapping either the
 * ranking model or the chat app does not need a migration.
 *
 * Plain script; the shared files are loaded before it by ordered <script> tags.
 */
const { DEFAULT_CANDIDATES, parseCandidates } = self.Candidates;
const { DEFAULT_PROVIDER, getProvider } = self.ProviderRegistry;

const keyInput = document.getElementById("api-key");
const keyStatus = document.getElementById("key-status");
const providerLabel = document.getElementById("provider-label");
const candidatesInput = document.getElementById("candidates");
const candidatesStatus = document.getElementById("candidates-status");
const syncStatus = document.getElementById("sync-status");
const syncButton = document.getElementById("sync-emoji");
const customDescriptionsInput = document.getElementById("custom-descriptions");
const customDescriptionsStatus = document.getElementById("custom-descriptions-status");

let providerId = DEFAULT_PROVIDER;

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function describeSync(count, syncedAt) {
  if (!count) return "まだ取り込んでいません。";
  const when = syncedAt ? new Date(syncedAt).toLocaleString("ja-JP") : "不明";
  return `${count} 件（最終取り込み: ${when}）`;
}

async function load() {
  const s = await chrome.storage.local.get([
    "provider",
    "apiKeys",
    "candidates",
    "customEmoji",
    "customEmojiSyncedAt",
    "customEmojiDescriptions",
  ]);
  providerId = s.provider || DEFAULT_PROVIDER;
  providerLabel.textContent = `（${getProvider(providerId).LABEL}）`;
  setStatus(keyStatus, s.apiKeys?.[providerId] ? "保存済みです。" : "まだ保存されていません。");
  candidatesInput.value = s.candidates || DEFAULT_CANDIDATES;
  customDescriptionsInput.value = s.customEmojiDescriptions || "";
  setStatus(syncStatus, describeSync((s.customEmoji || []).length, s.customEmojiSyncedAt));
}

document.getElementById("save-key").addEventListener("click", async () => {
  const value = keyInput.value.trim();
  if (value === "") {
    setStatus(keyStatus, "キーが空です。", true);
    return;
  }
  const { apiKeys } = await chrome.storage.local.get("apiKeys");
  await chrome.storage.local.set({
    provider: providerId,
    apiKeys: { ...(apiKeys || {}), [providerId]: value },
  });
  keyInput.value = "";
  setStatus(keyStatus, "保存しました。");
});

document.getElementById("save-candidates").addEventListener("click", async () => {
  const parsed = parseCandidates(candidatesInput.value);
  if (parsed.error) {
    setStatus(candidatesStatus, parsed.error, true);
    return;
  }
  await chrome.storage.local.set({ candidates: candidatesInput.value });
  setStatus(candidatesStatus, `${parsed.candidates.length} 件を保存しました。`);
});

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  setStatus(syncStatus, "取り込み中…");
  const res = await new Promise((r) =>
    chrome.runtime.sendMessage({ type: "syncCustomEmoji" }, (x) =>
      r(chrome.runtime.lastError ? { ok: false, error: "拡張機能が応答しませんでした。" } : x),
    ),
  );
  syncButton.disabled = false;
  if (!res?.ok) {
    setStatus(syncStatus, res?.error || "取り込みに失敗しました。", true);
    return;
  }
  setStatus(syncStatus, `${describeSync(res.count, res.syncedAt)} / 今回 ${res.found} 件を ${res.ms}ms で取得`);
});

document.getElementById("save-custom-descriptions").addEventListener("click", async () => {
  const text = customDescriptionsInput.value;
  if (text.trim() !== "") {
    const parsed = parseCandidates(text);
    if (parsed.error) {
      setStatus(customDescriptionsStatus, parsed.error, true);
      return;
    }
    await chrome.storage.local.set({ customEmojiDescriptions: text });
    setStatus(customDescriptionsStatus, `${parsed.candidates.length} 件を保存しました。`);
    return;
  }
  await chrome.storage.local.set({ customEmojiDescriptions: "" });
  setStatus(customDescriptionsStatus, "説明をすべて消しました。");
});

document.getElementById("reset-candidates").addEventListener("click", async () => {
  candidatesInput.value = DEFAULT_CANDIDATES;
  await chrome.storage.local.set({ candidates: DEFAULT_CANDIDATES });
  setStatus(candidatesStatus, "初期値に戻しました。");
});

void load();
