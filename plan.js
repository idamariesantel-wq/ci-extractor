// plan.js — the AI "planner" (Step 3 + 4).
// Takes extracted brand CI + exact print dimensions, asks an LLM to DESIGN a
// layout (where the logo/title/blocks go), and returns a structured layout
// spec as JSON. It does NOT render pixels — the generator renders the spec into
// the real, print-exact, editable file. The AI decides; the tool prints.
//
// Requires an API key in the environment: ANTHROPIC_API_KEY (set on Render).
// Model is configurable via ANTHROPIC_MODEL (default claude-3-5-haiku-20241022, a
// text model — NOT an image model, on purpose: we want a layout plan, not a
// flat picture).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// The schema we ask the model to fill. Keeping it small + explicit makes the
// output reliable and easy for the generator to consume.
const LAYOUT_INSTRUCTIONS = `
You are a print layout designer. You receive a brand's visual identity and the
EXACT dimensions of a physical print product. You output ONLY a JSON object
describing a layout plan. You do NOT draw images or render text yourself.

Rules:
- Respect the print's wide/tall proportion. Keep all content inside the safe area.
- Place the logo with breathing room; never center a logo in the middle of text.
- Choose ONE primary color for background or a clean light background, and use
  accents sparingly for emphasis (eyebrow, one highlighted word, the CTA).
- Pick a sensible reading order for the proportion: wide formats read left-to-right
  (message left, supporting points right); tall formats read top-to-bottom.
- Keep titles short. Suggest a title and subtitle the user can swap.

Output JSON with EXACTLY this shape (no prose, no markdown):
{
  "orientation": "wide" | "tall",
  "background": "primary" | "light" | "dark",
  "logo": { "position": "top-left" | "top-right" | "top-center", "sizeHint": "small" | "medium" | "large" },
  "title": "string (short, punchy)",
  "highlightWord": "string (one word from the title to color, or empty)",
  "subtitle": "string (one sentence)",
  "eyebrow": "string (short label like NEW or a category)",
  "accentUsage": "minimal" | "balanced" | "bold",
  "points": [ { "title": "string", "text": "string" } ],
  "cta": { "label": "string", "text": "string" },
  "footer": { "left": "string", "center": "string", "right": "string" },
  "rationale": "one short sentence on the design choice"
}
`;

function buildUserPrompt(ci, product) {
  const colors = (ci.colors || []).join(", ");
  const fonts = (ci.fonts || []).join(", ") || "(none detected)";
  const wcm = (product.trim.w / 10).toFixed(1);
  const hcm = (product.trim.h / 10).toFixed(1);
  const ratio = (product.trim.w / product.trim.h).toFixed(2);
  const orient = product.trim.w >= product.trim.h ? "wide (landscape)" : "tall (portrait)";
  return `BRAND
- name: ${ci.name || "Unknown"}
- primary color: ${ci.primary || (ci.colors && ci.colors[0]) || "#222"}
- palette: ${colors}
- fonts: ${fonts}

PRINT PRODUCT
- name: ${product.label || product.key}
- trim size: ${wcm} x ${hcm} cm  (ratio ${ratio}, ${orient})
- this is a physical ${orient} display; design for that proportion.

Design a layout plan for a marketing graphic for this brand on this product.
Return ONLY the JSON object.`;
}

export async function planLayout(ci, product) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { error: "No ANTHROPIC_API_KEY set on the server. Add it in Render → Environment." };
  }
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";

  // Anthropic Messages API: system prompt is a top-level field; we nudge the
  // model to reply with JSON only and parse the first text block.
  const body = {
    model,
    max_tokens: 1024,
    temperature: 0.7,
    system: LAYOUT_INSTRUCTIONS + "\nRespond with ONLY the JSON object, no prose, no markdown fences.",
    messages: [
      { role: "user", content: buildUserPrompt(ci, product) },
    ],
  };

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `LLM request failed (${res.status}): ${txt.slice(0, 200)}` };
    }
    const data = await res.json();
    // response shape: { content: [ { type:"text", text:"..." }, ... ] }
    let content = "";
    if (Array.isArray(data?.content)) {
      content = data.content.filter(b => b.type === "text").map(b => b.text).join("");
    }
    // strip any accidental code fences before parsing
    content = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let plan;
    try {
      plan = JSON.parse(content);
    } catch {
      return { error: "LLM did not return valid JSON.", raw: content.slice(0, 300) };
    }
    return { plan };
  } catch (e) {
    return { error: String(e) };
  }
}
