'use strict';
/*
 * Bot WhatsApp per le chat di gruppo
 *  - modalita "auto":    risponde da solo con l'AI
 *  - modalita "approva": prepara una bozza che approvi dal pannello web o dal telefono
 *  - modalita "off":     ignora il gruppo
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const DIR = __dirname;
const FILE_CONFIG = path.join(DIR, 'config.json');
const FILE_GRUPPI = path.join(DIR, 'gruppi.json');
const FILE_BOZZE = path.join(DIR, 'bozze.json');

// ---------- utilità ----------
const log = (...a) => console.log(new Date().toLocaleTimeString('it-IT'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const caso = (min, max) => min + Math.random() * (max - min);
const accorcia = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

function leggiJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function scriviJson(file, dati) {
  fs.writeFileSync(file, JSON.stringify(dati, null, 2), 'utf8');
}

// ---------- configurazione ----------
let config;
try {
  config = Object.assign(
    {
      ai: 'ollama',
      ollama: {},
      gemini: {},
      mioNome: 'Io',
      istruzioniGenerali: '',
      firma: '',
      pausaMinSecondi: 10,
      pausaMaxSecondi: 30,
      messaggiDiContesto: 20,
      notificaSuTelefono: true,
      porta: 3001,
    },
    leggiJson(FILE_CONFIG)
  );
} catch (e) {
  console.error(`Non riesco a leggere config.json: ${e.message}`);
  process.exit(1);
}

// ---------- AI gratuita: Ollama (sul tuo PC) oppure Gemini (piano gratuito Google) ----------
const OLLAMA = Object.assign({ indirizzo: 'http://localhost:11434', modello: 'gemma4:e4b' }, config.ollama);
const GEMINI = Object.assign({ apiKey: '', modello: 'gemini-flash-lite-latest' }, config.gemini);

if (config.ai === 'gemini' && (!GEMINI.apiKey || GEMINI.apiKey.startsWith('INCOLLA'))) {
  console.error('Hai scelto Gemini ma manca la chiave: creala gratis su https://aistudio.google.com e inseriscila in config.json.');
  process.exit(1);
}
if (!['ollama', 'gemini'].includes(config.ai)) {
  console.error('In config.json "ai" deve essere "ollama" oppure "gemini".');
  process.exit(1);
}

async function chiediAllAI(system, utente) {
  if (config.ai === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI.modello}:generateContent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: utente }] }],
        generationConfig: { maxOutputTokens: 600, temperature: 0.7 },
      }),
    });
    if (r.status === 429) throw new Error('limite gratuito di Gemini raggiunto, riprova più tardi');
    if (!r.ok) throw new Error(`Gemini ha risposto ${r.status}: ${accorcia(await r.text(), 200)}`);
    const d = await r.json();
    const parti = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return parti.map((p) => p.text || '').join('');
  }

  const corpo = {
    model: OLLAMA.modello,
    stream: false,
    think: false, // niente "ragionamento" nei modelli che lo prevedono (qwen3, ecc.): risposte più rapide
    options: { temperature: 0.7, num_predict: 600 },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: utente },
    ],
  };
  const invia = () =>
    fetch(`${OLLAMA.indirizzo.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
  let r;
  try {
    r = await invia();
    if (r.status === 400 && /think/i.test(await r.clone().text())) {
      delete corpo.think; // il modello non supporta l'opzione: riprovo senza
      r = await invia();
    }
  } catch (_) {
    throw new Error(`Ollama non risponde su ${OLLAMA.indirizzo}: è avviato?`);
  }
  if (r.status === 404) throw new Error(`modello "${OLLAMA.modello}" non installato: esegui  ollama pull ${OLLAMA.modello}`);
  if (!r.ok) throw new Error(`Ollama ha risposto ${r.status}: ${accorcia(await r.text(), 200)}`);
  const d = await r.json();
  return (d.message && d.message.content) || '';
}

async function controllaAI() {
  if (config.ai !== 'ollama') return log(`AI: Gemini (${GEMINI.modello}, piano gratuito)`);
  try {
    const r = await fetch(`${OLLAMA.indirizzo.replace(/\/$/, '')}/api/tags`);
    const d = await r.json();
    const ok = (d.models || []).some((m) => m.name === OLLAMA.modello || m.name === `${OLLAMA.modello}:latest`);
    log(ok ? `AI: Ollama, modello ${OLLAMA.modello} ✅` : `⚠️  Ollama è avviato ma manca il modello: esegui  ollama pull ${OLLAMA.modello}`);
  } catch (_) {
    log(`⚠️  Ollama non risponde su ${OLLAMA.indirizzo}: installalo da https://ollama.com e avvialo`);
  }
}

const DEFAULT_GRUPPO = { nome: '', modalita: 'off', quando: 'menzione', parole: [], istruzioni: '', maxOra: 5 };

// gruppi.json viene riletto quando cambia, così puoi modificarlo a bot acceso
let gruppi = { gruppi: {} };
let gruppiMtime = 0;
function caricaGruppi() {
  try {
    const mtime = fs.statSync(FILE_GRUPPI).mtimeMs;
    if (mtime === gruppiMtime) return gruppi;
    const nuovi = leggiJson(FILE_GRUPPI);
    nuovi.gruppi = nuovi.gruppi || {};
    gruppi = nuovi;
    gruppiMtime = mtime;
    if (pronto) log('gruppi.json ricaricato');
  } catch (e) {
    if (e.code === 'ENOENT') gruppi = { gruppi: {} };
    else log(`⚠️  gruppi.json contiene un errore, uso la versione precedente: ${e.message}`);
  }
  return gruppi;
}
function salvaGruppi() {
  scriviJson(FILE_GRUPPI, gruppi);
  gruppiMtime = fs.statSync(FILE_GRUPPI).mtimeMs;
}
function configGruppo(chatId) {
  const g = caricaGruppi().gruppi[chatId];
  return g ? Object.assign({}, DEFAULT_GRUPPO, g) : null;
}

// ---------- bozze ----------
let bozze = { prossimoId: 1, lista: [] };
try {
  bozze = leggiJson(FILE_BOZZE);
} catch (_) {}
const salvaBozze = () => scriviJson(FILE_BOZZE, bozze);

// ---------- limite di risposte all'ora ----------
const invii = new Map(); // chatId -> [timestamp]
function inviiUltimaOra(chatId) {
  const ora = Date.now();
  const lista = (invii.get(chatId) || []).filter((t) => ora - t < 3600_000);
  invii.set(chatId, lista);
  return lista.length;
}
const registraInvio = (chatId) => invii.set(chatId, [...(invii.get(chatId) || []), Date.now()]);

// ---------- WhatsApp ----------
let pronto = false;
let ultimoQr = null;
let mioId = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DIR, '.sessione') }),
  puppeteer: {
    headless: true,
    timeout: 120000, // su macchine lente Chrome può metterci un po' ad avviarsi
    pipe: true, // comunica con Chrome senza porta di rete (necessario nei container Proxmox)
    executablePath: config.chromium || undefined, // su Linux: "/usr/bin/chromium"
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', async (qr) => {
  ultimoQr = await QRCode.toDataURL(qr);
  log(`Inquadra il QR code dal telefono (WhatsApp > Dispositivi collegati), qui sotto o su http://localhost:${config.porta}`);
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('authenticated', () => log('Accesso riuscito'));
client.on('auth_failure', (m) => log('❌ Accesso fallito:', m));
client.on('disconnected', (m) => {
  pronto = false;
  log('❌ Disconnesso da WhatsApp:', m, '- chiudo il bot (su Proxmox ripartirà da solo)');
  setTimeout(() => process.exit(1), 2000);
});

client.on('ready', async () => {
  pronto = true;
  ultimoQr = null;
  mioId = client.info.wid._serialized;
  log(`✅ Collegato come ${client.info.pushname || mioId}`);

  // aggiunge a gruppi.json i gruppi nuovi (spenti) e aggiorna i nomi
  const chats = await client.getChats();
  const gr = chats.filter((c) => c.isGroup);
  caricaGruppi();
  let aggiunti = 0;
  for (const c of gr) {
    const id = c.id._serialized;
    if (!gruppi.gruppi[id]) {
      gruppi.gruppi[id] = { ...DEFAULT_GRUPPO, nome: c.name };
      aggiunti++;
    } else {
      gruppi.gruppi[id].nome = c.name;
    }
  }
  salvaGruppi();
  log(`Trovati ${gr.length} gruppi${aggiunti ? `, ${aggiunti} nuovi aggiunti a gruppi.json (spenti)` : ''}:`);
  for (const [id, g] of Object.entries(gruppi.gruppi)) {
    log(`   [${(g.modalita || 'off').padEnd(7)}] ${g.nome}`);
  }
  log(`Pannello bozze: http://localhost:${config.porta}`);
});

// Decide se il messaggio merita una reazione del bot
async function deveReagire(msg, g) {
  const testo = (msg.body || '').toLowerCase();
  if (g.quando === 'sempre') return true;
  if (g.quando === 'parole') return (g.parole || []).some((p) => p && testo.includes(String(p).toLowerCase()));

  // "menzione": ti taggano, rispondono a un tuo messaggio o scrivono il tuo nome
  try {
    const menzioni = await msg.getMentions();
    if (menzioni.some((c) => c.isMe)) return true;
  } catch (_) {}
  if (msg.hasQuotedMsg) {
    try {
      const citato = await msg.getQuotedMessage();
      if (citato && citato.fromMe) return true;
    } catch (_) {}
  }
  const nome = (config.mioNome || '').toLowerCase();
  return nome.length > 2 && new RegExp(`\\b${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(testo);
}

// Aspetta un po' prima di rispondere: se arrivano altri messaggi, risponde una volta sola all'ultimo
const inAttesa = new Map(); // chatId -> { timer, msg }
function pianifica(msg) {
  const chatId = msg.from;
  const precedente = inAttesa.get(chatId);
  if (precedente) clearTimeout(precedente.timer);
  const ritardo = caso(config.pausaMinSecondi, config.pausaMaxSecondi) * 1000;
  const timer = setTimeout(() => {
    const voce = inAttesa.get(chatId);
    inAttesa.delete(chatId);
    elabora(voce.msg).catch((e) => log('❌ Errore:', e.message));
  }, ritardo);
  inAttesa.set(chatId, { timer, msg });
}

function nomeAutore(m) {
  if (m.fromMe) return `${config.mioNome} (tu)`;
  return (m._data && m._data.notifyName) || (m.author || m.from || '').split('@')[0];
}

async function generaRisposta(g, nomeGruppo, cronologia, ultimo, autore) {
  const system = [
    config.istruzioniGenerali,
    g.istruzioni ? `Istruzioni specifiche per questo gruppo:\n${g.istruzioni}` : '',
    'Se l\'ultimo messaggio non richiede una risposta da parte tua (saluti generici, discorsi tra altri, messaggi già risolti), rispondi soltanto con la parola SKIP.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const utente =
    `Gruppo WhatsApp: "${nomeGruppo}"\n\n` +
    `Ultimi messaggi del gruppo:\n${cronologia}\n\n` +
    `Messaggio a cui rispondere, scritto da ${autore}:\n${ultimo}\n\n` +
    'Scrivi solo il testo della risposta, senza virgolette e senza premesse.';

  const testo = (await chiediAllAI(system, utente))
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // alcuni modelli locali scrivono il "ragionamento"
    .replace(/^["«]|["»]$/g, '')
    .trim();
  if (!testo || /^SKIP\b/i.test(testo)) return null;
  return testo;
}

const conFirma = (t) => (config.firma ? `${t}\n${config.firma}` : t);

async function elabora(msg) {
  const chatId = msg.from;
  const g = configGruppo(chatId);
  if (!g || g.modalita === 'off') return;

  if (inviiUltimaOra(chatId) >= g.maxOra) {
    log(`⏸  ${g.nome}: limite di ${g.maxOra} risposte/ora raggiunto, salto`);
    return;
  }

  const chat = await msg.getChat();
  const storico = await chat.fetchMessages({ limit: config.messaggiDiContesto });
  const cronologia = storico
    .filter((m) => m.body)
    .map((m) => {
      const ora = new Date(m.timestamp * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      return `[${ora}] ${nomeAutore(m)}: ${accorcia(m.body, 500)}`;
    })
    .join('\n');
  const autore = nomeAutore(msg);

  const testo = await generaRisposta(g, chat.name, cronologia, msg.body, autore);
  if (!testo) {
    log(`…  ${g.nome}: nessuna risposta necessaria`);
    return;
  }

  if (g.modalita === 'auto') {
    try {
      await chat.sendStateTyping();
    } catch (_) {}
    await sleep(Math.min(2000 + testo.length * 60, 9000)); // simula il tempo di scrittura
    await msg.reply(conFirma(testo));
    registraInvio(chatId);
    log(`💬 ${g.nome}: risposto a ${autore}`);
  } else if (g.modalita === 'approva') {
    const b = {
      id: bozze.prossimoId++,
      chatId,
      gruppo: chat.name,
      autore,
      originale: msg.body,
      msgId: msg.id._serialized,
      testo,
      creata: Date.now(),
      stato: 'attesa',
    };
    bozze.lista.push(b);
    salvaBozze();
    registraInvio(chatId);
    log(`📝 ${g.nome}: bozza #${b.id} da approvare`);
    if (config.notificaSuTelefono && mioId) {
      await client.sendMessage(
        mioId,
        `📝 *Bozza #${b.id}* – ${b.gruppo}\n` +
          `Da ${autore}: «${accorcia(b.originale, 300)}»\n\n` +
          `Proposta:\n${b.testo}\n\n` +
          `Rispondi qui:  *si ${b.id}*  ·  *no ${b.id}*  ·  *mod ${b.id} nuovo testo*`
      );
    }
  }
}

async function inviaBozza(id, testoModificato) {
  const b = bozze.lista.find((x) => x.id === id);
  if (!b) throw new Error(`Bozza #${id} non trovata`);
  if (b.stato !== 'attesa') throw new Error(`Bozza #${id} già ${b.stato}`);
  const testo = conFirma((testoModificato || b.testo).trim());
  let originale = null;
  try {
    originale = await client.getMessageById(b.msgId);
  } catch (_) {}
  if (originale) await originale.reply(testo);
  else await client.sendMessage(b.chatId, testo);
  b.stato = 'inviata';
  b.testo = testoModificato || b.testo;
  b.inviata = Date.now();
  salvaBozze();
  log(`✅ Bozza #${id} inviata in ${b.gruppo}`);
  return b;
}

function scartaBozza(id) {
  const b = bozze.lista.find((x) => x.id === id);
  if (!b) throw new Error(`Bozza #${id} non trovata`);
  if (b.stato !== 'attesa') throw new Error(`Bozza #${id} già ${b.stato}`);
  b.stato = 'scartata';
  salvaBozze();
  log(`🗑  Bozza #${id} scartata`);
  return b;
}

// Avviso "Assistente IA" quando non rispondi
const assenza = require('./assenza')({ client, configGruppo, config, log });

// Messaggi in arrivo nei gruppi
client.on('message', async (msg) => {
  try {
    if (msg.fromMe || !msg.from.endsWith('@g.us')) return;
    assenza.suMessaggioAltrui(msg);
    if (!msg.body) return;
    const g = configGruppo(msg.from);
    if (!g || g.modalita === 'off') return;
    if (await deveReagire(msg, g)) pianifica(msg);
  } catch (e) {
    log('❌ Errore:', e.message);
  }
});

// Approvazione dal telefono: comandi scritti nella chat "Messaggi a te stesso"
client.on('message_create', async (msg) => {
  if (msg.fromMe) assenza.suMioMessaggio(msg);
  if (!config.notificaSuTelefono || !msg.fromMe || msg.from !== msg.to) return;
  const t = (msg.body || '').trim();
  let m;
  try {
    if ((m = t.match(/^s[iì]\s+(\d+)$/i))) {
      await inviaBozza(Number(m[1]));
      await client.sendMessage(mioId, `✅ Bozza #${m[1]} inviata`);
    } else if ((m = t.match(/^no\s+(\d+)$/i))) {
      scartaBozza(Number(m[1]));
      await client.sendMessage(mioId, `🗑 Bozza #${m[1]} scartata`);
    } else if ((m = t.match(/^mod\s+(\d+)\s+([\s\S]+)$/i))) {
      await inviaBozza(Number(m[1]), m[2]);
      await client.sendMessage(mioId, `✅ Bozza #${m[1]} inviata con le tue modifiche`);
    }
  } catch (e) {
    await client.sendMessage(mioId, `⚠️ ${e.message}`);
  }
});

// ---------- pannello web ----------
const app = express();
if (config.passwordPannello) {
  // accesso con utente qualsiasi e la password indicata in config.json
  app.use((req, res, next) => {
    const [, b64 = ''] = (req.headers.authorization || '').split(' ');
    const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (pass === config.passwordPannello) return next();
    res.set('WWW-Authenticate', 'Basic realm="Bot WhatsApp"').status(401).send('Password richiesta');
  });
}
app.use(express.json());
app.get('/', (_req, res) => res.sendFile(path.join(DIR, 'pannello.html')));
app.get('/api/stato', (_req, res) => {
  const inAttesaLista = bozze.lista.filter((b) => b.stato === 'attesa');
  const recenti = bozze.lista.filter((b) => b.stato !== 'attesa').slice(-10).reverse();
  const gr = Object.values(caricaGruppi().gruppi).map((g) => ({ nome: g.nome, modalita: g.modalita || 'off' }));
  res.json({ pronto, qr: ultimoQr, bozze: inAttesaLista, recenti, gruppi: gr });
});
app.post('/api/bozze/:id/invia', async (req, res) => {
  try {
    res.json(await inviaBozza(Number(req.params.id), req.body && req.body.testo));
  } catch (e) {
    res.status(400).json({ errore: e.message });
  }
});
app.post('/api/bozze/:id/scarta', (req, res) => {
  try {
    res.json(scartaBozza(Number(req.params.id)));
  } catch (e) {
    res.status(400).json({ errore: e.message });
  }
});
const host = config.accessoDaRete ? '0.0.0.0' : '127.0.0.1';
app.listen(config.porta, host, () =>
  log(`Pannello avviato su http://${config.accessoDaRete ? '<IP-di-questa-macchina>' : 'localhost'}:${config.porta}`)
);
if (config.accessoDaRete && !config.passwordPannello) log('⚠️  Pannello aperto in rete senza password: imposta "passwordPannello" in config.json');

// ---------- avvio / chiusura ----------
process.on('SIGINT', async () => {
  log('Chiusura in corso…');
  try {
    await client.destroy();
  } catch (_) {}
  process.exit(0);
});

caricaGruppi();
controllaAI();
log('Avvio di WhatsApp Web…');
client.initialize().catch((e) => {
  log(`❌ Non riesco ad aprire WhatsApp Web (${e.message}). Controlla la connessione internet e riavvia il bot.`);
  setTimeout(() => process.exit(1), 500);
});
