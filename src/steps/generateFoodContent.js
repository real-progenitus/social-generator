import { config } from "../config.js";
import { getTopicWeights, recentUsedFacts } from "../db.js";
import { callDeepSeekWithRetry } from "../lib/deepseekClient.js";

// Em dashes / double hyphens read as an obvious AI tell — strip them even if
// the model ignores the system prompt instruction not to use them.
function stripEmDashes(text) {
  return text.replace(/\s*(--|—)\s*/g, ", ").replace(/,(\s*,)+/g, ",");
}

// See generateFact.js for why this exists: the model sometimes leaves a
// literal backslash-u escape sequence in a JSON string value instead of the
// decoded character.
function unescapeUnicode(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function clean(text) {
  return stripEmDashes(unescapeUnicode(text));
}

// review.js reads fact.fact_type/fact.artist_name directly, and
// generateFoodCover.js reads fact.image_subject — both aliased to dish_name so
// the shared review/cover code needs no food-specific branching.
function sanitizeFood(fact) {
  const dish = unescapeUnicode(fact.dish_name);
  const base = {
    ...fact,
    dish_name: dish,
    artist_name: dish,
    image_subject: dish,
    headline: clean(fact.headline),
    source_note: clean(fact.source_note),
    caption: clean(fact.caption),
  };
  return fact.fact_type === "recipe"
    ? { ...base, ingredients: fact.ingredients.map(clean), steps: fact.steps.map(clean), health_note: clean(fact.health_note) }
    : { ...base, slides: fact.slides.map(clean) };
}

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    fact_type: { type: "string", enum: ["recipe"] },
    topic: { type: "string", enum: ["recipe"] },
    headline: { type: "string", description: "Cover slide hook, max ~90 characters, appetizing, no clickbait" },
    dish_name: {
      type: "string",
      description: "The exact dish name as it'd appear on a menu, e.g. 'Miso-Glazed Salmon Grain Bowl'.",
    },
    trend_source: {
      type: "string",
      description:
        "One sentence for the human reviewer on why this pick works: what makes it a reliably popular, well-loved " +
        "choice. Not shown on the slides.",
    },
    servings: { type: "string", description: "e.g. '2 servings'" },
    prep_time: { type: "string", description: "e.g. '10 min'" },
    cook_time: { type: "string", description: "e.g. '20 min'" },
    ingredients: {
      type: "array",
      items: { type: "string" },
      description: "6 to 10 ingredient lines with quantities, e.g. '1 cup rolled oats'. HARD CAP: never output more than 10 — simplify or combine rather than exceed it.",
    },
    steps: {
      type: "array",
      items: { type: "string" },
      description: "4 to 8 short numbered instructions, each 1-2 sentences, real food-safe technique. HARD CAP: never output more than 8.",
    },
    health_note: {
      type: "string",
      description: "1-2 sentence why-it's-healthy blurb (fiber/protein/micronutrients). No medical or cure claims.",
    },
    source_note: {
      type: "string",
      description: "What grounds this as sound: the technique basis and any nutrition claim's source.",
    },
    caption: {
      type: "string",
      description: "Instagram caption: 1-2 sentences plus 5-8 relevant hashtags",
    },
  },
  required: [
    "fact_type",
    "topic",
    "headline",
    "dish_name",
    "trend_source",
    "servings",
    "prep_time",
    "cook_time",
    "ingredients",
    "steps",
    "health_note",
    "source_note",
    "caption",
  ],
  additionalProperties: false,
};

const TRIVIA_SCHEMA = {
  type: "object",
  properties: {
    fact_type: { type: "string", enum: ["trivia"] },
    topic: { type: "string", enum: ["trivia"] },
    headline: { type: "string", description: "Cover slide hook, max ~90 characters" },
    dish_name: {
      type: "string",
      description: "The specific food, ingredient, or dish the trivia is about, e.g. 'Kimchi', 'Avocado Toast'.",
    },
    trend_source: {
      type: "string",
      description:
        "One sentence for the human reviewer on why this is a reliably well-loved, well-documented fact. " +
        "Not shown on-slide.",
    },
    slides: {
      type: "array",
      items: { type: "string" },
      description: "2 to 3 short text blocks for the carousel body, each 1-3 sentences, standalone. HARD CAP: never output more than 3. Keep it tight — pick the single most surprising angle rather than a long list of facts.",
    },
    source_note: {
      type: "string",
      description:
        "Where this is documented: nutrition-science source, food-history reference, or reputable food publication.",
    },
    caption: {
      type: "string",
      description: "Instagram caption: 1-2 sentences plus 5-8 relevant hashtags",
    },
  },
  required: ["fact_type", "topic", "headline", "dish_name", "trend_source", "slides", "source_note", "caption"],
  additionalProperties: false,
};

// Recipe-primary mix, nudged over time by analytics.js's existing engagement
// feedback loop. Keyed on the coarse content-type bucket rather than the
// live-discovered dish name: a freshly-discovered topic is different every
// run, so weighting by that string would never repeat and the feedback loop
// would be inert. Bucketing lets analytics.js learn recipe-vs-trivia
// preference for free, with zero changes to that file.
function pickContentType() {
  const base = { recipe: 1.6, trivia: 1.0 };
  const weights = getTopicWeights();
  const options = Object.keys(base).map((type) => ({ type, weight: weights[type] ?? base[type] }));
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = Math.random() * total;
  for (const o of options) {
    roll -= o.weight;
    if (roll <= 0) return o.type;
  }
  return options[options.length - 1].type;
}

const MOCK_RECIPE = {
  fact_type: "recipe",
  topic: "recipe",
  headline: "This 10-minute cottage cheese bowl is the protein hack going viral right now",
  dish_name: "High-Protein Cottage Cheese Berry Bowl",
  trend_source: "Cottage cheese breakfast bowls are trending across food media as a high-protein, low-effort swap for yogurt.",
  servings: "1 serving",
  prep_time: "10 min",
  cook_time: "0 min",
  ingredients: [
    "1 cup full-fat cottage cheese",
    "1/2 cup mixed berries",
    "1 tbsp honey",
    "1 tbsp hemp seeds",
    "2 tbsp sliced almonds",
    "1/4 tsp cinnamon",
  ],
  steps: [
    "Spoon the cottage cheese into a bowl and smooth the top.",
    "Scatter the berries, almonds, and hemp seeds over it.",
    "Drizzle with honey and dust with cinnamon.",
    "Serve immediately while the cottage cheese is cold.",
  ],
  health_note: "Cottage cheese packs roughly 25g of protein per cup, and the berries add fiber and antioxidants without much added sugar.",
  source_note: "Standard nutrition values for full-fat cottage cheese and mixed berries (USDA FoodData Central).",
  caption: "Ten minutes, one bowl, 25+ grams of protein before 9am. 🍓 #cottagecheese #highprotein #healthyrecipes #proteinbowl #easybreakfast #mealprep",
};

const MOCK_TRIVIA = {
  fact_type: "trivia",
  topic: "trivia",
  headline: "Kimchi wasn't always red, and it wasn't always spicy",
  dish_name: "Kimchi",
  trend_source: "Fermented foods and gut-health content are consistently trending across food and wellness media.",
  slides: [
    "Kimchi has been made in Korea for over a thousand years, but for most of that history it had no chili in it at all.",
    "Chili peppers only arrived in Korea in the 16th and 17th centuries, brought by Portuguese and Japanese traders. Before that, kimchi was a salted, non-spicy pickle closer to today's baek-kimchi (white kimchi).",
    "Modern kimchi is also a genuinely rich source of live probiotic cultures from its lacto-fermentation process, not just a flavor condiment.",
  ],
  source_note: "Korean food history references and USDA/nutrition-science coverage of fermented vegetable probiotics.",
  caption: "Kimchi went red less than 300 years ago. 🌶️ #kimchi #fermentedfoods #foodhistory #guthealth #koreanfood #probiotics",
};

// Applies to both content types — the writing rules don't depend on whether
// the post is a recipe or a trivia fact.
const FOOD_WRITING_RULES =
  "For a RECIPE post: keep it realistically healthy — whole-food ingredients, balanced macronutrients, no fad-diet " +
  "or medical claims ('cures', 'treats', 'detoxes'). Write the ingredient list and steps in your own words and your " +
  "own structure; do not copy another source's recipe text verbatim even when the idea came from a specific blogger " +
  "or publication. Steps must reflect real, food-safe technique (correct temperatures/times for meat, fish, eggs).\n\n" +
  "For a TRIVIA post: base every claim on what you're confident is well established — verify dates, numbers, and " +
  "'firsts' against what you're sure is true, and drop or soften anything not clearly supported. Never invent " +
  "statistics, quotes, or studies.\n\n" +
  "Write for a food-curious, health-conscious audience: concrete, appetizing, no filler. Keep carousels short and " +
  "punchy rather than exhaustive — a tight 3-4 slide read outperforms a long one. Never use em dashes or double " +
  "hyphens (— or --) anywhere in the output; use periods, commas, colons, or parentheses instead.";

// The only arm since 2026-08-21. Healthy recipes and food trivia are mostly
// evergreen (unlike bass_vault's recent_news pillar), so nothing here needs
// same-day freshness — which is why the old FOOD_SEARCH_SHARE web-search arm
// was dropped with the move off Claude rather than rebuilt on Tavily.
const FOOD_SYSTEM_PROMPT_KNOWLEDGE =
  "You are the recipe developer and food-trivia writer for a health-conscious Instagram foodie page. Write from your " +
  "own well-established knowledge of healthy eating and food culture: a reliably popular recipe style or a widely " +
  "documented food fact, not something you need to verify against today's news. Do not claim to have searched the " +
  "web or to be reporting something breaking right now — evergreen and well-loved beats unverified and 'trending'. " +
  "If you're not confident a specific claim (a date, a number, a 'first') is well established, soften it or drop it " +
  "rather than guessing.\n\n" + FOOD_WRITING_RULES;

// DeepSeek's json_object mode has no schema enforcement, so the shape has to be
// spelled out in the prompt. Rendering it from the same schema object keeps the
// two from drifting: generateFact.js hand-writes its equivalent, which is fine
// for one fixed shape but would mean maintaining two long parallel strings here
// (recipe and trivia). The word "json" must appear for response_format to work.
function schemaShapeInstruction(schema) {
  const lines = Object.entries(schema.properties).map(([key, spec]) => {
    const fixed = spec.enum ? ` (exactly "${spec.enum[0]}")` : "";
    const arr = spec.type === "array" ? " (array of strings)" : "";
    return `- ${key}${fixed}${arr}: ${spec.description ?? ""}`.trimEnd();
  });
  return (
    "\n\nRespond with a single valid json object and nothing else (no markdown, no code " +
    `fences), with exactly these keys:\n${lines.join("\n")}`
  );
}

/**
 * Generate one food post — either a healthy recipe or a food-trivia fact —
 * from DeepSeek's own knowledge, with no fixed topic seed list and no live
 * search (see FOOD_SYSTEM_PROMPT_KNOWLEDGE for why this content doesn't need
 * one). Returns the validated content object (shape of RECIPE_SCHEMA or
 * TRIVIA_SCHEMA).
 */
export async function generateFoodContent() {
  if (config.mockMode) {
    console.log("[generateFoodContent] MOCK_MODE — returning canned content");
    return sanitizeFood(Math.random() < 0.5 ? MOCK_RECIPE : MOCK_TRIVIA);
  }

  const contentType = pickContentType();
  const used = recentUsedFacts(80);
  const usedList =
    used.length > 0
      ? used.map((f) => `- ${f.headline}${f.artist_name ? ` (${f.artist_name})` : ""}`).join("\n")
      : "(none yet)";

  const schema = contentType === "recipe" ? RECIPE_SCHEMA : TRIVIA_SCHEMA;

  console.log(`[generateFoodContent] routing to DeepSeek knowledge-only (${contentType})`);

  const postPrompt =
    contentType === "recipe" ? "Produce one original, healthy recipe post." : "Produce one surprising, well-sourced food trivia post.";

  const text = await callDeepSeekWithRetry({
    account: config.accountLabel,
    operation: "generateFoodContent",
    model: config.deepseekModel,
    jsonMode: true,
    onRetry: (err, attempt) =>
      console.warn(`[generateFoodContent] DeepSeek attempt ${attempt} failed (${err.message}); retrying`),
    // A full recipe (10 ingredients, 8 steps, caption) is a long JSON object,
    // and reasoning_content is drawn from this same budget before any of it is
    // written — see generateReply.js's call for the failure this avoids.
    maxTokens: 8000,
    system: FOOD_SYSTEM_PROMPT_KNOWLEDGE + schemaShapeInstruction(schema),
    user:
      postPrompt +
      "\n\nDraw on your own well-established knowledge — no need for this to be tied to what's trending this " +
      "particular week.\n\n" +
      `Already-posted — do NOT repeat or closely paraphrase any of these:\n${usedList}`,
  });

  // json_object mode should return bare JSON; strip stray fences defensively,
  // same as generateFact.js's parseFactJson.
  const fact = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));

  if (fact.fact_type === "recipe") {
    if (!fact.ingredients || fact.ingredients.length < 3 || fact.ingredients.length > 10)
      throw new Error(`Recipe validation failed: expected 3-10 ingredients, got ${fact.ingredients?.length}`);
    if (!fact.steps || fact.steps.length < 2 || fact.steps.length > 8)
      throw new Error(`Recipe validation failed: expected 2-8 steps, got ${fact.steps?.length}`);
  } else {
    if (!fact.slides || fact.slides.length < 2 || fact.slides.length > 3)
      throw new Error(`Trivia validation failed: expected 2-3 slides, got ${fact.slides?.length}`);
  }
  return sanitizeFood(fact);
}
