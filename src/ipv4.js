// IPv4 maths for the calculator, VLSM planner and summariser.
// Addresses are held as unsigned 32-bit numbers; `>>> 0` keeps them unsigned after bit operations.

export class AddressError extends Error {}

export function parseIPv4(text) {
  const s = String(text).trim();
  const parts = s.split('.');
  if (parts.length !== 4) throw new AddressError(`"${s}" is not an IPv4 address (expected four numbers separated by dots)`);
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) throw new AddressError(`"${s}" is not an IPv4 address ("${p}" is not a number from 0 to 255)`);
    if (p.length > 1 && p[0] === '0') throw new AddressError(`"${s}" has a leading zero in "${p}"; write it without the zero`);
    const v = Number(p);
    if (v > 255) throw new AddressError(`"${s}" is not an IPv4 address (${v} is larger than 255)`);
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function formatIPv4(n) {
  n = n >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function prefixToMask(prefix) {
  checkPrefix(prefix);
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function maskToPrefix(mask) {
  const m = typeof mask === 'number' ? mask >>> 0 : parseIPv4(mask);
  const inverted = ~m >>> 0;
  // a valid mask is ones followed by zeros, so the inverted mask plus one is a power of two
  if ((inverted & (inverted + 1)) !== 0) throw new AddressError(`${formatIPv4(m)} is not a valid subnet mask (the 1 bits must be contiguous)`);
  return 32 - bitLength(inverted);
}

function bitLength(n) {
  let bits = 0;
  while (n > 0) { bits++; n = Math.floor(n / 2); }
  return bits;
}

function checkPrefix(prefix) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new AddressError(`/${prefix} is not a valid prefix length (use 0 to 32)`);
}

export function blockSize(prefix) {
  checkPrefix(prefix);
  return 2 ** (32 - prefix);
}

/**
 * Accepts "10.1.2.3/24", "10.1.2.3 255.255.255.0", "10.1.2.3/255.255.255.0" or a bare address (/32).
 * Returns the address as typed plus the prefix; use networkOf() for the network address.
 */
export function parseCIDR(text, { defaultPrefix = 32 } = {}) {
  const s = String(text).trim().replace(/\s+/g, ' ');
  if (!s) throw new AddressError('Enter an address, for example 192.168.10.0/24');
  let addr, pfx;
  const m = s.match(/^(.+?)\s*(?:\/|\s)\s*([^/\s]+)$/);
  if (m) {
    addr = m[1];
    pfx = m[2].includes('.') ? maskToPrefix(m[2]) : Number(m[2].replace(/^\//, ''));
    if (!/^\d+$/.test(String(pfx))) throw new AddressError(`"${m[2]}" is not a prefix length or subnet mask`);
  } else {
    addr = s;
    pfx = defaultPrefix;
  }
  checkPrefix(pfx);
  return { address: parseIPv4(addr), prefix: pfx };
}

export function networkOf(address, prefix) {
  return (address & prefixToMask(prefix)) >>> 0;
}

export function formatCIDR(network, prefix) {
  return `${formatIPv4(network)}/${prefix}`;
}

const SPECIAL = [
  ['0.0.0.0/8', 'This network (RFC 1122)'],
  ['10.0.0.0/8', 'Private (RFC 1918)'],
  ['100.64.0.0/10', 'Carrier-grade NAT (RFC 6598)'],
  ['127.0.0.0/8', 'Loopback'],
  ['169.254.0.0/16', 'Link-local (APIPA)'],
  ['172.16.0.0/12', 'Private (RFC 1918)'],
  ['192.0.0.0/24', 'IETF protocol assignments'],
  ['192.0.2.0/24', 'Documentation (TEST-NET-1)'],
  ['192.168.0.0/16', 'Private (RFC 1918)'],
  ['198.18.0.0/15', 'Benchmark testing'],
  ['198.51.100.0/24', 'Documentation (TEST-NET-2)'],
  ['203.0.113.0/24', 'Documentation (TEST-NET-3)'],
  ['224.0.0.0/4', 'Multicast'],
  ['240.0.0.0/4', 'Reserved'],
  ['255.255.255.255/32', 'Limited broadcast'],
].map(([c, label]) => { const { address, prefix } = parseCIDR(c); return { network: address, prefix, label }; });

export function addressType(address) {
  let best = null;
  for (const r of SPECIAL) {
    if (networkOf(address, r.prefix) === r.network && (!best || r.prefix > best.prefix)) best = r;
  }
  return best ? best.label : 'Public';
}

export function addressClass(address) {
  const first = address >>> 24;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D (multicast)';
  return 'E (reserved)';
}

export function subnetInfo(address, prefix) {
  const mask = prefixToMask(prefix);
  const network = (address & mask) >>> 0;
  const size = blockSize(prefix);
  const broadcast = (network + size - 1) >>> 0;
  let firstHost, lastHost, usable;
  if (prefix === 32) { firstHost = lastHost = network; usable = 1; }
  else if (prefix === 31) { firstHost = network; lastHost = broadcast; usable = 2; } // RFC 3021 point-to-point
  else { firstHost = network + 1; lastHost = broadcast - 1; usable = size - 2; }
  return {
    address, prefix, mask, wildcard: ~mask >>> 0, network, broadcast,
    firstHost: firstHost >>> 0, lastHost: lastHost >>> 0,
    totalAddresses: size, usableHosts: usable,
    addressClass: addressClass(address), type: addressType(network),
    isNetworkAddress: address === network,
  };
}

/** Smallest prefix whose block holds `hosts` usable addresses (network and broadcast reserved). */
export function prefixForHosts(hosts) {
  if (!Number.isInteger(hosts) || hosts < 1) throw new AddressError('Each subnet needs at least 1 host');
  // 1 or 2 hosts get a /30, the usual size for a point-to-point link; /31 and /32 are left for
  // people who choose them on purpose in the calculator.
  for (let p = 30; p >= 0; p--) if (blockSize(p) - 2 >= hosts) return p;
  throw new AddressError(`${hosts} hosts will not fit in IPv4`);
}

/**
 * Variable-length subnetting. Largest requests are placed first so every block stays aligned.
 * requests: [{ name, hosts }]. Returns { allocations, free, used, total } or throws if it does not fit.
 */
export function planVLSM(baseText, requests) {
  const { address, prefix } = parseCIDR(baseText);
  const base = networkOf(address, prefix);
  const baseEnd = base + blockSize(prefix); // exclusive
  if (!requests.length) throw new AddressError('Add at least one subnet to plan');

  const sized = requests.map((r, i) => {
    const name = String(r.name || '').trim() || `Subnet ${i + 1}`;
    const hosts = Number(r.hosts);
    if (!Number.isInteger(hosts) || hosts < 1) throw new AddressError(`"${name}" needs a whole number of hosts (1 or more)`);
    const p = prefixForHosts(hosts);
    if (p < prefix) throw new AddressError(`"${name}" needs ${hosts} hosts (a /${p}), which is bigger than ${formatCIDR(base, prefix)}`);
    return { name, hosts, prefix: p, order: i };
  });
  sized.sort((a, b) => a.prefix - b.prefix || a.order - b.order);

  let cursor = base;
  const allocations = [];
  for (const r of sized) {
    const size = blockSize(r.prefix);
    const start = Math.ceil(cursor / size) * size; // align (only matters if a caller reorders)
    if (start + size > baseEnd) {
      const need = sized.reduce((t, x) => t + blockSize(x.prefix), 0);
      throw new AddressError(`Not enough space: the subnets need ${need.toLocaleString('en')} addresses but ${formatCIDR(base, prefix)} has ${blockSize(prefix).toLocaleString('en')}`);
    }
    const info = subnetInfo(start >>> 0, r.prefix);
    allocations.push({ ...r, ...info, spare: info.usableHosts - r.hosts });
    cursor = start + size;
  }
  allocations.sort((a, b) => a.network - b.network);
  const free = rangeToCIDRs(cursor, baseEnd);
  const used = cursor - base;
  return { base: { network: base, prefix }, allocations, free, used, total: blockSize(prefix) };
}

/** Cover the half-open range [start, end) with the fewest aligned CIDR blocks. */
export function rangeToCIDRs(start, end) {
  const out = [];
  while (start < end) {
    let size = start === 0 ? 2 ** 32 : 2 ** Math.min(32, trailingZeros(start));
    while (start + size > end) size /= 2;
    out.push({ network: start >>> 0, prefix: 32 - Math.log2(size) });
    start += size;
  }
  return out;
}

function trailingZeros(n) {
  let z = 0;
  while (z < 32 && n % 2 === 0) { n /= 2; z++; }
  return z;
}

export function splitSubnet(text, newPrefix, limit = 4096) {
  const { address, prefix } = parseCIDR(text);
  checkPrefix(newPrefix);
  if (newPrefix < prefix) throw new AddressError(`/${newPrefix} is larger than /${prefix}; pick a longer prefix to split into`);
  const count = 2 ** (newPrefix - prefix);
  if (count > limit) throw new AddressError(`That makes ${count.toLocaleString('en')} subnets; the limit here is ${limit.toLocaleString('en')}`);
  const base = networkOf(address, prefix);
  const size = blockSize(newPrefix);
  return Array.from({ length: count }, (_, i) => subnetInfo((base + i * size) >>> 0, newPrefix));
}

/** Route summarisation: merge a list of networks into the fewest CIDR blocks covering exactly the same addresses. */
export function summarize(texts) {
  const ranges = texts
    .map((t) => String(t).trim()).filter(Boolean)
    .map((t) => { const { address, prefix } = parseCIDR(t); const n = networkOf(address, prefix); return [n, n + blockSize(prefix)]; })
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.flatMap(([s, e]) => rangeToCIDRs(s, e));
}

/** Smallest single block that contains every network given. `extra` counts addresses it adds that were not in the list (gaps included). */
export function supernet(texts) {
  const nets = texts.map((t) => String(t).trim()).filter(Boolean).map((t) => parseCIDR(t));
  if (!nets.length) throw new AddressError('Enter at least one network');
  let lo = Infinity, hi = -Infinity;
  for (const { address, prefix } of nets) {
    const n = networkOf(address, prefix);
    lo = Math.min(lo, n); hi = Math.max(hi, n + blockSize(prefix) - 1);
  }
  let p = 32;
  while (p > 0 && (networkOf(lo, p) !== networkOf(hi, p))) p--;
  const network = networkOf(lo, p);
  const covered = summarize(texts).reduce((t, r) => t + blockSize(r.prefix), 0);
  return { network, prefix: p, extra: blockSize(p) - covered };
}

export function toBinary(n, prefix) {
  const bits = (n >>> 0).toString(2).padStart(32, '0');
  return { network: bits.slice(0, prefix), host: bits.slice(prefix) };
}
