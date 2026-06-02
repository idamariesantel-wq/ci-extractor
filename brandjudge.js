// brandjudge.js — turns noisy extracted candidates into a clean brand CI by
// letting the AI judge them like a designer would. Regex gathers candidates
// (colors with usage counts, fonts, meta); the AI decides which are the real
// brand colors, the accent, and the font character. This is the accuracy jump
// over pure regex: the model knows a cookie-banner grey isn't a brand color.
//
// Needs ANTHROPIC_API_KEY. Falls back to the regex result if the AI is
// unavailable, so extraction never hard-fails.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYS = `You are a brand designer identifying a company's core visual identity
from signals scraped off their website. You are given candidate colors (with how
often each appears in the CSS), detected font names, and page meta. Decide the
REAL brand identity a designer would name:
- primary: the main brand color (often black/dark for elegant brands, or the
  dominant brand hue). Usage count matters; ignore rare incidental colors.
- accents: 1-3 true accent colors actually part of the identity (NOT random UI
  greys, link blues, or error reds unless they're clearly the brand).
- neutralBrand: true if the brand is essentially black/white/monochrome.
- fontFeel: "thin" | "light" | "regular" | "bold" | "black" — the headline
  character. Elegant fashion/beauty brands are usually thin/light.
- fontName: the most likely real brand font from the candidates (or best guess).
Return ONLY a JSON object, no prose:
{"primary":"#RRGGBB","accents":["#RRGGBB"],"neutralBrand":true|false,"fontFeel":"...","fontName":"...","reasoning":"one short sentence"}`;

function buildPrompt(candidates) {
  const colorLines = (candidates.colors || [])
    .map(c => `${c.hex} (used ${c.n}x, ${c.lum < 0.2 ? "very dark" : c.lum > 0.85 ? "very light" : "mid"}, ${c.sat > 0.4 ? "vivid" : "muted"})`)
    .join("\n");
  return `CANDIDATE COLORS (from CSS, with usage):
${colorLines || "(none)"}

DETECTED FONTS: ${(candidates.fonts || []).join(", ") || "(none)"}
META theme-color: ${candidates.themeColor || "(none)"}
BRAND NAME: ${candidates.name || "(unknown)"}
VISIBLE HEADLINE SAMPLE: ${candidates.headlineSample || "(none)"}

Judge the real brand identity. Return ONLY the JSON.`;
}

export async function judgeBrand(candidates) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null; // caller falls back to regex result
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 500,
        system: SYS + "\nRespond with ONLY the JSON object.",
        messages: [{ role: "user", content: buildPrompt(candidates) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let txt = Array.isArray(data?.content) ? data.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
    txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const judged = JSON.parse(txt);
    // basic validation
    if (!judged || !/^#[0-9a-fA-F]{6}$/.test(judged.primary || "")) return null;
    judged.accents = (judged.accents || []).filter(h => /^#[0-9a-fA-F]{6}$/.test(h)).slice(0, 3);
    return judged;
  } catch {
    return null;
  }
}
