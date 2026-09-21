/**
 * The emoji candidate list, and the parser for the editable version of it.
 *
 * Site-neutral on purpose: shortcodes are close enough between chat apps that
 * one list is worth more than one list per site. Nothing here knows about a
 * ranking model either -- a provider is handed `{shortcode, description}` and
 * gives back scores.
 *
 * The content script never sees it: it only renders whatever the background ranked.
 */
import { t } from "./i18n.js";

/**
 * One candidate per line: `:shortcode: description`. The description says what
 * the reaction *means* in a chat app, in English, because that is the text the
 * model reads and it was tuned that way. Ported from ai-lab's
 * web/src/components/jev/EmojiTab.tsx.
 */
export const DEFAULT_CANDIDATES = [
  ":pray: thanking someone, or politely asking a favor",
  ':eyes: "I\'ve seen this" or "I\'m looking into it"',
  ":white_check_mark: done / confirmed / task complete",
  ":bow: apologizing, or a deep respectful thank-you",
  ":tada: celebrating a release, launch, or good news",
  ":sob: sad, overwhelmed, or in real distress",
  ":joy: something is genuinely very funny",
  ":thinking_face: considering, unsure, or mildly skeptical",
  ':fire: this is excellent work, or something is urgently broken ("on fire")',
  ":rocket: shipping something, or moving fast toward a goal",
  ':+1: simple agreement, approval, "sounds good"',
  ":heart: warmth, appreciation, or emotional support",
  ":100: fully agree, perfect, no notes",
  ":clap: applause, praising someone's effort or result",
  ':muscle: encouragement, "you can do it" / effort paid off',
  ":ok_hand: acknowledged and fine, minor confirmation",
  ":sweat_smile: awkward relief, narrowly avoided trouble, embarrassed laugh",
  ":scream: shocked, alarmed, or startled by bad news",
  ":raised_hands: celebrating together, giving praise or thanks",
  ":sparkles: something nice and a little special, extra polish",
  ":bulb: a good idea or useful suggestion",
  ":memo: noting something down, will write it up or document it",
  ":warning: heads up, caution, a risk worth flagging",
  ":bug: a bug was found or reported",
  ":ship: shipped or deployed to production",
  ':coffee: taking a break, or "let\'s grab coffee sometime"',
  ":beer: celebratory drink, end-of-week or launch cheers",
  ":zzz: tired, sleepy, or signing off for the day",
  ":face_with_thermometer: hope you feel better soon, sympathy for illness",
  ":birthday: happy birthday",
  ":wave: greeting hello, or a friendly goodbye",
  ':raised_hand: "I have a question", or a gentle "wait a moment"',
  ":point_up: important point worth noticing",
  ":question: unclear, needs clarification",
  ":heavy_check_mark: verified or reviewed, a stronger confirmation than a plain check",
  ":new: pointing out something newly added",
  ':innocent: playful "who, me?" innocence',
  ":laughing: laughing out loud at something funny",
  ":smile: a friendly, simply happy reaction",
  ":grin: pleased, a big satisfied grin",
  ":wink: playful teasing or a knowing joke",
  ":cry: sad, disappointed, or moved to tears",
  ":rage: frustrated or angry about something",
  ":confused: puzzled, does not add up",
  ":flushed: embarrassed or caught off guard",
  ':sunglasses: cool, confident, "nailed it" swagger',
  ":star: noteworthy, worth remembering",
  ":trophy: a big win or achievement",
  ":moneybag: money-related good news, a sale or budget win",
  ":calendar: something about scheduling or a date",
  ":hourglass: waiting on something, or time-sensitive and in progress",
  ":no_entry_sign: blocked, do not proceed, off-limits",
  ":x: rejected, wrong, or a check that failed",
  ":pushpin: pinning this as an important reference",
  ":handshake: agreement reached, a deal, or good collaboration",
  ":raised_eyebrow: skeptical, doubtful about a claim",
].join("\n");

/**
 * Only the defaults need a glyph. A workspace's custom emoji has none -- the
 * shortcode text is shown instead, which is why this map stays small rather
 * than trying to cover every shortcode in existence.
 */
export const EMOJI_GLYPHS = {
  ":pray:": "\u{1F64F}",
  ":eyes:": "\u{1F440}",
  ":white_check_mark:": "✅",
  ":bow:": "\u{1F647}",
  ":tada:": "\u{1F389}",
  ":sob:": "\u{1F62D}",
  ":joy:": "\u{1F602}",
  ":thinking_face:": "\u{1F914}",
  ":fire:": "\u{1F525}",
  ":rocket:": "\u{1F680}",
  ":+1:": "\u{1F44D}",
  ":heart:": "❤️",
  ":100:": "\u{1F4AF}",
  ":clap:": "\u{1F44F}",
  ":muscle:": "\u{1F4AA}",
  ":ok_hand:": "\u{1F44C}",
  ":sweat_smile:": "\u{1F605}",
  ":scream:": "\u{1F631}",
  ":raised_hands:": "\u{1F64C}",
  ":sparkles:": "✨",
  ":bulb:": "\u{1F4A1}",
  ":memo:": "\u{1F4DD}",
  ":warning:": "⚠️",
  ":bug:": "\u{1F41B}",
  ":ship:": "\u{1F6A2}",
  ":coffee:": "☕",
  ":beer:": "\u{1F37A}",
  ":zzz:": "\u{1F4A4}",
  ":face_with_thermometer:": "\u{1F912}",
  ":birthday:": "\u{1F382}",
  ":wave:": "\u{1F44B}",
  ":raised_hand:": "✋",
  ":point_up:": "☝️",
  ":question:": "❓",
  ":heavy_check_mark:": "✔️",
  ":new:": "\u{1F195}",
  ":innocent:": "\u{1F607}",
  ":laughing:": "\u{1F606}",
  ":smile:": "\u{1F604}",
  ":grin:": "\u{1F601}",
  ":wink:": "\u{1F609}",
  ":cry:": "\u{1F622}",
  ":rage:": "\u{1F621}",
  ":confused:": "\u{1F615}",
  ":flushed:": "\u{1F633}",
  ":sunglasses:": "\u{1F60E}",
  ":star:": "⭐",
  ":trophy:": "\u{1F3C6}",
  ":moneybag:": "\u{1F4B0}",
  ":calendar:": "\u{1F4C5}",
  ":hourglass:": "⏳",
  ":no_entry_sign:": "\u{1F6AB}",
  ":x:": "❌",
  ":pushpin:": "\u{1F4CC}",
  ":handshake:": "\u{1F91D}",
  ":raised_eyebrow:": "\u{1F928}",
};

/**
 * A sanity cap on a hand-edited list, not a protocol limit. The per-request
 * budget is handled by splitting (see `chunkByBudget`), so a long list costs
 * more requests rather than failing.
 */
export const MAX_CANDIDATES = 1000;

const CANDIDATE_LINE = /^(:[\w+-]+:)\s+(.+)$/;

/**
 * One line, one candidate. Returns `{candidates}` or `{error}` with a sentence
 * naming the offending line, because a parser that just throws sends people to
 * devtools.
 */
export function parseCandidates(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return { error: t("errCandidatesEmpty") };
  if (lines.length > MAX_CANDIDATES) {
    return { error: t("errTooManyCandidates", [String(lines.length), String(MAX_CANDIDATES)]) };
  }

  const candidates = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = CANDIDATE_LINE.exec(lines[i]);
    if (!m) {
      return { error: t("errLineUnreadable", [String(i + 1), lines[i]]) };
    }
    const [, shortcode, description] = m;
    if (seen.has(shortcode)) return { error: t("errDuplicateShortcode", [String(i + 1), shortcode]) };
    seen.add(shortcode);
    candidates.push({ shortcode, description: description.trim() });
  }
  return { candidates };
}

/**
 * Merge the workspace's own emoji with the standard list.
 *
 * A candidate is `{shortcode, description, url}`. `description` is null for a
 * workspace emoji with no override -- the provider reads that as "judge this
 * one by its name alone", which is the whole point: a workspace can have
 * hundreds of emoji and nobody is going to write a sentence for each. `url` is
 * set only for workspace emoji, and only so the suggestion row can draw them.
 *
 * Workspace emoji come first. Nothing downstream depends on the order, but it
 * makes the split into requests put them together.
 */
export function buildCandidates({ standardText, customEmoji = [], customDescriptionsText = "" }) {
  const standard = parseCandidates(standardText || DEFAULT_CANDIDATES);
  if (standard.error) return { error: t("errStandardCandidates", [standard.error]) };

  const overrides = new Map();
  if (customDescriptionsText.trim() !== "") {
    const parsed = parseCandidates(customDescriptionsText);
    if (parsed.error) return { error: t("errCustomDescriptions", [parsed.error]) };
    for (const c of parsed.candidates) overrides.set(c.shortcode, c.description);
  }

  const seen = new Set();
  const candidates = [];
  for (const e of customEmoji) {
    const shortcode = `:${e.name}:`;
    if (seen.has(shortcode)) continue;
    seen.add(shortcode);
    candidates.push({ shortcode, description: overrides.get(shortcode) ?? null, url: e.url || null });
  }
  for (const c of standard.candidates) {
    if (seen.has(c.shortcode)) continue;
    seen.add(c.shortcode);
    candidates.push({ shortcode: c.shortcode, description: c.description, url: null });
  }
  return { candidates };
}

/* ------------------------------------------------------- name matching --- */

/**
 * If the message says an emoji's name, that emoji is what the person meant.
 *
 * No model involved and nothing extra sent: it is a string match, and it beats
 * any score. 「Claude Codeの絵文字つけてほしい」 has to lead with `:claude-code:`
 * even when the ranker preferred ✨.
 *
 * Both sides are normalised the same way -- NFKC (so full-width Ｃｌａｕｄｅ folds
 * onto ASCII), lowercased, `-`/`_` treated as spaces -- and then compared two
 * ways:
 *
 * - **spaced**, with a word boundary for ASCII names. That is what stops
 *   `:pig:` firing inside "config".
 * - **tight**, separators removed, so "ClaudeCode" still hits `:claude-code:`.
 *   Tight has no boundary to check, so it is allowed *only* for names that
 *   contain a separator: those are long and specific, where a chance substring
 *   hit is not a real risk.
 */
const MIN_MATCH_LENGTH = 3;

function normalizeText(s) {
  return s.normalize("NFKC").toLowerCase();
}

/** True when `name` (a shortcode without its colons) is named by the text. */
function nameIsMentioned(name, spacedText, tightText) {
  const n = normalizeText(name);
  if (n.length < MIN_MATCH_LENGTH) return false;

  const spacedName = n.replace(/[-_]+/g, " ").trim();
  const hasSeparator = /[-_]/.test(n);
  const isAscii = /^[\x20-\x7e]*$/.test(spacedName);

  if (isAscii) {
    // \b is unreliable next to non-ASCII, so the boundary is spelled out as
    // "not a letter or digit" either side -- which Japanese text satisfies,
    // letting 「Claude Codeの絵文字」 match despite the trailing の.
    const escaped = spacedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(spacedText)) return true;
  } else if (spacedText.includes(spacedName)) {
    return true;
  }

  if (hasSeparator) {
    const tightName = n.replace(/[-_\s]+/g, "");
    if (tightName.length >= MIN_MATCH_LENGTH && tightText.includes(tightName)) return true;
  }
  return false;
}

/**
 * Mark the ranked suggestions whose name the message mentions.
 *
 * Returns a new array; matched entries gain `matched: true` and `matchLength`,
 * the latter so the caller can prefer `claude-code` over `claude` when both
 * hit. Order is left alone -- presentation is the caller's business.
 */
export function markNameMatches(suggestions, text) {
  const spacedText = normalizeText(text || "").replace(/[-_]+/g, " ");
  const tightText = spacedText.replace(/\s+/g, "");
  return suggestions.map((s) => {
    const name = s.shortcode.replace(/^:|:$/g, "");
    if (!nameIsMentioned(name, spacedText, tightText)) return s;
    return { ...s, matched: true, matchLength: name.length };
  });
}

/* ------------------------------------------------------------- budget ---- */

/**
 * Rough input-token cost of asking about one candidate.
 *
 * Deliberately crude and deliberately over-estimating: the only decision it
 * feeds is where to split, and splitting one request too many costs half a
 * second while overshooting the context window costs the whole answer.
 * Calibrated against a measured 38 name-only questions ~= 2.8k tokens (~74
 * each); the formula gives ~80 for those. The +330 is the context sentence
 * the provider appends to each question when earlier messages go along --
 * counted always, since over-estimating is the safe direction.
 */
export function estimateTokens(candidate) {
  const body = (candidate.description ? candidate.description.length + 260 : 300) + 330;
  return Math.ceil(body / 3.4) + 12;
}

/** Tokens per request. The documented ceiling is 64k; this leaves ample room
 *  for the message itself, the response, and the estimate being wrong. */
export const TOKEN_BUDGET = 20000;
/** Questions per request, independent of tokens: a large map is slower to
 *  serialise on both ends and harder to reason about when something fails. */
const MAX_QUESTIONS = 200;

/** Split candidates into request-sized groups. One group is the common case. */
export function chunkByBudget(candidates) {
  const chunks = [];
  let current = [];
  let tokens = 0;
  for (const c of candidates) {
    const cost = estimateTokens(c);
    if (current.length > 0 && (tokens + cost > TOKEN_BUDGET || current.length >= MAX_QUESTIONS)) {
      chunks.push(current);
      current = [];
      tokens = 0;
    }
    current.push(c);
    tokens += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
