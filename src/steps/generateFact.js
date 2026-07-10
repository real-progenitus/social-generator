import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getTopicWeights, recentUsedFacts } from "../db.js";

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
};

// Em dashes / double hyphens read as an obvious AI tell — strip them even if
// the model ignores the system prompt instruction not to use them.
function stripEmDashes(text) {
  return text.replace(/\s*(--|—)\s*/g, ", ").replace(/,(\s*,)+/g, ",");
}

function sanitizeFact(fact) {
  return {
    ...fact,
    headline: stripEmDashes(fact.headline),
    slides: fact.slides.map(stripEmDashes),
    source_note: stripEmDashes(fact.source_note),
    caption: stripEmDashes(fact.caption),
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

function pickTopic() {
  const { topics } = JSON.parse(fs.readFileSync(topicsFile, "utf8"));
  const weights = getTopicWeights();
  const weighted = topics.map((t) => ({
    ...t,
    weight: weights[t.topic] ?? 1.0,
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

/**
 * Generate a fact + slide copy via the Claude API.
 * Returns the validated fact object (shape of FACT_SCHEMA).
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

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 16000,
    system:
      "You are the researcher-copywriter for an Instagram page that posts one well-sourced electronic music fact per day as a carousel. " +
      "The page covers four content pillars: performance moments from big names, controversial innovations in music, " +
      "culture-defining moments, and random trivia about big bands/artists, always within electronic music. " +
      "This account covers electronic music broadly, house and techno included, not just mainstream pop-EDM crossover " +
      "acts: only feature artists, venues, festivals, and events that a casual electronic music fan would already " +
      "recognize by name (think Daft Punk, Tomorrowland, Ibiza, Berghain, David Guetta, but equally Jeff Mills, " +
      "Richie Hawtin, Carl Cox — major names within house/techno culture count as big names too, not just pop chart " +
      "stars). Avoid true deep-cuts only known within one hyper-niche scene. When a topic seed names a specific act " +
      "or place, stick to that; when you have latitude to pick who or what a fact centers on, always default to the " +
      "biggest, most widely known name available within its own genre rather than a more obscure or 'cooler' choice. " +
      "You only state facts you are confident are true and documented; when unsure, choose a different, verifiable fact. " +
      "Never invent quotes, dates, or chart positions. Write for music fans: concrete, specific, no filler. " +
      "There is no fact-checking pass after this, so only propose facts that are easy to verify: well-established, " +
      "corroborated by multiple sources, and uncontroversial in their basic details. Avoid disputed statistics " +
      "(crowd sizes, sales figures), 'first ever' or superlative claims unless extremely well-documented, exact " +
      "chronological sequences you're not fully certain of, and disputed writing/production credits. If any detail " +
      "in a fact isn't something you're highly confident about, drop that detail or pick a different fact entirely " +
      "rather than stating it with false precision. " +
      "Never use em dashes or double hyphens (— or --) anywhere in the output; write with periods, commas, colons, or parentheses instead.",
    messages: [
      {
        role: "user",
        content:
          `Topic seed for today: "${topic.topic}"\n` +
          `Content pillar: ${topic.kind} — ${CONTENT_PILLARS[topic.kind]}\n\n` +
          `Produce one interesting, verifiable fact about this topic with carousel copy, matching the content pillar above.\n` +
          `If the fact is fundamentally about one artist or group, set fact_type to "artist_specific" and fill artist_name; otherwise use "generic" with artist_name null.\n\n` +
          `Already-posted facts — do NOT repeat or closely paraphrase any of these:\n${usedList}`,
      },
    ],
    output_config: { format: { type: "json_schema", schema: FACT_SCHEMA } },
  });

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content for fact generation");
  const fact = JSON.parse(text);

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
