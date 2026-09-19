/**
 * Ranking provider: TypeSafe's Jev ("System One").
 *
 * Everything Jev-specific is confined to this file -- the endpoint, the model
 * id, the wording of the question, and how an answer turns into a score.
 * Swapping the ranking model means adding a sibling file with the same `rank`
 * signature; nothing else in the extension mentions Jev.
 *
 * Why one Noul per candidate rather than one Choice over all of them: Choice's
 * probabilities sum to 1, so a single winner drowns out everything else, and
 * the point here is to suggest several. Noul judges each emoji on its own, so
 * several can score high at once. It also runs lenient -- a lot of 0.8s -- so
 * the caller is expected to apply a threshold and a top-N.
 *
 * A plain script publishing itself into `self.Providers.jev`.
 */
(() => {
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

/** Shown next to the API key field on the options page. */
const LABEL = "TypeSafe Jev";

/**
 * Score every candidate for one message.
 *
 * @param {object} args
 * @param {string} args.message      the message text being reacted to
 * @param {{shortcode: string, description: string}[]} args.candidates
 * @param {string} args.apiKey
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{shortcode: string, p: number}[]>}
 *   every candidate, **sorted by `p` descending**. No threshold, no truncation:
 *   that is the caller's policy, not the model's.
 * @throws {Error} with a message written for the user, in Japanese.
 */
async function rank({ message, candidates, apiKey, signal }) {
  const questions = {};
  candidates.forEach((c, i) => {
    questions[`noul_${i}`] = {
      type: "noul",
      instructions:
        `\`state.message\` is a message posted in a Slack channel. Would reacting to it ` +
        `with the emoji ${c.shortcode} be natural and appropriate here, given that ` +
        `${c.shortcode} is used on Slack to mean: ${c.description}. Judge this emoji on ` +
        `its own — other emoji may also be appropriate at the same time.`,
    };
  });

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ state: { message }, model: MODEL, questions }),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error("TypeSafe に接続できませんでした。");
  }

  if (!r.ok) throw new Error(await describe(r));

  const body = await r.json();
  return candidates
    .map((c, i) => {
      const a = body?.answers?.[`noul_${i}`];
      return a && typeof a.noul === "number" ? { shortcode: c.shortcode, p: a.noul } : null;
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.p - a.p);
}

/** Turn a failed response into a sentence worth reading. */
async function describe(r) {
  const detail = (await r.text().catch(() => "")).trim().slice(0, 200);
  switch (r.status) {
    // A missing or wrong key comes back as 403 authentication_error, not 401.
    case 401:
    case 403:
      return "API キーが正しくありません。拡張機能の設定で確認してください。";
    case 422:
      return `質問の形が API に弾かれました (422): ${detail}`;
    case 429:
      return "レート制限に当たりました。少し待ってからもう一度。";
    case 529:
      return "TypeSafe 側が混雑しています。少し待ってからもう一度。";
    default:
      return `エラーが返りました (${r.status})${detail ? `: ${detail}` : ""}`;
  }
}

self.Providers = self.Providers || {};
self.Providers.jev = { LABEL, rank };
})();
