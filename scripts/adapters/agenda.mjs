// Weby farností na systému Agenda farnosti (IS OMNIA): Rožnov, Valašské Meziříčí, Kelč, Zašová, Loučka.
//   1) /oznameni_vypis  – oznámení akcí (název, Kde, Kdy, detail s časem a plakátem) – strukturované
//   2) /rss_kalendar.php – kalendář (~měsíc dopředu); skoro jen mše, bereme jen typy z options.calendarTypes
//   3) /blog            – články; akce z nich vytáhne AI (jen nedávné články)
import { fetchText, decodeHtml, stripHtml, cleanDesc, truncate, fmt, addDays, parseWall } from '../lib.mjs';
import { extractEvents, aiAvailable, ocrImage } from '../ai.mjs';
import { toEvent } from './ai-sources.mjs';
import { articleText } from './pages.mjs';

const pad = (n) => String(n).padStart(2, '0');
/** „31.5.2026“ → „2026-05-31“ */
const czDate = (s) => { const m = String(s).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/); return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null; };
const hm = (s) => { const m = String(s || '').match(/(\d{1,2})[:.](\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : null; };

function endFor(date, time, endDate, endTime) {
  if (!time) return endDate && endDate >= date ? endDate : date;
  if (endTime && (endDate || date) + endTime > date + time) return `${endDate || date}T${endTime}`;
  return fmt(new Date(parseWall(`${date}T${time}`).getTime() + 2 * 3600000));
}

// ---- 1) oznámení -------------------------------------------------------------
async function oznameni(base, historyFrom) {
  const html = await fetchText(`${base}/oznameni_vypis`);
  const items = [];
  for (const m of html.matchAll(/<h2><a href="(\/oznameni\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?Kdy:\s*([^<]+)</g)) {
    const date = czDate(m[3]);
    if (date && date >= historyFrom) items.push({ url: base + m[1], title: stripHtml(m[2]), date });
  }
  const out = [];
  for (const it of items) {
    const d = await fetchText(it.url);
    const meta = (label) => { const r = d.match(new RegExp(`<p class="title">${label}</p>\\s*<p>([\\s\\S]*?)</p>`)); return r ? stripHtml(r[1]) : ''; };
    // „31.5.2026 od 14:00 do 17:00“, „5.12.2026 - 6.12.2026“, „20.11.2026“
    // nebo zvlášť „Datum a čas začátku“ / „Datum a čas konce“: „20.11.2026 18:00“ (Rožnov)
    const dRe = /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/g, tRe = /\d{1,2}[:.]\d{2}/;
    const when = meta('Datum a čas');
    const whenFrom = meta('Datum a čas začátku'), whenTo = meta('Datum a čas konce');
    let date, endDate, time, endTime;
    if (!when && whenFrom) {
      date = czDate(whenFrom.match(dRe)?.[0] || '') || it.date;
      time = hm(whenFrom.replace(dRe, '').match(tRe)?.[0]);
      endDate = czDate(whenTo.match(dRe)?.[0] || '') || null;
      endTime = hm(whenTo.replace(dRe, '').match(tRe)?.[0]);
      if (endDate === date) endDate = null;
    } else {
      const dates = [...when.matchAll(dRe)].map((x) => czDate(x[0]));
      date = dates[0] || it.date;
      endDate = dates[1] || null;
      time = hm(when.match(/od\s+(\d{1,2}[:.]\d{2})/)?.[1]);
      endTime = hm(when.match(/do\s+(\d{1,2}[:.]\d{2})/)?.[1]);
    }
    const img = d.match(/<img src="([^"]+)"[^>]*class="img_oznameni"/)?.[1] || '';
    const body = d.match(/<div class="row event-details">([\s\S]*?)<!-- \/Event Single -->/)?.[1] || '';
    let description = truncate(cleanDesc(stripHtml(body), it.title));
    if (img && description.length < 200) {
      try { const t = await ocrImage(img); if (t) description = truncate(`${description}\n${t}`.trim()); } catch (e) { console.error(`  plakát ${img}: ${e.message}`); }
    }
    out.push({
      uid: it.url.replace(/^.*\//, ''),
      title: it.title,
      start: time ? `${date}T${time}` : date,
      end: endFor(date, time, endDate, endTime),
      allDay: !time,
      location: meta('Místo uskutečnění'),
      description,
      url: it.url,
      image: img,
      recurring: false,
      needsCheck: true,
    });
  }
  return out;
}

// ---- 2) kalendář (RSS) -------------------------------------------------------
async function kalendar(base, types) {
  if (!types?.length) return [];
  const xml = await fetchText(`${base}/rss_kalendar.php`);
  const re = new RegExp(`^(${types.join("|")})(?=\\s|$)`, "i");
  const out = [];
  for (const it of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (t) => decodeHtml(it[1].match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g, '') || '');
    // „2026-11-19 19:00 - Příležitost ke svátosti smíření Kelč“
    const m = get('title').match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d) - (.+)$/);
    if (!m) continue;
    const typeAndPlace = m[3].trim();
    const type = types.map((t) => typeAndPlace.match(new RegExp(`^(${t})`, 'i'))?.[1]).find(Boolean);
    if (!type || !re.test(typeAndPlace)) continue;
    const place = typeAndPlace.slice(type.length).trim();
    const desc = stripHtml(get('description')).replace(/^.*?\d{4}-\d\d-\d\d v \d\d:\d\d\s*/s, '').trim();
    out.push({
      uid: get('link') || `${m[1]}T${m[2]}|${typeAndPlace}`,
      title: /^(akce|oznámení)$/i.test(type) && desc && desc.length < 90 ? desc : type,
      start: `${m[1]}T${m[2]}`,
      end: endFor(m[1], m[2]),
      allDay: false,
      location: place,
      description: desc,
      url: get('link'),
      recurring: false,
      needsCheck: true,
    });
  }
  return out;
}

// ---- 3) články (AI) ----------------------------------------------------------
async function blog(base, name, historyFrom, maxAgeDays) {
  if (!aiAvailable()) throw new Error('AI není k dispozici (GROQ_API_KEY)');
  const html = await fetchText(`${base}/blog`);
  const since = fmt(addDays(new Date(), -maxAgeDays), true);
  const seen = new Set();
  const posts = [];
  // <a href="/blog_clanek/adventni-duchovni-obnova-1234">Adventní duchovní obnova</a> … 9.11.2026
  for (const m of html.matchAll(/href="(\/blog_clanek\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,600}?)(\d{1,2}\.\d{1,2}\.\d{4})/g)) {
    const url = base + m[1];
    const date = czDate(m[4]);
    if (seen.has(url) || !date || date < since) continue;
    seen.add(url);
    posts.push({ url, date });
  }
  const out = [];
  for (const p of posts) {
    const page = await fetchText(p.url);
    const title = stripHtml(page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || '');
    // jen samotný článek (bez seznamu dalších článků a postranního panelu), plakáty přečte AI
    const { text: body, image: img } = await articleText(page, p.url, { contentStart: 'class="blog-post-single"', contentEnd: 'class="blog-post style2|id="sidebar"', imageMatch: 'agendafarnosti\\.cz/' });
    const text = `Název článku: ${title}\nPublikováno: ${p.date}\n\n${body}`;
    const evs = await extractEvents(text, { context: `článek na webu ${name}`, refDate: p.date });
    for (const e of evs) if (e.date >= historyFrom) out.push(toEvent(e, { url: p.url, image: img }));
  }
  return out;
}

export async function collectAgenda(source, { historyFrom }) {
  const base = source.url.replace(/\/$/, '');
  const o = source.options || {};
  const out = [];
  const errors = [];
  for (const [name, fn] of [
    ['oznámení', () => oznameni(base, historyFrom)],
    ['kalendář', () => kalendar(base, o.calendarTypes)],
    ['články', () => (o.blog === false ? [] : blog(base, source.fullName, historyFrom, o.blogMaxAgeDays || 75))],
  ]) {
    try { const r = await fn(); out.push(...r); console.log(`  ${source.id} ${name}: ${r.length}`); } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  // chyba kterékoli části (např. web farnosti vrací 500/502) = chyba zdroje → collect ponechá
  // poslední známé akce; jinak by akce z nedostupné části (články) z kalendáře zmizely
  if (errors.length) throw new Error(errors.join('; '));
  return out;
}
