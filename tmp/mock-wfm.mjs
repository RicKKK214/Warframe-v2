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

// Deterministic per-slug base price. Warframes 80–420p, weapons 60–260p.
function basePrice(slug, nParts) {
  const isFrame = !slug.includes('set') || WARFRAMES.some((w) => slug.startsWith(w + '_'));
  const h = Math.abs(hash(slug));
  const lo = isFrame ? 90 : 60;
  const hi = isFrame ? 420 : 260;
  return lo + (h % (hi - lo)) - nParts * 2;
}
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

function ordersFor(slug) {
  const isSet = slug.endsWith('_set');
  const root = itemDetail.get(slug);
  const nParts = root?.setParts?.length ?? 3;
  const base = Math.max(25, basePrice(slug, nParts));
  const partFactor = isSet ? 1 : 1 / Math.max(1, nParts - 0.4);
  const mk = (type, plat, qty, status, name) => ({
    id: `o_${slug}_${type}_${plat}_${name}`, type, platinum: plat, quantity: qty,
    visible: true,
    user: { id: `u_${name}`, ingameName: name, status, reputation: 50 + Math.floor(rnd() * 400), lastSeen: new Date().toISOString() },
  });
  const orders = [];
  const sellers = [
    ['AlphaOne', 'ingame'], ['BravoTrader', 'online'], ['CharliePlat', 'ingame'],
    ['DeltaSeller', 'online'], ['EchoVault', 'ingame'], ['FoxOffline', 'offline'],
    ['GammaDeal', 'ingame'], ['HotelCheap', 'online'],
  ];
  let price = Math.max(2, Math.round(base * partFactor));
  for (const [name, status] of sellers) {
    orders.push(mk('sell', price, 1 + Math.floor(rnd() * 3), status, name));
    price += Math.max(1, Math.round(price * 0.07));
  }
  const buyers = [
    ['BuyBot01', 'ingame'], ['QuickFlip', 'online'], ['PlatHunter', 'ingame'],
    ['SetCollector', 'online'], ['DeepPockets', 'ingame'], ['AFKbuyer', 'offline'],
    ['MarginMax', 'ingame'], ['SnipeLord', 'online'],
  ];
  // Buyers bid close to (sometimes above) the cheapest sell → real spreads.
  price = Math.max(1, Math.round(base * partFactor * (0.86 + rnd() * 0.28)));
  for (const [name, status] of buyers) {
    orders.push(mk('buy', price, 1 + Math.floor(rnd() * 4), status, name));
    price -= Math.max(1, Math.round(price * 0.05));
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
