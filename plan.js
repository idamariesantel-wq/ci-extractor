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

MOST IMPORTANT: match the DESIGN CHARACTER to the brand. Do not default to a
dark, bold, busy look. Read the brand signals and decide honestly:
- An elegant / luxury / beauty / fashion brand (thin fonts, black-and-white or
  minimal palette) → LIGHT background, lots of whitespace, THIN type, very few
  words, NO boxes. Restrained and airy. Use layout "luxury".
- A bold / sporty / youthful / energetic brand (heavy fonts, vivid colors) →
  dark or saturated background, big bold type, more energy. Use "hero" or "bold-block".
- A structured / informational / corporate brand → "split" or "editorial" with
  tidy points.
Copy must match too: elegant brands get short, calm, sophisticated lines (NOT
"BOLD", "FEARLESS", "UNLEASH"). Bold brands can be punchy.

Rules:
- Respect the print's wide/tall proportion. Keep content inside the safe area.
- Place the logo with breathing room; never center a logo in the middle of text.
- Use accents sparingly (eyebrow, one highlighted word, the CTA).
- Wide formats read left-to-right; tall formats top-to-bottom. Keep titles short.

Output JSON with EXACTLY this shape (no prose, no markdown):
{
  "orientation": "wide" | "tall",
  "mood": "elegant" | "bold" | "minimal" | "playful" | "corporate",
  "layout": "editorial" | "centered" | "bold-block" | "split" | "minimal" | "luxury" | "hero",
  "background": "light" | "dark" | "primary",
  "density": "airy" | "balanced" | "dense",
  "logo": { "position": "top-left" | "top-right" | "top-center", "sizeHint": "small" | "medium" | "large" },
  "title": "string (short, punchy — but tone must match the mood)",
  "highlightWord": "string (one word from the title to color, or empty)",
  "subtitle": "string (one sentence, tone matches mood)",
  "eyebrow": "string (short label like NEW or a category)",
  "accentUsage": "minimal" | "balanced" | "bold",
  "points": [ { "title": "string", "text": "string" } ],
  "cta": { "label": "string", "text": "string" },
  "footer": { "left": "string", "center": "string", "right": "string" },
  "rationale": "one short sentence on the design choice"
}

Layout guide:
- luxury: huge airy headline, thin type, no boxes, generous whitespace — elegant beauty/fashion/luxury
- centered: minimal, symmetric, lots of air — premium brands, few points
- editorial: oversized headline, understated points — confident, magazine-like
- hero: oversized statement headline, supporting points along a baseline — bold/dramatic
- bold-block: accent panels behind eyebrow/highlight — energetic, youthful
- split: side rail + a tidy grid of points — structured, informational
- minimal: type + CTA only, no points — single-message campaigns
For elegant/minimal moods, prefer "airy" density and FEW or ZERO points.
Vary the choice by brand; do NOT default to the same layout or to dark/bold.`;

function buildUserPrompt(ci, product) {
  const colors = (ci.colors || []).join(", ");
  const fonts = (ci.fonts || []).join(", ") || "(none detected)";
  const wcm = (product.trim.w / 10).toFixed(1);
  const hcm = (product.trim.h / 10).toFixed(1);
  const ratio = (product.trim.w / product.trim.h).toFixed(2);
  const orient = product.trim.w >= product.trim.h ? "wide (landscape)" : "tall (portrait)";
  // Brand character signals — these STEER the design direction.
  const feel = ci.fontFeel || "unknown";
  const mono = ci.monochrome ? "YES (black/white/minimal brand)" : "no";
  const aiNote = ci.aiReasoning ? `\n- designer read: ${ci.aiReasoning}` : "";
  return `BRAND
- name: ${ci.name || "Unknown"}
- primary color: ${ci.primary || (ci.colors && ci.colors[0]) || "#222"}
- palette: ${colors}
- fonts: ${fonts}
- font character: ${feel} (thin/light = elegant; bold/black = energetic)
- monochrome brand: ${mono}${aiNote}

PRINT PRODUCT
- name: ${product.label || product.key}
- trim size: ${wcm} x ${hcm} cm  (ratio ${ratio}, ${orient})
- this is a physical ${orient} display; design for that proportion.

Decide the DESIGN CHARACTER that matches THIS brand (don't default to dark/bold),
then design the layout plan. If the brand reads elegant/minimal/monochrome, make
it LIGHT, airy, thin, with few words. Return ONLY the JSON object.`;
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
