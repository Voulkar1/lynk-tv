# LYNK TV

IPTV player for M3U/M3U8 playlists, Xtream Codes and Stalker portals — a product of
**LYNK Technology & Systems** ([lynkts.com](https://lynkts.com)).

LYNK TV is a player only: it does not include channels, playlists or subscriptions.
Use only playlists you have the right to watch.

## Builds

| Where | How |
| --- | --- |
| Mac (Apple Silicon / Intel) | GitHub Actions → **LYNK TV builds** → Run workflow; download the `.dmg` from the run. Unsigned for now: the first time, right-click the app → **Open**. |
| LG webOS TV | Same workflow, `lynk-tv-webos` artifact (`.ipk`). Install in Developer Mode. Needs a LYNK TV server on the home network (the Mac app → Settings → Server). |
| Web | `pnpm nx build web --configuration=pwa && node tools/netlify/build.mjs`, then deploy `dist/netlify` to Netlify. The `/api` function needs the `LYNK_TARGET_KEY` env var (32+ random characters). |

Push a tag such as `v0.25.0-lynk.1` to publish a GitHub Release with all files attached.

## Credits

Based on [IPTVnator](https://github.com/4gray/iptvnator) by 4gray, MIT License
(see [LICENSE.md](LICENSE.md), which must be kept). "IPTVnator" and its logo are
trademarks of their owner and are not used to identify this product
(see [TRADEMARK.md](TRADEMARK.md)). The original README is in
[docs/IPTVNATOR-README.md](docs/IPTVNATOR-README.md).
