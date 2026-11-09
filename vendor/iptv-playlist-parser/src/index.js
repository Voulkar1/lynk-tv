'use strict'
// Optimized iptv-playlist-parser prototype.
// TARGET SEMANTICS: upstream freearhey/iptv-playlist-parser v0.15.2
// ('#' comment lines append to raw, split on /\r?\n/, tvg-shift,
// http.referrer from EXTINF 'referrer' attr, 'lang') PLUS the 4gray fork's
// deltas: the `radio` attribute and pipe stripping — item.url is cut at the
// first '|' while |User-Agent=/|Referer= params still land in http.*.
//
// Optimizations vs upstream:
//  - no String.prototype pollution
//  - all regexes precompiled at module level (upstream compiles
//    13 x `new RegExp` per EXTINF line + 2 per URL line)
//  - ONE global attribute scan per EXTINF line into an ordered list, then a
//    single ordered pass distributes values to the 15 wanted fields.
//    Upstream getAttribute(name) matches `name="..."` case-insensitively at
//    any position, i.e. also as a *suffix* of a longer attribute name
//    (e.g. getAttribute('user-agent') matches http-user-agent="...").
//    We replicate that with an endsWith check in scan order, first hit wins.
//  - raw built with an array + single join per item instead of repeated +=
//  - no re-trim / no toString round trips

const ATTR_SCAN_RE = /([A-Za-z0-9-]+)="([^"]*)"/g
const NAME_CLEAN_RE = /="(.*?)"/g
const OPT_REFERRER_RE = /:http-referrer=(.*)/i
const OPT_USER_AGENT_RE = /:http-user-agent=(.*)/i
const QUOTE_RE = /"/g
const EXTGRP_VALUE_RE = /:(.*)/
const PIPE_STRIP_RE = /^(.*)\|/
const PARAM_USER_AGENT_RE = /user-agent=(\w[^&]*)/i
const PARAM_REFERER_RE = /referer=(\w[^&]*)/i
const EXTM3U_RE = /^#EXTM3U/i

// Wanted attribute names (lowercase) in the fixed order fields are assigned.
// Index layout must match buildItem().
const WANTED = [
  'tvg-id', 'tvg-name', 'tvg-logo', 'tvg-url', 'tvg-rec', 'tvg-shift',
  'group-title', 'referrer', 'user-agent', 'catchup', 'catchup-days',
  'catchup-source', 'timeshift', 'lang', 'radio'
]
const W_LEN = WANTED.length

// Scan a line once; return flat array [name0, value0, name1, value1, ...]
function scanAttributes(line) {
  ATTR_SCAN_RE.lastIndex = 0
  let out = null
  let m
  while ((m = ATTR_SCAN_RE.exec(line)) !== null) {
    if (out === null) out = []
    out.push(m[1], m[2])
  }
  return out
}

// Upstream-compatible lookup over one scan result: first attribute (in
// position order) whose lowercased name ends with `name` wins — even when its
// value is empty (upstream getAttribute takes the first regex match and maps
// an empty capture to ''). A bitmask tracks positionally-claimed fields.
function distribute(attrs, fields) {
  if (attrs === null) return
  let taken = 0
  for (let a = 0; a < attrs.length; a += 2) {
    const lower = attrs[a].toLowerCase()
    for (let wIdx = 0; wIdx < W_LEN; wIdx++) {
      const bit = 1 << wIdx
      if ((taken & bit) === 0 && lower.endsWith(WANTED[wIdx])) {
        taken |= bit
        fields[wIdx] = attrs[a + 1]
      }
    }
    if (taken === (1 << W_LEN) - 1) return
  }
}

function getName(trimmed) {
  const cleaned = trimmed.replace(NAME_CLEAN_RE, '')
  const comma = cleaned.indexOf(',')
  return comma === -1 ? '' : cleaned.slice(comma + 1)
}

function getOption(trimmed, regex) {
  const m = regex.exec(trimmed)
  return m !== null && m[1] ? m[1].replace(QUOTE_RE, '') : ''
}

function getParameter(trimmed, regex) {
  // Upstream: strip everything through the LAST '|' (greedy), then search.
  // Without a '|' the search runs over the whole URL, by design.
  const pipe = trimmed.lastIndexOf('|')
  const params = pipe === -1 ? trimmed : trimmed.slice(pipe + 1)
  const m = regex.exec(params)
  return m !== null && m[1] ? m[1] : ''
}

function parseHeader(firstLine) {
  const attrs = {}
  const scanned = scanAttributes(firstLine)
  if (scanned !== null) {
    for (const name of ['x-tvg-url', 'url-tvg']) {
      for (let a = 0; a < scanned.length; a += 2) {
        if (scanned[a].toLowerCase().endsWith(name)) {
          if (scanned[a + 1]) attrs[name] = scanned[a + 1]
          break
        }
      }
    }
  }
  return { attrs, raw: firstLine }
}

const Parser = {}

/**
 * Parse an M3U/M3U8 IPTV playlist.
 *
 * Accepts a UTF-8 string or a Node Buffer. A leading BOM, blank lines before
 * the header, surrounding whitespace, and a case-insensitive `#EXTM3U` are
 * all tolerated.
 *
 * @param {string|Buffer} content playlist content
 * @returns {{header: {attrs: Object, raw: string}, items: Array<Object>}}
 *   parsed playlist; see README for the exact item shape
 * @throws {TypeError} when content is neither a string nor a Buffer
 * @throws {Error} `Playlist is not valid` when no `#EXTM3U` header is found
 */
Parser.parse = content => {
  if (typeof content !== 'string') {
    // typeof guard keeps this branch safe in browsers, where Buffer is absent
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
      content = content.toString('utf8')
    } else {
      throw new TypeError(
        'parse() expects an M3U playlist as a string or Buffer, got ' +
          (content === null ? 'null' : typeof content)
      )
    }
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)

  const lines = content.split(/\r?\n/)

  let headerIndex = 0
  while (headerIndex < lines.length && lines[headerIndex].trim().length === 0) {
    headerIndex++
  }
  const headerLine = headerIndex < lines.length ? lines[headerIndex] : ''
  if (!EXTM3U_RE.test(headerLine.trim())) {
    throw new Error('Playlist is not valid')
  }

  const playlist = {
    header: parseHeader(headerLine.trim()),
    items: []
  }

  const items = playlist.items
  const fields = new Array(W_LEN)
  let current = null // item under construction
  let currentRaw = null // array of raw lines for `current`
  let pendingKodiprops = null // #KODIPROP: lines seen before the next #EXTINF

  for (let idx = headerIndex + 1; idx < lines.length; idx++) {
    const raw = lines[idx]
    const line = raw.trim()
    if (line.length !== 0 && line.charCodeAt(0) === 35 /* '#' */) {
      if (line.startsWith('#EXTINF:')) {
        fields.fill('')
        distribute(scanAttributes(line), fields)
        current = {
          name: getName(line),
          tvg: {
            id: fields[0],
            name: fields[1],
            logo: fields[2],
            url: fields[3],
            rec: fields[4],
            shift: fields[5]
          },
          group: { title: fields[6] },
          http: { referrer: fields[7], 'user-agent': fields[8] },
          url: undefined,
          raw,
          line: idx + 1,
          catchup: {
            type: fields[9],
            days: fields[10],
            source: fields[11]
          },
          timeshift: fields[12],
          lang: fields[13],
          radio: fields[14]
        }
        if (pendingKodiprops !== null) {
          // Kodi semantics: #KODIPROP lines apply to the NEXT list entry.
          // Seed raw with them (file order preserved) so consumers reading
          // item.raw see the full DRM/property block of this channel.
          pendingKodiprops.push(raw)
          currentRaw = pendingKodiprops
          current.raw = currentRaw.join('\r\n')
          pendingKodiprops = null
        } else {
          currentRaw = null
        }
        continue
      }
      if (current === null) {
        // Between items (or before the first one) only #KODIPROP lines are
        // buffered for the upcoming #EXTINF; other stray '#' lines are
        // dropped, matching upstream.
        if (
          line.length > 10 &&
          line.slice(0, 10).toUpperCase() === '#KODIPROP:'
        ) {
          if (pendingKodiprops === null) pendingKodiprops = []
          pendingKodiprops.push(raw)
        }
        continue
      }
      if (line.startsWith('#EXTVLCOPT:')) {
        current.http.referrer =
          getOption(line, OPT_REFERRER_RE) || current.http.referrer
        current.http['user-agent'] =
          getOption(line, OPT_USER_AGENT_RE) || current.http['user-agent']
      } else if (line.startsWith('#EXTGRP:')) {
        const m = EXTGRP_VALUE_RE.exec(line)
        const value =
          m !== null && m[1] ? m[1].replace(QUOTE_RE, '') : ''
        current.group.title = value || current.group.title
      }
      // any other '#' line: raw append only
      if (currentRaw === null) currentRaw = [current.raw]
      currentRaw.push(raw)
    } else {
      if (current === null) continue
      const pipeIdx = line.indexOf('|')
      const url = pipeIdx === -1 ? line : line.slice(0, pipeIdx)
      if (url.length !== 0) {
        current.url = url
        current.http['user-agent'] =
          getParameter(line, PARAM_USER_AGENT_RE) || current.http['user-agent']
        current.http.referrer =
          getParameter(line, PARAM_REFERER_RE) || current.http.referrer
        if (currentRaw === null) current.raw = current.raw + '\r\n' + raw
        else {
          currentRaw.push(raw)
          current.raw = currentRaw.join('\r\n')
          currentRaw = null
        }
        items.push(current)
        current = null
      } else {
        // blank line (or url empty after pipe-strip) while an item is open:
        // appended to raw, item stays open (matches String.getURL() || '')
        if (currentRaw === null) currentRaw = [current.raw]
        currentRaw.push(raw)
      }
    }
  }

  // trailing EXTINF without URL stays in the list (upstream Object.values
  // behavior), with raw including any appended continuation lines
  if (current !== null) {
    if (currentRaw !== null) current.raw = currentRaw.join('\r\n')
    items.push(current)
  }

  return playlist
}

module.exports = Parser
