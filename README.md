# Kalendář akcí – děkanát Valašské Meziříčí

Souhrnný kalendář akcí farností děkanátu Valašské Meziříčí a Centra pro rodinu: koncerty, poutě, přednášky, kurzy Alfa, příprava snoubenců, duchovní obnovy, předvánoční a předvelikonoční zpovídání…

- Web: https://varmuzaj-git.github.io/kalendar-dekanat/ (vkládá se na https://dekanatvalmez.cz/ shortcodem `[kalendar_akci]`)
- Odběr do kalendáře: `data/akce.ics`
- Aktualizace 3× denně (GitHub Actions, `.github/workflows/update.yml`)

## Jak to funguje
`scripts/collect.mjs` stáhne akce ze zdrojů (`config/sources.json`):

| Zdroj | Adaptér | Jak |
|---|---|---|
| Akce zadané na dekanatvalmez.cz | `wp-manual` | plugin `wp-plugin/kalendar-dekanat` (REST) |
| Rožnov, Val. Meziříčí, Kelč, Zašová, Loučka | `agenda` | Agenda farnosti: oznámení, kalendář (vybrané typy), články (AI) |
| Zubří, Vidče | `chilli` | seznam událostí na webu farnosti |
| Valašská Bystřice | `tribe` | The Events Calendar (REST) |
| Hutisko | `ai-page` | aktuality (AI) |
| Dolní Bečva | `pdf-ohlasky` | týdenní ohlášky v PDF (AI) |
| Choryně, Centrum pro rodinu | `ai-links` | články a plakáty (AI) |

Výběr akcí („jen akce s přesahem do okolních obcí a farností“) je popsaný v `scripts/ai.mjs` (SCOPE).
Akce z kalendářů farností posuzuje AI (Groq), text z plakátů čte model s viděním. Výsledky AI jsou v `cache/ai.json`, takže se stejný text neposílá znovu.

Typy akcí: `config/categories.json`, pořadatelé: `config/organizers.json` (id musí odpovídat pluginu).
