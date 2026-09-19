/**
 * The options page. Two things are stored: the API key for the current
 * provider, and the candidate list.
 *
 * The key field is write-only by design -- a saved key is never read back into
 * the DOM, only its presence is reported. Storage keys are provider-neutral
 * (`provider`, `apiKeys.<id>`, `candidates`) so swapping the ranking model does
 * not need a migration.
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

let providerId = DEFAULT_PROVIDER;

function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function load() {
  const s = await chrome.storage.local.get(["provider", "apiKeys", "candidates"]);
  providerId = s.provider || DEFAULT_PROVIDER;
  providerLabel.textContent = `（${getProvider(providerId).LABEL}）`;
  setStatus(keyStatus, s.apiKeys?.[providerId] ? "保存済みです。" : "まだ保存されていません。");
  candidatesInput.value = s.candidates || DEFAULT_CANDIDATES;
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

document.getElementById("reset-candidates").addEventListener("click", async () => {
  candidatesInput.value = DEFAULT_CANDIDATES;
  await chrome.storage.local.set({ candidates: DEFAULT_CANDIDATES });
  setStatus(candidatesStatus, "初期値に戻しました。");
});

void load();
