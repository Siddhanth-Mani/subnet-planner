import {
  AddressError, parseCIDR, formatIPv4, formatCIDR, subnetInfo, planVLSM,
  splitSubnet, summarize, supernet, toBinary,
} from './ipv4.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en');

// Small DOM builder. Text always goes in through textContent, so typed input can't inject markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

function showError(id, err) {
  const box = $(id);
  if (!err) { box.hidden = true; box.textContent = ''; return; }
  box.textContent = err instanceof AddressError ? err.message : `Something went wrong: ${err.message}`;
  box.hidden = false;
  if (!(err instanceof AddressError)) console.error(err);
}

function copyButton(label, getText) {
  const btn = h('button', { type: 'button', class: 'secondary small' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = label; }, 1400);
  });
  return btn;
}

function toCSV(rows) {
  return rows.map((r) => r.map((c) => {
    const s = String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

function table(headers, rows, { numeric = [] } = {}) {
  return h('div', { class: 'table-scroll' },
    h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, headers.map((t, i) => h('th', { class: numeric.includes(i) ? 'num' : null }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'num' : null }, c)))))));
}

/* ---------- URL state ---------- */
let restoring = false;
function saveState(params) {
  if (restoring) return;
  const q = new URLSearchParams(params).toString();
  history.replaceState(null, '', `#${q}`);
}

/* ---------- tabs ---------- */
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = false) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (d) { e.preventDefault(); selectTab(tabs[(i + d + tabs.length) % tabs.length], true); }
  });
});

/* ---------- calculator ---------- */
function runCalc() {
  const out = $('calc-result');
  out.replaceChildren();
  try {
    const text = $('calc-input').value;
    const { address, prefix } = parseCIDR(text);
    const s = subnetInfo(address, prefix);
    showError('calc-error', null);
    saveState({ tool: 'calc', q: text.trim() });

    const rows = [
      ['Address', formatIPv4(s.address) + (s.isNetworkAddress ? ' (network address)' : '')],
      ['Network', formatCIDR(s.network, prefix)],
      ['Subnet mask', `${formatIPv4(s.mask)}  (/${prefix})`],
      ['Wildcard mask', formatIPv4(s.wildcard)],
      ['Usable hosts', `${formatIPv4(s.firstHost)} – ${formatIPv4(s.lastHost)}`],
      ['Broadcast', prefix >= 31 ? 'none' : formatIPv4(s.broadcast)],
      ['Addresses', `${fmt(s.totalAddresses)} total, ${fmt(s.usableHosts)} usable`],
      ['Type', `${s.type}, class ${s.addressClass}`],
    ];
    const note = prefix === 31 ? 'A /31 has no network or broadcast address. Both addresses are usable on a point-to-point link (RFC 3021).'
      : prefix === 32 ? 'A /32 is a single host route.' : null;

    const bin = toBinary(s.address, prefix);
    const binRow = (label, n) => {
      const b = toBinary(n, prefix);
      return h('div', { class: 'bin-row' }, h('span', { class: 'bin-label' }, label),
        h('code', {}, h('span', { class: 'net' }, dotted(b.network, 0)), h('span', { class: 'host' }, dotted(b.host, prefix))));
    };
    out.append(
      h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      note ? h('p', { class: 'note' }, note) : '',
      h('div', { class: 'binary' },
        h('h2', {}, 'In binary'),
        binRow('Address', s.address), binRow('Mask', s.mask), binRow('Network', s.network),
        h('p', { class: 'legend' }, h('span', { class: 'net' }, `${bin.network.length} network bits`), ' · ', h('span', { class: 'host' }, `${bin.host.length} host bits`))),
      h('div', { class: 'actions' }, copyButton('Copy as text', () => rows.map(([k, v]) => `${k}: ${v}`).join('\n'))),
    );
  } catch (err) {
    showError('calc-error', err);
  }
}
// put a dot after every 8th bit of the full 32-bit string, given where this piece starts
function dotted(bits, offset) {
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const pos = offset + i;
    if (pos > 0 && pos % 8 === 0) out += '.';
    out += bits[i];
  }
  return out;
}
$('calc-form').addEventListener('submit', (e) => { e.preventDefault(); runCalc(); });

/* ---------- VLSM ---------- */
const EXAMPLE = [['Office LAN', 300], ['Wi-Fi guests', 120], ['Servers', 50], ['Printers', 20], ['Management', 10], ['WAN link A', 2], ['WAN link B', 2]];
function addReqRow(name = '', hosts = '') {
  const tr = h('tr', {},
    h('td', {}, h('input', { class: 'req-name', value: name, 'aria-label': 'Subnet name', placeholder: 'e.g. Staff LAN' })),
    h('td', {}, h('input', { class: 'req-hosts', value: hosts, inputmode: 'numeric', 'aria-label': 'Hosts needed', placeholder: '50' })),
    h('td', {}, h('button', { type: 'button', class: 'icon', 'aria-label': 'Remove this subnet', onclick: () => { tr.remove(); if (!$('vlsm-rows').children.length) addReqRow(); } }, '×')));
  $('vlsm-rows').append(tr);
  return tr;
}
function setRequests(list) {
  $('vlsm-rows').replaceChildren();
  (list.length ? list : [['', '']]).forEach(([n, c]) => addReqRow(n, c));
}
function readRequests() {
  return [...$('vlsm-rows').children]
    .map((tr) => ({ name: tr.querySelector('.req-name').value, hosts: tr.querySelector('.req-hosts').value.trim() }))
    .filter((r) => r.name.trim() || r.hosts)
    .map((r) => ({ name: r.name, hosts: r.hosts === '' ? NaN : Number(r.hosts) }));
}
function runVLSM() {
  const out = $('vlsm-result');
  out.replaceChildren();
  try {
    const reqs = readRequests();
    const plan = planVLSM($('vlsm-base').value, reqs);
    showError('vlsm-error', null);
    saveState({ tool: 'vlsm', base: $('vlsm-base').value.trim(), s: reqs.map((r) => `${r.name.replace(/[:,]/g, ' ').trim()}:${r.hosts}`).join(',') });

    const pct = (plan.used / plan.total) * 100;
    const headers = ['Name', 'Hosts needed', 'Subnet', 'Mask', 'Usable range', 'Broadcast', 'Usable', 'Spare'];
    const rows = plan.allocations.map((a) => [
      a.name, fmt(a.hosts), formatCIDR(a.network, a.prefix), formatIPv4(a.mask),
      `${formatIPv4(a.firstHost)} – ${formatIPv4(a.lastHost)}`, formatIPv4(a.broadcast), fmt(a.usableHosts), fmt(a.spare),
    ]);
    out.append(
      h('div', { class: 'summary' },
        h('p', {}, h('strong', {}, `${plan.allocations.length} subnets`), ` placed in ${formatCIDR(plan.base.network, plan.base.prefix)}. `,
          `${fmt(plan.used)} of ${fmt(plan.total)} addresses allocated (${pct < 1 && pct > 0 ? '<1' : Math.round(pct)}%).`),
        h('div', { class: 'meter', role: 'img', 'aria-label': `${Math.round(pct)} percent of the block allocated` }, h('span'))),
      table(headers, rows, { numeric: [1, 6, 7] }),
      h('h2', {}, 'Unallocated space'),
      plan.free.length
        ? h('ul', { class: 'free' }, plan.free.map((f) => h('li', {}, h('code', {}, formatCIDR(f.network, f.prefix)), ` ${fmt(2 ** (32 - f.prefix))} addresses`)))
        : h('p', { class: 'muted' }, 'None. The block is fully used.'),
      h('div', { class: 'actions' },
        copyButton('Copy as CSV', () => toCSV([headers, ...rows.map((r) => r.map((c) => String(c).replace(/ – /, '-').replace(/,/g, '')))])),
        copyButton('Copy link to this plan', () => location.href)),
    );
    out.querySelector('.meter span').style.width = `${Math.max(pct, 0.5)}%`;
  } catch (err) {
    showError('vlsm-error', err);
  }
}
$('vlsm-add').addEventListener('click', () => addReqRow().querySelector('input').focus());
$('vlsm-example').addEventListener('click', () => { $('vlsm-base').value = '10.20.0.0/22'; setRequests(EXAMPLE); runVLSM(); });
$('vlsm-form').addEventListener('submit', (e) => { e.preventDefault(); runVLSM(); });

/* ---------- split ---------- */
function fillSplitOptions() {
  const sel = $('split-prefix');
  const prev = Number(sel.value);
  let prefix;
  try { prefix = parseCIDR($('split-input').value).prefix; } catch { return; }
  sel.replaceChildren();
  for (let p = prefix + 1; p <= Math.min(32, prefix + 12); p++) {
    sel.append(h('option', { value: p }, `/${p}  (${fmt(2 ** (p - prefix))} × ${fmt(2 ** (32 - p))} addresses)`));
  }
  if (!sel.options.length) sel.append(h('option', { value: '' }, 'cannot split a /32'));
  if (prev && [...sel.options].some((o) => Number(o.value) === prev)) sel.value = String(prev);
  else if (sel.options.length > 2) sel.selectedIndex = 1;
}
function runSplit() {
  const out = $('split-result');
  out.replaceChildren();
  try {
    if (!$('split-prefix').value) throw new AddressError('A /32 is a single address and cannot be split');
    const nets = splitSubnet($('split-input').value, Number($('split-prefix').value));
    showError('split-error', null);
    saveState({ tool: 'split', q: $('split-input').value.trim(), p: $('split-prefix').value });
    const headers = ['#', 'Subnet', 'Usable range', 'Broadcast', 'Usable'];
    const rows = nets.map((s, i) => [i + 1, formatCIDR(s.network, s.prefix),
      `${formatIPv4(s.firstHost)} – ${formatIPv4(s.lastHost)}`, s.prefix >= 31 ? 'none' : formatIPv4(s.broadcast), fmt(s.usableHosts)]);
    out.append(h('p', { class: 'summary' }, `${fmt(nets.length)} subnets of /${nets[0].prefix}.`), table(headers, rows, { numeric: [0, 4] }),
      h('div', { class: 'actions' }, copyButton('Copy as CSV', () => toCSV([headers, ...rows.map((r) => r.map((c) => String(c).replace(/ – /, '-').replace(/,/g, '')))]))));
  } catch (err) {
    showError('split-error', err);
  }
}
$('split-input').addEventListener('input', fillSplitOptions);
$('split-form').addEventListener('submit', (e) => { e.preventDefault(); runSplit(); });

/* ---------- summarise ---------- */
function runSum() {
  const out = $('sum-result');
  out.replaceChildren();
  try {
    const lines = $('sum-input').value.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new AddressError('Enter at least one network');
    const exact = summarize(lines);
    const sup = supernet(lines);
    showError('sum-error', null);
    saveState({ tool: 'sum', n: lines.join(',') });
    out.append(
      h('div', { class: 'two' },
        h('div', {},
          h('h2', {}, `Exact summary (${exact.length} ${exact.length === 1 ? 'route' : 'routes'})`),
          h('ul', { class: 'free' }, exact.map((r) => h('li', {}, h('code', {}, formatCIDR(r.network, r.prefix))))),
          h('p', { class: 'muted' }, `Covers the same ${fmt(exact.reduce((t, r) => t + 2 ** (32 - r.prefix), 0))} addresses as the ${lines.length} networks you entered.`)),
        h('div', {},
          h('h2', {}, 'Smallest supernet'),
          h('ul', { class: 'free' }, h('li', {}, h('code', {}, formatCIDR(sup.network, sup.prefix)))),
          h('p', { class: 'muted' }, sup.extra
            ? `Also covers ${fmt(sup.extra)} addresses that were not in your list. Check nothing else uses them before advertising this route.`
            : 'Covers exactly the addresses in your list.'))),
      h('div', { class: 'actions' }, copyButton('Copy exact summary', () => exact.map((r) => formatCIDR(r.network, r.prefix)).join('\n'))),
    );
  } catch (err) {
    showError('sum-error', err);
  }
}
$('sum-form').addEventListener('submit', (e) => { e.preventDefault(); runSum(); });

/* ---------- start-up: restore from the link, otherwise show the defaults ---------- */
function restore() {
  restoring = true;
  const p = new URLSearchParams(location.hash.slice(1));
  const tool = p.get('tool');
  setRequests(EXAMPLE);
  if (tool === 'calc' && p.get('q')) $('calc-input').value = p.get('q');
  if (tool === 'vlsm') {
    if (p.get('base')) $('vlsm-base').value = p.get('base');
    const s = p.get('s');
    if (s != null) setRequests(s.split(',').filter(Boolean).map((x) => { const i = x.lastIndexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
  }
  if (tool === 'split' && p.get('q')) $('split-input').value = p.get('q');
  fillSplitOptions();
  if (tool === 'split' && p.get('p')) $('split-prefix').value = p.get('p');
  if (tool === 'sum' && p.get('n')) $('sum-input').value = p.get('n').split(',').join('\n');

  runCalc(); runVLSM(); runSplit(); runSum();
  const tab = { calc: 'tab-calc', vlsm: 'tab-vlsm', split: 'tab-split', sum: 'tab-sum' }[tool] || 'tab-calc';
  selectTab($(tab));
  restoring = false;
}
restore();

