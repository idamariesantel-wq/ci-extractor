// vision.js — analyze an uploaded brand/product image with Claude's vision model.
// Returns a compact JSON description the design generator can use: visual mood,
// product context, style descriptors, and a short brand-feel summary.
// Falls back gracefully (returns null) if no API key or the call fails.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYS = `You analyze a single brand or product image (could be a photo, logo,
screenshot, or marketing material). Describe ONLY what you can actually see — do
not invent brand facts. Return ONLY JSON in this exact shape:
{
  "mood": "elegant" | "bold" | "minimal" | "playful" | "corporate",
  "background": "light" | "dark",
  "fontFeel": "thin" | "light" | "regular" | "bold" | "black",
  "productContext": "short phrase naming what the image shows (e.g. 'skincare bottle', 'running shoe', 'logo on white')",
  "styleWords": ["3-5 short adjectives describing the visual style"],
  "summary": "one sentence a designer could use to match this look"
}
Pick the single closest mood. If you are unsure about fonts, use "regular".`;

// imageData: base64 string (no data: prefix). mediaType: e.g. "image/png".
export async function analyzeImage(imageData, mediaType) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !imageData) return null;
  // Use a vision-capable model. Allow override; default to a Claude 3.5 model.
  const model = process.env.ANTHROPIC_VISION_MODEL || process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 500,
        system: SYS,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/png", data: imageData } },
            { type: "text", text: "Analyze this brand/product image. Return ONLY the JSON." },
          ],
        }],
      }),
    });
    if (!res.ok) {
      return { error: `vision model returned ${res.status}` };
    }
    const data = await res.json();
    let txt = Array.isArray(data?.content) ? data.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
    txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    const j = JSON.parse(txt);
    return j;
  } catch (e) {
    return { error: String(e).slice(0, 160) };
  }
}
