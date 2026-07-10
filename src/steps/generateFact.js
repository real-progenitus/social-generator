import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { getTopicWeights, recentUsedFacts } from "../db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const topicsFile = path.join(here, "..", "..", "data", "topics.json");

const FACT_SCHEMA = {
  type: "object",
  properties: {
    fact_type: { type: "string", enum: ["generic", "artist_specific"] },
    artist_name: {
      type: ["string", "null"],
      description:
        "Artist or group the fact is about; null when fact_type is generic",
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
  topic: "acid house & the TB-303",
  headline: "The TB-303 was a commercial flop before it defined acid house",
  slides: [
    "Roland released the TB-303 Bass Line in 1981 as a practice tool: a bass synthesizer meant to accompany solo guitarists.",
    "It sounded nothing like a real bass guitar. Roland discontinued it in 1984 after selling only around 10,000 units, and second-hand prices collapsed.",
    "In Chicago, DJ Pierre and Spanky of Phuture picked one up cheap and twisted its resonance and cutoff knobs while a pattern played — producing the now-iconic squelch.",
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
    return MOCK_FACT;
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
      "You only state facts you are confident are true and documented; when unsure, choose a different, verifiable fact. " +
      "Never invent quotes, dates, or chart positions. Write for music fans: concrete, specific, no filler.",
    messages: [
      {
        role: "user",
        content:
          `Topic seed for today: "${topic.topic}" (${topic.kind}).\n\n` +
          `Produce one interesting, verifiable fact about this topic with carousel copy.\n` +
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
  return fact;
}
