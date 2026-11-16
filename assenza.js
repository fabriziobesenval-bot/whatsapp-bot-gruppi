'use strict';
// Avviso "Assistente IA" quando in un gruppo ti scrivono e tu non rispondi.
// Si attiva per gruppo in gruppi.json con:  "assenza": { "attivo": true }
// Opzioni: dopoMessaggi (2), dopoMinuti (5), pausaOre (6), testo
module.exports = function creaAssenza({ client, configGruppo, config, log }) {
  const stato = new Map(); // chatId -> { conta, timer, avvisato, ultimoAvviso }
  const testoBase = `🤖 Ciao, sono l'Assistente IA di ${config.mioNome}: in questo momento non riesce a rispondere, lo farà appena possibile.`;
  const opzioni = (g) =>
    Object.assign({ attivo: false, dopoMessaggi: 2, dopoMinuti: 5, pausaOre: 6, testo: testoBase }, g && g.assenza);

  async function controlla(chatId) {
    const s = stato.get(chatId);
    if (!s) return;
    s.timer = null;
    const g = configGruppo(chatId);
    const a = opzioni(g);
    if (!a.attivo || s.avvisato || s.conta < a.dopoMessaggi) return;
    if (Date.now() - s.ultimoAvviso < a.pausaOre * 3600000) return;
    s.avvisato = true;
    s.ultimoAvviso = Date.now();
    await client.sendMessage(chatId, a.testo);
    log(`🤖 ${g.nome}: avviso "Assistente IA" inviato (${s.conta} messaggi senza risposta)`);
  }

  // un messaggio di un altro nel gruppo
  function suMessaggioAltrui(msg) {
    const chatId = msg.from;
    const a = opzioni(configGruppo(chatId));
    if (!a.attivo) return;
    const s = stato.get(chatId) || { conta: 0, timer: null, avvisato: false, ultimoAvviso: 0 };
    stato.set(chatId, s);
    if (s.avvisato) return;
    s.conta++;
    if (!s.timer) {
      s.timer = setTimeout(() => controlla(chatId).catch((e) => log('❌ Avviso assenza:', e.message)), a.dopoMinuti * 60000);
    }
  }

  // un tuo messaggio (anche dal telefono): azzera il conteggio
  function suMioMessaggio(msg) {
    const chatId = msg.to;
    if (!chatId || !chatId.endsWith('@g.us')) return;
    if ((msg.body || '') === opzioni(configGruppo(chatId)).testo) return; // è l'avviso stesso
    const s = stato.get(chatId);
    if (!s) return;
    clearTimeout(s.timer);
    s.timer = null;
    s.conta = 0;
    s.avvisato = false;
  }

  return { suMessaggioAltrui, suMioMessaggio };
};
