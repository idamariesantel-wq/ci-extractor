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

  const sys = `You write prompts for an image generator producing a BACKGROUND graphic
for a printed marketing display. Rules for the prompt you output:
- NO text, words, letters, numbers or logos. Background/backdrop only: shapes,
  gradients, texture, abstract or product-evocative imagery.
- Leave a calm region (one side or lower third) for headline text added later.
- BALANCE brand + user: brand colours are the BASE palette (keep it recognisably
  on-brand); the user's requests + chosen style shape mood/theme/composition (e.g.
  "olympics-like" => dynamic, sporty, motion). ONLY if the user explicitly asks for
  other colours do you expand the palette — and still weave the brand colour in.
  Never drop the brand, never ignore the user.
Output ONLY the prompt text, one paragraph, no preamble.`;

  // Style + user notes shape the mood; brand colours stay the base palette.
  const STYLE_BRIEF = {
    technical: "technical and precise: blueprint/grid feel, fine lines, schematic, engineered, structured.",
    clean: "clean and uncluttered: smooth surfaces, lots of calm negative space, neutral and tidy.",
    minimal: "minimal: almost empty, one subtle gradient or shape, maximal restraint.",
    abstract: "abstract: flowing organic or geometric forms, artistic, non-literal.",
    premium: "premium and luxurious: rich depth, subtle sheen, refined materials, high-end and elegant.",
    edgy: "edgy and raw: high contrast, bold asymmetry, gritty texture, daring and unconventional.",
    funky: "funky and retro: playful shapes, expressive unexpected colour combinations, energetic.",
    motivating: "motivating and energetic: dynamic movement, uplifting light, forward energy.",
  };
  const styleKey = ci.direction || "";
  const styleLine = styleKey ? `\nStyle to express: ${STYLE_BRIEF[styleKey] || styleKey}` : "";
  const notesLine = ci.directionNotes ? `\nUser's requests (shape the mood/theme around this, keep it on-brand): ${ci.directionNotes}` : "";
  const palette = (ci.colors || []).join(", ") || ci.primary || "#222";
  const user = `Make an ON-BRAND background for "${ci.name || "the brand"}".
Brand colours (base palette — keep it recognisably on-brand): ${palette}${notesLine}${styleLine}
Proportion: ${(product.trim.w/product.trim.h).toFixed(2)} (${product.trim.w>=product.trim.h?"wide/landscape":"tall/portrait"}).
Write the background-image prompt: on-brand colours as the base, with the user's requests and style shaping the mood and composition.`;

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

// Stage 2b (image-to-image): refine a reference image toward the brief. Uses
// OpenAI's images/edits endpoint (gpt-image-1), which takes the reference image
// as a multipart upload plus a prompt. This is the "send the background back to
// itself as a reference" step — it nudges the first background toward the brand
// style for higher consistency, rather than generating from scratch again.
async function renderImageToImage(prompt, size, refDataUrl) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: "No OPENAI_API_KEY." };
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "medium";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    // strip the data URL header → raw base64 → Buffer for the multipart upload
    const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(refDataUrl || "");
    if (!m) return { error: "Reference image is not a valid data URL." };
    const mime = m[1]; const buf = Buffer.from(m[2], "base64");
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    form.append("n", "1");
    // Node 18+ has Blob/FormData globally
    form.append("image", new Blob([buf], { type: mime }), "reference.png");
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}` },  // no Content-Type; fetch sets the multipart boundary
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `Image-to-image failed (${res.status}): ${(await res.text()).slice(0,200)}` };
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (b64) {
      try {
        const sharp = (await import("sharp")).default;
        const inBuf = Buffer.from(b64, "base64");
        const outBuf = await sharp(inBuf).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
        return { dataUrl: `data:image/jpeg;base64,${outBuf.toString("base64")}` };
      } catch (e) { return { dataUrl: `data:image/png;base64,${b64}` }; }
    }
    return { error: "Image-to-image returned no image." };
  } catch (e) {
    if (e.name === "AbortError") return { error: "Image-to-image timed out." };
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
  const firstImage = img.dataUrl || img.url;

  // Optional two-stage image-to-image: send the freshly generated background back
  // in as a REFERENCE and refine it toward the brand style. Enabled per-request
  // (ci.useI2I) or globally (env USE_I2I=1). Falls back to the first image if the
  // refine step fails, so it never breaks the basic flow.
  const wantI2I = ci.useI2I || process.env.USE_I2I === "1";
  if (wantI2I && firstImage && typeof firstImage === "string" && firstImage.startsWith("data:")) {
    const refinePrompt = (process.env.FAST_IMAGE === "1")
      ? directPrompt(ci, product) + " Refine this reference image to match the brand style more closely; keep the calm text area."
      : prompt + " Use the supplied image as a style reference; refine it to match the brand style more closely while keeping a calm area for headline text.";
    const t3 = Date.now();
    const refined = await renderImageToImage(refinePrompt, size, firstImage);
    const t4 = Date.now();
    console.log(`[image] image-to-image refine took ${((t4-t3)/1000).toFixed(1)}s`);
    if (!refined.error && refined.dataUrl) {
      return { prompt, size, image: refined.dataUrl, stage: "image-to-image", reference: firstImage, timing: { promptMs: t1-t0, renderMs: t2-t1, refineMs: t4-t3 } };
    }
    // refine failed → return the first image, note why
    return { prompt, size, image: firstImage, stage: "single (refine failed)", refineError: refined.error, timing: { promptMs: t1-t0, renderMs: t2-t1 } };
  }

  return { prompt, size, image: firstImage, stage: "single", timing: { promptMs: t1-t0, renderMs: t2-t1 } };
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
