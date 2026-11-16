#!/bin/bash
# Installa il bot WhatsApp in un container/VM Debian (12 o 13) su Proxmox.
# Uso, da root, dentro la cartella del bot:
#   bash installa-proxmox.sh [modello]                              -> installa anche Ollama qui
#   bash installa-proxmox.sh --ollama http://IP:11434 [modello]     -> usa un Ollama che hai già
# Si può rilanciare per aggiornare: config.json e gruppi.json esistenti NON vengono sovrascritti.
set -e

OLLAMA_URL=""
if [ "$1" = "--ollama" ]; then
  OLLAMA_URL="${2%/}"
  shift 2
  [ -n "$OLLAMA_URL" ] || { echo "Indica l'indirizzo, es: --ollama http://10.0.0.20:11434"; exit 1; }
fi
MODELLO="${1:-gemma4:e4b}"
DEST=/opt/whatsapp-bot
UTENTE=wabot
SORGENTE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "Lancia lo script come root"; exit 1; }

echo "==> Pacchetti di sistema (Node.js, browser, font)"
apt-get update
apt-get install -y nodejs npm fonts-noto-color-emoji ca-certificates curl zstd
if grep -qi ubuntu /etc/os-release; then
  # su Ubuntu "chromium" è uno snap, che nei container non funziona: uso Google Chrome
  if [ ! -x /usr/bin/google-chrome ]; then
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y /tmp/chrome.deb
    rm -f /tmp/chrome.deb
  fi
  BROWSER=/usr/bin/google-chrome
else
  apt-get install -y chromium
  BROWSER=/usr/bin/chromium
fi

NODEV=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODEV" -ge 18 ] || { echo "Serve Node.js 18 o superiore (trovato $NODEV)"; exit 1; }

if [ -n "$OLLAMA_URL" ]; then
  echo "==> Uso l'Ollama esistente su $OLLAMA_URL"
  if ! curl -fsS --max-time 10 "$OLLAMA_URL/api/tags" >/dev/null; then
    echo
    echo "ERRORE: Ollama non risponde su $OLLAMA_URL"
    echo "Sulla macchina dove gira Ollama deve ascoltare in rete, non solo su localhost:"
    echo "   systemctl edit ollama"
    echo "   aggiungi:  [Service]"
    echo "              Environment=\"OLLAMA_HOST=0.0.0.0:11434\""
    echo "   poi:       systemctl restart ollama"
    exit 1
  fi
  if curl -fsS "$OLLAMA_URL/api/tags" | grep -q "\"name\":\"$MODELLO\""; then
    echo "    modello $MODELLO già presente"
  else
    echo "==> Faccio scaricare a Ollama il modello $MODELLO (alcuni GB, attendi...)"
    curl -fsS -X POST "$OLLAMA_URL/api/pull" -d "{\"model\":\"$MODELLO\",\"stream\":false}" --max-time 3600
    echo
  fi
  INDIRIZZO_OLLAMA="$OLLAMA_URL"
  DOPO_OLLAMA=""
else
  echo "==> Ollama (AI locale gratuita)"
  if ! command -v ollama >/dev/null; then
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  systemctl enable --now ollama
  sleep 3
  echo "==> Scarico il modello $MODELLO (alcuni GB, attendi...)"
  ollama pull "$MODELLO"
  INDIRIZZO_OLLAMA="http://localhost:11434"
  DOPO_OLLAMA="ollama.service"
fi

echo "==> Copio il bot in $DEST"
id "$UTENTE" >/dev/null 2>&1 || useradd -r -m -d /var/lib/$UTENTE -s /usr/sbin/nologin "$UTENTE"
mkdir -p "$DEST"
cp "$SORGENTE"/bot.js "$SORGENTE"/assenza.js "$SORGENTE"/pannello.html "$SORGENTE"/package.json "$DEST"/
cp -r "$SORGENTE"/docs "$DEST"/ 2>/dev/null || true
[ -f "$DEST/config.json" ] || cp "$SORGENTE/config.json" "$DEST/"
[ -f "$DEST/gruppi.json" ] || cp "$SORGENTE/gruppi.json" "$DEST/"

# impostazioni per Linux/Proxmox dentro config.json
PASSWORD_GENERATA=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
node -e '
const fs = require("fs"), f = process.argv[1];
const c = JSON.parse(fs.readFileSync(f, "utf8"));
delete c.chromium; // si usa il Chrome scaricato da puppeteer (vedi sotto)
c.accessoDaRete = true;
if (!c.passwordPannello) c.passwordPannello = process.argv[2];
c.ai = c.ai || "ollama";
c.ollama = Object.assign({}, c.ollama, { indirizzo: process.argv[4], modello: process.argv[3] });
fs.writeFileSync(f, JSON.stringify(c, null, 2));
' "$DEST/config.json" "$PASSWORD_GENERATA" "$MODELLO" "$INDIRIZZO_OLLAMA"

echo "==> Installo le dipendenze Node"
cd "$DEST"
PUPPETEER_SKIP_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund
chown -R "$UTENTE":"$UTENTE" "$DEST"

# Chrome "per test" scaricato da puppeteer: su Ubuntu il Google Chrome di sistema
# è bloccato da AppArmor dentro i container (niente rete), questo invece funziona
echo "==> Scarico il Chrome usato dal bot"
runuser -u "$UTENTE" -- env HOME=/var/lib/$UTENTE npx puppeteer browsers install chrome

echo "==> Servizio di avvio automatico"
cat > /etc/systemd/system/whatsapp-bot.service <<EOF
[Unit]
Description=Bot WhatsApp gruppi
After=network-online.target $DOPO_OLLAMA
Wants=network-online.target

[Service]
User=$UTENTE
WorkingDirectory=$DEST
Environment=PUPPETEER_SKIP_DOWNLOAD=1
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable whatsapp-bot
systemctl restart whatsapp-bot

IP=$(hostname -I | awk '{print $1}')
PORTA=$(node -p "require('$DEST/config.json').porta || 3001")
PASS=$(node -p "require('$DEST/config.json').passwordPannello")
echo
echo "============================================================"
echo " Bot installato e avviato."
echo " Pannello:  http://$IP:$PORTA"
echo " Password:  $PASS   (utente: qualsiasi)"
echo " Apri il pannello e inquadra il QR code dal telefono."
echo
echo " Comandi utili:"
echo "   journalctl -u whatsapp-bot -f      # vedere cosa fa il bot"
echo "   systemctl restart whatsapp-bot     # riavviarlo"
echo "   nano $DEST/gruppi.json             # configurare i gruppi"
echo "============================================================"
