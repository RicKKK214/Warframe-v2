#!/usr/bin/env node
/**
 * Local mock of the Warframe.market v2 API for end-to-end manual verification
 * in the sandbox (the real api.warframe.market is unreachable from here).
 * Serves /items, /item/{slug}, /orders/item/{slug} with realistic data:
 * several Prime sets with profitable PARTS_TO_SET spreads and per-order
 * QUANTITIES (needed by the Capital Calculator).
 */
import http from 'node:http';

const SETS = [
  { slug: 'wisp_prime_set', name: 'Wisp Prime Set', parts: ['blueprint', 'neuroptics', 'chassis', 'systems'] },
  { slug: 'mesa_prime_set', name: 'Mesa Prime Set', parts: ['blueprint', 'neuroptics', 'chassis', 'systems', 'carapace'] },
  { slug: 'gelon_prime_set', name: 'Glaive Prime Set', parts: ['blueprint', 'blade', 'disc'] },
  { slug: 'nikana_prime_set', name: 'Nikana Prime Set', parts: ['blueprint', 'blade', 'hilt'] },
  { slug: 'gram_prime_set', name: 'Gram Prime Set', parts: ['blueprint', 'blade', 'heavy_blade'] },
  { slug: 'saryn_prime_set', name: 'Saryn Prime Set', parts: ['blueprint', 'neuroptics', 'chassis', 'systems'] },
  { slug: 'zephy_prime_set', name: 'Zephyr Prime Set', parts: ['blueprint', 'neuroptics', 'chassis', 'systems'] },
  { slug: 'forma_set', name: 'Boar Prime Set', parts: ['blueprint', 'receiver', 'stock', 'barrel'] },
].map((s) => ({ ...s, slug: s.slug }));

const rnd = mulberry32(42);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const catalog = [];
for (const set of SETS) {
  catalog.push({ id: `id_${set.slug}`, slug: set.slug, tags: ['prime', 'set'], i18n: { en: { name: set.name, thumb: null } } });
  for (const p of set.parts) {
    const slug = `${set.slug.replace('_set', '')}_${p}`;
    catalog.push({ id: `id_${slug}`, slug, tags: ['prime', 'part'], i18n: { en: { name: `${set.name.replace(' Set', '')} ${p.replace('_', ' ')}`, thumb: null } } });
  }
}

const itemDetail = new Map(catalog.map((i) => [i.slug, i]));
for (const set of SETS) {
  const partIds = set.parts.map((p) => `id_${set.slug.replace('_set', '')}_${p}`);
  itemDetail.get(set.slug).setParts = [`id_${set.slug}`, ...partIds];
  itemDetail.get(set.slug).setRoot = true;
  itemDetail.get(set.slug).tradable = true;
  for (const id of partIds) {
    const item = catalog.find((c) => c.id === id);
    itemDetail.get(item.slug).quantityInSet = 1 + (rnd() < 0.2 ? 1 : 0);
    itemDetail.get(item.slug).tradable = true;
  }
}

function ordersFor(slug) {
  const isSet = slug.endsWith('_set');
  // Base economics: sets ~200p, parts ~35p each → parts-to-set is profitable.
  const base = isSet ? 180 + Math.floor(rnd() * 60) : 30 + Math.floor(rnd() * 15);
  const mk = (type, plat, qty, status, name) => ({
    id: `o_${slug}_${type}_${plat}_${name}`, type, platinum: plat, quantity: qty,
    visible: true,
    user: { id: `u_${name}`, ingameName: name, status, reputation: 50 + Math.floor(rnd() * 400), lastSeen: new Date().toISOString() },
  });
  const orders = [];
  // SELL side (cheapest first): a few sellers with limited quantities.
  const sellers = [
    ['AlphaOne', 'ingame'], ['BravoTrader', 'online'], ['CharliePlat', 'ingame'],
    ['DeltaSeller', 'online'], ['EchoVault', 'ingame'], ['OfflineOld', 'offline'],
  ];
  let price = base;
  for (const [name, status] of sellers) {
    orders.push(mk('sell', price, 1 + Math.floor(rnd() * 3), status, name));
    price += Math.max(1, Math.round(base * 0.06));
  }
  // BUY side (highest first): plenty of demand slightly below sell prices.
  const buyers = [
    ['BuyBot01', 'ingame'], ['QuickFlip', 'online'], ['PlatHunter', 'ingame'],
    ['SetCollector', 'online'], ['DeepPockets', 'ingame'], ['AFKbuyer', 'offline'],
  ];
  price = Math.round(base * (isSet ? 0.88 : 0.82));
  for (const [name, status] of buyers) {
    orders.push(mk('buy', price, 1 + Math.floor(rnd() * 4), status, name));
    price -= Math.max(1, Math.round(base * 0.05));
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

server.listen(5454, '127.0.0.1', () => console.log('[mock-wfm] listening on 127.0.0.1:5454'));
