// Weby farností Zubří a Vidče (WordPress, šablona chilli-codes): /udalosti/?date-from=&date-to=
// Seznam událostí po měsících → detail s „Zahájení“, „Ukončení“, „Místo konání“ a plakátem.
import { fetchText, stripHtml, truncate, fmt, addDays, parseWall, todayWall } from '../lib.mjs';

const pad = (n) => String(n).padStart(2, '0');
/** „7.11.2026 09:00“ → { date: '2026-11-07', time: '09:00' } */
function czDateTime(s) {
  const m = String(s).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return { date: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : null };
}

export async function collectChilli(source, { historyFrom }) {
  const base = source.url.replace(/\/$/, '');
  const months = source.options?.monthsAhead ?? 12;
  const urls = new Set();
  // měsíce od začátku historie do N měsíců dopředu
  const t = todayWall();
  const [fy, fm] = historyFrom.split('-').map(Number);
  const endIdx = t.getUTCFullYear() * 12 + t.getUTCMonth() + months;
  for (let i = fy * 12 + fm - 1; i <= endIdx; i++) {
    const y = Math.floor(i / 12), m = (i % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const html = await fetchText(`${base}/udalosti/?date-from=${y}-${pad(m)}-01&date-to=${y}-${pad(m)}-${last}`);
    for (const x of html.matchAll(/href="([^"]+\/udalosti\/[a-z0-9-]+\/)"\s+class="event__content__title__link"/g)) urls.add(x[1]);
  }
  const out = [];
  for (const url of urls) {
    const d = await fetchText(url);
    const row = (label) => stripHtml(d.match(new RegExp(`${label}:</div>\\s*<div[^>]*>([\\s\\S]*?)</div>`))?.[1] || '');
    const from = czDateTime(row('Zahájení'));
    if (!from) continue;
    const to = czDateTime(row('Ukončení'));
    const allDay = !from.time;
    const start = allDay ? from.date : `${from.date}T${from.time}`;
    let end;
    if (allDay) end = to && to.date >= from.date ? to.date : from.date;
    else if (to?.time && `${to.date}T${to.time}` > start) end = `${to.date}T${to.time}`;
    else end = fmt(new Date(parseWall(start).getTime() + 2 * 3600000));
    const descHtml = d.match(/<div class="event-detail__col event-detail__description">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] || '';
    const img = descHtml.match(/<img[^>]+src="([^"]+)"/)?.[1] || '';
    const badge = stripHtml(d.match(/<div class="event-detail__badge">([\s\S]*?)<\/div>/)?.[1] || '');
    out.push({
      uid: url,
      title: stripHtml(d.match(/<h1 class="event-detail__title">([\s\S]*?)<\/h1>/)?.[1] || ''),
      start, end, allDay,
      location: row('Místo konání'),
      description: truncate(stripHtml(descHtml)),
      url,
      image: img,
      sourceTags: badge ? [badge] : [],
      recurring: false,
      needsCheck: true,
    });
  }
  return out.filter((e) => e.title && e.end.slice(0, 10) >= historyFrom);
}
