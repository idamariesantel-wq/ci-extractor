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

Graphic-design best practices (apply ALL of these):
- HIERARCHY: one clear focal point. The headline is the largest, most dominant
  element; eyebrow/subtitle/points are clearly smaller and secondary. Never let
  two elements compete for first attention.
- CONTRAST: ensure text is clearly readable against its background. Highlight ONE
  word at most in an accent colour, and only if it stays legible.
- TYPOGRAPHY: keep the headline short (ideally <= 5 words). Don't write long
  sentences in the title. Subtitle is one short line. Limit total text — white
  space is part of the design.
- SPACING & BALANCE: prefer an "airy" or "balanced" density unless the brand is
  truly energetic. Don't cram. Distribute weight so the layout doesn't feel
  lopsided.
- CTA: the call-to-action must be visually distinct and clearly the action step
  (a short verb-led label). Place it where the eye lands last (bottom or a
  deliberate focal spot), never buried among the points.
- BRAND CONSISTENCY: use ONLY the brand's palette and character. Don't introduce
  unrelated colours or a tone that contradicts the brand.
- RESTRAINT: fewer, stronger elements beat many weak ones. If unsure, choose
  fewer points and more space.

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
  const visionNote = ci.productContext ? `\n- product/context (from an uploaded image): ${ci.productContext}` : "";
  const visionSummary = ci.visionSummary ? `\n- visual style to match: ${ci.visionSummary}` : "";

  // Use-case-specific design priorities. The selected output format changes
  // what the layout should optimise for.
  const USE_CASE_RULES = {
    online: `OUTPUT USE CASE: ONLINE ADVERTISING (web banner / display ad)
Prioritise: attention-grabbing visual impact and CONVERSION. One dominant message,
a strong clear CTA (action verb), minimal supporting text. Assume the viewer
glances for under 2 seconds — the headline + CTA must land instantly. Keep copy
extremely short. The CTA should feel clickable and benefit-driven.`,
    print: `OUTPUT USE CASE: PRINT (physical display / poster)
Prioritise: readability at distance, generous margins, and a print-safe layout.
Keep important text and the logo away from the very edges (safe area), since print
is trimmed. Favour high legibility, strong contrast, and colours that survive CMYK
printing (avoid relying on very bright RGB-only neon tones). Layout should be calm,
well-spaced and legible from a few metres away.`,
    social: `OUTPUT USE CASE: SOCIAL MEDIA (mobile feed / story)
Prioritise: MOBILE readability and fast visual impact. Big, bold, thumb-stopping
headline that reads on a small screen. Very short copy. High contrast. Assume the
viewer scrolls fast — the first glance must communicate the whole message. Keep
key content centred and away from screen edges (UI overlaps top/bottom on stories).`,
    presentation: `OUTPUT USE CASE: PRESENTATION SLIDE
Prioritise: clarity and hierarchy for an audience viewing from a distance. One clear
idea per slide, large readable headline, minimal supporting points. Clean and
uncluttered. High contrast so it reads on a projector or shared screen.`,
  };
  const ucRule = USE_CASE_RULES[ci.useCase] || "";
  const ucBlock = ucRule ? ("\n" + ucRule + "\n") : "";

  return `BRAND
- name: ${ci.name || "Unknown"}
- primary color: ${ci.primary || (ci.colors && ci.colors[0]) || "#222"}
- palette: ${colors}
- fonts: ${fonts}
- font character: ${feel} (thin/light = elegant; bold/black = energetic)
- monochrome brand: ${mono}${aiNote}${visionNote}${visionSummary}
${ucBlock}
FORMAT (do NOT name the format in any text)
- size: ${wcm} x ${hcm} cm  (ratio ${ratio}, ${orient})
- design for this ${orient} proportion.

IMPORTANT: The format's internal name must NEVER appear in the title, eyebrow,
subtitle, points, CTA, footer, or any other text. Write campaign copy about the
BRAND only. Decide the DESIGN CHARACTER that matches THIS brand (don't default to
dark/bold) AND respects the output use case above, then design the layout plan.
If the brand reads elegant/minimal/monochrome, make it LIGHT, airy, thin, with few
words. Return ONLY the JSON object.`;
}

export async function planLayout(ci, product, opts) {
  opts = opts || {};
  const userPrompt = buildUserPrompt(ci, product);
  const systemPrompt = LAYOUT_INSTRUCTIONS + "\nRespond with ONLY the JSON object, no prose, no markdown fences.";
  // preview mode: return the exact prompt that WOULD be sent, without calling the model
  if (opts.previewOnly) {
    return { preview: true, systemPrompt, userPrompt };
  }
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
    system: systemPrompt,
    messages: [
      { role: "user", content: userPrompt },
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
    return { plan, systemPrompt, userPrompt };
  } catch (e) {
    return { error: String(e) };
  }
}
