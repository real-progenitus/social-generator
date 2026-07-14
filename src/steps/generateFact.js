import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getTopicWeights, recentUsedFacts } from "../db.js";
import { callClaude } from "../lib/claudeClient.js";

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
        "4 to 6 short text blocks for the carousel body: the fact in detail, context, why it matters. Each 1-3 sentences, standalone.",
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

function pickTopic() {
  const { topics } = JSON.parse(fs.readFileSync(topicsFile, "utf8"));
  const weights = getTopicWeights();
  const pool = [...topics, RECENT_NEWS_TOPIC];
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
};

// Real web search grounds each fact in sources at generation time, which
// replaces the old separate fact-check call — the generator can only state what
// it actually found. Supported on claude-sonnet-5 (the configured model).
// max_uses bumped from 4: the recent_news pillar needs a discovery search
// (what's trending right now) before it can even settle on a subject to
// research, the same two-phase search generateFoodContent.js budgets 6 for.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 6 };

/**
 * Generate a fact + slide copy via the Claude API, grounded in a live web
 * search. Returns the validated fact object (shape of FACT_SCHEMA).
 */
export async function generateFact() {
  if (config.mockMode) {
    console.log("[generateFact] MOCK_MODE — returning canned fact");
    return sanitizeFact(MOCK_FACT);
  }

  const topic = pickTopic();
  const used = recentUsedFacts(60);
  const usedList =
    used.length > 0
      ? used.map((f) => `- ${f.headline}`).join("\n")
      : "(none yet)";

  const response = await callClaude({
    account: config.account,
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

  if (fact.slides.length < 4 || fact.slides.length > 6) {
    throw new Error(
      `Fact validation failed: expected 4-6 slides, got ${fact.slides.length}`,
    );
  }
  if (fact.fact_type === "artist_specific" && !fact.artist_name) {
    throw new Error("Fact validation failed: artist_specific without artist_name");
  }
  return sanitizeFact(fact);
}
