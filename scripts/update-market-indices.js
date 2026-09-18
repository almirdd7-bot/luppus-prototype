/**
 * Roda 2x/dia via GitHub Actions (.github/workflows/update-market-indices.yml).
 * Busca as cotações na Alpha Vantage usando a chave guardada como GitHub Secret
 * (nunca aparece no código nem no navegador) e grava no mesmo documento do
 * Firestore que o app já lê (luppus_system/market_data), no mesmo formato
 * que app.js espera — então o front-end não muda a lógica de leitura, só
 * para de fazer a chamada direto com a chave exposta.
 */
const admin = require('firebase-admin');

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

if (!ALPHA_VANTAGE_KEY || !SERVICE_ACCOUNT_JSON) {
  console.error('Faltando ALPHA_VANTAGE_KEY ou FIREBASE_SERVICE_ACCOUNT_KEY nas variáveis de ambiente.');
  process.exit(1);
}

const MARKET_INDICES = [
  { symbol: 'QQQ', label: 'NASDAQ' },
  { symbol: 'EWG', label: 'DAX (Frankfurt)' },
  { symbol: 'EWU', label: 'FTSE 100' }
];

// Replica exatamente o mesmo formato de slot que app.js (getMarketSlotKey) gera
// no navegador, calculado em horário de São Paulo, para que a comparação
// `data.slot === slotKey` no cliente continue funcionando.
function getMarketSlotKeySaoPaulo() {
  const shifted = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(shifted);
  const get = (t) => parts.find(p => p.type === t).value;
  const year = Number(get('year'));
  const month0 = Number(get('month')) - 1; // getMonth() do JS é 0-indexado
  const day = Number(get('day'));
  const hour = Number(get('hour'));
  const slot = hour < 12 ? 'AM' : 'PM';
  return `${year}-${month0}-${day}-${slot}`;
}

async function fetchQuote(symbol) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const q = data['Global Quote'];
  if (!q || !q['10. change percent']) return null;
  return parseFloat(q['10. change percent']);
}

async function main() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(SERVICE_ACCOUNT_JSON))
  });
  const db = admin.firestore();

  const indices = {};
  for (const m of MARKET_INDICES) {
    try {
      const pct = await fetchQuote(m.symbol);
      if (pct !== null) indices[m.label] = pct;
    } catch (err) {
      console.error(`Falha ao buscar ${m.symbol}:`, err.message);
    }
  }

  if (Object.keys(indices).length === 0) {
    console.error('Nenhuma cotação obtida — não sobrescrevendo o Firestore.');
    process.exit(1);
  }

  const slotKey = getMarketSlotKeySaoPaulo();
  await db.collection('luppus_system').doc('market_data').set({ slot: slotKey, indices });
  console.log('Atualizado luppus_system/market_data:', slotKey, indices);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
