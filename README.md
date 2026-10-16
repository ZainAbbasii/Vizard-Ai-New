# Cutroom

Paste a YouTube link, get five short clips. Self-hosted: the server uses **yt-dlp** to download the video and **ffmpeg** to cut it. No third-party clipping service is involved.

> **Use it only on videos you own or have permission to clip.** Downloading other people's videos can violate YouTube's Terms of Service and copyright law. The form requires a confirmation checkbox, but that is a reminder, not a legal shield.

## How it works

1. Validates the link (YouTube only) and reads the video's length and title.
2. Downloads the video at up to 720p.
3. Downloads YouTube's captions (if any) and turns them into a timestamped transcript.
4. Scores every 25-55 second stretch of speech and picks the best five that do not overlap. Scoring rewards fast, dense speech, hook words, questions, numbers, and a strong opening, and penalizes filler words. If `ANTHROPIC_API_KEY` is set, Claude chooses among the top 12 candidates and writes titles; otherwise the built-in rules decide.
5. Cuts each moment with ffmpeg, center-crops it to 9:16 (or square or original), and burns in captions when it can.
6. Deletes the source video and keeps only the five clips for `KEEP_MINUTES` (default 120).

If a video has no captions, the five clips are spaced evenly through the video and the page says so.

## Run locally

Requires Node 22+.

```bash
npm install          # also downloads the yt-dlp binary into ./bin
npm start
```

Open http://localhost:3000. ffmpeg comes from the `ffmpeg-static` package, or from your system `ffmpeg` if that package could not install. `GET /api/health` shows whether both tools were found.

## Deploy to Cloudways Velocity

1. Commit and push to GitHub, GitLab, or Bitbucket (`.gitignore` already excludes `node_modules`, `.env`, `bin`, `work`, and cookie files). Run `npm install` locally first and commit `package-lock.json`.
2. In the Cloudways console open **Velocity**, choose **Connect via Git**, select the repo. It should detect Express and run `npm install` and `npm start`. Pick Node 22 or 24.
3. Set environment variables in the app settings (see below). Do not set `PORT`.
4. Deploy, then open `/api/health`. It must show both a yt-dlp version and an ffmpeg version. If either is `null`, check the build log: the install step needs outbound internet to fetch the binaries.
5. Strongly recommended on a public site: set `ACCESS_CODE`, so strangers cannot use up your CPU and disk.

**Things that can go wrong on a hosting provider (read these):**

- **YouTube blocks datacenter IPs.** Downloads often fail with "Sign in to confirm you're not a bot." The fix is cookies from a logged-in browser session, exported as a Netscape `cookies.txt` and supplied through `YTDLP_COOKIES_B64` (base64 of the file's contents). Using your account's cookies with yt-dlp can get that account flagged, so use a dedicated account, never your main one. Even with cookies, YouTube changes things often and it may still fail.
- **yt-dlp goes out of date quickly.** If downloads suddenly fail everywhere, run `npm run update:ytdlp` (or redeploy, which re-runs the install step only when `bin/yt-dlp` is missing).
- **Encoding is CPU-heavy.** One job runs at a time and others wait (`MAX_QUEUE`). On a small plan, a long video can take many minutes. Lower `MAX_VIDEO_MINUTES` if jobs time out or the server runs out of memory.
- **Disk is not permanent.** Clips live in `work/` and are deleted after `KEEP_MINUTES` and on every restart. People must download what they want.
- **Some hosts limit long requests or background processes.** This app polls short requests and does the work in the background of a persistent Node process, which Velocity's model supports, but confirm on your plan.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ACCESS_CODE` | none | If set, visitors must enter it to make clips |
| `CLIP_COUNT` | 5 | Clips per video |
| `CLIP_MIN_SECONDS` / `CLIP_MAX_SECONDS` | 25 / 55 | Clip length range |
| `MAX_VIDEO_MINUTES` | 60 | Longest source video accepted |
| `JOBS_PER_HOUR` | 4 | Videos per visitor IP per hour |
| `MAX_QUEUE` | 4 | Jobs running or waiting before the server says it is busy |
| `KEEP_MINUTES` | 120 | How long finished clips stay on disk |
| `ANTHROPIC_API_KEY` | none | Optional AI choice of moments and titles |
| `ANTHROPIC_MODEL` | claude-sonnet-5-5 | Model used when the key is set |
| `YTDLP_COOKIES` / `YTDLP_COOKIES_B64` | none | Cookies for yt-dlp (file path, or base64 contents) |
| `YTDLP_PATH`, `FFMPEG_PATH`, `WORK_DIR` | auto | Overrides |

## Tests

```bash
npm test             # unit tests + full pipeline test (needs ffmpeg, no internet)
npm run test:e2e     # same flow over HTTP (needs npm install first)
```

The tests use a fake `yt-dlp` (`test/fake-ytdlp.js`) and a synthetic video, so they never touch YouTube. That means they prove the cutting, captioning, picking, queueing, and cleanup work, but **not** that a real YouTube download will succeed from your server. Test that yourself with a video you own.

## Known limits

- Cropping is centered; there is no face tracking, so an off-center speaker can be cut off.
- Picking by scoring rules does not understand the video. It finds dense, hook-like speech, not necessarily the funniest or most important moment. Review clips before posting.
- Captions are YouTube's own (often auto-generated, sometimes wrong). Non-English videos work only if YouTube offers captions in that language's original track.
- No accounts, payments, scheduling, or social posting.

## Layout

```
server.js            Express app and job API
lib/config.js        Environment settings
lib/youtube.js       URL checks and the yt-dlp wrapper
lib/vtt.js           Caption parser (handles YouTube's rolling captions)
lib/highlights.js    Scoring and picking moments
lib/llm.js           Optional Claude refinement
lib/clipper.js       ffmpeg cutting, cropping, caption burn-in
lib/jobs.js          Queue and the end-to-end pipeline
scripts/install-ytdlp.js
public/              Site: index.html, 404.html, css/, js/
test/                Unit, pipeline, and HTTP tests with a fake yt-dlp
```
