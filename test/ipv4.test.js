import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AddressError, parseIPv4, formatIPv4, prefixToMask, maskToPrefix, parseCIDR, subnetInfo,
  prefixForHosts, planVLSM, rangeToCIDRs, splitSubnet, summarize, supernet, addressType, formatCIDR,
} from '../src/ipv4.js';

const cidrs = (list) => list.map((r) => formatCIDR(r.network, r.prefix));

test('parses and formats addresses', () => {
  assert.equal(parseIPv4('0.0.0.0'), 0);
  assert.equal(parseIPv4('255.255.255.255'), 4294967295);
  assert.equal(formatIPv4(parseIPv4('192.168.1.200')), '192.168.1.200');
  assert.equal(formatIPv4(parseIPv4(' 10.0.0.1 ')), '10.0.0.1');
});

test('rejects bad addresses with a useful message', () => {
  for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', 'a.b.c.d', '1.2.3.-4', '01.2.3.4', '']) {
    assert.throws(() => parseIPv4(bad), AddressError, bad);
  }
});

test('masks and prefixes convert both ways', () => {
  assert.equal(formatIPv4(prefixToMask(0)), '0.0.0.0');
  assert.equal(formatIPv4(prefixToMask(20)), '255.255.240.0');
  assert.equal(formatIPv4(prefixToMask(32)), '255.255.255.255');
  for (let p = 0; p <= 32; p++) assert.equal(maskToPrefix(prefixToMask(p)), p);
  assert.equal(maskToPrefix('255.255.255.192'), 26);
  assert.throws(() => maskToPrefix('255.0.255.0'), AddressError);
  assert.throws(() => prefixToMask(33), AddressError);
});

test('parseCIDR accepts slash, mask and bare forms', () => {
  assert.deepEqual(parseCIDR('10.1.2.3/8'), { address: parseIPv4('10.1.2.3'), prefix: 8 });
  assert.deepEqual(parseCIDR('10.1.2.3 255.255.0.0'), { address: parseIPv4('10.1.2.3'), prefix: 16 });
  assert.deepEqual(parseCIDR('10.1.2.3/255.255.255.0'), { address: parseIPv4('10.1.2.3'), prefix: 24 });
  assert.deepEqual(parseCIDR('10.1.2.3'), { address: parseIPv4('10.1.2.3'), prefix: 32 });
  assert.throws(() => parseCIDR('10.0.0.0/33'), AddressError);
  assert.throws(() => parseCIDR('10.0.0.0/x'), AddressError);
});

test('subnet details for an ordinary /26', () => {
  const s = subnetInfo(parseIPv4('192.168.10.37'), 26);
  assert.equal(formatIPv4(s.network), '192.168.10.0');
  assert.equal(formatIPv4(s.broadcast), '192.168.10.63');
  assert.equal(formatIPv4(s.firstHost), '192.168.10.1');
  assert.equal(formatIPv4(s.lastHost), '192.168.10.62');
  assert.equal(formatIPv4(s.wildcard), '0.0.0.63');
  assert.equal(s.usableHosts, 62);
  assert.equal(s.type, 'Private (RFC 1918)');
  assert.equal(s.addressClass, 'C');
});

test('/31 and /32 edge cases', () => {
  const p2p = subnetInfo(parseIPv4('10.0.0.1'), 31);
  assert.equal(p2p.usableHosts, 2);
  assert.equal(formatIPv4(p2p.firstHost), '10.0.0.0');
  assert.equal(formatIPv4(p2p.lastHost), '10.0.0.1');
  const host = subnetInfo(parseIPv4('10.0.0.9'), 32);
  assert.equal(host.usableHosts, 1);
  assert.equal(formatIPv4(host.firstHost), '10.0.0.9');
  const all = subnetInfo(parseIPv4('8.8.8.8'), 0);
  assert.equal(all.totalAddresses, 2 ** 32);
  assert.equal(formatIPv4(all.broadcast), '255.255.255.255');
});

test('address types pick the most specific range', () => {
  assert.equal(addressType(parseIPv4('172.31.255.1')), 'Private (RFC 1918)');
  assert.equal(addressType(parseIPv4('172.32.0.1')), 'Public');
  assert.equal(addressType(parseIPv4('100.100.1.1')), 'Carrier-grade NAT (RFC 6598)');
  assert.equal(addressType(parseIPv4('169.254.10.10')), 'Link-local (APIPA)');
  assert.equal(addressType(parseIPv4('255.255.255.255')), 'Limited broadcast');
});

test('prefixForHosts picks the smallest block that fits', () => {
  assert.equal(prefixForHosts(1), 30);
  assert.equal(prefixForHosts(2), 30);
  assert.equal(prefixForHosts(3), 29);
  assert.equal(prefixForHosts(62), 26);
  assert.equal(prefixForHosts(63), 25);
  assert.equal(prefixForHosts(254), 24);
  assert.equal(prefixForHosts(255), 23);
  assert.throws(() => prefixForHosts(0), AddressError);
});

test('VLSM plan matches a worked textbook example', () => {
  const plan = planVLSM('192.168.1.0/24', [
    { name: 'A', hosts: 60 }, { name: 'B', hosts: 28 }, { name: 'C', hosts: 12 }, { name: 'D', hosts: 2 },
  ]);
  assert.deepEqual(plan.allocations.map((a) => [a.name, formatCIDR(a.network, a.prefix)]), [
    ['A', '192.168.1.0/26'], ['B', '192.168.1.64/27'], ['C', '192.168.1.96/28'], ['D', '192.168.1.112/30'],
  ]);
  assert.equal(plan.used, 116);
  assert.deepEqual(cidrs(plan.free), ['192.168.1.116/30', '192.168.1.120/29', '192.168.1.128/25']);
});

test('VLSM keeps input order for equal sizes and never overlaps', () => {
  const plan = planVLSM('10.0.0.0/16', [
    { name: 'link1', hosts: 2 }, { name: 'big', hosts: 1000 }, { name: 'link2', hosts: 2 }, { name: 'mid', hosts: 200 },
  ]);
  const names = plan.allocations.map((a) => a.name);
  assert.deepEqual(names, ['big', 'mid', 'link1', 'link2']);
  for (let i = 1; i < plan.allocations.length; i++) {
    assert.ok(plan.allocations[i].network > plan.allocations[i - 1].broadcast, 'subnets overlap');
  }
  for (const a of plan.allocations) assert.equal(a.network % a.totalAddresses, 0, `${a.name} is not aligned`);
});

test('VLSM reports when the block is too small', () => {
  assert.throws(() => planVLSM('192.168.1.0/24', [{ name: 'A', hosts: 200 }, { name: 'B', hosts: 100 }]), /Not enough space/);
  assert.throws(() => planVLSM('192.168.1.0/26', [{ name: 'Huge', hosts: 100 }]), /bigger than/);
  assert.throws(() => planVLSM('192.168.1.0/24', [{ name: 'A', hosts: 2.5 }]), /whole number/);
  assert.throws(() => planVLSM('192.168.1.0/24', []), AddressError);
});

test('VLSM uses the network address even if a host address is given', () => {
  const plan = planVLSM('192.168.1.77/24', [{ name: 'A', hosts: 10 }]);
  assert.equal(formatCIDR(plan.allocations[0].network, plan.allocations[0].prefix), '192.168.1.0/28');
});

test('rangeToCIDRs covers awkward ranges exactly', () => {
  assert.deepEqual(cidrs(rangeToCIDRs(parseIPv4('10.0.0.1'), parseIPv4('10.0.0.9'))),
    ['10.0.0.1/32', '10.0.0.2/31', '10.0.0.4/30', '10.0.0.8/32']);
  assert.deepEqual(cidrs(rangeToCIDRs(0, 2 ** 32)), ['0.0.0.0/0']);
});

test('splitSubnet produces equal, consecutive subnets', () => {
  const parts = splitSubnet('172.16.0.0/20', 22);
  assert.deepEqual(parts.map((s) => formatCIDR(s.network, s.prefix)),
    ['172.16.0.0/22', '172.16.4.0/22', '172.16.8.0/22', '172.16.12.0/22']);
  assert.throws(() => splitSubnet('10.0.0.0/24', 23), AddressError);
  assert.throws(() => splitSubnet('10.0.0.0/8', 30), /limit/);
});

test('summarize merges adjacent and overlapping routes only', () => {
  assert.deepEqual(cidrs(summarize(['192.168.0.0/24', '192.168.1.0/24', '192.168.2.0/24', '192.168.3.0/24'])), ['192.168.0.0/22']);
  assert.deepEqual(cidrs(summarize(['192.168.0.0/24', '192.168.1.0/24', '192.168.2.0/24'])), ['192.168.0.0/23', '192.168.2.0/24']);
  assert.deepEqual(cidrs(summarize(['10.0.0.0/8', '10.20.0.0/16', '10.0.0.5'])), ['10.0.0.0/8']);
  assert.deepEqual(cidrs(summarize(['10.0.1.0/24', '10.0.0.0/24'])), ['10.0.0.0/23']);
});

test('supernet finds the smallest containing block and counts extra space', () => {
  const s = supernet(['192.168.0.0/24', '192.168.1.0/24', '192.168.2.0/24', '192.168.3.0/24', '192.168.5.0/24']);
  assert.equal(formatCIDR(s.network, s.prefix), '192.168.0.0/21');
  assert.equal(s.extra, 3 * 256);
  const exact = supernet(['10.0.0.0/25', '10.0.0.128/25']);
  assert.equal(formatCIDR(exact.network, exact.prefix), '10.0.0.0/24');
  assert.equal(exact.extra, 0);
});
