# TrivexaAI Google Login & Access Control — Setup

This is a staged implementation. It is on a separate branch and is not live until Firebase, Cloudflare D1, Worker variables and the protected Worker are configured and tested.

## Policy
- Public homepage, SEO and information pages remain open.
- Google sign-in is required for all Worker-backed tools.
- Active users get basic tools automatically.
- AI image generation, AI voice generation, advanced features and Video Studio actions require invite or admin approval.
- Only the Google email stored as the Worker secret ADMIN_EMAIL becomes the initial owner admin.

## 1. Firebase
1. Open https://console.firebase.google.com/ and create/use a TrivexaAI project.
2. Authentication → Sign-in method → enable Google and choose a support email.
3. Authentication → Settings → Authorized domains: add `abubakar902.github.io` (no /Creator-Kit path).
4. Project settings → General → Web app: copy the Web App config into `auth/firebase-config.js`.
5. Restrict the Firebase browser API key to HTTP referrer `https://abubakar902.github.io/*` and required Firebase Authentication APIs. Never put service-account JSON, private keys or Gemini keys in browser files.

## 2. Cloudflare D1
1. Workers & Pages → D1 → create database `trivexaai-users`.
2. Run all SQL from `auth/schema.sql` in the D1 console.
3. On the Worker add D1 binding name `TRIVEXA_DB` mapped to `trivexaai-users`.

## 3. Worker variables / secret
Variables:
- `FIREBASE_PROJECT_ID`: exact Firebase Project ID.
- `ALLOWED_ORIGINS`: `https://abubakar902.github.io`.

Secret:
- `ADMIN_EMAIL`: your verified Google email for the owner-only admin account. Do not share it in chat.

Keep all existing bindings and secrets for current tools (AI, CREATOR_LIMITER, GEMINI_API_KEY, VIDEO_DOWNLOADER_API_KEY, SAVEAPI_API_KEY, SAVERAPI_KEY, and anything else currently used). Do not delete them.

## 4. Before deployment
The prepared Worker reuses the latest saved Worker source supplied for this setup. Compare it with the actual currently deployed Worker first; if later edits exist, merge them before replacing the live code. Configure D1 and variables before deploying, or the Worker will reject protected requests as not configured. Deploy the Worker first, then the website files. Test unauthenticated POST returns 401, normal Google account gets basic access, advanced actions return 403 until invited, and owner account can open `auth/admin.html`.

## 5. Files
- `auth/login.html`: Google login screen.
- `auth/account.html`: account status and invite redemption.
- `auth/admin.html`: admin user/invite management.
- `auth/auth-client.js`: Firebase session and Worker Authorization header bridge.
- `auth/firebase-config.js`: fill with your Firebase Web App config.
- `auth/schema.sql`: D1 schema.
- `cloudflare-worker/trivexaai-worker-auth.js`: protected Worker replacement.

## Important limits
GitHub Pages is static hosting. Authentication protects tools and Worker/API operations, but it does not make public HTML/JS source files private. No API keys or private project credentials should be stored in the website. Add Turnstile with server-side Siteverify later if signup abuse appears.