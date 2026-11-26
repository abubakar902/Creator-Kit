# TrivexaAI AI Shorts Maker — Product & Build Plan

**Status:** Revised to the user's core product idea  
**Branch:** `feature/trivexaai-ai-shorts-maker-plan`  
**Product role:** A separate AI-powered, batch short-clip maker. It is not a general-purpose video editor and does not replace TrivexaAI Video Studio.

## 1. The exact product idea

The user uploads **one of their own long videos**. TrivexaAI analyzes what is actually said and shown in that video, finds the strongest short-form topics and moments, then creates the number of separate vertical Shorts the user requested.

Example: a user uploads a 20-minute recording and requests 4 Shorts. The AI may identify four distinct, worthwhile moments in that same recording, prepare a hook and an appropriate in/out range for each, and create four separate short videos from the original source.

The core promise is:

**Upload one video → find strong short topics and moments → create the requested number of Shorts → download them.**

This is the primary workflow. "Create from an idea", general-purpose editing, and manual multi-track timeline work are not the main purpose of this product.

## 2. What "viral topics" means in V1

In V1, "viral topics" means **high-potential, engaging moments found inside the video the user uploaded**. The AI should look for moments such as:
- A strong statement, surprising fact, or useful takeaway
- A clear question followed by an interesting answer
- A story, reaction, emotional moment, or entertaining exchange
- A tip, lesson, opinion, or debate that can stand on its own
- A moment with a natural hook and a satisfying payoff

The AI must not promise that a clip will go viral. It should explain briefly why each selected moment may work well as a Short (for example: strong opening, useful information, curiosity, or emotional impact).

V1 does **not** claim to scan TikTok, YouTube, or Instagram live trends. It analyses the contents of the uploaded video. Matching those topics against live external trends can be considered later, only if a reliable and affordable source is available.

## 3. Simple user journey

### Step 1 — Upload one source video
- Drag and drop or browse for a video file.
- Show its filename, duration, and a basic preview.
- The user confirms they own the video or have permission to edit it.
- Keep the original video in the browser's local project storage. Do not upload the entire video file to an AI provider for topic analysis.

### Step 2 — Choose only the important options
Keep the choices simple:
- **How many Shorts?** 1, 2, 3, 4, 5, or a sensible custom number after implementation testing.
- **Target length:** Auto, or a few practical ranges such as 15–30, 30–45, and 45–60 seconds.
- **Format:** vertical 9:16 by default for YouTube Shorts, Reels, and TikTok.
- **Captions:** optional. The user can ask for on-video subtitles, a social-media post caption, or both.
- **Caption language:** Auto detect or a supported selected language.

Do not overwhelm the user with an advanced editor before the AI has found the clips.

### Step 3 — AI analyzes the uploaded video
1. Read the video's duration and prepare its audio locally in manageable chunks.
2. Use the existing authenticated speech-to-text route for timestamped transcription where the account has the required permission.
3. Keep the original time offset for every transcript segment so the AI's suggested clips point to the exact moments in the source video.
4. Analyze the transcript in context and group related discussion into distinct short-form topics.
5. Rank candidate moments by hook strength, clarity, standalone meaning, useful/entertaining value, and whether the moment has a natural beginning and payoff.
6. Select the requested number of **distinct** clips, avoiding repetitive or heavily overlapping moments.
7. If there are not enough genuinely useful moments, say so and offer fewer good Shorts rather than inventing content or forcing weak clips.

### Step 4 — Create the requested Shorts
For each selected moment:
- Use the original video segment and its timestamp range.
- Preserve the speaker's real meaning and context. Do not fabricate spoken words or splice unrelated sentences together.
- Choose a suitable vertical crop. Use automatic subject-aware reframing only when it works reliably; otherwise use a safe centre crop and allow a simple adjustment.
- Add an optional short opening hook/title overlay.
- Generate editable on-video subtitles only when requested.
- Prepare an optional social post caption (and relevant hashtags if requested) separately from the on-video subtitles.
- Keep a consistent look across a requested batch/series while giving each Short its own topic and hook.
- Label outputs clearly (Short 1 of 4, Short 2 of 4, etc.) without forcing an episodic narrative when the source does not support one.

The result should be actual short video files cut from the user's own upload—not merely a list of script ideas.

### Step 5 — Review and download
Show a batch results screen with:
- Short preview
- Topic / hook
- Source timestamp range
- Optional editable on-video subtitles
- Optional copyable social caption
- Download button for each finished Short
- A way to regenerate or adjust an individual result without losing the others

Generate and export clips one at a time to reduce memory and CPU pressure. A batch download/ZIP can be a later improvement after its reliability is proven.

## 4. Separate from Video Studio

- **AI Shorts Maker:** upload one long source video, discover the strongest moments, automatically choose clip ranges, and create a requested batch of short vertical videos.
- **Video Studio:** a general multi-track editor for manual, detailed editing of broader video projects.

Do not copy the entire Video Studio editor into Shorts Maker. Reuse only proven, isolated capabilities where it is safe to do so.

## 5. AI, access, and cost approach

- Reuse the existing authenticated TrivexaAI Worker and its current text-generation route for topic selection, hooks, clip metadata, and optional social captions. Send only transcript text and the minimum context required; give this work its own tool ID such as `ai-shorts-maker` for rate-limit and usage measurement.
- Reuse the existing `transcribe_audio` Whisper route for timestamped speech-to-text only when the signed-in account is allowed to use it. The current Worker marks transcription as an advanced action and checks account approval. **Do not bypass that access check.**
- The current transcription endpoint accepts audio chunks encoded as Base64, with `audio/webm` or `audio/ogg` MIME types and a request-size limit. The client must process short chunks, keep their source-time offsets, handle errors, and never assume a long video can be transcribed in one request.
- If transcription is unavailable because the account lacks permission or the service is temporarily unavailable, show a clear message. Do not pretend analysis is complete. A later fallback may let the user supply a transcript, but automatic upload-to-Shorts is the main goal.
- Do not add a new paid API key for V1.
- No text-to-video generation model is required: V1 creates clips from the user's real uploaded footage.
- Optional narration/TTS is not part of the first release. The original speaker's audio should remain the default.
- Do not promise live trend discovery, automatic virality, unlimited usage, or features whose access is not configured.

## 6. Technical foundation

- Keep the project isolated under `shorts-maker/` and keep its first implementation on this feature branch until tested.
- Use a separate IndexedDB database, for example `trivexaai-shorts-maker`, for project metadata, the original video, transcript data, candidate clips, and exported results. Do not collide with Video Studio or Photo Studio storage.
- Store user media locally in the browser/device. Clearly warn users that drafts are device/browser-specific and to download finished videos.
- Reuse the proven timestamped transcription approach from Video Studio: extract audio in-browser, record manageable chunks, call the existing protected Worker route, and restore global timestamps by adding each chunk's source offset.
- Build a dedicated lightweight clip renderer rather than depending on private functions inside the large Video Studio editor. It should load a source time range, render a 9:16 composition to a canvas, capture video/audio where browser support permits, and export one clip at a time.
- Reuse existing local-video utilities only where their exported module API is appropriate; avoid tightly coupling to Video Studio DOM IDs or internal application state.
- Use a conservative export default (for example 720p) and offer 1080p where the browser/device can handle it. Test the actual output and sync before promising a format.
- Offer MP4 only when native browser recording or a tested local conversion path supports it reliably. Otherwise provide a clearly labelled WebM fallback.
- Handle unsupported files/codecs, long durations, large files, missing audio, transcription failures, low memory, tab closure, and export cancellation with readable messages.
- Never send the entire original video to AI just to identify topics. Only send the audio chunks needed for the user-requested transcription and the resulting transcript text needed for topic analysis.

## 7. V1 scope — build this first

1. Premium upload-first start screen.
2. Local video file import, preview, duration and basic validation.
3. Simple options for requested Shorts count, length and optional captions.
4. Timestamped transcript analysis using the already configured protected route, subject to account access.
5. AI shortlist of the best matching topics/moments in the source video.
6. Automatic selection of the requested number of distinct clip ranges.
7. Vertical 9:16 clip rendering from the original source footage.
8. Optional editable on-video subtitles and optional copyable social post captions.
9. Batch results page, per-Short preview, regeneration and individual download.
10. Local draft saving and reopening through Recent Projects.

## 8. Later upgrades — only after V1 works well

- Live trend comparison from supported, trustworthy sources.
- Smarter face/person tracking and auto-reframing.
- Better visual scene-change detection and highlight ranking.
- Custom brand kits, logo/watermark, font and caption themes.
- Batch ZIP download.
- More advanced trimming or handoff to Video Studio for detailed manual editing.
- Optional AI voiceovers, only after access, performance, and API costs are understood.

## 9. Explicitly out of scope for V1

- A general-purpose multi-track timeline editor.
- Generating completely new AI video footage from a text prompt.
- Automatically downloading or scraping other creators' videos.
- A cloud-rendering service or uploading the full source video to an AI provider.
- Live trend scanning without a reliable source.
- Guaranteed viral scores, views, or engagement.
- Unlimited AI usage or a new paid AI subscription.
- Automatically adding unlicensed stock footage or music.

## 10. Build milestones

1. **Upload foundation:** responsive upload-first start screen, local video preview, project storage, recent projects.
2. **Transcript pipeline:** safely extract audio chunks, call permitted transcription route, preserve exact timestamps, show progress and errors.
3. **Viral-moment finder:** analyze transcript, rank candidates, choose the requested count, show concise reasons and time ranges.
4. **Shorts renderer:** cut source ranges, crop to 9:16, render optional hook overlays, produce reliable separate video files.
5. **Captions:** optional subtitle generation and editing; optional social post captions and hashtags.
6. **Batch results:** preview, regenerate one Short, download each result, recover saved drafts.
7. **Device testing and polish:** desktop Chrome/Edge, supported mobile browsers, file-size limits, memory, audio sync, accessibility, and performance.

## 11. V1 acceptance checklist

- The main workflow begins with **one uploaded video**, not a blank editing timeline or an idea-only prompt.
- A beginner can request 1, 2, 3, 4, or another supported number of Shorts with minimal settings.
- The AI finds real, timestamped moments in the uploaded video and returns distinct topics.
- The tool never invents a quote, event, or topic that is not supported by the source video.
- Each final result is a real vertical clip cut from the uploaded source.
- The number of generated Shorts matches the user's request when the source has enough worthwhile moments; otherwise the app explains why fewer are available.
- Captions are optional, with on-video subtitles clearly distinguished from social post captions.
- Users can preview and download each Short separately.
- Drafts reopen correctly from Recent Projects on the same browser/device.
- Transcription access checks are respected; restricted AI features are not silently bypassed.
- Existing Video Studio, Photo Studio, account permissions, and Admin security remain unchanged.
- No claim is made that a result is guaranteed to go viral.

---

**Recommended first implementation:** build Milestone 1 only (the upload-first start screen, local video preview, simple Shorts-count/captions options, and local project foundation). Verify that foundation before adding transcription and AI analysis. This makes the first release match the user's actual idea without risking the working studios.
