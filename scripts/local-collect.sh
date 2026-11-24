#!/bin/bash
# Sběr akcí děkanátu z místního serveru agenta (1× denně z cronu) → commit + push → GitHub Pages.
# Weby na Agendě farnosti (Rožnov, Kelč, Zašová) a CPR servery GitHubu blokují, proto se nesbírá v Actions.
# Volitelný argument: id zdroje (např. „rucne“) → sbírá se jen ten, ostatní akce zůstanou z cache.
set -euo pipefail
ONLY="${1:-}"
export PATH="$HOME/.local/bin:$PATH"   # cron má minimální PATH (node je v ~/.local/bin)
cd "$(dirname "$0")/.."
LOG="$HOME/.local/state/dekanat-kalendar/collect-last${ONLY:+-$ONLY}.log"
exec 9>"$HOME/.local/state/dekanat-kalendar/collect.lock"
flock -n 9 || { echo "$(date -Is) ${ONLY:-vše}: už běží"; exit 0; }
export GIT_SSH_COMMAND="ssh -i $HOME/.config/kalendar-dekanat/deploy_key -o IdentitiesOnly=yes"
git pull -q --rebase
node scripts/collect.mjs ${ONLY:+--only=$ONLY} > "$LOG" 2>&1 || { echo "$(date -Is) ${ONLY:-vše}: collect selhal"; tail -5 "$LOG"; exit 1; }
git add public/data cache
if git diff --cached --quiet -- public/data/events.json cache; then git reset -q; git checkout -q -- public/data cache 2>/dev/null || true; [ -n "$ONLY" ] || echo "$(date -Is) beze změny"; exit 0; fi
git -c user.name="Petr (agent)" -c user.email="varmuzaj@gmail.com" commit -qm "Aktualizace akcí${ONLY:+ ($ONLY)} $(date -u +%Y-%m-%dT%H:%MZ)"
git pull -q --rebase -X theirs && git push -q
echo "$(date -Is) ${ONLY:-vše}: odesláno"
