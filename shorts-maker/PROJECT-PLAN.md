# TrivexaAI AI Shorts Maker — Product & Build Plan

**Status:** Planning approved for the project foundation  
**Branch:** `feature/trivexaai-ai-shorts-maker-plan`  
**Product role:** A separate, vertical-first short-form video creation project. It is not a replacement for TrivexaAI Video Studio.

## 1. Product goal

Help a beginner turn an idea, a written script, or their own video clips into a polished vertical short for YouTube Shorts, Instagram Reels, and TikTok.

The experience should feel guided: choose a starting method, prepare the story, arrange scenes, preview the short, and export it. Advanced timeline editing remains the job of Video Studio.

## 2. What makes it different from Video Studio

- **AI Shorts Maker:** story-first and vertical-first. It guides the creator from idea to hook, script, scene plan, captions, and a ready-to-edit short.
- **Video Studio:** a general-purpose multi-track editor for detailed manual editing and broader video projects.

The Shorts Maker should reuse proven local media capabilities where practical, not copy the entire 397 KB Video Studio editor into a second project.

## 3. V1 creation paths

### A. Start from an idea or script

The user enters:
- Topic or pasted script
- Language
- Audience and tone
- Target platform
- Target duration: 15, 30, 45, or 60 seconds
- Visual style

The existing text-generation Worker route can return a structured short package:
- Opening hook
- Voiceover / narration
- Scene-by-scene plan with approximate timing
- On-screen text for each scene
- Visual suggestions for footage the creator can supply
- Closing call to action
- Suggested title, caption, and hashtags

The creator can edit every generated line before building the video.

### B. Build with the creator's own media

The user imports their own video clips, photos, or audio. The Shorts Maker provides:
- A vertical 9:16 canvas
- Scene order and simple trimming
- Fit / fill crop controls
- Editable text overlays and caption styling
- Optional background audio from the user's own files
- Preview before export

No copyrighted stock-video or music library is assumed. The user supplies media they own or have permission to use.

## 4. Planned start screen

Use the familiar TrivexaAI project-start pattern:

1. **Create from an Idea** — write a topic and let AI prepare the hook, narration, and scene plan.
2. **Use My Clips** — upload existing footage and build a vertical short.
3. **Start from a Template** — choose a ready-made short structure.
4. **Recent Projects** — reopen or delete saved drafts.

Recent projects should reopen directly into the editing flow, not force the user through the start panel again.

## 5. First template set

- Talking-head / voiceover with B-roll
- Podcast highlight
- Gaming moment
- Quick facts / education
- Product showcase
- Mini vlog

Templates define layout, text placement, caption style, and scene pacing. They do not include unlicensed footage or music.

## 6. AI and cost approach

- Reuse the existing authenticated TrivexaAI Worker for short-script generation. Give requests a dedicated tool ID such as `ai-shorts-maker` so usage can be measured and rate-limited separately.
- Do not add a new paid API key for V1.
- Do not promise generated AI video from a text prompt. Full text-to-video generation is outside V1 because it would introduce substantial model cost and availability risk.
- Optional generated narration can reuse the existing voice route only where the account already has the required approved access.
- Existing Whisper auto-transcription can be considered for uploaded clips, but the current Worker protects `transcribe_audio` behind advanced access. V1 must respect that gate; it must not bypass it or pretend the feature is available to every account.
- If AI voice or auto-transcription is unavailable to an account, the user can still edit captions manually and upload or record their own audio.

## 7. Technical foundation

- Keep the project isolated under `shorts-maker/`.
- Use a separate IndexedDB database, for example `trivexaai-shorts-maker`, so Shorts projects and media do not collide with Video Studio or Photo Studio data.
- Store project metadata and imported media locally in the browser/device, with clear storage and export warnings.
- Reuse `video-studio/local-video-tools.js` only for capabilities that can be safely called as a module; avoid coupling to private functions inside the giant editor page.
- Reuse browser playback, canvas rendering, and `MediaRecorder` techniques where supported.
- Export MP4 only when the browser's recording support or the existing local conversion path can reliably provide it; otherwise offer a clearly labelled WebM fallback.
- Offer adaptive export quality (720p as a safer default for weaker devices, 1080p when the device can handle it). Never promise identical performance on every phone or computer.
- Do not upload a user's original videos to an AI provider just to edit or preview them. Send only the minimum audio/text required for a feature the user deliberately chooses.

## 8. V1 scope and later upgrades

### V1 — build first
- Premium start panel and recent projects
- Idea-to-script and scene-plan generation
- 9:16 vertical canvas
- User-owned video/photo/audio import
- Scene ordering and simple trimming
- Text overlays and manually editable captions
- Local preview, autosave, and export

### V1.5 — after V1 is stable
- Optional TTS voiceover using existing approved access
- Optional timestamped auto-captions using the existing protected transcription route
- More caption presets, transition presets, and reusable branded styles

### Later — only after usage and costs are understood
- Find highlights automatically in long videos
- Smarter silence / pause trimming
- Automatic reframing and scene suggestions
- Additional AI-generated visual assets
- More sophisticated scene-to-beat syncing

## 9. Explicitly out of scope for the first release

- Text-to-video model generation
- A cloud-rendering service
- Unlimited AI generation
- A new paid API subscription
- A replacement for the full Video Studio timeline editor
- Automatic scraping or downloading of other creators' videos

## 10. Build milestones

1. **Foundation:** create the isolated Shorts Maker folder, responsive start screen, and project database.
2. **Story builder:** idea/script input, settings, AI hook/script/scene-plan output, and editable storyboard.
3. **Short editor:** 9:16 preview, media import, scene ordering, trimming, overlays, and captions.
4. **Audio:** bring-your-own audio first; then integrate optional approved TTS and transcription.
5. **Export:** render, download, recover from failures, and test on desktop and mobile.
6. **Polish:** onboarding, helpful empty states, storage warnings, accessibility, and performance tuning.

## 11. V1 acceptance checklist

- A first-time user can create a draft without knowing video-editing terminology.
- A user can start from an idea or from their own clips.
- Every generated script and caption is editable before export.
- The output preview and export use a vertical 9:16 frame.
- Drafts reopen correctly from Recent Projects on the same browser/device.
- Export has clear progress, cancellation/error messages, and a usable fallback format.
- Existing Video Studio, Photo Studio, account access, and Admin permissions remain unchanged.
- No paid feature is displayed as active when the required API access or account permission is missing.

---

**Recommended first implementation:** build Milestone 1 only (the responsive start screen + local project foundation), verify it, and then add the AI story builder. This keeps the first delivery small and avoids risking the already working studios.
