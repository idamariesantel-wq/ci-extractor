// datasheet.js — Step 1 of the pipeline, generalized.
// Given ANY product URL, find a likely datasheet PDF on the page, download it,
// extract its text, and pull out print specs (dimensions, bleed, safe margin,
// panel splits). Returns candidates for the user to CONFIRM (semi-automatic).
//
// Honest scope: this reads numbers out of arbitrary PDFs with heuristics. It
// works best on datasheets shaped like Flyeralarm's. The user always reviews
// the extracted numbers before a format is created.

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const UA = "Mozilla/5.0 (compatible; CI-Datasheet/1.0)";
const FETCH_TIMEOUT_MS = 20000;

function abs(base, href) { try { return new URL(href, base).href; } catch { return null; } }

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    return { ok: true, text: await res.text(), finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e) };
  } finally { clearTimeout(t); }
}

async function fetchPdfBuffer(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch { return null; } finally { clearTimeout(t); }
}

// Find candidate datasheet PDF links on a product page.
function findDatasheetLinks(html, baseUrl) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+\.pdf[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = abs(baseUrl, m[1]);
    const label = m[2].replace(/<[^>]+>/g, " ").toLowerCase();
    if (!href) continue;
    let score = 1;
    const hay = (href + " " + label).toLowerCase();
    if (/datenblatt|datasheet|druckdaten|vorlage|template|masse|maße|spec/.test(hay)) score += 5;
    if (/anleitung|manual|aufbau/.test(hay)) score += 1;
    links.push({ href, score });
  }
  // also any bare .pdf links
  for (const m of html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)) {
    const href = abs(baseUrl, m[1]);
    if (href && !links.find(l => l.href === href)) links.push({ href, score: 1 });
  }
  links.sort((a, b) => b.score - a.score);
  return links.slice(0, 5).map(l => l.href);
}

// Extract all text from a PDF buffer (all pages).
async function pdfText(bytes) {
  const doc = await getDocument({ data: bytes, disableFontFace: true, isEvalSupported: false }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += "\n" + content.items.map(it => (it.str || "")).join(" ");
  }
  return text;
}

// Parse dimensions/specs out of datasheet text. Returns best-guess fields.
function parseSpecs(text) {
  const out = { raw: {} };
  const norm = text.replace(/\s+/g, " ");

  // helper: all "<num> cm" and "<num> mm" with their values in mm
  const dimsCm = [...norm.matchAll(/(\d{1,4}(?:[.,]\d)?)\s*cm/gi)].map(m => parseFloat(m[1].replace(",", ".")) * 10);
  const dimsMm = [...norm.matchAll(/(\d{1,4}(?:[.,]\d)?)\s*mm/gi)].map(m => parseFloat(m[1].replace(",", ".")));

  // Datenformat / Endformat patterns like "183,7 x 80,5" or "182.7 x 79.5 cm"
  const pairCm = [...norm.matchAll(/(\d{2,4}(?:[.,]\d)?)\s*[x×]\s*(\d{2,4}(?:[.,]\d)?)\s*cm/gi)]
    .map(m => ({ w: parseFloat(m[1].replace(",", ".")) * 10, h: parseFloat(m[2].replace(",", ".")) * 10 }));

  // bleed (Beschnitt) and safe (Sicherheitsabstand) — look for labelled values
  const bleed = (norm.match(/Beschnitt\w*\s*\(?[xyz]?\)?\s*:?\s*(\d{1,3}(?:[.,]\d)?)\s*(mm|cm)/i));
  const safe  = (norm.match(/Sicherheitsabstand\s*\(?[xyz]?\)?\s*:?\s*(\d{1,3}(?:[.,]\d)?)\s*(mm|cm)/i));
  const toMm = (v, unit) => parseFloat(v.replace(",", ".")) * (/cm/i.test(unit) ? 10 : 1);

  // trim = largest pair, data = a slightly larger pair if present
  if (pairCm.length) {
    const byArea = [...pairCm].sort((a, b) => (b.w * b.h) - (a.w * a.h));
    out.trim = { w: Math.round(byArea[byArea.length - 1].w), h: Math.round(byArea[byArea.length - 1].h) };
    out.data = { w: Math.round(byArea[0].w), h: Math.round(byArea[0].h) };
    // if only one pair, derive data from trim + bleed later
  }
  if (bleed) out.bleed = Math.round(toMm(bleed[1], bleed[2]));
  if (safe)  out.safe  = Math.round(toMm(safe[1], safe[2]));

  // panel widths: repeated "67,2 cm" / "73,2 cm" style values across the sheet
  const panelCounts = {};
  for (const m of norm.matchAll(/(\d{2,3}[.,]\d)\s*cm/gi)) {
    const key = m[1].replace(",", ".");
    panelCounts[key] = (panelCounts[key] || 0) + 1;
  }
  const repeated = Object.entries(panelCounts).filter(([, n]) => n >= 2).map(([v]) => parseFloat(v) * 10);
  if (repeated.length) out.raw.repeatedWidthsMm = repeated;

  out.raw.allCm = dimsCm.slice(0, 40);
  out.raw.allMm = dimsMm.slice(0, 40);
  return out;
}

export async function extractDatasheet(productUrl) {
  let url = productUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // If the URL itself is a PDF, parse it directly.
  let pdfUrl = null;
  let candidates = [];
  if (/\.pdf(\?|$)/i.test(url)) {
    pdfUrl = url;
    candidates = [url];
  } else {
    const page = await fetchText(url);
    if (!page.ok) return { error: `Could not fetch ${url} (status ${page.status})`, url };
    candidates = findDatasheetLinks(page.text, page.finalUrl || url);
    if (!candidates.length) {
      return { error: "No datasheet PDF link found on that page. Paste a direct PDF link, or enter dimensions manually.", url, candidates: [] };
    }
    pdfUrl = candidates[0];
  }

  const bytes = await fetchPdfBuffer(pdfUrl);
  if (!bytes) return { error: `Found a datasheet link but could not download it: ${pdfUrl}`, pdfUrl };

  let text = "";
  try { text = await pdfText(bytes); }
  catch (e) { return { error: "Could not read the PDF text: " + String(e), pdfUrl }; }

  const specs = parseSpecs(text);
  // derive data from trim+bleed if data missing
  if (specs.trim && (!specs.data || (specs.data.w === specs.trim.w && specs.data.h === specs.trim.h)) && specs.bleed) {
    specs.data = { w: specs.trim.w + specs.bleed * 2, h: specs.trim.h + specs.bleed * 2 };
  }

  return {
    sourceUrl: url,
    pdfUrl,
    candidates,
    specs,
    note: "Auto-extracted from datasheet — please review and confirm the numbers before use.",
  };
}
