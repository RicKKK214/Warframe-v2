#!/usr/bin/env node
/**
 * Local mock of the Warframe.market v2 API for end-to-end preview/verification
 * in the sandbox (the real api.warframe.market is unreachable from here).
 * Serves /items, /item/{slug}, /orders/item/{slug} with realistic data:
 * ~38 Prime sets with a healthy mix of PARTS_TO_SET / SET_TO_PARTS spreads
 * and per-order QUANTITIES (needed by the Capital Calculator).
 */
import http from 'node:http';

// name → parts (compositions mirror the real game loosely; quantities vary)
const WARFRAMES = [
  'ash', 'atlas', 'banshee', 'chroma', 'equinox', 'frost', 'gara', 'garuda',
  'gauss', 'grendel', 'harrow', 'hildryn', 'hydroid', 'inaros', 'ivara',
  'khora', 'loki', 'mag', 'mesa', 'mirage', 'nekros', 'nezha', 'nidus', 'nova',
  'nyx', 'oberon', 'octavia', 'protea', 'rhino', 'saryn', 'titania', 'trinity',
  'valkyr', 'vauban', 'volt', 'wisp', 'wukong', 'zephyr',
];
const WEAPONS = {
  braton_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  burston_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  latron_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  boar_prime: ['blueprint', 'receiver', 'stock', 'barrel'],
  soma_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  stradavar_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  sybaris_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  vectis_prime: ['blueprint', 'barrel', 'receiver', 'stock'],
  nikana_prime: ['blueprint', 'blade', 'hilt'],
  galatine_prime: ['blueprint', 'blade', 'handle'],
  gram_prime: ['blueprint', 'blade', 'heavy_blade'],
  fragor_prime: ['blueprint', 'head', 'handle'],
  orthos_prime: ['blueprint', 'blade', 'handle', 'orb'],
  akmagnus_prime: ['blueprint', 'barrel', 'receiver', 'link'],
  akstiletto_prime: ['blueprint', 'barrel', 'receiver', 'link'],
};

const rnd = mulberry32(1337);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SETS = [];
for (const w of WARFRAMES) {
  SETS.push({ slug: `${w}_prime_set`, name: title(w) + ' Prime Set', parts: ['blueprint', 'neuroptics', 'chassis', 'systems'] });
}
for (const [slug, parts] of Object.entries(WEAPONS)) {
  SETS.push({ slug: slug.replace('_prime', '_prime_set'), name: title(slug.replace('_prime', '')) + ' Prime Set', parts });
}
function title(s) { return s.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join(' '); }

const catalog = [];
const itemDetail = new Map();
for (const set of SETS) {
  catalog.push({ id: `id_${set.slug}`, slug: set.slug, tags: ['prime', 'set'], tradable: true, i18n: { en: { name: set.name, thumb: null } } });
  for (const p of set.parts) {
    const slug = `${set.slug.replace('_set', '')}_${p}`;
    catalog.push({ id: `id_${slug}`, slug, tags: ['prime', 'part'], tradable: true, i18n: { en: { name: `${set.name.replace(' Set', '')} ${p.replace(/_/g, ' ')}`, thumb: null } } });
  }
}
for (const i of catalog) itemDetail.set(i.slug, i);
for (const set of SETS) {
  const partIds = set.parts.map((p) => `id_${set.slug.replace('_set', '')}_${p}`);
  const d = itemDetail.get(set.slug);
  d.setParts = [`id_${set.slug}`, ...partIds];
  d.setRoot = true;
  // Some parts need 2 copies (like real dual weapons / orthos blades).
  const qty2 = set.parts.filter(() => rnd() < 0.18);
  for (const id of partIds) {
    const item = catalog.find((c) => c.id === id);
    itemDetail.get(item.slug).quantityInSet = qty2.includes(set.parts.find((p) => id.endsWith(`_${p}`))) ? 2 : 1;
  }
}

// Deterministic per-set economics. Real markets NEVER have a buy order above
// a sell ask on the same item — profit only emerges from SET vs PARTS price
// mismatches, and stays in a believable range (single/double-digit to ~80p).
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

const idToSlug = new Map(catalog.map((i) => [i.id, i.slug]));
// Explicit part→set mapping (string surgery breaks on two-word parts like
// 'heavy_blade' → 'gram_prime_heavy_set' phantom slugs).
const partToSet = new Map();
for (const set of SETS) {
  for (const p of set.parts) {
    partToSet.set(`${set.slug.replace('_set', '')}_${p}`, set.slug);
  }
}

function econ(slug) {
  const setSlug = slug.endsWith('_set') ? slug : (partToSet.get(slug) ?? slug);
  const root = itemDetail.get(setSlug);
  const h = Math.abs(hash(setSlug));
  const setBase = 60 + (h % 340);                       // 60..399p per set
  const ratio = 0.70 + ((h >> 4) % 41) / 100;           // sum-of-parts 70%..110% of set
  let units = 0;
  if (root?.setParts) {
    for (const id of root.setParts.slice(1)) {
      units += itemDetail.get(idToSlug.get(id))?.quantityInSet ?? 1;
    }
  }
  if (!units) units = 4;
  return { setBase, ratio, units };
}

function ordersFor(slug) {
  // Deterministic PER SLUG: every call returns the exact same order book, and
  // parts of one set stay mutually consistent (shared econ(setSlug)).
  const rnd = mulberry32((Math.abs(hash(slug)) ^ 0x9e3779b9) >>> 0);
  const isSet = slug.endsWith('_set');
  const { setBase, ratio, units } = econ(slug);
  const unitAsk = Math.max(3, Math.round((setBase * ratio) / units)); // avg part ask
  const mk = (type, plat, qty, status, name) => ({
    id: `o_${slug}_${type}_${plat}_${name}`, type, platinum: plat, quantity: qty,
    visible: true,
    user: { id: `u_${name}`, ingameName: name, status, reputation: 50 + Math.floor(rnd() * 400), lastSeen: new Date().toISOString() },
  });
  const orders = [];

  // SELL side (asks, cheapest first).
  const firstAsk = isSet
    ? Math.round(setBase * (0.95 + rnd() * 0.05))
    : Math.round(unitAsk * (0.92 + rnd() * 0.08));
  const sellers = [
    ['AlphaOne', 'ingame'], ['BravoTrader', 'online'], ['CharliePlat', 'ingame'],
    ['DeltaSeller', 'online'], ['EchoVault', 'ingame'], ['FoxOffline', 'offline'],
    ['GammaDeal', 'ingame'], ['HotelCheap', 'online'],
  ];
  let ask = firstAsk;
  for (const [name, status] of sellers) {
    orders.push(mk('sell', ask, 1 + Math.floor(rnd() * 3), status, name));
    ask += Math.max(1, Math.round(ask * 0.07));
  }

  // BUY side (bids, highest first) — ALWAYS at least 2p under the cheapest
  // ask of the same item, so no free instant money exists on one item.
  const bidTop = Math.min(
    firstAsk - 2,
    Math.round(firstAsk * (isSet ? 0.72 + rnd() * 0.21 : 0.65 + rnd() * 0.25)),
  );
  const buyers = [
    ['BuyBot01', 'ingame'], ['QuickFlip', 'online'], ['PlatHunter', 'ingame'],
    ['SetCollector', 'online'], ['DeepPockets', 'ingame'], ['AFKbuyer', 'offline'],
    ['MarginMax', 'ingame'], ['SnipeLord', 'online'],
  ];
  let bid = Math.max(1, bidTop);
  for (const [name, status] of buyers) {
    orders.push(mk('buy', bid, 1 + Math.floor(rnd() * 4), status, name));
    bid -= Math.max(1, Math.round(bid * 0.05));
  }
  return orders;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/items') {
    res.end(JSON.stringify({ data: catalog, payload: catalog }));
    return;
  }
  const item = url.pathname.match(/^\/item(?:s)?\/([^/]+)$/);
  if (item) {
    const detail = itemDetail.get(item[1]);
    if (!detail) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
    res.end(JSON.stringify({ data: detail, payload: detail }));
    return;
  }
  const orders = url.pathname.match(/^\/orders\/item\/([^/]+)$/);
  if (orders) {
    const list = ordersFor(orders[1]);
    res.end(JSON.stringify({ data: list, payload: list }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'unknown path' }));
});

server.listen(5454, '127.0.0.1', () => console.log(`[mock-wfm] ${SETS.length} sets / ${catalog.length} items, listening on 127.0.0.1:5454`));
