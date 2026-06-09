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
EXACT dimensions of a print product. Output ONLY a JSON object describing a
layout plan. Do NOT render images or text yourself.

MOST IMPORTANT — match the DESIGN CHARACTER to the brand; never default to a
dark/bold/busy look. Read the signals:
- elegant/luxury/beauty/fashion (thin fonts, minimal palette) → LIGHT bg, lots of
  whitespace, THIN type, few words, no boxes; layout "luxury".
- bold/sporty/youthful (heavy fonts, vivid colours) → dark/saturated bg, big bold
  type; layout "hero" or "bold-block".
- structured/corporate/informational → "split" or "editorial" with tidy points.
Copy matches the character: elegant = short, calm, sophisticated (not "BOLD",
"UNLEASH"); bold = punchy.

Rules: respect the wide/tall proportion; keep content in the safe area; give the
logo breathing room (never centre it in text); use accents sparingly (eyebrow,
one highlighted word, CTA); keep titles short.

Best practices (apply all): one clear focal point (headline largest, rest
secondary); strong text/background contrast; headline <= 5 words, subtitle one
short line, limit total text; prefer airy/balanced density, don't cram; CTA
visually distinct, verb-led, placed where the eye lands last; use ONLY the
brand's palette/character; fewer strong elements beat many weak ones.

Output JSON with EXACTLY this shape (no prose, no markdown):
{
  "orientation": "wide" | "tall",
  "mood": "elegant" | "bold" | "minimal" | "playful" | "corporate",
  "layout": "editorial" | "centered" | "bold-block" | "split" | "minimal" | "luxury" | "hero",
  "background": "light" | "dark" | "primary",
  "density": "airy" | "balanced" | "dense",
  "logo": { "position": "top-left" | "top-right" | "top-center", "sizeHint": "small" | "medium" | "large" },
  "title": "string (short, punchy — tone matches the mood)",
  "highlightWord": "string (one word from the title to color, or empty)",
  "subtitle": "string (one sentence, tone matches mood)",
  "eyebrow": "string (short label like NEW or a category)",
  "accentUsage": "minimal" | "balanced" | "bold",
  "points": [ { "title": "string", "text": "string" } ],
  "cta": { "label": "string", "text": "string" },
  "footer": { "left": "string", "center": "string", "right": "string" },
  "rationale": "one short sentence on the design choice"
}

Layout guide (one line each):
- luxury: huge airy headline, thin type, no boxes — elegant beauty/fashion
- centered: minimal, symmetric, airy — premium, few points
- editorial: oversized headline, understated points — magazine-like
- hero: oversized statement headline + baseline points — bold/dramatic
- bold-block: accent panels behind eyebrow/highlight — energetic/youthful
- split: side rail + tidy grid of points — structured/informational
- minimal: type + CTA only, no points — single-message
For elegant/minimal moods prefer airy density and few/zero points. Vary by brand.`;

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
    online: `USE CASE: ONLINE AD (web banner). Attention + conversion. One dominant message, strong verb-led CTA, minimal text. Viewer glances <2s — headline + CTA must land instantly.`,
    print: `USE CASE: PRINT (poster/display). Readability at distance, generous margins, keep text/logo off the edges (trimmed). High legibility, strong contrast, CMYK-safe colours (avoid RGB-only neon). Calm, well-spaced.`,
    social: `USE CASE: SOCIAL (mobile feed/story). Mobile readability, fast impact. Big thumb-stopping headline, very short copy, high contrast. Keep key content centred, away from edges (UI overlaps top/bottom).`,
    presentation: `USE CASE: PRESENTATION SLIDE. Clarity + hierarchy for distance viewing. One idea per slide, large headline, minimal points, clean, high contrast.`,
  };
  const ucRule = USE_CASE_RULES[ci.useCase] || "";
  const ucBlock = ucRule ? ("\n" + ucRule + "\n") : "";

  // Overall design direction (from the first wizard step) + the user's free-text
  // notes. This is the top-level creative steer and must shape every choice.
  const DIRECTION_DEF = {
    minimal: "MINIMAL: strip everything back, maximal whitespace, very few elements, restraint above all.",
    clean: "CLEAN: tidy, neutral, uncluttered, clear grid, nothing decorative.",
    technical: "TECHNICAL: precise and structured, data/spec feel, fine lines, monospace-like rigor, functional.",
    bold: "BOLD: big, high-impact, confident, oversized type, strong blocks of colour.",
    premium: "PREMIUM: luxurious and refined, high-end, elegant restraint, generous space, sophisticated.",
    playful: "PLAYFUL: fun, lively, friendly, energetic, approachable.",
    edgy: "EDGY: raw, daring, unconventional, asymmetric, high tension.",
    funky: "FUNKY: quirky, retro, expressive, unexpected colour and shape combinations.",
  };
  const dirDef = ci.direction ? (DIRECTION_DEF[ci.direction] || ci.direction) : "";
  const dirBlock = ci.direction ? `\nDESIGN DIRECTION (overall creative steer — applies to everything): ${dirDef}` : "";
  const notesBlock = ci.directionNotes ? `\nUSER'S SPECIFIC REQUESTS (follow these closely): ${ci.directionNotes}` : "";
  const toneBlock = ci.tone ? `\nTONE OF VOICE for all copy (headline, subtitle, CTA): ${ci.tone} — write the words in this tone.` : "";

  return `BRAND
- name: ${ci.name || "Unknown"}
- primary color: ${ci.primary || (ci.colors && ci.colors[0]) || "#222"}
- palette: ${colors}
- fonts: ${fonts}
- font character: ${feel} (thin/light = elegant; bold/black = energetic)
- monochrome brand: ${mono}${aiNote}${visionNote}${visionSummary}${dirBlock}${notesBlock}${toneBlock}
${ucBlock}
FORMAT (do NOT name the format in any text)
- size: ${wcm} x ${hcm} cm  (ratio ${ratio}, ${orient})
- design for this ${orient} proportion.

IMPORTANT: the format's internal name must NEVER appear in any text (title,
eyebrow, subtitle, points, CTA, footer). Write campaign copy about the BRAND only.
Design the layout to match THIS brand's character and the use case above. Return
ONLY the JSON object.`;
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

// planThreeVariants: ask the AI for THREE distinct layout plans for THIS brand
// in a single call. The model sees all three at once, so it makes them genuinely
// different from each other WHILE keeping each one true to the brand — instead of
// us forcing fixed layouts that look identical across every brand.
export async function planThreeVariants(ci, product, opts) {
  opts = opts || {};
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "No ANTHROPIC_API_KEY set on the server." };
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
  const base = buildUserPrompt(ci, product);
  // The user picked an overall style direction (mood). Give each mood a CONCRETE
  // visual definition so the choice clearly changes the output, and so all three
  // variants stay within that direction while differing from each other.
  const MOOD_DEF = {
    elegant: `ELEGANT/LUXURY: light or soft background, THIN type, huge whitespace, very few words, no boxes, refined and calm. Layouts: "luxury" or "centered" or "minimal".`,
    bold: `BOLD/STRONG: dark or saturated background, HEAVY/BLACK type, oversized headline, high energy, strong accent blocks. Layouts: "hero" or "bold-block".`,
    corporate: `CORPORATE/CLEAN: structured and tidy, medium weight, clear grid of points, trustworthy and professional. Layouts: "split" or "editorial".`,
    playful: `PLAYFUL/FRESH: lively, rounded, generous accent colour use, friendly and energetic but not heavy. Layouts: "bold-block" or "centered".`,
  };
  const chosen = ci.moodHint || ci.mood || null;
  const moodLine = chosen
    ? `\nThe user chose the overall style: "${chosen}".
DEFINITION — ${MOOD_DEF[chosen] || chosen}
ALL THREE concepts MUST clearly express this "${chosen}" style (do NOT drift toward
another mood, and do NOT default to dark/bold if the chosen style is elegant).
Within that ${chosen} direction, make the three genuinely different from each other
(vary layout archetype, composition, emphasis, and light/dark where the style allows)
and unique to THIS brand. Set "mood":"${chosen}" on all three.`
    : `\nMake the three genuinely different moods/directions, each true to the brand.`;
  const sys = LAYOUT_INSTRUCTIONS + `

You will produce THREE DISTINCT layout concepts for the SAME brand and format.${moodLine}
Do not output three near-identical designs. Think of them as three different
creative directions a designer would pitch for this specific brand within the
chosen style.
Respond with ONLY a JSON array of exactly 3 plan objects: [ {plan1}, {plan2}, {plan3} ].
Each object uses the exact plan shape described above. No prose, no markdown.`;
  const body = {
    model, max_tokens: 2048, temperature: 0.9,
    system: sys,
    messages: [{ role: "user", content: base + "\n\nReturn ONLY a JSON array of 3 distinct plan objects for this brand." }],
  };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const txt = await res.text(); return { error: `LLM request failed (${res.status}): ${txt.slice(0,200)}` }; }
    const data = await res.json();
    let content = Array.isArray(data?.content) ? data.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
    content = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let plans;
    try { plans = JSON.parse(content); } catch { return { error: "LLM did not return valid JSON array.", raw: content.slice(0,300) }; }
    if (!Array.isArray(plans)) plans = [plans];
    return { plans };
  } catch (e) {
    return { error: String(e) };
  }
}

// suggestCopy: propose 3 headline+subtitle ideas for the brand in a chosen tone.
// Used by the wording step so the user can pick a ready-made message or get
// inspiration before writing their own. One small text call.
export async function suggestCopy(ci, tone) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: "No OPENAI_API_KEY set on the server." };
  const model = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
  const TONE_DEF = {
    professional: "professional: credible, polished, business-appropriate.",
    playful: "playful: fun, light, friendly, a bit cheeky.",
    bold: "bold: punchy, confident, high-energy, short.",
    minimal: "minimal: very few words, understated, calm.",
    emotional: "emotional: warm, human, evocative, feeling-led.",
    premium: "premium: refined, aspirational, elegant, high-end.",
    direct: "direct: clear, plain, action-oriented, no fluff.",
  };
  const toneLine = tone ? `Tone: ${TONE_DEF[tone] || tone}` : "Tone: on-brand.";
  const sys = `You are a brand copywriter. Propose THREE distinct campaign message
ideas for the brand below, in the requested tone. Each idea = a short headline
(<= 6 words) plus a one-line subtitle (<= 12 words). Do NOT mention the physical
format or product type. Return ONLY JSON: {"ideas":[{"headline":"...","subtitle":"..."}, ...]}
exactly 3 items, no prose, no markdown.`;
  const user = `Brand: ${ci.name || "the brand"}
${ci.productContext ? "Product/context: " + ci.productContext + "\n" : ""}${toneLine}
Write 3 ideas.`;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [ { role: "system", content: sys }, { role: "user", content: user } ],
      }),
    });
    if (!res.ok) return { error: `Copy request failed (${res.status}): ${(await res.text()).slice(0,160)}` };
    const data = await res.json();
    let txt = data?.choices?.[0]?.message?.content || "";
    txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let parsed = JSON.parse(txt);
    // accept {"ideas":[...]} or a bare array
    let ideas = Array.isArray(parsed) ? parsed : (parsed.ideas || []);
    if (!Array.isArray(ideas)) ideas = [ideas];
    return { ideas: ideas.slice(0, 3) };
  } catch (e) {
    return { error: String(e) };
  }
}
