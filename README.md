# Electronic Music Facts — Instagram Automation

Daily automated pipeline that posts an Instagram carousel of electronic music facts.

## 1. Overview
Daily automated pipeline that posts an Instagram carousel:
- **Cover slide**: AI-generated image, either (a) generic electronic music visual, or (b) an AI-edited/stylized image referencing the artist/group tied to the fact
- **Following slides**: "PowerPoint-style" text slides expanding on the fact (source, context, why it matters)

Posting cadence: 1 carousel/day, fully automated with an optional human-approval gate before publish.

---

## 2. Components

### 2.1 Fact Generation — Claude API
- Model: Claude (Sonnet-tier, e.g. `claude-sonnet-4-6`) via Messages API
- Input: rotating topic seed list (genres, eras, gear/synths, DJs, labels, festivals, chart history, production techniques) + list of already-used facts (dedup)
- Output: structured JSON —
  - `fact_type`: `"generic"` | `"artist_specific"`
  - `artist_name` (nullable)
  - `headline` (cover slide text)
  - `slides[]`: array of 4–6 short text blocks for the carousel body
  - `source_note`: brief factual grounding (helps avoid hallucinated "facts")
- Enforce JSON-only system prompt, no markdown fences, parse + validate before continuing
- Add a lightweight fact-check pass (second Claude call, or web search tool) since music trivia is a common hallucination area

### 2.2 Cover Image Generation — Grok API (xAI)
- Two branches based on `fact_type`:
  - **Generic**: prompt built from genre/era/mood keywords → abstract/atmospheric electronic music visual (club lighting, waveform, synth close-up, crowd silhouette, etc.)
  - **Artist-specific**: stylized/illustrative treatment referencing the artist or group

> **⚠️ Flag for the agent/implementer**: Generating AI images of real, named musicians (especially photorealistic ones) carries meaningful legal and platform risk — right of publicity, defamation, and Meta's Community Standards on synthetic/manipulated media of real people. Recommended mitigation, to be decided by you before build:
> - Default to **stylized/illustrated/abstract** representations (silhouette, pop-art, collage, symbolic gear/album-era imagery) rather than photorealistic likeness
> - Avoid photorealistic face generation of real people entirely
> - Add a config flag `ARTIST_IMAGE_MODE = "stylized" | "photoreal"` defaulting to `stylized`, so this is a conscious choice, not a default
> - Have the human-review step (2.5) pay special attention to artist-specific covers before they go live

### 2.3 Carousel Slide Rendering
- Template renderer: HTML/CSS + Puppeteer (headless Chrome → PNG export), or Python + Pillow
- Fixed brand template: consistent font, color palette, logo/handle watermark, slide numbering
- Cover slide = Grok image + headline text overlay
- Body slides = template background + `slides[]` text, one fact chunk per slide
- Output: ordered set of PNGs at Instagram carousel spec (1080×1350 recommended)

### 2.4 Orchestration
- Scheduler: n8n (self-hosted) running a daily cron workflow
- Pipeline steps: `generate_fact` → `validate/fact-check` → `generate_cover_image` → `render_slides` → `queue_for_review` → `publish`
- State store: simple DB (SQLite/Postgres) or n8n's own data store — tracks used topics/artists, post history, approval status

### 2.5 Human Review Gate (recommended, at least initially)
- Telegram or Slack bot: sends rendered carousel preview + fact text
- Approve → triggers publish step
- Reject/edit → loop back to regeneration with feedback note
- Can be removed later once pipeline is trusted

### 2.6 Publishing — Instagram Graph API
- Requires: Instagram Business/Creator account linked to a Facebook Page + Meta Developer app
- Flow: upload each image as a container → create carousel container → publish
- Note: Meta app review needed for production access beyond test users

### 2.7 Optional — Analytics Feedback Loop
- Pull post insights (reach, saves, shares) via Graph API weekly
- Feed top-performing topics/artists back into the topic seed list to bias future fact generation

---

## 3. Data Flow Summary
```
[Topic seed list + history]
        -> Claude API (fact + slide text, JSON)
        -> validation / fact-check
        -> Grok API (cover image, stylized)
        -> Puppeteer/Pillow renderer (branded slides)
        -> Telegram/Slack approval
        -> Instagram Graph API (publish carousel)
        -> Analytics pull (weekly) -> feeds back into topic list
```

---

## 4. Suggested Stack

| Layer | Choice |
|---|---|
| Orchestration | n8n (self-hosted) |
| Fact generation | Claude API |
| Cover image | Grok API |
| Slide rendering | Puppeteer (HTML/CSS templates) |
| Storage | SQLite or Postgres |
| Approval bot | Telegram Bot API |
| Publishing | Instagram Graph API |
| Hosting | Small VPS (e.g. Hetzner/DigitalOcean) |

---

## 5. Open Decisions to Confirm Before Building
1. `ARTIST_IMAGE_MODE` default (stylized vs photoreal) — recommend stylized
2. Whether the human-review gate is mandatory at launch (recommend yes, for first 2–4 weeks)
3. Brand template details: fonts, color palette, logo placement (not yet specified — needs brand guideline input)
4. Topic seed list content (genres/eras/artists to include) — needs initial dataset
