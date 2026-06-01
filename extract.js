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

// Rank colors: a dark "primary", then up to 3 vivid accents, ignoring near-white/black noise.
function rankColors(counts) {
  const all = [...counts.entries()]
    .map(([hex, n]) => ({ hex, n, lum: luminance(hex), sat: saturation(hex) }))
    // drop pure white/black which appear everywhere and aren't brand colors
    .filter(c => !(c.lum > 0.96) && !(c.lum < 0.04));

  // primary = a strong dark color used a lot (dark + frequent)
  const darks = all.filter(c => c.lum < 0.4).sort((a, b) => b.n - a.n);
  const primary = (darks[0] || all.sort((a,b)=>b.n-a.n)[0] || { hex: "#1F2933" }).hex;

  // accents = vivid mid-tone colors, by saturation*frequency, excluding the primary
  const accents = all
    .filter(c => c.hex !== primary && c.sat > 0.25 && c.lum > 0.15 && c.lum < 0.9)
    .sort((a, b) => (b.sat * Math.log(1 + b.n)) - (a.sat * Math.log(1 + a.n)))
    .map(c => c.hex);

  // dedupe and cap
  const uniqueAccents = [...new Set(accents)].slice(0, 3);
  return { primary, accents: uniqueAccents };
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
  const logo = findLogo(html, baseUrl);
  const name = findName(html, baseUrl);

  return {
    name,
    url: baseUrl,
    primary,
    colors: [primary, ...accents],
    accents,
    fonts,
    logo: logo ? { dark: logo, light: logo } : null,
    note: "Heuristic extraction — review before applying.",
  };
}
