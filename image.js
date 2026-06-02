// image.js — Step 4 (image route).
// Generates a BACKGROUND image for a print product using the brand CI.
// Two-stage: (1) Claude writes a tight image prompt from the brand + product,
// (2) OpenAI gpt-image-1 renders it at the closest supported size to the
// product's aspect ratio. The generator then layers EDITABLE text on top,
// so words stay crisp and correct (the image never renders the text).
//
// Needs: ANTHROPIC_API_KEY (prompt writing) + OPENAI_API_KEY (image).
// Optional: OPENAI_IMAGE_MODEL (default gpt-image-1).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

// gpt-image-1 supports a small set of sizes. Pick the closest to the product's
// aspect ratio so the background matches the print proportion as well as possible.
function pickSize(trim) {
  const ar = trim.w / trim.h;
  // supported: 1024x1024 (1.0), 1536x1024 (1.5 wide), 1024x1536 (0.67 tall)
  if (ar >= 1.25) return "1536x1024";
  if (ar <= 0.8) return "1024x1536";
  return "1024x1024";
}

// Stage 1: ask Claude to write a background-image prompt. We explicitly tell it
// to design a BACKGROUND with NO text/letters (text is layered on later) and to
// leave a calm area for the headline.
async function writeImagePrompt(ci, product) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "No ANTHROPIC_API_KEY (needed to write the image prompt)." };
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";

  const sys = `You write prompts for an image generator that will produce a BACKGROUND
graphic for a printed marketing display. Hard rules for the prompt you output:
- The image must contain NO text, NO words, NO letters, NO numbers, NO logos.
- It is a background/backdrop only: shapes, gradients, texture, abstract or
  product-evocative imagery in the brand's colors.
- Leave a visually calm region (e.g. one side or lower third) where headline
  text can be overlaid legibly later.
- Match the brand's mood and color palette. Print-suitable, high quality, clean.
Output ONLY the prompt text, one paragraph, no preamble.`;

  const user = `Brand: ${ci.name || "Unknown"}
Primary color: ${ci.primary || (ci.colors && ci.colors[0]) || "#222"}
Palette: ${(ci.colors || []).join(", ")}
Product: ${product.label || product.key}, proportion ${(product.trim.w/product.trim.h).toFixed(2)} (${product.trim.w>=product.trim.h?"wide/landscape":"tall/portrait"}).
Write the background-image prompt.`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 400, system: sys, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return { error: `Prompt-writing failed (${res.status}): ${(await res.text()).slice(0,150)}` };
    const data = await res.json();
    const text = Array.isArray(data?.content) ? data.content.filter(b=>b.type==="text").map(b=>b.text).join("").trim() : "";
    if (!text) return { error: "Claude returned an empty image prompt." };
    return { prompt: text };
  } catch (e) { return { error: String(e) }; }
}

// Stage 2: call OpenAI images. Returns a base64 data URL the browser can use.
async function renderImage(prompt, size) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: "No OPENAI_API_KEY (needed to render the image)." };
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  // Quality drives speed/cost the most. Default to "medium" for a good
  // speed/quality balance; override with OPENAI_IMAGE_QUALITY (low|medium|high).
  const quality = process.env.OPENAI_IMAGE_QUALITY || "medium";
  // Fail fast instead of hanging forever if OpenAI is slow.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(OPENAI_IMAGES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model, prompt, size, n: 1, quality }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `Image generation failed (${res.status}): ${(await res.text()).slice(0,200)}` };
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (b64) {
      // The raw PNG from gpt-image-1 is several MB — slow to transfer through
      // the free tier. Compress to a smaller JPEG so it reaches the browser in
      // a second or two instead of minutes. (It's a background, so JPEG is fine.)
      try {
        const sharp = (await import("sharp")).default;
        const inBuf = Buffer.from(b64, "base64");
        const outBuf = await sharp(inBuf)
          .resize({ width: 1280, withoutEnlargement: true })
          .jpeg({ quality: 78 })
          .toBuffer();
        return { dataUrl: `data:image/jpeg;base64,${outBuf.toString("base64")}` };
      } catch (e) {
        // if compression fails for any reason, fall back to the original PNG
        return { dataUrl: `data:image/png;base64,${b64}` };
      }
    }
    const url = data?.data?.[0]?.url;
    if (url) return { url };
    return { error: "Image API returned no image." };
  } catch (e) {
    if (e.name === "AbortError") return { error: "Image generation timed out (90s). Try again — the server may have been waking up." };
    return { error: String(e) };
  } finally { clearTimeout(timer); }
}

export async function generateBackground(ci, product) {
  if (!ci || !product || !product.trim) return { error: "Need ci and product with trim.w/h." };
  const t0 = Date.now();
  // Speed option: when FAST_IMAGE is set, build the prompt directly from brand
  // data instead of calling Claude first (saves one API round-trip).
  let prompt;
  if (process.env.FAST_IMAGE === "1") {
    prompt = directPrompt(ci, product);
  } else {
    const p = await writeImagePrompt(ci, product);
    if (p.error) return { error: p.error };
    prompt = p.prompt;
  }
  const t1 = Date.now();
  console.log(`[image] prompt-prep took ${((t1-t0)/1000).toFixed(1)}s`);
  const size = pickSize(product.trim);
  const img = await renderImage(prompt, size);
  const t2 = Date.now();
  console.log(`[image] image-render took ${((t2-t1)/1000).toFixed(1)}s (size ${size})`);
  if (img.error) return { error: img.error, prompt };
  return { prompt, size, image: img.dataUrl || img.url, timing: { promptMs: t1-t0, renderMs: t2-t1 } };
}

// directPrompt(): builds a background-image prompt from brand data without an
// LLM call. Same NO-TEXT background rules, just assembled directly for speed.
function directPrompt(ci, product) {
  const colors = (ci.colors || []).slice(0, 4).join(", ") || (ci.primary || "#222");
  const wide = product.trim.w >= product.trim.h;
  return `Abstract background graphic for a printed marketing display, in the brand colors ${colors}. `
    + `Clean, modern, high-quality composition with shapes, soft gradients and subtle texture. `
    + `${wide ? "Wide landscape composition" : "Tall portrait composition"} with a calm, less-busy area `
    + `(one side or lower third) where headline text can be overlaid legibly later. `
    + `Absolutely NO text, NO words, NO letters, NO numbers, NO logos anywhere in the image. `
    + `Backdrop only, evoking the brand's mood.`;
}
