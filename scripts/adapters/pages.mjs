// Zdroje bez strukturovaného kalendáře – akce vytahuje AI z textu (a z plakátů):
//   ai-links – stránka se seznamem článků → posledních N článků (text + plakáty) (CPR, Choryně)
//   ai-page  – jedna stránka s krátkými oznámeními (Hutisko – Aktuality)
//   pdf-ohlasky – týdenní ohlášky v PDF (Dolní Bečva)
import { fetchText, decodeHtml, stripHtml, truncate } from '../lib.mjs';
import { extractEvents, aiAvailable, ocrImage } from '../ai.mjs';
import { toEvent } from './ai-sources.mjs';

const needAi = () => { if (!aiAvailable()) throw new Error('AI není k dispozici (GROQ_API_KEY)'); };
const abs = (u, base) => new URL(decodeHtml(u), base).href;

/** HTML → hlavní obsah bez hlavičky, menu a patičky. */
function mainHtml(html, o = {}) {
  let h = html.replace(/<(script|style|noscript|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '');
  if (o.contentStart) { const i = h.search(new RegExp(o.contentStart, 'i')); if (i >= 0) h = h.slice(i); }
  if (o.contentEnd) { const i = h.search(new RegExp(o.contentEnd, 'i')); if (i > 0) h = h.slice(0, i); }
  return h;
}

/** Text článku + přepis plakátů (jen když je textu málo nebo o.ocrAlways). */
export async function articleText(html, url, o) {
  const body = mainHtml(html, o);
  const text = stripHtml(body);
  const imgs = [...body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => abs(m[1], url))
    .filter((u) => !o.imageMatch || new RegExp(o.imageMatch, 'i').test(u))
    .filter((u) => !/logo|icon|avatar|kriz150|sponzor|\.gif(\?|$)/i.test(u))
    .map((u) => (o.imageRewrite ? u.replace(new RegExp(o.imageRewrite[0]), o.imageRewrite[1]) : u));
  const uniq = [...new Set(imgs)].slice(0, 3);
  let posters = '';
  if (uniq.length && (o.ocrAlways || text.length < (o.ocrBelow ?? 400))) {
    for (const [i, u] of uniq.entries()) {
      try { const t = await ocrImage(u); if (t) posters += `\n\n[Text z plakátu ${i + 1}]\n${t}`; } catch (e) { console.error(`  plakát ${u}: ${e.message}`); }
    }
  }
  return { text: truncate(text, 5000) + posters, image: uniq[0] || '' };
}

export async function collectAiLinks(source, { historyFrom, today }) {
  needAi();
  const o = source.options || {};
  const list = await fetchText(o.list || source.url);
  const links = [];
  // HTML odkazy i <link> z RSS
  for (const m of list.matchAll(/href="([^"#]+)"|<link>([^<]+)<\/link>/g)) {
    if (!m[1] && !m[2]) continue;
    const u = abs(m[1] || m[2].trim(), o.list || source.url);
    if (new RegExp(o.link).test(u) && !links.includes(u)) links.push(u);
  }
  const out = [];
  for (const url of links.slice(0, o.max || 12)) {
    const html = await fetchText(url);
    const title = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || html.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const { text, image } = await articleText(html, url, o);
    const evs = await extractEvents(`Název článku: ${title}\n\n${text}`, { context: `${source.fullName} – článek na webu`, refDate: today });
    for (const e of evs) if (e.date >= historyFrom) out.push(toEvent(e, { url, image }));
  }
  return out;
}

export async function collectAiPage(source, { historyFrom, today }) {
  needAi();
  const o = source.options || {};
  const html = await fetchText(source.url);
  const { text } = await articleText(html, source.url, { ...o, ocrBelow: 0 });
  const out = [];
  // dlouhé stránky po částech
  for (let i = 0; i < text.length; i += 6000) {
    const evs = await extractEvents(text.slice(i, i + 6500), { context: `${source.fullName} – ${o.label || 'aktuality'}`, refDate: today });
    for (const e of evs) if (e.date >= historyFrom) out.push(toEvent(e, { url: source.link || source.url }));
  }
  return out;
}

export async function collectPdfOhlasky(source, { historyFrom }) {
  needAi();
  const o = source.options || {};
  const { extractText, getDocumentProxy } = await import('unpdf');
  const list = await fetchText(source.url);
  const pages = [...new Set([...list.matchAll(/href="([^"]+)"/g)].map((m) => abs(m[1], source.url)).filter((u) => new RegExp(o.link).test(u)))].slice(0, o.max || 3);
  const out = [];
  for (const page of pages) {
    const html = await fetchText(page);
    const pdf = html.match(/href="([^"]+\.pdf)"/i)?.[1];
    // datum ohlášek z adresy „…-15112026“
    const dm = page.match(/(\d{2})(\d{2})(\d{4})(?:\D*$)/);
    const refDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : historyFrom;
    let text;
    if (pdf) {
      const buf = new Uint8Array(await (await fetch(abs(pdf, page), { headers: { 'User-Agent': 'KalendarDekanat/1.0' } })).arrayBuffer());
      text = (await extractText(await getDocumentProxy(buf), { mergePages: true })).text;
    } else text = stripHtml(mainHtml(html, o));
    const evs = await extractEvents(truncate(text, 7000), { context: `${source.fullName} – ohlášky`, refDate });
    for (const e of evs) if (e.date >= historyFrom) out.push(toEvent(e, { url: page }));
  }
  return out;
}
