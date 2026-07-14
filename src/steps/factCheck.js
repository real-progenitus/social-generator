import { config } from "../config.js";
import { callClaude } from "../lib/claudeClient.js";

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    issues: {
      type: "array",
      items: { type: "string" },
      description:
        "Specific claims that are wrong, unverifiable, or misleading. Empty when verdict is pass.",
    },
  },
  required: ["verdict", "confidence", "issues"],
  additionalProperties: false,
};

/**
 * Second Claude pass: independently verify the generated fact.
 * Music trivia is a common hallucination area, so a draft only proceeds on a
 * confident pass.
 */
export async function factCheck(fact) {
  if (config.mockMode) {
    console.log("[factCheck] MOCK_MODE — auto-pass");
    return { verdict: "pass", confidence: "high", issues: [] };
  }

  const response = await callClaude({
    account: config.accountLabel,
    operation: "factCheck",
    model: config.claudeModel,
    max_tokens: 16000,
    system:
      "You are a skeptical music-history fact checker. You verify claims about electronic music against your knowledge. " +
      "Flag anything that is wrong, unverifiable, plausibly confused with a similar event, or stated more precisely than the evidence supports " +
      "(exact dates, exact sales figures, chart positions, 'first ever' claims). Passing content through is worse than rejecting borderline content.",
    messages: [
      {
        role: "user",
        content:
          "Fact-check every claim in this Instagram carousel draft. " +
          "Return verdict 'fail' if any material claim is wrong or dubious.\n\n" +
          JSON.stringify(fact, null, 2),
      },
    ],
    output_config: { format: { type: "json_schema", schema: CHECK_SCHEMA } },
  });

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Claude returned no text content for fact check");
  return JSON.parse(text);
}
