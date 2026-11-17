// Ručně zadané akce z WordPressu děkanátu (plugin „Kalendář akcí děkanátu – ruční akce“,
// /wp-json/kalendar-dekanat/v1/akce). Opakovaná akce = první termín + „Další termíny“ (more_dates).
import { fetchJson, fmt, parseWall } from '../lib.mjs';

export async function collectWpManual(source) {
  const list = await fetchJson(`${source.url}${source.url.includes('?') ? '&' : '?'}nc=${Date.now()}`);
  const out = [];
  for (const a of list) {
    const dates = [a.date_from, ...(a.more_dates || [])].filter((d) => /^\d{4}-\d\d-\d\d$/.test(d || ''));
    // délka akce (ve dnech) z prvního termínu se použije i pro další termíny
    const spanDays = a.date_to && a.date_to > a.date_from ? Math.round((Date.parse(a.date_to) - Date.parse(a.date_from)) / 86400000) : 0;
    dates.forEach((d, i) => {
      const allDay = !a.time_from;
      const dTo = spanDays ? fmt(new Date(Date.parse(d) + spanDays * 86400000), true) : d;
      const start = allDay ? d : `${d}T${a.time_from}`;
      let end;
      if (allDay) end = dTo;
      else if (a.time_to) end = `${dTo}T${a.time_to}`;
      else end = fmt(new Date(parseWall(start).getTime() + 2 * 3600000));
      if (end < start) end = start;
      out.push({
        uid: `wp-${a.id}${i ? `-${d}` : ''}`,
        title: a.title,
        start, end, allDay,
        location: a.location || '',
        description: a.description || '',
        url: a.url || '',
        image: a.image || '',
        organizers: a.organizers || [],
        aiCategories: a.categories || [],
        sourceTags: a.tags || [],
        recurring: false,
      });
    });
  }
  return out;
}
