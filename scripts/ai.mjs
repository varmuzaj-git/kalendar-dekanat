// AI (Groq, OpenAI-kompatibilní API): vytažení akcí z volného textu + rozhodování o duplicitách.
// Výsledky se ukládají do cache/ai.json (klíč = hash vstupu), takže se stejný text posílá jen jednou.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hash, normalize } from './lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const CACHE_FILE = ROOT + 'cache/ai.json';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const PROMPT_VERSION = 2;

function apiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  // místní vývoj: klíč ze souboru (nikdy se nevypisuje)
  try { return readFileSync(process.env.HOME + '/.config/groq.key', 'utf8').trim(); } catch { return ''; }
}
export const aiAvailable = () => !!apiKey();

let cache = null;
async function loadCache() {
  if (!cache) { try { cache = JSON.parse(await readFile(CACHE_FILE, 'utf8')); } catch { cache = {}; } }
  return cache;
}
export async function saveCache() {
  if (!cache) return;
  await mkdir(ROOT + 'cache', { recursive: true });
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(CACHE_FILE, JSON.stringify(sorted, null, 1) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

// Denní limit Groq (tokeny/požadavky za den): dál nečekat, zbytek se zpracuje v dalším běhu
// (výsledky se ukládají do cache, takže se úvodní naplnění rozloží do více dní).
export class AiBudgetError extends Error {}
const budgetOut = new Set(); // modely s vyčerpaným denním limitem
export const aiBudgetOut = () => budgetOut.size > 0;
async function checkDaily(res, model) {
  if (res.status !== 429) return;
  const body = await res.clone().text().catch(() => '');
  if (/per day|TPD|RPD/i.test(body)) {
    budgetOut.add(model);
    console.log(`  AI: vyčerpaný denní limit Groq (${model}) – zbytek se zpracuje v dalším běhu`);
    throw new AiBudgetError('vyčerpaný denní limit Groq');
  }
}

async function chatJson(system, user) {
  const key = apiKey();
  if (!key) throw new Error('chybí GROQ_API_KEY');
  if (budgetOut.has(MODEL)) throw new AiBudgetError('vyčerpaný denní limit Groq');
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    await checkDaily(res, MODEL);
    if (res.status === 429 || res.status >= 500) {
      const wait = Math.min(90, Number(res.headers.get('retry-after')) || 20 * (attempt + 1));
      console.log(`  AI: ${res.status}, čekám ${wait} s`);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      // model občas vrátí neplatné JSON → zkusit znovu (max. 2×)
      if (res.status === 400 && body.includes('json_validate_failed') && attempt < 2) { console.log('  AI: neplatné JSON, zkouším znovu'); continue; }
      throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    calls++;
    if (calls % 5 === 0) await saveCache(); // průběžně, ať se při přerušení nic neztratí
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }
  throw new Error('Groq: příliš mnoho opakování');
}
export const aiCalls = () => calls;

const CATS = 'kultura|pout|duchovni|zpoved|vzdelavani|rodina|deti|seniori|charita|ostatni';

// Které akce do kalendáře děkanátu patří (zadání od Honzy, 17. 11. 2026)
const SCOPE = `Kalendář je pro děkanát Valašské Meziříčí (farnosti Branky, Dolní a Prostřední Bečva, Hutisko-Solanec, Choryně, Kelč, Lešná, Loučka, Rožnov pod Radhoštěm, Valašské Meziříčí, Valašská Bystřice, Vidče, Zašová, Veselá, Zubří; Centrum pro rodinu a Charita Valašské Meziříčí).
BERE SE jen akce s přesahem do okolních obcí a farností: koncerty a kulturní akce, poutě, přednášky, kurzy (Alfa, příprava snoubenců, manželské večery, kurzy pro rodiče), duchovní obnovy, předvánoční a předvelikonoční zpovídání (i rozpisy zpovídání), večery chval, ekumenická setkání, děkanátní setkání (rodin, mládeže, seniorů, ministrantů), děkanátní turnaje, výstavy, farní dny a plesy otevřené veřejnosti, akce Charity (Tříkrálová sbírka, sbírka potravin, benefice), akce Centra pro rodinu.
NEBERE SE: běžné mše svaté a jejich úmysly, adorace, růženec, pravidelné pobožnosti, zpověď před mší, schůzky společenství a spolků, porady, pastorační a ekonomické rady, úklid, rozpisy služeb, výuka náboženství, svatby, křty, pohřby, nedělní sbírky při mších (např. sbírka na misie, na Charitu, na pronásledované křesťany), dušičkové pobožnosti na hřbitově, odpustky, ohlášky bez konkrétní akce, pravidelná setkání skupin mládeže a společenství.
Akce MIMO děkanát (např. Velehrad, Svatý Hostýn, Frýdek-Místek, Olomouc) se berou JEN když je pořádá farnost nebo organizace z děkanátu, nebo je výslovně určená pro tento děkanát (např. děkanátní pouť na Svatý Hostýn).`;

/**
 * Vytáhne akce z textu. context = popis zdroje (např. „ohlášky farnosti Dolní Bečva 15. 11. 2026“).
 * images = seznam URL obrázků, které se v textu objevují jako [OBRÁZEK n] – AI vybere plakát.
 */
export async function extractEvents(text, { context, refDate, images = [] }) {
  const system = `Jsi pečlivý extraktor akcí pro kalendář akcí děkanátu. Zdroj: ${context}. Datum zdroje: ${refDate}.
${SCOPE}
Vypiš jen akce, které se BEROU, a jen s konkrétním datem. Zahrň i akce, které už proběhly, pokud mají jasné datum.
Opakovaná akce (kurz s více setkáními) = jedna položka na každý termín.
Rok: když není uveden, odvoď ho z data zdroje (akce bývají v blízkém okolí data zdroje).
Nevymýšlej: chybí-li čas nebo místo, dej null. Místo uveď i s obcí (např. „fara Zubří“, „kostel sv. Martina, Zašová“). Název piš stručně a věcně (jak by byl v kalendáři), bez data.
organizer = kdo akci pořádá, pokud to ze zdroje plyne (farnost, Centrum pro rodinu, Charita…), jinak null.
${images.length ? 'Obrázky v textu jsou označené [OBRÁZEK n]. Pokud k akci patří plakát/obrázek ve stejném bloku textu, uveď jeho číslo v "image", jinak null.' : ''}
Odpověz jen JSON: {"events":[{"title":"","date":"YYYY-MM-DD","endDate":"YYYY-MM-DD"|null,"time":"HH:MM"|null,"endTime":"HH:MM"|null,"location":null,"organizer":null,"summary":"1–2 věty","categories":["${CATS}"],"tags":["1–3 krátké štítky malými písmeny"],"image":null,"quote":"krátký DOSLOVNÝ úryvek ze zdroje, který obsahuje datum akce"}]}`;
  const c = await loadCache();
  const key = 'ex-' + hash(`${PROMPT_VERSION}|${MODEL}|${system}|${text}`);
  if (!c[key]) {
    let out;
    try { out = await chatJson(system, text); } catch (e) { if (e instanceof AiBudgetError) return []; throw e; }
    c[key] = { at: new Date().toISOString(), events: Array.isArray(out.events) ? out.events : [] };
  }
  // kontrola halucinací: úryvek musí ve zdroji opravdu být, datum musí být platné
  const hay = normalize(text).replace(/\s+/g, ' ');
  return c[key].events.filter((e) => {
    if (!/^\d{4}-\d\d-\d\d$/.test(e.date || '') || Number.isNaN(Date.parse(e.date))) return false;
    if (!e.title) return false;
    const q = normalize(e.quote || '').replace(/\s+/g, ' ').trim();
    return q.length >= 4 && hay.includes(q.slice(0, 60));
  }).map((e) => ({ ...e, image: Number.isInteger(e.image) && images[e.image - 1] ? images[e.image - 1] : null }));
}

/**
 * Patří strukturovaná akce (z kalendáře farnosti) do kalendáře děkanátu? Výsledek v cache.
 * → { keep: bool, categories: [] }
 */
export async function classifyEvent(ev, sourceName) {
  const c = await loadCache();
  const input = `zdroj: ${sourceName}\nnázev: ${ev.title}\nzačátek: ${ev.start}\nmísto: ${ev.location || '?'}\npopis: ${(ev.description || '').slice(0, 600)}`;
  const key = 'cl-' + hash(`${PROMPT_VERSION}|${MODEL}|${input}`);
  if (c[key] === undefined) {
    const system = `Rozhoduješ, zda akce patří do kalendáře akcí děkanátu.
${SCOPE}
Odpověz jen JSON {"keep":true|false,"categories":["${CATS}"]}.`;
    const out = await chatJson(system, input);
    c[key] = { keep: !!out.keep, categories: Array.isArray(out.categories) ? out.categories : [] };
  }
  return c[key];
}

/** Jsou dvě akce ze stejného dne tatáž akce? (jen sporné páry; výsledek v cache) */
export async function sameEvent(a, b) {
  const c = await loadCache();
  const key = 'dup-' + hash(`${PROMPT_VERSION}|${a.title}|${a.start}|${a.location || ''}|${b.title}|${b.start}|${b.location || ''}`);
  if (c[key] === undefined) {
    const system = 'Rozhodni, zda dva záznamy z různých zdrojů (weby farností, Centrum pro rodinu) popisují TUTÉŽ akci (stejný den). Např. „Adventní obnova pro ženy“ a „Duchovní obnova pro ženy – advent“ téhož dne = ano. Různé typy akcí nebo různá místa = ne. Odpověz JSON {"same":true|false}.';
    const fmtE = (e) => `název: ${e.title}\nzačátek: ${e.start}\nmísto: ${e.location || '?'}\npopis: ${(e.description || '').slice(0, 300)}`;
    let out;
    try { out = await chatJson(system, `A)\n${fmtE(a)}\n\nB)\n${fmtE(b)}`); } catch (e) { if (e instanceof AiBudgetError) return false; throw e; }
    c[key] = !!out.same;
  }
  return c[key];
}

// ---- Text z plakátu (obrázku) – Groq model s viděním; výsledek v cache podle URL --------------
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
export async function ocrImage(url) {
  const c = await loadCache();
  const key = 'ocr-' + hash(`${VISION_MODEL}|${url}`);
  if (c[key] !== undefined) return c[key].text;
  const key2 = apiKey();
  if (!key2) throw new Error('chybí GROQ_API_KEY');
  const ask = async (imageUrl) => {
    if (budgetOut.has(VISION_MODEL)) throw new AiBudgetError('vyčerpaný denní limit Groq');
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: VISION_MODEL, temperature: 0, messages: [{ role: 'user', content: [
          { type: 'text', text: 'Přepiš doslovně veškerý text z tohoto plakátu nebo obrázku (česky), včetně dat, časů a míst. Jen text, nic dalšího. Když obrázek žádný text nemá, odpověz prázdně.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ] }] }),
        signal: AbortSignal.timeout(120000),
      });
      await checkDaily(res, VISION_MODEL);
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(90, Number(res.headers.get('retry-after')) || 20 * (attempt + 1));
        console.log(`  AI (obrázek): ${res.status}, čekám ${wait} s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      calls++;
      if (calls % 5 === 0) await saveCache();
      return (await res.json()).choices[0].message.content || '';
    }
    throw new Error('Groq: příliš mnoho opakování');
  };
  let text;
  try { text = await ask(url); } catch (e) {
    if (e instanceof AiBudgetError) throw e;
    // když si Groq obrázek sám nestáhne, pošleme ho přímo (do ~3 MB)
    const r = await fetch(url, { headers: { 'User-Agent': 'KalendarDekanat/1.0' }, signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok || buf.length > 3e6) throw e;
    text = await ask(`data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`);
  }
  text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  c[key] = { at: new Date().toISOString(), text };
  return text;
}
