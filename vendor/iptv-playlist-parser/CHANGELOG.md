# Changelog

This fork is consumed by [IPTVnator](https://github.com/4gray/iptvnator) as a
git dependency pinned by commit SHA (`github:4gray/iptv-playlist-parser#<sha>`).
Versions use the upstream base version plus an `-iptvnator.N` suffix.

## 0.15.2-iptvnator.2 — 2026-07-24

- **`#KODIPROP` lines before `#EXTINF` are preserved**: Kodi property lines
  apply to the next list entry, so ones placed above the `#EXTINF` are now
  buffered and attached to that item's `raw` in file order (case-insensitive
  prefix). Other stray `#` lines outside an open item are still dropped,
  matching upstream. Needed by IPTVnator's DASH + ClearKey support
  ([iptvnator#1225](https://github.com/4gray/iptvnator/pull/1225)), which
  extracts `inputstream.adaptive.license_*` config from `item.raw`.

## 0.15.2-iptvnator.1 — 2026-07-19

- **sync with upstream v0.15.2** — URL validation removed (fixes
  [iptvnator#1189](https://github.com/4gray/iptvnator/issues/1189): URLs longer
  than 2084 chars used to be rejected and collapse the playlist into one
  channel); `#` comments/unknown directives never become URLs; `\r\n` split;
  `tvg-shift`, `lang`, EXTINF `referrer` attribute
- **fork deltas preserved**: `radio` attribute; pipe options stripped from
  `item.url` (still extracted into `item.http`)
- **perf**: `parse()` rewritten around measured hotspots — 2.5–3× faster
  (100k channels ~780 ms → ~285 ms), byte-identical output
- **robust input**: leading BOM, blank lines/whitespace before the header, and
  case-insensitive `#EXTM3U` are accepted; Node Buffers decoded as UTF-8;
  clear `TypeError` for other non-string input
- **types**: `url?: string` (matches runtime), `radio: string`, header attrs
  optional; stray ambient module declaration removed
- **deps**: unused `validator` / `is-valid-path` dropped — zero runtime deps
- **tests/CI**: 31 tests, 100% coverage enforced via `coverageThreshold`,
  50k-channel scale test, `npm run bench`, GitHub Actions (node 20/22)

## 0.12.2 base (historical fork state)

- `radio` attribute support
- `require_tld: false` so LAN hostnames pass URL validation
  (superseded by the 0.15.x validation removal)
