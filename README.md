# Subnet Planner

An IPv4 subnet calculator, VLSM planner and route summariser that runs in the browser.

**Live:** https://siddhanth-mani.github.io/subnet-planner/

I wrote it because I kept doing VLSM by hand on paper when setting up small office networks and lab topologies, and the calculators I found either stopped at a single subnet or wanted an account.

## What it does

- **Calculator.** Takes `192.168.10.37/26`, `192.168.10.37 255.255.255.192` or a bare address. Shows the network, mask, wildcard, usable range, broadcast, address type (RFC 1918, CGNAT, link-local, documentation ranges and so on) and the address in binary with network and host bits marked. Handles `/31` point-to-point links (RFC 3021) and `/32` host routes correctly.
- **VLSM planner.** Give it a block and a list of subnets with the number of hosts each needs. It sizes each one, places the largest first so every subnet sits on its boundary, and lists the space that is left as CIDR blocks. Tells you plainly when the block is too small and by how much.
- **Split.** Divide a network into equal subnets of a chosen prefix.
- **Summarise.** Paste a list of networks and get the exact summary (the fewest routes covering the same addresses) and the smallest single supernet, with a count of any extra addresses that supernet would also advertise.

Results can be copied as CSV or plain text. The page address keeps your inputs, so a plan can be bookmarked or sent to someone.

## How it works

All the maths is in [`src/ipv4.js`](src/ipv4.js), a dependency-free ES module. Addresses are stored as unsigned 32-bit numbers. Range-to-CIDR conversion works by taking the largest aligned block that fits at the start of the range, which is how the "unallocated space" list and the exact summary are produced.

The page has a strict Content Security Policy (no inline scripts, no network requests) and builds every result with `textContent`, so nothing typed into a field is ever parsed as HTML.

## Running it

It is a static site. Any web server will do:

```
python -m http.server 8000
```

then open http://localhost:8000. (Opening `index.html` straight from disk won't work because browsers block ES modules on `file://`.)

## Tests

```
npm test
```

Uses Node's built-in test runner (Node 18 or newer, no packages to install). The tests cover parsing and validation, mask conversion for every prefix, `/31` and `/32`, a worked VLSM example checked by hand, alignment and overlap checks, range splitting and route summarisation. They run on every push through GitHub Actions.

## Licence

MIT
