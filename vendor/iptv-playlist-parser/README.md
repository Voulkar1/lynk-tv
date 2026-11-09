# iptv-playlist-parser (IPTVnator fork) [![test](https://github.com/4gray/iptv-playlist-parser/actions/workflows/test.yml/badge.svg)](https://github.com/4gray/iptv-playlist-parser/actions/workflows/test.yml)

[4gray](https://github.com/4gray)'s fork of [freearhey/iptv-playlist-parser](https://github.com/freearhey/iptv-playlist-parser), used by [IPTVnator](https://github.com/4gray/iptvnator). It parses an IPTV playlist and converts it to a regular JavaScript object.

## Differences from upstream

The fork tracks upstream (currently fully synced with **v0.15.2**) with these deliberate changes on top:

- **`radio` attribute** — `#EXTINF` lines may carry `radio="true"`; the value is exposed as `item.radio` (`''` when absent). IPTVnator keys its radio player, EPG suppression, and external-player gating off this field.
- **Pipe options are stripped from `item.url`** — a line like `http://host/stream.ts|User-Agent=Foo&Referer=bar` yields `url: 'http://host/stream.ts'`, while the `|User-Agent=` / `|Referer=` parameters still land in `item.http`. Upstream 0.15.0 stopped stripping and keeps the whole line in `url`; IPTVnator feeds `item.url` verbatim to hls.js/mpv/VLC, catch-up URL building, and url-keyed favorites, so the fork restores the pre-0.15.0 contract.
- **Optimized `parse()`** — same output, rewritten around measured hotspots (one precompiled attribute scan per `#EXTINF` line instead of 14+ `new RegExp` constructions, no catastrophic pipe-regex backtracking, no `String.prototype` pollution). Roughly 2.5–3× faster: 100k channels parse in ~285 ms instead of ~780 ms, 10k in ~25 ms instead of ~79 ms. Output is differential-verified byte-identical against the reference implementation on every test fixture, real Pluto TV playlists, and 10k/50k/100k synthetic corpora.
- **Zero runtime dependencies** — upstream still declares (but no longer uses) `validator` and `is-valid-path`; the fork drops both.
- **Robust input handling** — a leading UTF-8 BOM, blank lines/whitespace before the header, and a case-insensitive `#EXTM3U` are accepted (VLC-compatible); Node Buffers are decoded as UTF-8; other non-string input throws a clear `TypeError`. Upstream rejects all of these.
- **`#KODIPROP` lines before `#EXTINF` are preserved** — Kodi property lines apply to the *next* list entry, so ones placed before the `#EXTINF` (a layout some DRM playlists use) are attached to that item's `raw` in file order (case-insensitive prefix). Upstream drops any `#` line outside an open item; other stray comments are still dropped. IPTVnator reads ClearKey DRM config from these lines ([iptvnator#1225](https://github.com/4gray/iptvnator/pull/1225)).
- **Extra regression tests** — URLs longer than 2084 characters ([iptvnator#1189](https://github.com/4gray/iptvnator/issues/1189)), comments/unknown directives between `#EXTINF` and the URL, the `radio` value, and LAN hostnames.

Like upstream since 0.15.0, the parser performs **no URL validation**: any non-empty line that does not start with `#` closes the current item as its URL, and `#` comment lines are appended to `item.raw` without ever being treated as URLs.

## Installation

```sh
npm install github:4gray/iptv-playlist-parser
```

## Usage

### From string

```js
const parser = require('iptv-playlist-parser')
// import parser from 'iptv-playlist-parser'

const playlist = `#EXTM3U x-tvg-url="http://example.com/epg.xml.gz"
#EXTINF:-1 tvg-id="cnn.us" tvg-name="CNN" tvg-url="http://195.154.221.171/epg/guide.xml.gz" tvg-shift="-4.5" timeshift="3" catchup="shift" catchup-days="3" catchup-source="https://m3u-server/hls-apple-s4-c494-abcdef.m3u8?utc=325234234&lutc=3123125324" lang="eng" tvg-logo="http://example.com/logo.png" group-title="News",CNN (US)
#EXTGRP:News
#EXTVLCOPT:http-referrer=http://example.com/
#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_5)
http://example.com/stream.m3u8`

const result = parser.parse(playlist)

console.log(result)
```

### From file

```js
const fs = require('fs')
const parser = require('iptv-playlist-parser')

const playlist = fs.readFileSync('playlist.m3u', 'utf8')

const result = parser.parse(playlist)

console.log(result)
```

### From URL

```js
const https = require('https')
const parser = require('iptv-playlist-parser')

https
  .get('https://example.com/playlist.m3u', res => {
    let data = []

    res.on('data', chunk => {
      data.push(chunk)
    })

    res.on('end', () => {
      const playlist = Buffer.concat(data).toString()

      const result = parser.parse(playlist)

      console.log(result)
    })
  })
  .on('error', err => {
    console.error(err.message)
  })
```

## Output

```js
{
  header: {
    attrs: {
      'x-tvg-url': 'http://example.com/epg.xml.gz'
    },
    raw: '#EXTM3U x-tvg-url="http://example.com/epg.xml.gz"'
  },
  items: [
    {
      name: 'CNN (US)',
      tvg: {
        id: 'cnn.us',
        name: 'CNN',
        url: 'http://195.154.221.171/epg/guide.xml.gz',
        logo: 'http://example.com/logo.png',
        rec: '',
        shift: '-4.5'
      },
      group: {
        title: 'News'
      },
      http: {
        referrer: 'http://example.com/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_5)'
      },
      url: 'http://example.com/stream.m3u8',
      raw: '#EXTINF:-1 tvg-id="cnn.us" tvg-name="CNN" tvg-url="http://195.154.221.171/epg/guide.xml.gz" tvg-shift="-4.5" timeshift="3" catchup="shift" catchup-days="3" catchup-source="https://m3u-server/hls-apple-s4-c494-abcdef.m3u8?utc=325234234&lutc=3123125324" tvg-logo="http://example.com/logo.png" group-title="News",CNN (US)\n#EXTVLCOPT:http-referrer=http://example.com/\n#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_5)\nhttp://example.com/stream.m3u8',
      line: 2,
      timeshift: '3',
      catchup: {
        type: 'shift',
        source: 'https://m3u-server/hls-apple-s4-c494-abcdef.m3u8?utc=325234234&lutc=3123125324',
        days: '3'
      },
      lang: 'eng',
      radio: ''
    },
    //...
  ]
}
```

## Testing

```sh
npm test      # unit + edge-case + 50k-channel scale tests (100% coverage of src)
npm run bench # parse-time medians for 10k / 100k synthetic channels
```

## Contribution

If you find a bug or want to contribute to the code or documentation, you can help by submitting an [issue](https://github.com/4gray/iptv-playlist-parser/issues) or a [pull request](https://github.com/4gray/iptv-playlist-parser/pulls). Parser bugs that are not fork-specific are best reported [upstream](https://github.com/freearhey/iptv-playlist-parser/issues) as well.

## License

[MIT](LICENSE)
