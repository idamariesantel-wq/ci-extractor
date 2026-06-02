// extract.js — fetch a brand website and pull out CI signals.
// No third-party deps: uses Node's built-in fetch (Node 18+) and regex parsing.
// Returns { name, colors, fonts, logo } in the shape the CI Generator expects.

const UA = "Mozilla/5.0 (compatible; CI-Extractor/1.0; +https://example.com/bot)";
const FETCH_TIMEOUT_MS = 12000;

// ---- small fetch helper with timeout + sane headers ----
async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,text/css,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    const text = await res.text();
    return { ok: true, status: res.status, text, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

// Resolve a possibly-relative URL against a base.
function abs(base, href) {
  try { return new URL(href, base).href; } catch { return null; }
}

// ---- color parsing ----
// Collect hex colors and rgb()/rgba() colors, count frequency.
function collectColors(css) {
  const counts = new Map();
  const bump = (hex) => counts.set(hex, (counts.get(hex) || 0) + 1);

  // #rgb / #rrggbb
  const hexRe = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;
  let m;
  while ((m = hexRe.exec(css))) {
    let h = m[1];
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    bump("#" + h.toUpperCase());
  }
  // rgb()/rgba()
  const rgbRe = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g;
  while ((m = rgbRe.exec(css))) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (r <= 255 && g <= 255 && b <= 255) {
      const hex = "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();
      bump(hex);
    }
  }
  return counts;
}

function luminance(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
  return (0.2126*r + 0.7152*g + 0.0722*b) / 255;
}
function saturation(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substr(0,2),16)/255, g = parseInt(c.substr(2,2),16)/255, b = parseInt(c.substr(4,2),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  if (max === 0) return 0;
  return (max - min) / max;
}

// Rank colors into a brand palette. Handles three realities:
//  - monochrome/elegant brands (NARS): black + white ARE the brand colors
//  - colorful brands: pick the dominant brand hue, not a rare UI accent
//  - weight by actual USAGE (frequency), not just vividness, so a rarely-used
//    bright sale-red doesn't beat the brand's real colors.
function rankColors(counts) {
  const all = [...counts.entries()]
    .map(([hex, n]) => ({ hex, n, lum: luminance(hex), sat: saturation(hex) }));
  if (!all.length) return { primary: "#1F2933", accents: [] };

  const totalUses = all.reduce((s, c) => s + c.n, 0);
  // a color "matters" if it's used a meaningful share of the time
  const byUse = [...all].sort((a, b) => b.n - a.n);

  // Is this brand essentially monochrome? (very little saturated color used)
  const colorfulUse = all.filter(c => c.sat > 0.35 && c.lum > 0.1 && c.lum < 0.9)
                         .reduce((s, c) => s + c.n, 0);
  const isMono = (colorfulUse / totalUses) < 0.08;

  let primary, accents = [];

  if (isMono) {
    // elegant black/white brand: primary = the dominant dark (often near-black),
    // and we keep a clean near-black + near-white pairing.
    const darks = byUse.filter(c => c.lum < 0.35);
    const lights = byUse.filter(c => c.lum > 0.9);
    primary = (darks[0] || byUse[0]).hex;
    // one subtle accent if there's any real color used at all, else a light tone
    const anyColor = all.filter(c => c.sat > 0.3 && c.lum > 0.12 && c.lum < 0.88)
                        .sort((a, b) => b.n - a.n);
    if (anyColor[0]) accents = [anyColor[0].hex];
    else if (lights[0]) accents = [lights[0].hex];
  } else {
    // colorful brand: primary = the most-USED strong/dark color (brand anchor),
    // not the most-saturated rare one.
    const strong = byUse.filter(c => c.lum < 0.55 && !(c.lum < 0.04) );
    primary = (strong[0] || byUse.filter(c => !(c.lum>0.96))[0] || byUse[0]).hex;
    // accents = colors that are BOTH reasonably used and reasonably vivid
    accents = all
      .filter(c => c.hex !== primary && c.sat > 0.3 && c.lum > 0.15 && c.lum < 0.9)
      .filter(c => c.n >= Math.max(2, totalUses * 0.01)) // must actually be used
      .sort((a, b) => (b.n * (0.5 + b.sat)) - (a.n * (0.5 + a.sat)))
      .map(c => c.hex);
  }

  const uniqueAccents = [...new Set(accents)].filter(h => h !== primary).slice(0, 3);
  return { primary, accents: uniqueAccents, monochrome: isMono };
}

// ---- font parsing ----
function collectFonts(css, html) {
  const fonts = [];
  const add = (f) => {
    const name = f.replace(/['"]/g, "").trim();
    if (name &&
        !/^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|-apple-system|BlinkMacSystemFont|Segoe UI|Arial|Helvetica|Roboto|Times|Times New Roman|Georgia)$/i.test(name) &&
        !fonts.includes(name)) {
      fonts.push(name);
    }
  };
  // font-family declarations
  const ffRe = /font-family\s*:\s*([^;}{]+)/gi;
  let m;
  while ((m = ffRe.exec(css))) add(m[1].split(",")[0]);
  // @font-face family names (custom brand fonts)
  const faceRe = /@font-face[^}]*font-family\s*:\s*([^;}{]+)/gi;
  while ((m = faceRe.exec(css))) add(m[1].split(",")[0]);
  // Google Fonts <link> families in the HTML
  const gfRe = /fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi;
  while ((m = gfRe.exec(html))) add(decodeURIComponent(m[1].replace(/\+/g, " ")).split(":")[0]);
  return fonts.slice(0, 5);
}

// Detect the brand's headline weight FEEL. Naively counting every font-weight
// over-counts bold UI buttons; elegant brands (NARS) use a thin display weight
// for big headings even if buttons are bold. So we specifically look at weights
// declared on heading selectors (h1/h2/.title/.hero/display) first, and only
// fall back to the overall tally if no heading weights are found.
function detectFontWeight(css) {
  const toNum = (w) => {
    w = String(w).toLowerCase();
    if (w === "bold") return 700; if (w === "normal") return 400;
    if (w === "lighter") return 300; if (w === "bolder") return 700;
    const n = parseInt(w, 10); return (n >= 100 && n <= 900) ? n : null;
  };

  // 1) headline-context weights: blocks whose selector looks like a heading
  const headingWeights = [];
  const blockRe = /([^{}]+)\{([^}]*)\}/g;
  let bm;
  while ((bm = blockRe.exec(css))) {
    const sel = bm[1].toLowerCase();
    if (/\b(h1|h2|h3|\.title|\.headline|\.hero|\.display|\.heading|\[class\*=title\])/.test(sel)) {
      const wm = /font-weight\s*:\s*(\d{3}|bold|normal|lighter|bolder)/i.exec(bm[2]);
      if (wm) { const n = toNum(wm[1]); if (n) headingWeights.push(n); }
    }
  }

  // 2) overall tally as fallback
  const allWeights = [];
  const wRe = /font-weight\s*:\s*(\d{3}|bold|normal|lighter|bolder)/gi;
  let m;
  while ((m = wRe.exec(css))) { const n = toNum(m[1]); if (n) allWeights.push(n); }
  const axisRe = /wght@([0-9;,. ]+)/gi;
  while ((m = axisRe.exec(css))) {
    m[1].split(/[;,]/).forEach(s => { const n = parseInt(s, 10); if (n >= 100 && n <= 900) allWeights.push(n); });
  }

  // Prefer heading weights. Among them, if a light weight (<=300) appears at all
  // for headings, that defines the elegant feel — favor it over heavier values.
  let chosen = null;
  if (headingWeights.length) {
    const hasLight = headingWeights.some(w => w <= 300);
    chosen = hasLight ? Math.min(...headingWeights) : mode(headingWeights);
  } else if (allWeights.length) {
    chosen = mode(allWeights);
  }
  if (!chosen) return { weight: null, feel: null };
  const feel = chosen <= 300 ? "thin" : chosen <= 400 ? "light" : chosen <= 500 ? "regular"
            : chosen <= 700 ? "bold" : "black";
  return { weight: chosen, feel };
}

function mode(arr) {
  const f = {}; arr.forEach(w => f[w] = (f[w] || 0) + 1);
  return +Object.entries(f).sort((a, b) => b[1] - a[1])[0][0];
}

// Suggest a Google Fonts family that's a close free lookalike when the brand's
// real font isn't freely available. Maps common licensed/system fonts to a
// visually similar Google font; falls back by style category.
function suggestGoogleLookalike(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  const map = {
    "helvetica": "Inter", "helvetica neue": "Inter", "arial": "Inter",
    "neue haas": "Inter", "akzidenz": "Inter", "univers": "Inter",
    "futura": "Jost", "avenir": "Nunito Sans", "century gothic": "Jost",
    "gotham": "Montserrat", "proxima nova": "Montserrat", "circular": "Mulish",
    "din": "Oswald", "bebas": "Bebas Neue",
    "garamond": "EB Garamond", "times": "PT Serif", "georgia": "Lora",
    "didot": "Playfair Display", "bodoni": "Playfair Display",
    "caslon": "Libre Caslon Text", "baskerville": "Libre Baskerville",
    "frutiger": "Mukta", "myriad": "Source Sans 3", "gill sans": "Mukta",
    "sf pro": "Inter", "segoe": "Inter", "roboto": "Roboto",
  };
  for (const key in map) { if (n.includes(key)) return map[key]; }
  // category fallback: serif vs sans by name hint
  if (/serif|times|garamond|georgia|playfair|caslon|baskerville/.test(n)) return "Lora";
  return "Inter";
}

// ---- logo detection ----
function findLogo(html, baseUrl) {
  const candidates = [];
  // <img> whose src/alt/class hints at a logo
  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    const hay = tag.toLowerCase();
    let score = 0;
    if (/logo/.test(hay)) score += 3;
    if (/brand|header|site-logo|navbar/.test(hay)) score += 1;
    if (/\.svg(\?|$)/i.test(src)) score += 1; // svg logos preferred
    if (score > 0) candidates.push({ src: abs(baseUrl, src), score });
  }
  // <link rel="icon"> / apple-touch-icon as fallback
  const linkRe = /<link\b[^>]*rel=["']([^"']*icon[^"']*)["'][^>]*>/gi;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (href) candidates.push({ src: abs(baseUrl, href), score: /apple-touch/.test(tag) ? 1 : 0.5 });
  }
  // og:image as last resort
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) candidates.push({ src: abs(baseUrl, og[1]), score: 0.3 });

  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].src : null;
}

// ---- brand name detection ----
function findName(html, url) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1].trim();
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
  if (title) return title.split(/[|\u2013\-–—:·]/)[0].trim();
  try { return new URL(url).hostname.replace(/^www\./, "").split(".")[0]; } catch { return "Brand"; }
}

// ---- main ----
export async function extractCI(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const page = await getText(url);
  if (!page.ok) {
    return { error: `Could not fetch ${url} (status ${page.status})`, url };
  }
  const html = page.text;
  const baseUrl = page.finalUrl || url;

  // gather CSS: inline <style> blocks + style="" attrs + first few linked stylesheets
  let css = "";
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += "\n" + m[1];
  for (const m of html.matchAll(/style\s*=\s*["']([^"']+)["']/gi)) css += "\n" + m[1];

  const sheetUrls = [];
  for (const m of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)) {
    const href = (m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    const a = href && abs(baseUrl, href);
    if (a && !/fonts\.googleapis/.test(a)) sheetUrls.push(a);
  }
  // fetch up to 4 stylesheets in parallel (cap to stay fast)
  const sheets = await Promise.all(sheetUrls.slice(0, 4).map(u => getText(u)));
  for (const s of sheets) if (s.ok) css += "\n" + s.text;

  const colorCounts = collectColors(css + "\n" + html);
  const { primary, accents } = rankColors(colorCounts);
  const fonts = collectFonts(css, html);
  const { weight, feel } = detectFontWeight(css);
  const lookalike = suggestGoogleLookalike(fonts[0]);
  const logo = findLogo(html, baseUrl);
  const name = findName(html, baseUrl);

  return {
    name,
    url: baseUrl,
    primary,
    colors: [primary, ...accents],
    accents,
    fonts,
    fontWeight: weight,        // dominant numeric weight (e.g. 300)
    fontFeel: feel,            // "thin" | "light" | "regular" | "bold" | "black"
    fontLookalike: lookalike,  // closest free Google font when the real one isn't available
    logo: logo ? { dark: logo, light: logo } : null,
    note: "Heuristic extraction — review before applying.",
  };
}
