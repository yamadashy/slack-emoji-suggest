/**
 * The emoji candidate list, and the parser for the editable version of it.
 *
 * Site-neutral on purpose: shortcodes are close enough between chat apps that
 * one list is worth more than one list per site. Nothing here knows about a
 * ranking model either -- a provider is handed `{shortcode, description}` and
 * gives back scores.
 *
 * A plain script, not a module: the service worker loads it with
 * importScripts() and the options page with a <script> tag, so there is no
 * build step and no module-worker startup quirks. It publishes `self.Candidates`.
 * The content script never sees it: it only renders whatever the background ranked.
 */
(() => {

/**
 * One candidate per line: `:shortcode: description`. The description says what
 * the reaction *means* in a chat app, in English, because that is the text the
 * model reads and it was tuned that way. Ported from ai-lab's
 * web/src/components/jev/EmojiTab.tsx.
 */
const DEFAULT_CANDIDATES = [
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
const EMOJI_GLYPHS = {
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

/** Providers cap how many things they can be asked about in one request. */
const MAX_CANDIDATES = 255;

const CANDIDATE_LINE = /^(:[\w+-]+:)\s+(.+)$/;

/**
 * One line, one candidate. Returns `{candidates}` or `{error}` with a sentence
 * naming the offending line, because a parser that just throws sends people to
 * devtools.
 */
function parseCandidates(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return { error: "候補が空です。" };
  if (lines.length > MAX_CANDIDATES) {
    return { error: `候補が ${lines.length} 件あります。1 回あたり最大 ${MAX_CANDIDATES} 件までです。` };
  }

  const candidates = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = CANDIDATE_LINE.exec(lines[i]);
    if (!m) {
      return { error: `${i + 1} 行目が読めません。\`:shortcode: 説明\` の形で書いてください: ${lines[i]}` };
    }
    const [, shortcode, description] = m;
    if (seen.has(shortcode)) return { error: `${i + 1} 行目: ${shortcode} が重複しています。` };
    seen.add(shortcode);
    candidates.push({ shortcode, description: description.trim() });
  }
  return { candidates };
}

  self.Candidates = { DEFAULT_CANDIDATES, EMOJI_GLYPHS, MAX_CANDIDATES, parseCandidates };
})();
