import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getTopicWeights, recentUsedFacts } from "../db.js";
import { callClaude } from "../lib/claudeClient.js";
import { callDeepSeek } from "../lib/deepseekClient.js";
import { tavilySearch } from "../lib/tavilySearch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const topicsFile = path.join(here, "..", "..", "data", "topics.json");

const CONTENT_PILLARS = {
  performance_moment:
    "A specific, notable live performance or festival set: what happened on stage or in the crowd, and why it's still talked about.",
  controversial_innovation:
    "A technology, technique, or business-model innovation in electronic music that sparked real debate, backlash, or a legal fight when it appeared. Name the controversy plainly.",
  culture_defining_moment:
    "A specific event or shift that changed a scene or the culture around electronic music, and why it mattered beyond the moment itself.",
  artist_trivia:
    "A surprising, lesser-known fact about a major electronic act: something most fans of the genre wouldn't already know.",
  recent_news:
    "Something genuinely happening in electronic music right now, not history: a fresh festival lineup or set " +
    "announcement, a viral clip or moment, a new release or collab making noise, a chart shift, or breaking artist " +
    "news/controversy from the last few weeks.",
};

// Em dashes / double hyphens read as an obvious AI tell — strip them even if
// the model ignores the system prompt instruction not to use them.
function stripEmDashes(text) {
  return text.replace(/\s*(--|—)\s*/g, ", ").replace(/,(\s*,)+/g, ",");
}

// The model sometimes double-escapes non-ASCII characters in the JSON string
// output: it writes a backslash-escaped unicode sequence as literal text
// inside the string value, rather than an actual accented character, so
// JSON.parse leaves the raw six-character escape sequence behind instead of
// decoding it (e.g. "Hutter" ends up followed by a literal backslash-u
// sequence rather than becoming "Hütter"). Decode any leftover escapes.
function unescapeUnicode(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function clean(text) {
  return stripEmDashes(unescapeUnicode(text));
}

function sanitizeFact(fact) {
  return {
    ...fact,
    artist_name: fact.artist_name ? unescapeUnicode(fact.artist_name) : fact.artist_name,
    image_subject: fact.image_subject ? unescapeUnicode(fact.image_subject) : fact.image_subject,
    topic: unescapeUnicode(fact.topic),
    headline: clean(fact.headline),
    slides: fact.slides.map(clean),
    source_note: clean(fact.source_note),
    caption: clean(fact.caption),
    image_mood: clean(fact.image_mood),
    cover_subject: fact.cover_subject ? clean(fact.cover_subject) : fact.cover_subject,
  };
}

const FACT_SCHEMA = {
  type: "object",
  properties: {
    fact_type: { type: "string", enum: ["generic", "artist_specific"] },
    artist_name: {
      type: ["string", "null"],
      description:
        "Artist or group the fact is about; null when fact_type is generic",
    },
    image_subject: {
      type: ["string", "null"],
      description:
        "The single most recognizable real, photographable subject for this fact's cover image: an artist/group name, " +
        "a specific venue (e.g. 'Berghain'), or a specific festival (e.g. 'Tomorrowland'). Use the proper name as it'd " +
        "appear in a photo caption. Null only if the fact is about an abstract concept, technology, or trend with no " +
        "single real-world subject to photograph.",
    },
    topic: { type: "string", description: "The topic seed this fact expands" },
    headline: {
      type: "string",
      description:
        "Cover slide hook, max ~90 characters, punchy and factual — no clickbait exaggeration",
    },
    slides: {
      type: "array",
      items: { type: "string" },
      description:
        "4 to 6 short text blocks for the carousel body: the fact in detail, context, why it matters. " +
        "Each block is 1-2 short sentences and MUST be at most ~200 characters — they render on a fixed " +
        "card and longer text gets cut off. Standalone, no filler.",
    },
    source_note: {
      type: "string",
      description:
        "Brief factual grounding: where this is documented (interview, book, chart archive, label history). Not a URL.",
    },
    caption: {
      type: "string",
      description:
        "Instagram caption: 1-2 sentences summarizing the fact plus 5-8 relevant hashtags",
    },
    image_mood: {
      type: "string",
      description:
        "10-20 words describing the emotional tone/atmosphere this specific fact evokes (e.g. rebellious and " +
        "underground, euphoric and packed, tense and controversial, nostalgic and gritty), for briefing an AI photo " +
        "generator when no real photo of the subject is available. Describe mood, era, and energy only: no artist, " +
        "venue, festival, or song names, and no other proper nouns.",
    },
    cover_subject: {
      type: "string",
      description:
        "A specific, iconic, photographable close-up subject for the cover image that represents THIS fact, described " +
        "generically WITHOUT proper nouns and WITHOUT any recognizable real person's face. Prefer one concrete object, " +
        "instrument, or piece of gear tied to the fact (e.g. 'a vintage silver bass synthesizer with chrome knobs', " +
        "'a DJ's hand on a CDJ jog wheel under blue light', 'a stack of worn vinyl records', 'a smoke-filled beam of " +
        "club light over a dark dancefloor'). Anonymous crowds, hands, or silhouettes are fine; never a real person's " +
        "face or likeness, no logos, no text. 5-15 words.",
    },
  },
  required: [
    "fact_type",
    "artist_name",
    "image_subject",
    "topic",
    "headline",
    "slides",
    "source_note",
    "caption",
    "image_mood",
    "cover_subject",
  ],
  additionalProperties: false,
};

// Unlike the 139 fixed seeds in topics.json, this isn't a specific topic
// string to research — it tells generateFact() to search live for whatever's
// actually happening right now, the same open-discovery approach
// generateFoodContent.js uses instead of a seed list. Its base weight is
// deliberately not 1.0: with 139 individual seeds each weighted 1.0, a weight
// of 1.0 would make this whole pillar ~139x less likely to come up than a
// single seed. 34.75 against a weight-139 pool of seeds gives it ~20% of runs.
const RECENT_NEWS_TOPIC = { topic: "recent_news", kind: "recent_news" };
const RECENT_NEWS_BASE_WEIGHT = 34.75;

function pickTopic({ excludeRecentNews = false } = {}) {
  const { topics } = JSON.parse(fs.readFileSync(topicsFile, "utf8"));
  const weights = getTopicWeights();
  const pool = excludeRecentNews ? [...topics] : [...topics, RECENT_NEWS_TOPIC];
  const weighted = pool.map((t) => ({
    ...t,
    weight: weights[t.topic] ?? (t.kind === "recent_news" ? RECENT_NEWS_BASE_WEIGHT : 1.0),
  }));
  const total = weighted.reduce((sum, t) => sum + t.weight, 0);
  let roll = Math.random() * total;
  for (const t of weighted) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return weighted[weighted.length - 1];
}

const MOCK_FACT = {
  fact_type: "generic",
  artist_name: null,
  image_subject: "Roland TB-303",
  topic: "acid house & the TB-303",
  headline: "The TB-303 was a commercial flop before it defined acid house",
  slides: [
    "Roland released the TB-303 Bass Line in 1981 as a practice tool: a bass synthesizer meant to accompany solo guitarists.",
    "It sounded nothing like a real bass guitar. Roland discontinued it in 1984 after selling only around 10,000 units, and second-hand prices collapsed.",
    "In Chicago, DJ Pierre and Spanky of Phuture picked one up cheap and twisted its resonance and cutoff knobs while a pattern played, producing the now-iconic squelch.",
    "The result, 'Acid Tracks' (1987), is widely credited as the first acid house record, and the 303's sound spread from Chicago to the UK rave scene.",
    "Today original TB-303 units sell for thousands, and its sound has been cloned in dozens of hardware and software instruments.",
  ],
  source_note:
    "Documented in interviews with DJ Pierre and Roland's own company history of the TB-303.",
  caption:
    "The bass synth nobody wanted became the sound of a genre. 🎛️ #acidhouse #tb303 #electronicmusic #housemusic #musichistory #synth #chicagohouse",
  image_mood: "gritty, underground, DIY ingenuity, a cheap discarded machine turned cult weapon",
  cover_subject: "a vintage silver bass synthesizer with small chrome knobs on a dim studio surface",
};

// Real web search grounds each fact in sources at generation time, which
// replaces the old separate fact-check call — the generator can only state what
// it actually found. Supported on claude-sonnet-5 (the configured model).
// max_uses bumped from 4: the recent_news pillar needs a discovery search
// (what's trending right now) before it can even settle on a subject to
// research, the same two-phase search generateFoodContent.js budgets 6 for.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 6 };

/**
 * Claude + live web_search fact generation — the original, most-grounded path,
 * and the fallback when a cheaper path fails. Returns the validated fact
 * (shape of FACT_SCHEMA), tagged with its generation method.
 */
async function generateFactViaClaude(topic, usedList) {
  const response = await callClaude({
    account: config.accountLabel,
    operation: "generateFact",
    search: true,
    model: config.claudeModel,
    max_tokens: 16000,
    tools: [WEB_SEARCH_TOOL],
    system:
      "You are the researcher-copywriter for an Instagram page that posts one well-sourced electronic music fact per day as a carousel. " +
      "The page covers five content pillars: performance moments from big names, controversial innovations in music, " +
      "culture-defining moments, random trivia about big bands/artists, and what's happening right now in the scene, " +
      "always within electronic music. " +
      "This account covers electronic music broadly, house and techno included, not just mainstream pop-EDM crossover " +
      "acts: only feature artists, venues, festivals, and events that a casual electronic music fan would already " +
      "recognize by name (think Daft Punk, Tomorrowland, Ibiza, Berghain, David Guetta, but equally Jeff Mills, " +
      "Richie Hawtin, Carl Cox — major names within house/techno culture count too, not just pop chart stars). " +
      "Avoid true deep-cuts only known within one hyper-niche scene. When a topic seed names a specific act or place, " +
      "stick to that; otherwise default to the biggest, most widely known name available within its own genre. " +
      "You have a web_search tool. You MUST search the web before writing, and base every claim strictly on what the " +
      "sources you find actually say. Do not state specifics (dates, numbers, names, 'firsts', reactions) from memory: " +
      "verify each against search results, and if the sources don't clearly support a detail, drop it or pick a " +
      "different fact. Prefer facts corroborated by multiple reputable sources (Wikipedia, Resident Advisor, Mixmag, " +
      "DJ Mag, Pitchfork, Billboard, official artist or label pages). " +
      "Keep the post to ONE core, well-established fact; every slide should restate or expand that fact or add " +
      "widely-known context, not introduce extra shaky specifics. Avoid superlatives and 'first ever' claims unless the " +
      "sources state them plainly. Do not attribute quotes or reactions to named people unless a source shows it. Do " +
      "not mischaracterize things (e.g. calling an indie label a 'major label'). " +
      "In source_note, name the actual sources you verified against (e.g. 'Wikipedia and Resident Advisor coverage'), not a vague claim. " +
      "Never invent quotes, dates, or chart positions. Write for music fans: concrete, specific, no filler. " +
      "Never use em dashes or double hyphens (— or --) anywhere in the output; write with periods, commas, colons, or parentheses instead.",
    messages: [
      {
        role: "user",
        content:
          (topic.kind === "recent_news"
            ? `Content pillar: recent_news — ${CONTENT_PILLARS.recent_news}\n\n` +
              "First, search the web for what's genuinely happening in electronic music right now (the last few " +
              "weeks): festival lineup or set announcements, viral clips/moments, new releases or collabs making " +
              "noise, chart shifts, breaking artist news. Do not rely on memory for what's current. Pick the single " +
              "most compelling story you find.\n\n"
            : `Topic seed for today: "${topic.topic}"\n` +
              `Content pillar: ${topic.kind} — ${CONTENT_PILLARS[topic.kind]}\n\n`) +
          `Search the web to research this topic, then produce one interesting, verifiable fact with carousel copy, matching the content pillar above. Base every claim on the sources you find.\n` +
          `If the fact is fundamentally about one artist or group, set fact_type to "artist_specific" and fill artist_name; otherwise use "generic" with artist_name null.\n\n` +
          `Already-posted facts — do NOT repeat or closely paraphrase any of these:\n${usedList}`,
      },
    ],
    output_config: {
      format: { type: "json_schema", schema: FACT_SCHEMA },
      effort: "medium",
    },
  });

  // With structured output the final answer is one JSON text block; take the
  // last text block (earlier ones, if any, are intermediate search reasoning).
  const textBlocks = response.content.filter((b) => b.type === "text");
  const text = textBlocks[textBlocks.length - 1]?.text;
  if (!text) throw new Error("Claude returned no text content for fact generation");
  const fact = JSON.parse(text);
  // Bucket by pillar, not by the live-discovered story (which is different
  // every run) — same reasoning as generateFoodContent.js's content-type
  // bucketing: analytics.js's engagement feedback loop needs a stable key to
  // nudge, and "recent_news" is that key regardless of which story ran today.
  if (topic.kind === "recent_news") fact.topic = "recent_news";

  validateFact(fact);
  return tagFact(sanitizeFact(fact), "web_search_grounded");
}

// ---------------------------------------------------------------------------
// DeepSeek paths. Historical pillars can be written from the model's own
// training knowledge (no live search — far cheaper, and a test of whether the
// search loop is what manufactures disputed facts). The recent_news pillar
// can't: DeepSeek's training cutoff means "the last few weeks" must come from a
// live search, so it's grounded with Tavily results instead. Both emit the
// FACT_SCHEMA shape via JSON mode — which has no schema enforcement, so the
// shape is described in the prompt and validated after parse.
// ---------------------------------------------------------------------------

// Mirror of the persona paragraph in generateFactViaClaude's system prompt —
// keep the two in sync so both A/B arms target the same voice and scope.
const PERSONA =
  "You are the researcher-copywriter for an Instagram page that posts one well-sourced electronic music fact per day as a carousel. " +
  "The page covers five content pillars: performance moments from big names, controversial innovations in music, " +
  "culture-defining moments, random trivia about big bands/artists, and what's happening right now in the scene, " +
  "always within electronic music. " +
  "This account covers electronic music broadly, house and techno included, not just mainstream pop-EDM crossover " +
  "acts: only feature artists, venues, festivals, and events that a casual electronic music fan would already " +
  "recognize by name (think Daft Punk, Tomorrowland, Ibiza, Berghain, David Guetta, but equally Jeff Mills, " +
  "Richie Hawtin, Carl Cox, major names within house/techno culture count too, not just pop chart stars). " +
  "Avoid true deep-cuts only known within one hyper-niche scene. When a topic seed names a specific act or place, " +
  "stick to that; otherwise default to the biggest, most widely known name available within its own genre. ";

// Shared closing rules for the DeepSeek arms — equivalent to the Claude arm's,
// minus the web_search-specific verification language.
const WRITING_RULES =
  "Keep the post to ONE core, well-established fact; every slide should restate or expand that fact or add " +
  "widely-known context, not introduce extra shaky specifics. Avoid superlatives and 'first ever' claims unless they " +
  "are firmly established. Do not attribute quotes or reactions to named people unless it is well-documented. Do not " +
  "mischaracterize things (e.g. calling an indie label a 'major label'). " +
  "Never invent quotes, dates, or chart positions. Write for music fans: concrete, specific, no filler. " +
  "Never use em dashes or double hyphens anywhere in the output; write with periods, commas, colons, or parentheses instead. ";

// JSON mode has no schema enforcement, so the exact shape (mirrors FACT_SCHEMA)
// is spelled out here; the word "json" must appear for response_format to work.
const JSON_SHAPE_INSTRUCTION =
  "Respond with a single valid json object and nothing else (no markdown, no code fences), with exactly these keys: " +
  "fact_type ('generic' or 'artist_specific'); " +
  "artist_name (the artist or group the fact is about, or null when generic); " +
  "image_subject (the single most recognizable real, photographable subject: an artist/group name, a specific venue " +
  "like 'Berghain', or a festival like 'Tomorrowland'; null if the fact has no single real-world subject to photograph); " +
  "topic (the topic seed this fact expands); " +
  "headline (cover hook, max ~90 characters, punchy and factual, no clickbait); " +
  "slides (an array of 4 to 6 short strings; each 1-2 short sentences, standalone, and AT MOST ~200 characters " +
  "because they render on a fixed card and longer text is cut off: the fact in detail, context, why it matters); " +
  "source_note (brief factual grounding, the kind of documentation this is known from, not a URL); " +
  "caption (Instagram caption: 1-2 sentences summarizing the fact plus 5-8 relevant hashtags); " +
  "image_mood (10-20 words on emotional tone/atmosphere: mood, era, and energy only, with no artist, venue, festival, or song names and no other proper nouns); " +
  "cover_subject (5-15 words naming one specific, iconic, photographable close-up subject for the cover that represents this fact, described " +
  "generically with NO proper nouns and NO recognizable real person's face: a concrete object/instrument/gear tied to the fact, e.g. 'a vintage " +
  "silver bass synthesizer with chrome knobs' or 'a DJ's hand on a CDJ jog wheel'; anonymous crowds/hands/silhouettes are fine; no logos, no text).";

const DEEPSEEK_KNOWLEDGE_RULES =
  "Write from your own well-established knowledge; do not claim to have searched the web. Base every claim on widely " +
  "documented facts you are highly confident are correct. Do not state shaky specifics (exact dates, numbers, 'firsts', " +
  "quotes, chart positions) unless you are certain of them: if unsure, omit the detail, generalize it, or choose a " +
  "different fact you are sure of. In source_note, name the kind of documentation this is known from (e.g. 'interviews " +
  "and label history', 'contemporary press coverage'). ";

/**
 * DeepSeek knowledge-only fact generation for a historical pillar. Cheap, no
 * live search. Returns the validated, method-tagged fact.
 */
async function generateFactViaDeepSeek(topic, usedList, note) {
  const text = await callDeepSeek({
    account: config.accountLabel,
    operation: "generateFact",
    model: config.deepseekModel,
    jsonMode: true,
    maxTokens: 4000,
    system: PERSONA + DEEPSEEK_KNOWLEDGE_RULES + WRITING_RULES + JSON_SHAPE_INSTRUCTION,
    user:
      `Topic seed for today: "${topic.topic}"\n` +
      `Content pillar: ${topic.kind} — ${CONTENT_PILLARS[topic.kind]}\n\n` +
      "Produce one interesting, well-established, verifiable fact with carousel copy, matching the content pillar above.\n" +
      'If the fact is fundamentally about one artist or group, set fact_type to "artist_specific" and fill artist_name; otherwise use "generic" with artist_name null.\n\n' +
      `Already-posted facts, do NOT repeat or closely paraphrase any of these:\n${usedList}`,
  });

  const fact = parseFactJson(text);
  validateFact(fact);
  return tagFact(sanitizeFact(fact), "deepseek_knowledge", note);
}

const DEEPSEEK_NEWS_RULES =
  "You are given the results of a live web search for what is happening in electronic music right now. Base every claim " +
  "strictly on what these search results actually say; do not use your own memory for what is current, and do not add " +
  "specifics the results do not support. Choose the single most compelling, clearly-supported CURRENT story that is " +
  "genuinely about electronic music (house, techno, EDM, drum & bass, trance, electronic artists/festivals/labels) and " +
  "whose main subject or artist does NOT appear in the already-posted list below. A story counts as already-covered if " +
  "its main subject or artist matches one already posted, EVEN IF the wording, headline, or angle differs, so never " +
  "re-post or re-angle an already-covered story. Ignore results about pop, rock, hip-hop, or non-music topics. If every " +
  'fresh, on-genre result is already covered (or there are none), respond with EXACTLY {"no_fresh_story": true} and ' +
  "nothing else. Otherwise, in source_note, name the kind of outlets reporting it (e.g. 'as reported by DJ Mag and " +
  "Resident Advisor'), not a URL. ";

// Default outlet whitelist for the recent_news search — keeps results on
// electronic-music press so off-topic hits (local news, food festivals) don't
// surface. Override per-deploy with TAVILY_INCLUDE_DOMAINS. billboard.com stays
// in as a hedge so a big story covered only by mainstream press isn't missed.
const RECENT_NEWS_DOMAINS = [
  "residentadvisor.net",
  "ra.co",
  "mixmag.net",
  "djmag.com",
  "pitchfork.com",
  "factmag.com",
  "xlr8r.com",
  "dancingastronaut.com",
  "edm.com",
  "6amgroup.com",
  "beatportal.com",
  "billboard.com",
];

// Rotated per run so back-to-back recent_news posts don't keep surfacing the
// same dominant story — EDM breaking-news supply is thin, so varying the angle
// widens the candidate pool.
const RECENT_NEWS_QUERIES = [
  "latest electronic music news: festival lineups and set announcements",
  "new electronic music releases, singles, albums and collaborations this week",
  "techno and house scene news: DJs, clubs, labels, controversy",
  "electronic dance music (EDM) artist news and interviews",
  "drum and bass, trance, and underground electronic music news",
  "electronic music breaking news and viral moments right now",
];

// Thrown when Tavily returns nothing usable or DeepSeek reports no fresh,
// not-already-covered electronic-music story — the dispatcher then falls back
// to an evergreen fact rather than repeating a stale one.
class NoFreshNews extends Error {
  constructor() {
    super("no fresh electronic-music news found");
    this.name = "NoFreshNews";
  }
}

// Deterministic backstop for the soft dedup instruction: treat a news fact as a
// repeat if its artist/subject matches an already-posted one, or its headline
// strongly overlaps — so a reworded version of the same story falls through to
// the evergreen fallback instead of being posted again.
const normText = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function headlineOverlap(a, b) {
  const wa = new Set(normText(a).split(" ").filter((w) => w.length > 3));
  const wb = new Set(normText(b).split(" ").filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

function isDuplicateOfUsed(fact, usedFacts) {
  const artist = normText(fact.artist_name);
  return usedFacts.some(
    (u) => (artist && artist === normText(u.artist_name)) || headlineOverlap(fact.headline, u.headline) >= 0.5,
  );
}

// DeepSeek sometimes phrases "there's no news" as a normal fact object instead
// of the {"no_fresh_story": true} sentinel, producing a degenerate post. Catch
// those in code so they route to the evergreen fallback, not the carousel.
const NO_NEWS_PATTERNS = [
  /\bno (fresh|recent|relevant|new|current|electronic|edm)\b[^.]*\b(news|stor(?:y|ies)|results|found|available)\b/i,
  /\b(couldn'?t|could not|unable to|failed to)\s+(find|identify|locate)\b/i,
  /\bsearch results?\b[^.]*\b(no|not|didn'?t|did not|empty)\b/i,
];
function looksLikeNoNews(fact) {
  const blob = `${fact.headline ?? ""} ${(fact.slides ?? []).join(" ")}`;
  return NO_NEWS_PATTERNS.some((re) => re.test(blob));
}

/**
 * recent_news fact generation, grounded in a live Tavily news search and
 * written by DeepSeek. Replaces Claude's web_search for this pillar. Throws
 * NoFreshNews when there's no new, on-genre story to post.
 */
async function generateRecentNewsViaTavily(usedList, usedFacts = []) {
  const query = RECENT_NEWS_QUERIES[Math.floor(Math.random() * RECENT_NEWS_QUERIES.length)];
  console.log(`[generateFact] recent_news query: "${query}"`);
  const { answer, results } = await tavilySearch({
    account: config.accountLabel,
    operation: "recentNewsSearch",
    query,
    topic: "news",
    days: 14,
    maxResults: 10,
    includeDomains: config.tavilyIncludeDomains.length ? config.tavilyIncludeDomains : RECENT_NEWS_DOMAINS,
  });
  if (results.length === 0) throw new NoFreshNews();

  const sources =
    (answer ? `Search summary: ${answer}\n\n` : "") +
    results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join("\n\n");

  const text = await callDeepSeek({
    account: config.accountLabel,
    operation: "generateFact",
    model: config.deepseekModel,
    jsonMode: true,
    maxTokens: 4000,
    system: PERSONA + DEEPSEEK_NEWS_RULES + WRITING_RULES + JSON_SHAPE_INSTRUCTION,
    user:
      `Content pillar: recent_news — ${CONTENT_PILLARS.recent_news}\n\n` +
      `Live search results (most recent electronic music news):\n${sources}\n\n` +
      "Write one post about the single most compelling, clearly-supported current ELECTRONIC-MUSIC story from these results, with carousel copy.\n" +
      'Set fact_type to "artist_specific" with artist_name if the story centers on one act, otherwise "generic" with artist_name null.\n\n' +
      "Already-posted facts (main subject in parentheses). Pick a story whose main subject is NOT among these; if every " +
      'fresh result is already here, output {"no_fresh_story": true}:\n' +
      usedList,
  });

  const parsed = parseFactJson(text);
  if (parsed.no_fresh_story || looksLikeNoNews(parsed)) throw new NoFreshNews();
  parsed.topic = "recent_news"; // stable pillar key for analytics, as in the Claude path
  validateFact(parsed);
  // Deterministic backstop: if DeepSeek re-picked an already-covered subject
  // despite the instruction, treat it as no-fresh-news.
  if (isDuplicateOfUsed(parsed, usedFacts)) throw new NoFreshNews();
  return tagFact(sanitizeFact(parsed), "tavily_news_deepseek");
}

// JSON mode should return bare JSON, but strip stray code fences defensively.
function parseFactJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function validateFact(fact) {
  if (!Array.isArray(fact.slides) || fact.slides.length < 4 || fact.slides.length > 6) {
    throw new Error(`Fact validation failed: expected 4-6 slides, got ${fact.slides?.length}`);
  }
  if (fact.fact_type === "artist_specific" && !fact.artist_name) {
    throw new Error("Fact validation failed: artist_specific without artist_name");
  }
}

// Tag the generation method so pipeline.js persists it to fact_check_json and
// the dashboard/analytics can tell the A/B arms apart. The extra key rides
// harmlessly in fact_json; renderers read only the known fields.
function tagFact(fact, method, note) {
  return { ...fact, fact_check: note ? { method, note } : { method } };
}

/**
 * Music-account content entry point. `flow` (from the Telegram /generate picker)
 * forces a path; omitted/"auto" uses the default A/B dispatch:
 *   - recent_news  → always Tavily+DeepSeek
 *   - "deepseek"   → DeepSeek knowledge on a historical pillar
 *   - "claude"     → Claude web_search on a historical pillar
 *   - auto         → recent_news→Tavily; historical split by config.deepseekShare
 * The DeepSeek/Tavily paths fall back to Claude on any error, so a run never
 * fails to produce a post.
 */
export async function generateFact({ flow } = {}) {
  if (config.mockMode) {
    console.log("[generateFact] MOCK_MODE — returning canned fact");
    return tagFact(sanitizeFact(MOCK_FACT), "mock");
  }

  const used = recentUsedFacts(60);
  const usedList =
    used.length > 0
      ? used.map((f) => `- ${f.headline}${f.artist_name ? ` (${f.artist_name})` : ""}`).join("\n")
      : "(none yet)";

  // Fall back to the (always-available) Claude web_search path if a cheaper
  // path throws; `topic` is what that fallback should research.
  const withClaudeFallback = async (topic, label, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[generateFact] ${label} failed (${err.message}); falling back to Claude web_search`);
      return generateFactViaClaude(topic, usedList);
    }
  };

  // recent_news, with a graceful fallback: no fresh on-genre story => an
  // evergreen DeepSeek fact (tagged so the approval message says so); a hard
  // Tavily/DeepSeek failure => the always-available Claude web_search path.
  const recentNews = async () => {
    try {
      return await generateRecentNewsViaTavily(usedList, used);
    } catch (err) {
      const note =
        err.name === "NoFreshNews"
          ? "no fresh news today — evergreen fact"
          : "recent-news generation failed — evergreen fact";
      console.warn(`[generateFact] recent_news (${err.message}); evergreen DeepSeek fallback`);
      const t = pickTopic({ excludeRecentNews: true });
      return withClaudeFallback(t, "evergreen DeepSeek (news fallback)", () =>
        generateFactViaDeepSeek(t, usedList, note),
      );
    }
  };

  // Explicit flow from the Telegram picker overrides the A/B split.
  if (flow === "recent_news") {
    return recentNews();
  }
  if (flow === "deepseek") {
    const topic = pickTopic({ excludeRecentNews: true });
    console.log(`[generateFact] forced DeepSeek (${config.deepseekModel}) for "${topic.topic}"`);
    return withClaudeFallback(topic, "DeepSeek knowledge path", () => generateFactViaDeepSeek(topic, usedList));
  }
  if (flow === "claude") {
    const topic = pickTopic({ excludeRecentNews: true });
    console.log(`[generateFact] forced Claude web_search for "${topic.topic}"`);
    return generateFactViaClaude(topic, usedList);
  }

  // Default: auto A/B dispatch.
  const topic = pickTopic();
  if (topic.kind === "recent_news") {
    return recentNews();
  }
  if (Math.random() < config.deepseekShare) {
    console.log(`[generateFact] routing "${topic.topic}" to DeepSeek (${config.deepseekModel})`);
    return withClaudeFallback(topic, "DeepSeek knowledge path", () => generateFactViaDeepSeek(topic, usedList));
  }
  console.log(`[generateFact] routing "${topic.topic}" to Claude web_search`);
  return generateFactViaClaude(topic, usedList);
}
