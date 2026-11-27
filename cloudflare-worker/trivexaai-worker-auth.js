
/* TrivexaAI authentication gateway. Legacy AI tool handlers are retained below. */
const FIREBASE_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let firebaseKeys = null;
let firebaseKeysExpiry = 0;
const TRACKED_TOOL_ACTIONS = new Set([
  "generate_text", "generate_image", "generate_voice", "video_studio",
  "video_studio_create", "video_studio_export", "video_studio_ai_assistant",
  "transcribe_audio", "shorts_analyze", "shorts_caption",
  "ai_editing_assistant", "ai_prompt_writer", "creator_intelligence_generate"
]);
const TRACKED_TOOL_IDS = new Set([
  "titles", "caption", "hashtags", "description", "hooks", "script",
  "ai-question-answer", "trivexaai-website-guide", "creator-intelligence-studio"
]);
const ADVANCED_ACTIONS = new Set([
  "generate_image", "generate_voice", "video_studio", "video_studio_create",
  "video_studio_export", "video_studio_ai_assistant", "transcribe_audio", "shorts_analyze", "shorts_caption", "ai_editing_assistant", "ai_prompt_writer",
  "advanced_feature", "creator_intelligence_generate"
]);
function b64u(s) {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b + "=".repeat((4 - b.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function jwtPart(s) { return JSON.parse(new TextDecoder().decode(b64u(s))); }
async function getSigningKey(kid, refresh = false) {
  const now = Date.now();
  if (refresh || !firebaseKeys || now >= firebaseKeysExpiry) {
    const res = await fetch(FIREBASE_CERTS_URL, {headers:{Accept:"application/json"}, cf:{cacheTtl:3600}});
    if (!res.ok) throw new Error("Firebase signing keys unavailable.");
    const data = await res.json();
    if (!Array.isArray(data.keys)) throw new Error("Firebase signing keys invalid.");
    firebaseKeys = data.keys;
    const age = Number((res.headers.get("Cache-Control") || "").match(/max-age=(\d+)/i)?.[1] || 3600);
    firebaseKeysExpiry = now + Math.max(300, Math.min(age, 21600)) * 1000;
  }
  const jwk = firebaseKeys.find(k => k.kid === kid && k.alg === "RS256");
  if (!jwk && !refresh) return getSigningKey(kid, true);
  if (!jwk) throw new Error("Firebase signing key not found.");
  return crypto.subtle.importKey("jwk", jwk, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["verify"]);
}
async function verifyIdToken(token, env) {
  if (!env.FIREBASE_PROJECT_ID) throw new Error("Firebase project not configured.");
  if (typeof token !== "string" || token.length < 100 || token.length > 10000) throw new Error("Invalid token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token.");
  const head = jwtPart(parts[0]), claims = jwtPart(parts[1]);
  const project = String(env.FIREBASE_PROJECT_ID).trim();
  const now = Math.floor(Date.now()/1000);
  if (head.alg !== "RS256" || !head.kid) throw new Error("Token algorithm rejected.");
  if (claims.iss !== "https://securetoken.google.com/" + project || claims.aud !== project) throw new Error("Token audience rejected.");
  if (!claims.sub || claims.sub.length > 128 || !Number.isFinite(claims.exp) || claims.exp <= now) throw new Error("Token expired or invalid.");
  if (!Number.isFinite(claims.iat) || claims.iat > now+300 || !Number.isFinite(claims.auth_time) || claims.auth_time > now+300) throw new Error("Token time invalid.");
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 300 || claims.nbf > now)) throw new Error("Token not yet valid.");
  if (claims.email_verified !== true || typeof claims.email !== "string" || !claims.email.includes("@")) throw new Error("Verified Google email required.");
  if (claims.firebase?.sign_in_provider !== "google.com") throw new Error("Google sign-in required.");
  const key = await getSigningKey(head.kid);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0]+"."+parts[1]));
  if (!valid) throw new Error("Token signature invalid.");
  return claims;
}
function safeUser(r) {
  return {uid:r.uid,email:r.email,displayName:r.display_name||"",photoUrl:r.photo_url||"",role:r.role,status:r.status,advancedAccess:r.advanced_access,createdAt:r.created_at,lastSeenAt:r.last_seen_at};
}
async function getUser(env, c) {
  const db = env.TRIVEXA_DB, now = Math.floor(Date.now()/1000);
  const email = c.email.trim().toLowerCase();
  const owner = Boolean(env.ADMIN_EMAIL && email === String(env.ADMIN_EMAIL).trim().toLowerCase() && c.email_verified === true);
  await db.prepare(`INSERT INTO users (uid,email,display_name,photo_url,role,status,advanced_access,created_at,updated_at,last_seen_at)
    VALUES(?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(uid) DO UPDATE SET
    email=excluded.email,display_name=excluded.display_name,photo_url=excluded.photo_url,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`)
    .bind(c.sub,email,String(c.name||"").slice(0,120),String(c.picture||"").slice(0,1000),owner?"admin":"user",owner?"approved":"pending",now,now,now).run();
  if (owner) await db.prepare("UPDATE users SET role='admin',advanced_access='approved',updated_at=? WHERE uid=?").bind(now,c.sub).run();
  return db.prepare("SELECT uid,email,display_name,photo_url,role,status,advanced_access,created_at,last_seen_at FROM users WHERE uid=?").bind(c.sub).first();
}
async function audit(env, actor, target, action, detail={}) {
  await env.TRIVEXA_DB.prepare("INSERT INTO admin_audit_log(actor_uid,target_uid,action,details_json,created_at) VALUES(?,?,?,?,?)")
    .bind(actor,target||null,action,JSON.stringify(detail),Math.floor(Date.now()/1000)).run();
}
async function shaHex(s) {
  const b = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function inviteCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const h = [...b].map(x=>x.toString(16).padStart(2,"0")).join("").toUpperCase();
  return "TRI-"+h.slice(0,8)+"-"+h.slice(8);
}
async function accountAction(body, env, user, reply) {
  const now = Math.floor(Date.now()/1000), a = String(body.action||"");
  if (a === "creator_intelligence_workspace_access") {
    const allowed = user.status === "active" && (user.role === "admin" || user.advanced_access === "approved");
    if (!allowed) return reply({error:"Creator Intelligence Studio requires Advanced Access approval. Please request admin approval.",code:"ADVANCED_ACCESS_REQUIRED",allowed:false},403);
    return reply({allowed:true,workspace:"creator-intelligence",access:"approved"});
  }
  if (a === "shorts_workspace_access") {
    const allowed = user.status === "active" && (user.role === "admin" || user.advanced_access === "approved");
    if (!allowed) return reply({error:"Premium access is required to open AI Shorts Maker. Please request admin approval.",code:"ADVANCED_ACCESS_REQUIRED",allowed:false},403);
    return reply({allowed:true,workspace:"shorts-maker",access:"approved"});
  }
  if (a === "photo_editor_workspace_access") {
    const allowed = user.status === "active" && (user.role === "admin" || user.advanced_access === "approved");
    if (!allowed) return reply({error:"Premium access is required to open Photo Studio. Please request admin approval.",code:"ADVANCED_ACCESS_REQUIRED",allowed:false},403);
    return reply({allowed:true,workspace:"photo-editor",access:"approved"});
  }
  if (a === "dashboard_data") {
    const since = now - 30 * 86400;
    await env.TRIVEXA_DB.prepare("DELETE FROM user_activity WHERE created_at < ?").bind(now - 90 * 86400).run();
    const [totalRow, byAction, recent] = await Promise.all([
      env.TRIVEXA_DB.prepare("SELECT COUNT(*) AS total FROM user_activity WHERE uid=? AND created_at>=?")
        .bind(user.uid, since).first(),
      env.TRIVEXA_DB.prepare("SELECT action,COUNT(*) AS total FROM user_activity WHERE uid=? AND created_at>=? GROUP BY action ORDER BY total DESC LIMIT 8")
        .bind(user.uid, since).all(),
      env.TRIVEXA_DB.prepare("SELECT action,created_at FROM user_activity WHERE uid=? ORDER BY created_at DESC LIMIT 10")
        .bind(user.uid).all()
    ]);
    return reply({
      periodDays: 30,
      total: Number(totalRow?.total || 0),
      byAction: byAction.results || [],
      recent: recent.results || []
    });
  }
  if (a === "auth_me") return reply({user:safeUser(user),access:{
    basicTools:user.status==="active",
    advancedFeatures:user.status==="active"&&(user.role==="admin"||user.advanced_access==="approved"),
    videoStudio:user.status==="active"&&(user.role==="admin"||user.advanced_access==="approved")
  }});
  if (a === "auth_redeem_invite") {
    const code = typeof body.code==="string"?body.code.trim().toUpperCase():"";
    if (!/^TRI-[A-F0-9]{8}-[A-F0-9]{8}$/.test(code)) return reply({error:"Enter a valid TrivexaAI invite code."},400);
    const row = await env.TRIVEXA_DB.prepare("SELECT id,max_uses,uses FROM invite_codes WHERE code_hash=? AND status='active' AND expires_at>? LIMIT 1").bind(await shaHex(code),now).first();
    if (!row || row.uses>=row.max_uses) return reply({error:"Invite code is invalid, expired, or already used."},404);
    const used = await env.TRIVEXA_DB.prepare("UPDATE invite_codes SET uses=uses+1 WHERE id=? AND status='active' AND expires_at>? AND uses<max_uses").bind(row.id,now).run();
    if (!used.meta || used.meta.changes!==1) return reply({error:"Invite code has just been used or expired."},409);
    await env.TRIVEXA_DB.prepare("UPDATE users SET advanced_access='approved',updated_at=? WHERE uid=?").bind(now,user.uid).run();
    await audit(env,user.uid,user.uid,"invite_redeemed",{inviteId:row.id});
    return reply({success:true});
  }
  if (a.startsWith("admin_")) {
    if (user.role!=="admin") return reply({error:"Admin permission required.",code:"ADMIN_REQUIRED"},403);
    if (a==="admin_list_users") {
      const rows=await env.TRIVEXA_DB.prepare("SELECT uid,email,display_name,photo_url,role,status,advanced_access,created_at,last_seen_at FROM users ORDER BY created_at DESC LIMIT 200").all();
      return reply({users:(rows.results||[]).map(safeUser)});
    }
    if (a==="admin_set_access") {
      const uid=String(body.targetUid||"").trim(), value=body.advancedAccess;
      if (!uid || !["pending","approved","revoked"].includes(value) || uid===user.uid) return reply({error:"Choose a valid non-admin account and access status."},400);
      const result=await env.TRIVEXA_DB.prepare("UPDATE users SET advanced_access=?,updated_at=? WHERE uid=? AND role!='admin'").bind(value,now,uid).run();
      if (!result.meta||result.meta.changes!==1) return reply({error:"User not found or cannot be changed."},404);
      await audit(env,user.uid,uid,"advanced_access_changed",{advancedAccess:value});return reply({success:true});
    }
    if (a==="admin_set_status") {
      const uid=String(body.targetUid||"").trim(), value=body.status;
      if (!uid || !["active","suspended","banned"].includes(value) || uid===user.uid) return reply({error:"Choose a valid non-admin account and status."},400);
      const result=await env.TRIVEXA_DB.prepare("UPDATE users SET status=?,updated_at=? WHERE uid=? AND role!='admin'").bind(value,now,uid).run();
      if (!result.meta||result.meta.changes!==1) return reply({error:"User not found or cannot be changed."},404);
      await audit(env,user.uid,uid,"account_status_changed",{status:value});return reply({success:true});
    }
    if (a==="admin_create_invite") {
      const max=Math.max(1,Math.min(100,parseInt(body.maxUses,10)||1)), days=Math.max(1,Math.min(90,parseInt(body.expiresDays,10)||7));
      const code=inviteCode(), id=crypto.randomUUID();
      await env.TRIVEXA_DB.prepare("INSERT INTO invite_codes(id,code_hash,access_level,created_by,created_at,expires_at,max_uses,uses,status) VALUES(?,?,'advanced',?,?,?, ?,0,'active')")
        .bind(id,await shaHex(code),user.uid,now,now+days*86400,max).run();
      await audit(env,user.uid,null,"invite_created",{inviteId:id,maxUses:max,expiresDays:days});
      return reply({success:true,code,maxUses:max,expiresAt:now+days*86400});
    }
    if (a==="admin_revoke_invite") {
      const id=String(body.inviteId||"").trim();if(!id)return reply({error:"Invite ID required."},400);
      const result=await env.TRIVEXA_DB.prepare("UPDATE invite_codes SET status='revoked' WHERE id=? AND status='active'").bind(id).run();
      if(!result.meta||result.meta.changes!==1)return reply({error:"Active invite not found."},404);
      await audit(env,user.uid,null,"invite_revoked",{inviteId:id});return reply({success:true});
    }
    return reply({error:"Unknown admin action."},400);
  }
  return null;
}


const legacyWorker = {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "Content-Disposition"
    };

    const reply = (data, status = 200) =>
      Response.json(data, { status, headers: corsHeaders });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return reply({ error: "Please send a POST request." }, 405);
    }

    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return reply({ error: "Send a valid JSON request." }, 400);
      }

      // Retry transient Gemini network/server failures so a temporary 503 does not instantly fail the editor.
      const fetchGeminiWithRetry = async (url, options) => {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await fetch(url, options);
            if (![408, 425, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
          } catch (error) {
            lastError = error;
            if (attempt === 2) throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        }
        if (lastError) throw lastError;
        throw new Error("Gemini temporary service failure. Please try again.");
      };

      // OpenRouter is a free-only text fallback. The dynamic openrouter/free route
      // selects an available free model; this helper deliberately accepts text only.
      // OpenRouter is a free-only text fallback. Retry once only for transient
      // network/upstream failures; do not loop on daily quota, invalid keys, or credits.
      const fetchOpenRouterText = async (systemPrompt, userPrompt, maxTokens = 1200, temperature = 0.2) => {
        if (!env.OPENROUTER_API_KEY) throw new Error("OpenRouter is not configured.");
        const messages = [];
        if (typeof systemPrompt === "string" && systemPrompt.trim()) {
          messages.push({ role: "system", content: systemPrompt.slice(0, 14000) });
        }
        messages.push({ role: "user", content: String(userPrompt || "").slice(0, 22000) });
        const requestBody = JSON.stringify({
          model: "openrouter/free",
          messages,
          temperature,
          max_tokens: maxTokens,
          provider: { allow_fallbacks: true, data_collection: "deny" }
        });
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          let response;
          try {
            response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + env.OPENROUTER_API_KEY,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://abubakar902.github.io/Creator-Kit/",
                "X-Title": "TrivexaAI"
              },
              body: requestBody
            });
          } catch (networkError) {
            lastError = networkError;
            if (attempt === 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
            throw Object.assign(new Error("OpenRouter could not be reached after one retry: " + String(networkError?.message || "network error").slice(0, 250)), { code: "OPENROUTER_NETWORK_ERROR" });
          }

          let data = {};
          try { data = await response.json(); } catch (parseError) {}
          if (!response.ok) {
            const message = String(data.error?.message || "OpenRouter free model request failed.").slice(0, 450);
            const limitSource = String(data.error?.metadata?.limit_source || "");
            const retryableStatus = [408, 425, 500, 502, 503, 504].includes(response.status);
            const retryableProviderLimit = response.status === 429 && limitSource === "upstream_provider_shared_pool";
            lastError = Object.assign(new Error(message), {
              status: response.status,
              code: data.error?.code || "OPENROUTER_REQUEST_FAILED",
              limitSource
            });
            if (attempt === 0 && (retryableStatus || retryableProviderLimit)) {
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
            throw lastError;
          }

          const content = data.choices?.[0]?.message?.content;
          const generated = typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map(part => typeof part?.text === "string" ? part.text : "").join("")
              : "";
          if (!generated.trim()) {
            lastError = new Error("OpenRouter returned an empty response.");
            if (attempt === 0) {
              await new Promise(resolve => setTimeout(resolve, 500));
              continue;
            }
            throw lastError;
          }
          return generated.trim();
        }
        throw lastError || new Error("OpenRouter could not complete the request.");
      };

      // PER-TOOL RATE LIMITING
      // The frontend can send toolId, tool, toolName, or tool_name.
      // If none is supplied, requests are separated by their Worker action.
      const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
      // This header is set by the outer Worker only after Firebase token verification.
      // Users on a shared IP must not consume one another's per-tool request allowance.
      const verifiedAccountId = String(request.headers.get("X-Trivexa-Verified-Account") || "").trim();
      const rateLimitIdentity = verifiedAccountId ? `account:${verifiedAccountId}` : `ip:${clientIP}`;
      const rawToolKey =
        body.toolId ||
        body.tool ||
        body.toolName ||
        body.tool_name ||
        body.action ||
        (typeof body.prompt === "string" ? "gemini-text" : "other");

      const toolKey = String(rawToolKey)
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .slice(0, 80) || "other";

      // Voice-list lookup is lightweight and does not need a generation limit.
      if (env.CREATOR_LIMITER && body.action !== "get_voices") {
        try {
          const { success } = await env.CREATOR_LIMITER.limit({
            key: `${rateLimitIdentity}:${toolKey}`
          });

          if (!success) {
            return reply({
              error: "Too many requests for this tool. Please wait a minute and try again.",
              code: "TOOL_RATE_LIMITED",
              tool: toolKey
            }, 429);
          }
        } catch (limiterError) {
          // A limiter binding issue should not make every AI tool unavailable.
          console.error("Rate limiter error:", limiterError);
        }
      }

      // TEXT TO SPEECH
      const auraVoices = [
        { voice_id: "angus", name: "Angus", category: "Aura-1" },
        { voice_id: "asteria", name: "Asteria", category: "Aura-1" },
        { voice_id: "arcas", name: "Arcas", category: "Aura-1" },
        { voice_id: "orion", name: "Orion", category: "Aura-1" },
        { voice_id: "orpheus", name: "Orpheus", category: "Aura-1" },
        { voice_id: "athena", name: "Athena", category: "Aura-1" },
        { voice_id: "luna", name: "Luna", category: "Aura-1" },
        { voice_id: "zeus", name: "Zeus", category: "Aura-1" },
        { voice_id: "perseus", name: "Perseus", category: "Aura-1" },
        { voice_id: "helios", name: "Helios", category: "Aura-1" },
        { voice_id: "hera", name: "Hera", category: "Aura-1" },
        { voice_id: "stella", name: "Stella", category: "Aura-1" }
      ];

      if (body.action === "get_voices") {
        return reply({ voices: auraVoices });
      }

      if (body.action === "generate_voice") {
        if (!env.AI) {
          return reply({
            error: "Cloudflare Workers AI binding (AI) is not configured."
          }, 500);
        }

        if (
          typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 2000
        ) {
          return reply({
            error: "Enter text between 1 and 2000 characters."
          }, 400);
        }

        const allowedSpeakers = new Set(auraVoices.map(v => v.voice_id));
        if (
          typeof body.voiceId !== "string" ||
          !allowedSpeakers.has(body.voiceId)
        ) {
          return reply({ error: "Please select a valid voice." }, 400);
        }

        try {
          const audioResult = await env.AI.run(
            "@cf/deepgram/aura-1",
            {
              text: body.text.trim(),
              speaker: body.voiceId,
              encoding: "mp3"
            },
            { returnRawResponse: true }
          );

          if (audioResult instanceof Response && !audioResult.ok) {
            const errorText = await audioResult.text().catch(() => "");
            return reply({
              error: errorText ||
                "Cloudflare could not generate the audio. Please try again."
            }, audioResult.status || 502);
          }

          const audioBody = audioResult instanceof Response
            ? audioResult.body
            : audioResult;

          if (!audioBody) {
            return reply({
              error: "The voice service returned an empty audio response."
            }, 502);
          }

          const headers = new Headers(corsHeaders);
          headers.set(
            "Content-Type",
            audioResult instanceof Response
              ? (audioResult.headers.get("Content-Type") || "audio/mpeg")
              : "audio/mpeg"
          );
          headers.set(
            "Content-Disposition",
            'attachment; filename="TrivexaAI-Voice.mp3"'
          );
          headers.set("Cache-Control", "no-store");

          return new Response(audioBody, { status: 200, headers });
        } catch (voiceError) {
          console.error("Cloudflare TTS error:", voiceError);
          return reply({
            error: "Voice generation failed. Check your Cloudflare Workers AI daily usage limit and try again.",
            details: voiceError?.message || "Unknown TTS error."
          }, 502);
        }
      }

      // AI IMAGE GENERATOR
      if (body.action === "generate_image") {
        if (!env.AI) {
          return reply({
            error: "Workers AI binding is not configured."
          }, 500);
        }

        if (
          typeof body.prompt !== "string" ||
          !body.prompt.trim() ||
          body.prompt.length > 1400
        ) {
          return reply({
            error: "Enter a prompt of up to 1400 characters."
          }, 400);
        }

        const form = new FormData();
        const identityInstruction = body.preserveIdentity === true
          ? `FACE IDENTITY LOCK — HIGHEST PRIORITY:

Use the uploaded reference photo as the exact same person, not a lookalike. Preserve the original face identity and facial geometry: head shape, forehead, hairline, eyebrows, eyes and spacing, nose, lips, cheeks, jawline, ears, hairstyle, skin tone and natural details. Do not beautify, retouch, smooth, reshape, stylize, age, de-age, swap or invent a new face. Change only the requested pose/body position, clothing and scene. If any instruction conflicts, preserve the original face first.

`
          : "";

        const finalPrompt = identityInstruction + body.prompt.trim();
        form.append("prompt", finalPrompt);

        if (body.imageBase64) {
          if (
            typeof body.imageBase64 !== "string" ||
            body.imageBase64.length > 5000000
          ) {
            return reply({ error: "Image is too large." }, 400);
          }

          const imageData = body.imageBase64.replace(
            /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
            ""
          );
          const mimeType = body.mimeType || "image/png";

          if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
            return reply({ error: "Use a PNG, JPG or WEBP image." }, 400);
          }

          let binary;
          try {
            binary = atob(imageData);
          } catch {
            return reply({ error: "The uploaded image is not valid base64." }, 400);
          }
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

          form.append(
            "input_image_0",
            new Blob([bytes], { type: mimeType }),
            "input.png"
          );
        }

        const formRequest = new Request(
          "https://worker-ai-upload.local",
          { method: "POST", body: form }
        );

        let result;
        try {
          result = await env.AI.run(
            "@cf/black-forest-labs/flux-2-klein-4b",
            {
              multipart: {
                body: formRequest.body,
                contentType: formRequest.headers.get("content-type")
              }
            }
          );
        } catch (imageError) {
          console.error("Image generation error:", imageError);
          return reply({
            error: imageError?.message ||
              "Cloudflare image generation failed."
          }, 502);
        }

        return reply(result);
      }

      // VIDEO DOWNLOADER
      if (
        body.action === "download_info" ||
        body.action === "download_video"
      ) {
        if (typeof body.url !== "string" || body.url.length > 2000) {
          return reply({ error: "Please enter a valid video URL." }, 400);
        }

        let videoUrl;
        try {
          videoUrl = new URL(body.url.trim());
        } catch {
          return reply({ error: "Invalid video URL." }, 400);
        }

        const host = videoUrl.hostname.toLowerCase();
        const isTikTok =
          host === "tiktok.com" || host.endsWith(".tiktok.com");
        const isYouTube =
          host === "youtu.be" ||
          host === "youtube.com" ||
          host.endsWith(".youtube.com");
        const isInstagram =
          host === "instagram.com" ||
          host.endsWith(".instagram.com");
        const isFacebook =
          host === "facebook.com" ||
          host.endsWith(".facebook.com") ||
          host === "fb.watch";

        if (
          videoUrl.protocol !== "https:" ||
          !(isTikTok || isYouTube || isInstagram || isFacebook)
        ) {
          return reply({
            error: "Only YouTube, TikTok, Instagram and Facebook HTTPS links are supported."
          }, 400);
        }

        
        // FACEBOOK: SAVERAPI ALL-IN-ONE DOWNLOADER
        if (isFacebook) {
          if (!env.SAVERAPI_KEY) {
            return reply({
              error: "Facebook downloader API key is not configured."
            }, 500);
          }

          const saverUrl = new URL(
            "https://saverapi.net/api/all-in-one-downloader-api"
          );
          saverUrl.searchParams.set("url", videoUrl.toString());

          let saverResponse;

          try {
            saverResponse = await fetch(saverUrl, {
              method: "GET",
              headers: {
                "x-api-key": env.SAVERAPI_KEY,
                "Accept": "application/json"
              },
              signal: AbortSignal.timeout(180000)
            });
          } catch (apiError) {
            console.error("SaverAPI connection error:", apiError.message);
            return reply({
              error: "SaverAPI connection failed.",
              diagnostic: apiError.message || "Connection error"
            }, 502);
          }

          const saverText = await saverResponse.text();
          let saverData;

          try {
            saverData = JSON.parse(saverText);
          } catch {
            console.error("SaverAPI returned non-JSON:", {
              status: saverResponse.status,
              contentType: saverResponse.headers.get("content-type"),
              preview: saverText.slice(0, 250)
            });

            return reply({
              error: "SaverAPI returned an unreadable response.",
              diagnostic: "HTTP " + saverResponse.status,
              contentType: saverResponse.headers.get("content-type") || "unknown"
            }, 502);
          }

          if (
            !saverResponse.ok ||
            saverData.error === true ||
            !saverData.download_url
          ) {
            const message =
              saverData.message ||
              saverData.error_message ||
              (typeof saverData.error === "string"
                ? saverData.error
                : "SaverAPI did not return a download link.");

            console.error("SaverAPI rejected request:", {
              status: saverResponse.status,
              message
            });

            return reply({
              error: message,
              diagnostic: "SaverAPI HTTP " + saverResponse.status
            }, 502);
          }

          if (
            saverData.hosting &&
            !String(saverData.hosting).toLowerCase().includes("facebook")
          ) {
            return reply({
              error: "SaverAPI did not recognise this as Facebook content.",
              diagnostic: "Hosting: " + saverData.hosting
            }, 422);
          }

          let mediaUrl;

          try {
            mediaUrl = new URL(saverData.download_url);
          } catch {
            return reply({
              error: "SaverAPI returned an invalid download link."
            }, 502);
          }

          if (mediaUrl.protocol !== "https:") {
            return reply({
              error: "SaverAPI returned an unsafe download link."
            }, 502);
          }

          if (body.action === "download_info") {
            return reply({
              title: saverData.caption || "Facebook video",
              thumbnail: saverData.thumb || "",
              formats: [{
                id: "fb-video",
                quality: "Facebook Video",
                container: "video"
              }]
            });
          }

          if (body.format !== "fb-video") {
            return reply({
              error: "Please choose the Facebook Video format."
            }, 400);
          }

          let mediaResponse;

          try {
            mediaResponse = await fetch(mediaUrl, {
              redirect: "follow",
              signal: AbortSignal.timeout(180000)
            });
          } catch (mediaError) {
            console.error("Facebook media fetch error:", mediaError.message);

            return reply({
              error: "Could not connect to the Facebook video file.",
              diagnostic: mediaError.message || "Media connection failed."
            }, 502);
          }

          const mediaType = (
            mediaResponse.headers.get("content-type") || ""
          ).toLowerCase();

          const isVideoFile =
            mediaType.startsWith("video/") ||
            mediaType.includes("application/octet-stream") ||
            mediaType.includes("application/mp4");

          if (!mediaResponse.ok || !mediaResponse.body || !isVideoFile) {
            const preview = await mediaResponse.text().catch(() => "");

            console.error("Facebook media response is not a video:", {
              status: mediaResponse.status,
              contentType: mediaType || "unknown",
              preview: preview.slice(0, 250)
            });

            return reply({
              error: "SaverAPI did not return a playable video file.",
              diagnostic: "Media HTTP " + mediaResponse.status,
              contentType: mediaType || "unknown",
              details: preview.slice(0, 180)
            }, 502);
          }

          const mediaHeaders = new Headers(corsHeaders);

          mediaHeaders.set("Content-Type", mediaType);
          mediaHeaders.set(
            "Content-Disposition",
            'attachment; filename="TrivexaAI-Facebook.mp4"'
          );
          mediaHeaders.set("Cache-Control", "no-store");

          return new Response(mediaResponse.body, {
            status: 200,
            headers: mediaHeaders
          });
        }


        // TIKTOK
        if (isTikTok) {
          if (!env.SAVEAPI_API_KEY) {
            return reply({
              error: "TikTok API key is not configured."
            }, 500);
          }

          const saveUrl = new URL("https://api.saveapi.org/v1/tiktok");
          saveUrl.searchParams.set("url", videoUrl.toString());

          const saveResponse = await fetch(saveUrl, {
            headers: {
              Authorization: `Bearer ${env.SAVEAPI_API_KEY}`
            }
          });

          const saveText = await saveResponse.text();
          let saveData;
          try {
            saveData = JSON.parse(saveText);
          } catch {
            saveData = {};
          }

          if (!saveResponse.ok || saveData.success === false) {
            return reply({
              error: saveData.error || saveData.message ||
                "TikTok could not be processed."
            }, 502);
          }

          if (body.action === "download_info") {
            const formats = (saveData.formats || [])
              .filter(item => item.url && item.format)
              .map(item => ({
                id: item.format,
                quality: item.label || item.format,
                container: item.type || "video"
              }));

            if (!formats.length) {
              return reply({
                error: "No downloadable TikTok formats were found."
              }, 422);
            }

            return reply({
              title: saveData.meta?.title || "TikTok video",
              thumbnail: saveData.meta?.thumbnail || "",
              formats
            });
          }

          if (
            typeof body.format !== "string" ||
            !/^[a-zA-Z0-9_-]{1,50}$/.test(body.format)
          ) {
            return reply({
              error: "Please choose a valid TikTok format."
            }, 400);
          }

          const selected = (saveData.formats || []).find(
            item => item.format === body.format && item.url
          );

          if (!selected) {
            return reply({
              error: "Selected TikTok format is unavailable. Refresh and try again."
            }, 422);
          }

          const videoResponse = await fetch(selected.url);
          if (!videoResponse.ok || !videoResponse.body) {
            return reply({
              error: "Could not fetch the TikTok video."
            }, 502);
          }

          const headers = new Headers(corsHeaders);
          const isAudio = selected.type?.includes("audio");

          headers.set("Content-Type", isAudio ? "audio/mpeg" : "video/mp4");
          headers.set(
            "Content-Disposition",
            `attachment; filename="TrivexaAI-TikTok.${isAudio ? "mp3" : "mp4"}"`
          );
          headers.set("Cache-Control", "no-store");

          return new Response(videoResponse.body, {
            status: 200,
            headers
          });
        }

        // YOUTUBE AND INSTAGRAM
        if (!env.VIDEO_DOWNLOADER_API_KEY) {
          return reply({
            error: "Downloader API key is not configured."
          }, 500);
        }

        const endpoint =
          body.action === "download_info" ? "info" : "download";

        if (
          endpoint === "download" &&
          (
            typeof body.format !== "string" ||
            !/^(v-(1080|720|480|360)|a-(mp3|m4a))$/.test(body.format)
          )
        ) {
          return reply({ error: "Please choose a valid format." }, 400);
        }

        const apiUrl = new URL(`https://yoinku.com/api/v1/${endpoint}`);
        apiUrl.searchParams.set("url", videoUrl.toString());

        if (endpoint === "download") {
          apiUrl.searchParams.set("format", body.format);
        }

        const apiResponse = await fetch(apiUrl, {
          headers: {
            "x-api-key": env.VIDEO_DOWNLOADER_API_KEY
          }
        });

        const responseText = await apiResponse.text();
        let result;
        try {
          result = JSON.parse(responseText);
        } catch {
          result = { error: responseText.slice(0, 500) };
        }

        if (!apiResponse.ok || result.ok === false) {
          return reply({
            error: result.error?.message ||
              result.error ||
              result.message ||
              "Downloader request failed."
          }, apiResponse.status === 429 ? 429 : 502);
        }

        if (endpoint === "info") {
          const videoData = result.data || result;
          const formats = Array.isArray(videoData.formats)
            ? videoData.formats.map(item => ({
                id: item.id || item.format,
                quality: item.quality || item.label || item.id,
                container: item.container || item.kind || "video"
              })).filter(item => item.id)
            : [];

          if (!formats.length) {
            return reply({
              error: "No downloadable formats were returned by the video service."
            }, 422);
          }

          return reply({
            title: videoData.title || "Video",
            thumbnail: videoData.thumbnailUrl || videoData.thumbnail || "",
            formats
          });
        }

        return reply(result);
      }

      // AI AUTO CAPTIONS — timestamped speech-to-text via Cloudflare Workers AI Whisper
      if (body.action === "transcribe_audio") {
        if (!env.AI) {
          return reply({ error: "Cloudflare Workers AI is not configured for transcription." }, 500);
        }
        if (
          typeof body.audioBase64 !== "string" ||
          body.audioBase64.length < 500 ||
          body.audioBase64.length > 4000000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audioBase64)
        ) {
          return reply({ error: "The audio chunk is invalid or too large. Please try again with a shorter clip." }, 400);
        }
        const mimeType = String(body.mimeType || "").split(";")[0].trim().toLowerCase();
        if (!["audio/webm", "audio/ogg"].includes(mimeType)) {
          return reply({ error: "Unsupported audio format. Please use a current version of Chrome or Edge." }, 400);
        }
        const language = typeof body.language === "string" ? body.language.trim().slice(0, 12) : "";
        try {
          const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
            audio: body.audioBase64,
            task: "transcribe",
            ...(language ? { language } : {}),
            vad_filter: true,
            condition_on_previous_text: false
          });
          const segments = Array.isArray(result?.segments)
            ? result.segments.map(item => ({
                start: Number(item.start),
                end: Number(item.end),
                text: String(item.text || "").trim().slice(0, 500)
              })).filter(item =>
                Number.isFinite(item.start) &&
                Number.isFinite(item.end) &&
                item.start >= 0 &&
                item.end > item.start &&
                item.text
              )
            : [];
          return reply({
            text: String(result?.text || ""),
            language: result?.transcription_info?.language || "",
            segments
          });
        } catch (transcriptionError) {
          console.error("AI captions transcription error:", transcriptionError);
          return reply({
            error: "AI transcription could not finish. Please try a shorter clip or try again later.",
            details: transcriptionError?.message || "Workers AI transcription failed."
          }, 502);
        }
      }

      // AI SHORTS MAKER — rank engaging moments from a timestamped transcript.
      // Only transcript text and timestamps reach this route; the original video/audio does not.
      if (body.action === "shorts_analyze") {
        if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) return reply({ error: "The AI analysis connection is not configured.", code: "SHORTS_AI_NOT_CONFIGURED" }, 500);
        const duration = Number(body.duration), count = Number(body.count);
        const preferredLength = String(body.preferredLength || "auto");
        if (!Number.isFinite(duration) || duration < 1 || duration > 3600) return reply({ error: "The video duration is invalid. Use a video up to 60 minutes." }, 400);
        if (!Number.isInteger(count) || count < 1 || count > 10) return reply({ error: "Choose between 1 and 10 Shorts." }, 400);
        if (!["auto", "15-30", "30-45", "45-60"].includes(preferredLength)) return reply({ error: "Choose a valid preferred Short length." }, 400);
        if (!Array.isArray(body.transcript) || body.transcript.length < 1 || body.transcript.length > 800) return reply({ error: "Generate a timestamped transcript before finding highlights." }, 400);
        const safeSegments = body.transcript.slice(0, 800).map(item => {
          if (!item || typeof item !== "object") return null;
          const start = Number(item.start), end = Number(item.end);
          const text = typeof item.text === "string" ? item.text.trim().slice(0, 400) : "";
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start >= duration || !text) return null;
          return { start: Math.round(start * 10) / 10, end: Math.round(Math.min(end, duration) * 10) / 10, text };
        }).filter(Boolean);
        if (!safeSegments.length) return reply({ error: "The transcript does not contain valid timestamped speech." }, 400);
        const transcriptText = safeSegments.map(s => "[" + s.start.toFixed(1) + "-" + s.end.toFixed(1) + "] " + s.text).join("\n").slice(0, 42000);
        const target = preferredLength === "auto" ? "Choose the strongest natural moment, normally 15–45 seconds, and never exceed 60 seconds." : "Each highlight should be " + preferredLength + " seconds.";
        const systemPrompt = [
          "You are TrivexaAI AI Shorts Maker, an expert short-form video editor.",
          "Find compelling, self-contained moments ONLY from the supplied transcript of the user's uploaded video.",
          "Do not invent dialogue, events, visual scenes, or outside viral trends. A high-potential moment means a strong hook, useful insight, emotion, surprise, humor, conflict, or satisfying payoff visible in the spoken transcript.",
          "Return exactly one valid JSON object and no markdown: {\"highlights\":[{\"start\":number,\"end\":number,\"title\":string,\"hook\":string,\"reason\":string}],\"note\":string}.",
          "Treat the requested count as a firm target: return exactly the requested number of distinct highlights whenever the transcript contains enough separate usable moments. Do not stop after only 1 or 2 when more are requested. Search the full transcript for additional moments with different topics, hooks, or payoffs. Return fewer only after checking the complete transcript and confirming there are not enough genuinely usable non-overlapping moments; explain that honestly in note.",
          "Times are absolute seconds in the original video. Select clean boundaries around complete thoughts. Do not overlap highlights. Keep every highlight within the video duration.",
          "Titles should be concise and attractive, hooks should be short opening text, reasons should explain transcript evidence, not guarantee virality.",
          target
        ].join("\n");
        const userPrompt = "Video title: " + String(body.videoTitle || "Uploaded video").slice(0, 120) + "\nVideo duration: " + duration.toFixed(1) + " seconds\nRequested Shorts: " + count + "\nPreferred length: " + preferredLength + "\n\nTIMESTAMPED TRANSCRIPT:\n" + transcriptText;
        const requestHighlights = async (promptText, maxTokens = 2800) => {
          let raw = "", providerError = null;
          if (env.GEMINI_API_KEY) {
            try {
              const response = await fetchGeminiWithRetry("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
                body: JSON.stringify({
                  contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\n" + promptText }] }],
                  generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, responseMimeType: "application/json" }
                })
              });
              let data = {};
              try { data = await response.json(); } catch (e) {}
              if (!response.ok) throw Object.assign(new Error(String(data.error?.message || "Gemini analysis failed.").slice(0, 400)), { status: response.status });
              raw = data.candidates?.[0]?.content?.parts?.map(p => typeof p.text === "string" ? p.text : "").join("") || "";
              if (!raw.trim()) throw new Error("Gemini returned an empty highlight list.");
            } catch (e) {
              providerError = e;
              console.warn("Shorts highlight Gemini failed; trying OpenRouter:", e?.message);
            }
          }
          if (!raw && env.OPENROUTER_API_KEY) {
            try { raw = await fetchOpenRouterText(systemPrompt, promptText, maxTokens, 0.2); }
            catch (e) {
              console.error("Shorts highlight OpenRouter failed:", e);
              throw Object.assign(new Error(String(e?.message || providerError?.message || "Please try again shortly.").slice(0, 350)), { status: e?.status || providerError?.status || 502 });
            }
          }
          if (!raw.trim()) throw Object.assign(new Error(String(providerError?.message || "AI could not return a highlight list.")), { status: providerError?.status || 502 });
          const cleaned = raw.trim().replace(/^\uFEFF/, "").replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/i, "");
          let parsedResult;
          try { parsedResult = JSON.parse(cleaned); }
          catch (e) { throw Object.assign(new Error("AI returned an unreadable highlight list. Please try again."), { code: "SHORTS_AI_INVALID_JSON", status: 502 }); }
          if (!parsedResult || typeof parsedResult !== "object" || Array.isArray(parsedResult)) throw Object.assign(new Error("AI returned an invalid highlight list."), { code: "SHORTS_AI_INVALID_JSON", status: 502 });
          return parsedResult;
        };
        let parsed;
        try { parsed = await requestHighlights(userPrompt, 2800); }
        catch (e) {
          return reply({ error: e?.message || "AI could not analyze the transcript right now.", details: String(e?.message || "").slice(0, 350), code: e?.code || "SHORTS_AI_PROVIDER_FAILED" }, e?.status === 429 ? 429 : 502);
        }
        const minLen = preferredLength === "auto" ? 8 : Number(preferredLength.split("-")[0]);
        const maxLen = preferredLength === "auto" ? 60 : Number(preferredLength.split("-")[1]);
        const distinct = [];
        const addCandidates = rawItems => {
          const candidates = (Array.isArray(rawItems) ? rawItems : []).map(item => {
            if (!item || typeof item !== "object") return null;
            const start = Number(item.start), end = Number(item.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
            const safeStart = Math.max(0, Math.min(duration, start)), safeEnd = Math.max(0, Math.min(duration, end));
            const length = safeEnd - safeStart;
            if (length < minLen || length > maxLen || safeStart >= safeEnd) return null;
            return { start: Math.round(safeStart * 10) / 10, end: Math.round(safeEnd * 10) / 10, title: String(item.title || "Untitled highlight").trim().slice(0, 90), hook: String(item.hook || "").trim().slice(0, 140), reason: String(item.reason || "").trim().slice(0, 240) };
          }).filter(Boolean).sort((a, b) => a.start - b.start);
          for (const item of candidates) {
            if (distinct.length >= count) break;
            const overlaps = distinct.some(existing => item.start < existing.end && existing.start < item.end);
            if (!overlaps) distinct.push(item);
          }
        };
        addCandidates(parsed.highlights);
        // Models sometimes under-return even with a clear count. Ask for only
        // the missing moments, explicitly excluding already selected time ranges.
        for (let pass = 0; distinct.length < count && pass < 2; pass++) {
          const missing = count - distinct.length;
          const alreadyChosen = distinct.map(item => ({ start: item.start, end: item.end, title: item.title }));
          const supplementPrompt = userPrompt + "\n\nADDITIONAL HIGHLIGHT PASS " + (pass + 1) + ": You have already supplied " + distinct.length + " valid highlights. Supply exactly " + missing + " MORE distinct highlights, not the original ones. Do not reuse or overlap these selected time ranges: " + JSON.stringify(alreadyChosen) + ". Search for other strong, complete thoughts and moments anywhere else in the full transcript. Keep the same length and timestamp rules. If fewer than " + missing + " genuinely suitable moments remain, return only those that are valid and explain why in note.";
          try {
            const extra = await requestHighlights(supplementPrompt, 2200);
            const previousCount = distinct.length;
            addCandidates(extra.highlights);
            if (distinct.length === previousCount) break;
            if (distinct.length >= count) parsed.note = "";
            else if (extra.note) parsed.note = extra.note;
          } catch (e) {
            console.warn("Shorts additional highlight pass failed:", e?.message);
            break;
          }
        }
        distinct.sort((a, b) => a.start - b.start);
        if (!distinct.length) return reply({ error: "AI could not find highlights that match the selected length. Try Auto length or a different transcript.", code: "SHORTS_NO_VALID_HIGHLIGHTS" }, 422);

        return reply({ highlights: distinct, requestedCount: count, returnedCount: distinct.length, note: distinct.length < count ? String(parsed.note || ("Only " + distinct.length + " suitable, non-overlapping moments were found in the transcript for the selected clip length. Try Auto length or a longer video for more Shorts.")).slice(0, 240) : "", source: "uploaded_video_transcript" });
      }


      // AI SHORTS MAKER — generate a separate social caption and hashtags for one selected highlight.
      if (body.action === "shorts_caption") {
        if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) return reply({ error: "The AI caption connection is not configured." }, 500);
        const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
        const hook = typeof body.hook === "string" ? body.hook.trim().slice(0, 180) : "";
        const platform = ["YouTube Shorts", "Instagram Reels", "TikTok", "General"].includes(body.platform) ? body.platform : "General";
        const start = Number(body.start), end = Number(body.end);
        if (!title || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end-start > 90) return reply({ error: "The selected Short details are invalid." }, 400);
        if (!Array.isArray(body.transcript) || body.transcript.length < 1 || body.transcript.length > 120) return reply({ error: "The selected highlight transcript is missing." }, 400);
        const lines = body.transcript.slice(0,120).map(item => {
          if (!item || typeof item !== "object") return "";
          const a=Number(item.start),b=Number(item.end),t=typeof item.text==="string"?item.text.trim().slice(0,300):"";
          return Number.isFinite(a)&&Number.isFinite(b)&&b>a&&a<end&&b>start&&t ? "["+Math.max(start,a).toFixed(1)+"-"+Math.min(end,b).toFixed(1)+"] "+t : "";
        }).filter(Boolean).join("\n").slice(0,9000);
        if (!lines) return reply({ error: "No transcript text was found inside this highlight." }, 400);
        const system = "You are TrivexaAI's short-form social copywriter. Write an engaging but truthful caption based only on the supplied title, hook and transcript. Do not invent facts, claims, events or guarantees. Return JSON only: {\"caption\":string,\"hashtags\":[string],\"callToAction\":string}. Caption 1-3 short sentences, natural and platform appropriate. Return 5-10 relevant hashtags without spaces, each starting with #. Avoid generic spam hashtags and do not promise virality.";
        const prompt = "Platform: "+platform+"\nShort title: "+title+"\nOpening hook: "+hook+"\nSelected transcript:\n"+lines;
        let raw="", providerError=null;
        if(env.GEMINI_API_KEY){
          try{
            const response=await fetchGeminiWithRetry("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",{
              method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
              body:JSON.stringify({contents:[{role:"user",parts:[{text:system+"\n\n"+prompt}]}],generationConfig:{temperature:0.45,maxOutputTokens:700,responseMimeType:"application/json"}})
            });
            let data={};try{data=await response.json()}catch(e){}
            if(!response.ok)throw Object.assign(new Error(String(data.error?.message||"Gemini caption generation failed.").slice(0,300)),{status:response.status});
            raw=data.candidates?.[0]?.content?.parts?.map(p=>typeof p.text==="string"?p.text:"").join("")||"";
            if(!raw.trim())throw new Error("Gemini returned an empty caption.");
          }catch(e){providerError=e;console.warn("Shorts caption Gemini failed; trying OpenRouter:",e?.message);}
        }
        if(!raw&&env.OPENROUTER_API_KEY){
          try{raw=await fetchOpenRouterText(system,prompt,700,.4);}
          catch(e){return reply({error:"AI could not generate this caption right now.",details:String(e?.message||providerError?.message||"Please try again shortly.").slice(0,300)},e?.status===429?429:502);}
        }
        let parsed;
        try{const cleaned=raw.trim().replace(/^\uFEFF/,"").replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}$/i,"");parsed=JSON.parse(cleaned);}
        catch(e){return reply({error:"AI returned an unreadable caption. Please try again."},502);}
        const caption=String(parsed.caption||"").trim().slice(0,700);
        const hashtags=(Array.isArray(parsed.hashtags)?parsed.hashtags:[]).map(x=>String(x||"").trim().replace(/[^#\p{L}\p{N}_]/gu,"")).filter(x=>/^#[\p{L}\p{N}_]{2,40}$/u.test(x)).slice(0,10);
        const callToAction=String(parsed.callToAction||"").trim().slice(0,160);
        if(!caption)return reply({error:"AI did not return a usable caption. Please try again."},502);
        return reply({caption,hashtags,callToAction,platform});
      }

      // VIDEO STUDIO MULTILINGUAL PROMPT WRITER — converts the user's description
      // into a ready-to-paste natural-language prompt. This route never edits media.
      if (body.action === "ai_prompt_writer") {
        const expectedToolId = "video-studio-prompt-writer";
        if (body.toolId !== expectedToolId) {
          return reply({ error: "This request is not from the Video Studio Prompt Writer.", code: "AI_PROMPT_WRITER_TOOL_MISMATCH" }, 400);
        }
        if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
          return reply({ error: "The Video Studio Prompt Writer connection is not configured." }, 500);
        }
        const sourceRequest = typeof body.request === "string" ? body.request.trim() : "";
        if (!sourceRequest || sourceRequest.length > 2000) {
          return reply({ error: "Enter a request between 1 and 2,000 characters." }, 400);
        }

        // Only names and media types are shared with the selected text AI provider.
        // No IDs, local URLs, blobs, original media bytes, or clip settings are sent.
        const rawContext = body.editorContext && typeof body.editorContext === "object" && !Array.isArray(body.editorContext)
          ? body.editorContext
          : {};
        const rawProject = rawContext.project && typeof rawContext.project === "object" ? rawContext.project : {};
        const rawClips = Array.isArray(rawContext.clips) ? rawContext.clips : [];
        const rawSelectedId = typeof rawContext.selectedClipId === "string" ? rawContext.selectedClipId : "";
        const selectedClip = rawClips.find(item => item && typeof item === "object" && String(item.id || "") === rawSelectedId);
        const rawMedia = rawContext.mediaLibrary && typeof rawContext.mediaLibrary === "object" ? rawContext.mediaLibrary : {};
        const rawProjects = rawContext.projects && typeof rawContext.projects === "object" ? rawContext.projects : {};
        const promptContext = {
          currentProject: String(rawProject.name || "Current Video Studio project").slice(0, 80),
          selectedClip: selectedClip ? {
            name: String(selectedClip.name || "Selected clip").slice(0, 100),
            type: String(selectedClip.type || "").slice(0, 20),
            track: String(selectedClip.track || "").slice(0, 20)
          } : null,
          timelineClips: rawClips.slice(0, 20).map(item => {
            if (!item || typeof item !== "object") return null;
            return {
              name: String(item.name || "Untitled clip").slice(0, 100),
              type: String(item.type || "").slice(0, 20),
              track: String(item.track || "").slice(0, 20)
            };
          }).filter(Boolean),
          mediaLibrary: (Array.isArray(rawMedia.assets) ? rawMedia.assets : []).slice(0, 20).map(item => {
            if (!item || typeof item !== "object") return null;
            return {
              name: String(item.name || "Media asset").slice(0, 100),
              type: String(item.type || "").slice(0, 20)
            };
          }).filter(Boolean),
          savedProjects: (Array.isArray(rawProjects.projects) ? rawProjects.projects : []).slice(0, 20).map(item => {
            if (!item || typeof item !== "object") return null;
            return String(item.name || "Untitled project").slice(0, 80);
          }).filter(Boolean)
        };
        const supportedOperations = [
          "set_clip_properties", "split_clip", "move_clip", "duplicate_clip",
          "delete_clip", "add_text_overlay", "set_keyframes", "run_tool",
          "trim_clip", "set_preview_controls", "set_timeline_controls",
          "add_asset_to_timeline", "rename_asset", "remove_asset",
          "create_video_proxy", "set_proxy_usage", "rename_project",
          "create_project", "open_project", "delete_project"
        ];
        const supportedTools = [
          "scene_detection", "beat_sync", "remove_silence", "ai_colour_correction",
          "caption_translation", "auto_captions", "reverse_video", "motion_tracking",
          "enhance_audio", "remove_person_background", "auto_reframe", "detach_audio",
          "ai_voice_over", "add_sticker"
        ];
        const systemInstructions = [
          "You are TrivexaAI Video Studio's multilingual Prompt Writer. Convert the user's editing description from any language, writing system, transliteration, or mixture of languages into one clear, specific, ready-to-paste prompt for the TrivexaAI Video Studio AI Editor.",
          "Return exactly one JSON object and nothing else: {\"needsClarification\":false,\"prompt\":\"...\",\"question\":\"\"}. If an essential detail is ambiguous or the request is unsupported, return {\"needsClarification\":true,\"prompt\":\"\",\"question\":\"one short helpful question or explanation in clear English\"}.",
          "Automatically identify and understand the input language. Accept native scripts, Latin transliteration, spelling variations, informal wording, and code-switching between languages. Do not reject or downgrade a request because of its input language. When the meaning is clear, write the final editing prompt in clear, simple English. Preserve every requested action, exact number, time, duration, named language, style, and keep-unchanged instruction. Do not add creative changes the user did not request.",
          "This writer does NOT execute edits and must not generate operation JSON, code, scripts, tool calls, HTML, CSS, URLs, or markdown. It only writes natural-language instructions that the separate Video Studio AI Editor can understand.",
          "The Video Studio AI Editor only supports these operation types: " + supportedOperations.join(", ") + ". Its dedicated tool IDs are: " + supportedTools.join(", ") + ". Never promise or request a feature outside this supported list.",
          "The editor does not control the 17 standalone homepage tools, video export, render/download, export settings, or export queue. If the user asks for those, do not disguise them as supported editor work; return needsClarification=true with a short, clear English explanation.",
          "Respect media types and available actions: scene detection works on video; beat sync and silence removal work on audio/video; colour correction works on video/image; caption translation requires an existing caption track; auto captions work on video/audio; reverse, motion tracking, person background removal, auto reframe, and detach audio require video; audio enhancement requires audio; voice-over and stickers add supported timeline items.",
          "Never invent clip names, asset names, project names, times, values, or available media. Use only names in EDITOR_CONTEXT. If the user says selected clip and one is selected, refer to the selected clip. Otherwise use an exact name only when the user clearly identifies it.",
          "If multiple clips or assets could match, or the target is unclear and cannot safely be inferred from the selected clip, ask one concise question in English rather than guessing.",
          "Keep original audio unchanged for visual-only requests, and keep visuals unchanged for audio-only requests. Preserve sync for linked or detached audio unless the user explicitly requests otherwise.",
          "Do not claim that local files can be imported by AI. User imports files with the existing file picker. The writer must never claim that export will be performed.",
          "Output prompt must be 1 to 1,400 characters so it fits the main AI Editor prompt box. Do not include headings, preambles, quotes around the whole prompt, or markdown fences."
        ].join("\n");
        const userMessage = [
          "EDITOR_CONTEXT:",
          JSON.stringify(promptContext),
          "",
          "USER_REQUEST_IN_ORIGINAL_LANGUAGE:",
          sourceRequest
        ].join("\n");

        let generatedText = "";
        let geminiFailure = null;
        if (env.GEMINI_API_KEY) {
          try {
            const geminiResponse = await fetchGeminiWithRetry(
              "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": env.GEMINI_API_KEY
                },
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: systemInstructions }] },
                  contents: [{ role: "user", parts: [{ text: userMessage }] }],
                  generationConfig: {
                    temperature: 0.15,
                    maxOutputTokens: 1200,
                    responseMimeType: "application/json"
                  }
                })
              }
            );
            let geminiData = {};
            try { geminiData = await geminiResponse.json(); } catch (parseError) {}
            if (!geminiResponse.ok) {
              throw Object.assign(new Error(String(geminiData.error?.message || "Gemini request failed.").slice(0, 400)), { status: geminiResponse.status });
            }
            generatedText = geminiData.candidates?.[0]?.content?.parts
              ?.map(part => typeof part.text === "string" ? part.text : "")
              .join("")
              .trim() || "";
            if (!generatedText) throw new Error("Gemini returned an empty prompt response.");
          } catch (error) {
            geminiFailure = error;
            console.warn("Video Studio Prompt Writer Gemini failed; trying OpenRouter fallback:", error?.message);
          }
        }
        if (!generatedText && env.OPENROUTER_API_KEY) {
          try {
            generatedText = await fetchOpenRouterText(systemInstructions, userMessage, 1200, 0.15);
          } catch (openRouterError) {
            console.error("Video Studio Prompt Writer OpenRouter error:", openRouterError);
            return reply({
              error: "Gemini and OpenRouter could not generate this Video Studio prompt.",
              details: String(openRouterError?.message || geminiFailure?.message || "Please try again shortly.").slice(0, 400),
              code: "AI_PROMPT_WRITER_PROVIDERS_FAILED"
            }, openRouterError?.status === 429 ? 429 : 502);
          }
        }
        if (!generatedText || generatedText.length > 6000) {
          return reply({
            error: "The AI returned an empty or oversized prompt response. Please simplify your request.",
            details: String(geminiFailure?.message || "").slice(0, 300),
            code: "AI_PROMPT_WRITER_EMPTY"
          }, 502);
        }
        let result;
        try {
          const firstBrace = generatedText.indexOf("{");
          const lastBrace = generatedText.lastIndexOf("}");
          const jsonText = firstBrace >= 0 && lastBrace > firstBrace
            ? generatedText.slice(firstBrace, lastBrace + 1)
            : generatedText;
          result = JSON.parse(jsonText);
        } catch (parseError) {
          return reply({ error: "The AI service returned an invalid prompt response. Please try again.", code: "AI_PROMPT_WRITER_INVALID_JSON" }, 502);
        }
        if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.needsClarification !== "boolean") {
          return reply({ error: "Gemini returned an invalid prompt-writing response.", code: "AI_PROMPT_WRITER_INVALID_RESPONSE" }, 502);
        }
        if (result.needsClarification) {
          const question = typeof result.question === "string" ? result.question.trim().slice(0, 300) : "";
          if (!question || String(result.prompt || "").trim()) {
            return reply({ error: "The clarification response was incomplete. Please describe the request more clearly.", code: "AI_PROMPT_WRITER_INVALID_CLARIFICATION" }, 502);
          }
          return reply({ needsClarification: true, prompt: "", question });
        }
        const prompt = typeof result.prompt === "string" ? result.prompt.trim() : "";
        if (!prompt || prompt.length > 1400 || typeof result.question !== "string") {
          return reply({ error: "The generated prompt must be clear and no longer than 1,400 characters. Please try again.", code: "AI_PROMPT_WRITER_INVALID_PROMPT" }, 502);
        }
        return reply({ needsClarification: false, prompt, question: "" });
      }

      // VIDEO STUDIO AI EDITOR — strict, versioned, allow-listed edit plans.
      // This route only produces a structured plan. The Video Studio frontend
      // validates it again and previews all edits before the user can Apply.
      if (body.action === "ai_editing_assistant") {
        const AI_EDITOR_VERSION = "video-studio-ai-v2";
        const AI_EDITOR_ACTIONS = [
          "set_clip_properties", "split_clip", "move_clip", "duplicate_clip",
          "delete_clip", "add_text_overlay", "set_keyframes", "run_tool",
          "trim_clip", "set_preview_controls", "set_timeline_controls",
          "add_asset_to_timeline", "rename_asset", "remove_asset",
          "create_video_proxy", "set_proxy_usage", "rename_project",
          "create_project", "open_project", "delete_project"
        ];
        const AI_VIDEO_TOOLS = [
          "scene_detection", "beat_sync", "remove_silence", "ai_colour_correction",
          "caption_translation", "auto_captions", "reverse_video", "motion_tracking",
          "enhance_audio", "remove_person_background", "auto_reframe", "detach_audio",
          "ai_voice_over", "add_sticker"
        ];
        const clipTypes = ["video", "image", "audio", "text"];
        const trackTypes = ["video", "overlay", "text", "audio", "captions"];
        const languageNames = [
          "English", "Urdu", "Hindi", "Arabic", "Spanish", "French", "German",
          "Portuguese", "Turkish", "Bengali", "Chinese (Simplified)", "Japanese"
        ];
        const autoCaptionLanguages = ["en", "ur", "hi", "ar", "es", "fr", "pt", "tr", "de"];
        const voiceIds = [
          "angus", "asteria", "arcas", "orion", "orpheus", "athena",
          "luna", "zeus", "perseus", "helios", "hera", "stella"
        ];
        const propertyKeys = {
          video: [
            "name", "start", "duration", "scale", "rotation", "x", "y", "opacity",
            "flipX", "flipY", "framingMode", "filterPreset", "brightness", "contrast",
            "saturation", "blur", "hue", "transition", "transitionDuration", "volume",
            "speedStart", "speedEnd", "chromaEnabled", "chromaColor", "chromaTolerance",
            "chromaSoftness", "maskShape", "maskTop", "maskBottom", "maskFeather",
            "maskAngle"
          ],
          image: [
            "name", "start", "duration", "scale", "rotation", "x", "y", "opacity",
            "flipX", "flipY", "framingMode", "filterPreset", "brightness", "contrast",
            "saturation", "blur", "hue", "transition", "transitionDuration",
            "maskShape", "maskTop", "maskBottom", "maskFeather", "maskAngle"
          ],
          audio: [
            "name", "start", "duration", "volume", "fadeIn", "fadeOut",
            "audioBass", "audioMid", "audioTreble", "audioPan"
          ],
          text: [
            "name", "start", "duration", "text", "color", "fontSize", "font",
            "weight", "align", "bgColor", "bgOpacity", "italic", "rotation",
            "opacity", "textEffect", "textTransition", "textTransitionDuration",
            "x", "y", "scale"
          ]
        };
        const propertyTypes = {
          numeric: new Set([
            "start", "duration", "scale", "rotation", "x", "y", "opacity", "volume",
            "brightness", "contrast", "saturation", "blur", "hue", "transitionDuration",
            "speedStart", "speedEnd", "chromaTolerance", "chromaSoftness", "maskTop",
            "maskBottom", "maskFeather", "maskAngle", "fadeIn", "fadeOut", "audioBass",
            "audioMid", "audioTreble", "audioPan", "fontSize", "bgOpacity",
            "textTransitionDuration", "weight"
          ]),
          boolean: new Set(["flipX", "flipY", "chromaEnabled", "italic"]),
          string: new Set(["name", "text", "color", "bgColor", "chromaColor", "font",
            "framingMode", "filterPreset", "transition", "maskShape", "align",
            "textEffect", "textTransition"])
        };
        const propertyRanges = {
          start: [0, 7200], duration: [0.2, 7200], scale: [0.1, 4],
          rotation: [-180, 180], x: [-100, 100], y: [-100, 100],
          opacity: [0, 1], volume: [0, 1], brightness: [0.5, 1.8],
          contrast: [0.5, 1.8], saturation: [0, 2], blur: [0, 12],
          hue: [-45, 45], transitionDuration: [0.1, 2.5],
          speedStart: [0.25, 4], speedEnd: [0.25, 4],
          chromaTolerance: [20, 220], chromaSoftness: [0, 160],
          maskTop: [0, 95], maskBottom: [5, 100], maskFeather: [0, 20],
          maskAngle: [-90, 90], fadeIn: [0, 7200], fadeOut: [0, 7200],
          audioBass: [-12, 12], audioMid: [-12, 12], audioTreble: [-12, 12],
          audioPan: [-100, 100], fontSize: [10, 120], bgOpacity: [0, 1],
          textTransitionDuration: [0.1, 2]
        };
        const enumValues = {
          framingMode: ["project", "fit", "fill", "stretch"],
          filterPreset: ["none", "cinematic", "vivid", "warm", "cool", "noir", "vintage"],
          transition: ["none", "fade", "zoom", "slide-left", "wipe-left", "blur-reveal"],
          maskShape: ["none", "circle", "ellipse", "rounded", "left-half", "right-half", "horizontal"],
          align: ["left", "center", "right"],
          textEffect: ["none", "shadow", "glow", "neon", "outline"],
          textTransition: ["none", "fade", "pop", "slide-up", "bounce"],
          font: ["Arial, sans-serif", "Inter, sans-serif", "Georgia, serif", "Impact, sans-serif", "system-ui, sans-serif"],
          weight: [500, 700, 900]
        };
        const toolClipTypes = {
          scene_detection: ["video"],
          beat_sync: ["audio", "video"],
          remove_silence: ["audio", "video"],
          ai_colour_correction: ["video", "image"],
          auto_captions: ["video", "audio"],
          reverse_video: ["video"],
          motion_tracking: ["video"],
          enhance_audio: ["audio"],
          remove_person_background: ["video"],
          auto_reframe: ["video"],
          detach_audio: ["video"]
        };
        const validTracksForType = {
          video: ["video", "overlay"],
          image: ["video", "overlay"],
          audio: ["audio"],
          text: ["text", "captions"]
        };
        const str = (value, max = 160) =>
          typeof value === "string" ? value.trim().slice(0, max) : "";
        const finite = value =>
          typeof value === "number" && Number.isFinite(value) ? value : null;
        const boundedNumber = (value, min, max) =>
          finite(value) !== null && value >= min && value <= max;
        const exactSet = (provided, expected) =>
          Array.isArray(provided) &&
          provided.length === expected.length &&
          new Set(provided).size === expected.length &&
          expected.every(value => provided.includes(value));

        if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
          return reply({ error: "The AI Editor connection is not configured." }, 500);
        }
        if (body.toolId !== "video-studio-ai-editor") {
          return reply({ error: "This request is not from the Video Studio AI Editor.", code: "AI_EDITOR_TOOL_MISMATCH" }, 400);
        }
        if (body.capabilityVersion !== AI_EDITOR_VERSION) {
          return reply({
            error: "The Video Studio AI Editor needs a compatible frontend update. Refresh the editor and try again.",
            code: "AI_EDITOR_VERSION_MISMATCH"
          }, 409);
        }
        if (!exactSet(body.capabilities, AI_EDITOR_ACTIONS) || !exactSet(body.toolIds, AI_VIDEO_TOOLS)) {
          return reply({
            error: "The Video Studio AI Editor capability list does not match this Worker version.",
            code: "AI_EDITOR_CAPABILITY_MISMATCH"
          }, 409);
        }
        const userRequest = str(body.request, 1400);
        if (!userRequest || userRequest.length > 1400) {
          return reply({ error: "Describe the edit in 1 to 1,400 characters." }, 400);
        }
        // Detect a plain duration-only trim request independently of Gemini's
        // optional preserveStart flag. Explicit source in-points remain distinct.
        const explicitTrimInPoint = /\b(?:from|starting\s+at|start\s+at|beginning|first\s+\d|remove\s+the\s+first|cut\s+off\s+the\s+first|in[- ]?point)\b/i.test(userRequest);
        const durationOnlyTrimIntent = !explicitTrimInPoint &&
          /\b(?:duration|length|\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?))\b/i.test(userRequest);

        // Rebuild a small context from known fields only. Never forward blobs,
        // local URLs, media bytes, unknown properties, or arbitrary client data.
        const rawContext = body.editorContext && typeof body.editorContext === "object" && !Array.isArray(body.editorContext)
          ? body.editorContext
          : {};
        const rawProject = rawContext.project && typeof rawContext.project === "object" ? rawContext.project : {};
        const rawMedia = rawContext.mediaLibrary && typeof rawContext.mediaLibrary === "object" ? rawContext.mediaLibrary : {};
        const rawProjects = rawContext.projects && typeof rawContext.projects === "object" ? rawContext.projects : {};
        const allowedPropertyNames = new Set(Object.values(propertyKeys).flat());
        const safeProperties = (source, type) => {
          if (!source || typeof source !== "object" || Array.isArray(source)) return {};
          const allowed = new Set(propertyKeys[type] || []);
          const output = {};
          for (const key of Object.keys(source)) {
            if (!allowed.has(key) || !allowedPropertyNames.has(key)) continue;
            const value = source[key];
            if (typeof value === "string") output[key] = value.slice(0, 180);
            else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) output[key] = value;
          }
          return output;
        };
        const clips = (Array.isArray(rawContext.clips) ? rawContext.clips : [])
          .slice(0, 40)
          .map(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const type = str(item.type, 20);
            if (!clipTypes.includes(type)) return null;
            const id = str(item.id, 128);
            if (!id) return null;
            const start = finite(item.start), duration = finite(item.duration);
            if (start === null || duration === null || start < 0 || duration < 0) return null;
            return {
              id,
              name: str(item.name || "Untitled clip", 100),
              type,
              track: trackTypes.includes(item.track) ? item.track : "",
              start: Math.min(7200, start),
              duration: Math.min(7200, duration),
              assetId: str(item.assetId, 128),
              sourceTiming: {
                sourceStart: Math.max(0, Math.min(7200, finite(item.sourceTiming?.sourceStart) ?? 0)),
                speedSourceDuration: Math.max(0, Math.min(7200, finite(item.sourceTiming?.speedSourceDuration) ?? 0))
              },
              properties: safeProperties(item.properties, type)
            };
          })
          .filter(Boolean);
        const mediaAssets = (Array.isArray(rawMedia.assets) ? rawMedia.assets : [])
          .slice(0, 80)
          .map(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const type = str(item.type, 20), id = str(item.id, 128);
            if (!id || !["video", "audio", "image"].includes(type)) return null;
            return {
              id,
              name: str(item.name || "Media asset", 100),
              type,
              duration: Math.max(0, Math.min(7200, finite(item.duration) ?? 0)),
              size: Math.max(0, Math.min(100000000000, finite(item.size) ?? 0)),
              proxyAssetId: str(item.proxyAssetId, 128),
              proxyAvailable: item.proxyAvailable === true,
              usingProxy: item.usingProxy === true
            };
          })
          .filter(Boolean);
        const projects = (Array.isArray(rawProjects.projects) ? rawProjects.projects : [])
          .slice(0, 60)
          .map(item => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return null;
            const id = str(item.id, 128);
            if (!id) return null;
            return {
              id,
              name: str(item.name || "Untitled project", 80),
              ratio: str(item.ratio, 24),
              resolution: str(item.resolution, 24),
              fps: Math.max(1, Math.min(120, finite(item.fps) ?? 30))
            };
          })
          .filter(Boolean);
        const editorContext = {
          scope: "Video Studio only. Homepage standalone tools and all export controls are excluded.",
          project: {
            id: str(rawProject.id, 128),
            name: str(rawProject.name || "Untitled project", 80),
            ratio: str(rawProject.ratio, 24),
            resolution: str(rawProject.resolution, 24),
            fps: Math.max(1, Math.min(120, finite(rawProject.fps) ?? 30)),
            duration: Math.max(0, Math.min(7200, finite(rawProject.duration) ?? 0))
          },
          clipCount: Math.max(clips.length, Math.min(10000, Math.floor(finite(rawContext.clipCount) ?? clips.length))),
          clipsTruncated: rawContext.clipsTruncated === true,
          selectedClipId: str(rawContext.selectedClipId, 128),
          playhead: Math.max(0, Math.min(7200, finite(rawContext.playhead) ?? 0)),
          clips,
          mediaLibrary: {
            assetCount: Math.max(mediaAssets.length, Math.min(10000, Math.floor(finite(rawMedia.assetCount) ?? mediaAssets.length))),
            assetsTruncated: rawMedia.assetsTruncated === true,
            assets: mediaAssets
          },
          projects: {
            count: Math.max(projects.length, Math.min(500, Math.floor(finite(rawProjects.count) ?? projects.length))),
            projects
          },
          preview: {
            playback: rawContext.preview?.playback === "playing" ? "playing" : "paused",
            playhead: Math.max(0, Math.min(7200, finite(rawContext.preview?.playhead) ?? 0)),
            fit: rawContext.preview?.fit === "cover" ? "cover" : "contain",
            guides: rawContext.preview?.guides === true
          },
          timeline: {
            zoom: Math.max(24, Math.min(140, finite(rawContext.timeline?.zoom) ?? 64)),
            snapEnabled: rawContext.timeline?.snapEnabled !== false,
            tracks: trackTypes
          },
          capabilities: AI_EDITOR_ACTIONS
        };
        const contextJson = JSON.stringify(editorContext);
        if (contextJson.length > 24000) {
          return reply({
            error: "This Video Studio project has too much context for one AI request. Select a clip or shorten the project context and try again.",
            code: "AI_EDITOR_CONTEXT_TOO_LARGE"
          }, 413);
        }

        const clipById = new Map(clips.map(item => [item.id, item]));
        const assetById = new Map(mediaAssets.map(item => [item.id, item]));
        const projectById = new Map(projects.map(item => [item.id, item]));
        const requireClip = (id, types) => {
          const clip = typeof id === "string" ? clipById.get(id) : null;
          if (!clip || (types && !types.includes(clip.type))) throw new Error("An action referred to a clip that is not available in the current editor context.");
          return clip;
        };
        const normalizeClipName = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
        const resolveClipTarget = (item, types) => {
          const requestedName = typeof item.clipName === "string" ? item.clipName.trim() : "";
          const requestedId = typeof item.clipId === "string" ? item.clipId : "";
          const requestedTrack = item.clipTrack === undefined ? "" : str(item.clipTrack, 20);
          const requestedStart = item.clipStart === undefined ? null : finite(item.clipStart);
          if (item.clipStart !== undefined && requestedStart === null) {
            throw new Error("AI_CLIP_TARGET_CLARIFICATION: Clip start time must be a valid number of seconds.");
          }
          if (requestedTrack && !trackTypes.includes(requestedTrack)) {
            throw new Error("AI_CLIP_TARGET_CLARIFICATION: Clip track is not recognised. Use Video, Overlay, Audio, Text or Captions.");
          }

          const isCompatible = candidate => !!candidate && (!types || types.includes(candidate.type));
          const selected = editorContext.selectedClipId
            ? clipById.get(editorContext.selectedClipId) || null
            : null;
          const selectedIsCompatible = isCompatible(selected);
          let clip = null;

          // Prefer a unique exact timeline-name match over an inconsistent ID
          // generated by the model. The backend then writes the resolved target
          // back into the operation so the frontend validates the same clip.
          if (requestedName) {
            const namedMatches = clips.filter(candidate =>
              normalizeClipName(candidate.name) === normalizeClipName(requestedName) &&
              isCompatible(candidate)
            );

            // A unique exact clip name is sufficient by itself. Do not let a
            // model-guessed track or start time invalidate that unique match.
            if (namedMatches.length === 1) {
              clip = namedMatches[0];
            } else if (namedMatches.length > 1) {
              let narrowed = namedMatches;
              if (requestedTrack) narrowed = narrowed.filter(candidate => candidate.track === requestedTrack);
              if (requestedStart !== null) narrowed = narrowed.filter(candidate => Math.abs(candidate.start - requestedStart) <= 0.25);
              if (narrowed.length === 1) {
                clip = narrowed[0];
              } else if (selectedIsCompatible && namedMatches.some(candidate => candidate.id === selected.id)) {
                // If duplicate names remain, an existing user selection safely
                // identifies which of those matching clips is intended.
                clip = selected;
              } else {
                const choices = namedMatches.slice(0, 5).map(candidate =>
                  candidate.name + " (" + candidate.track + " track, starts at " + candidate.start.toFixed(1) + "s)"
                );
                throw new Error("AI_CLIP_TARGET_CLARIFICATION: Multiple clips share this name: " + choices.join("; ") + ". Please specify the correct track or start time.");
              }
            } else if (requestedId && selectedIsCompatible && requestedId === selected.id) {
              // Gemini can paraphrase a filename even though it correctly
              // identified the user's explicit selection. Trust the verified
              // selected clip ID instead of rejecting the whole edit.
              clip = selected;
            } else {
              const candidates = clips.filter(isCompatible);
              const byId = requestedId ? clipById.get(requestedId) || null : null;
              if (byId && isCompatible(byId) && candidates.length === 1 && !editorContext.clipsTruncated) {
                // If the AI has only one compatible target available, a bad
                // paraphrased name must not force the user to repeat the clip.
                clip = byId;
              } else if (!byId && candidates.length === 1 && !editorContext.clipsTruncated) {
                clip = candidates[0];
              } else {
                throw new Error("AI_CLIP_TARGET_CLARIFICATION: No compatible timeline clip is named '" + requestedName + "'. Please check the exact clip name shown on the timeline.");
              }
            }
          } else if (requestedId) {
            const byId = clipById.get(requestedId) || null;
            if (isCompatible(byId)) {
              clip = byId;
            } else if (selectedIsCompatible) {
              // Recover from an invalid model-generated ID using the verified
              // current selection before asking the user to identify it again.
              clip = selected;
            }
          } else if (selectedIsCompatible) {
            clip = selected;
          }

          if (!clip && !requestedName && !editorContext.clipsTruncated) {
            const candidates = clips.filter(isCompatible);
            if (candidates.length === 1) {
              // A single compatible clip is an unambiguous target.
              clip = candidates[0];
            } else if (candidates.length > 1) {
              const choices = candidates.slice(0, 5).map(candidate =>
                candidate.name + " (" + candidate.track + " track, starts at " + candidate.start.toFixed(1) + "s)"
              );
              throw new Error("AI_CLIP_TARGET_CLARIFICATION: Multiple clips could match this edit: " +
                choices.join("; ") + ". Please specify the target clip.");
            }
          }
          if (!clip) {
            if (editorContext.clipsTruncated && !requestedName) {
              throw new Error("AI_CLIP_TARGET_CLARIFICATION: The project contains more clips than the current AI context. Please select the clip you want to edit.");
            }
            throw new Error("AI_CLIP_TARGET_CLARIFICATION: No suitable timeline clip was found. Please select the clip you want to edit or provide its exact name.");
          }
          if (!isCompatible(clip)) {
            throw new Error("AI_CLIP_TARGET_CLARIFICATION: This tool cannot be used on the identified clip type.");
          }

          // Canonicalize all target fields so the browser-side validator cannot
          // reject a correct clip because Gemini mixed an old ID/name/location.
          item.clipId = clip.id;
          item.clipName = clip.name;
          item.clipTrack = clip.track;
          item.clipStart = clip.start;
          return clip;
        };
        const requireAsset = id => {
          const asset = typeof id === "string" ? assetById.get(id) : null;
          if (!asset) throw new Error("An action referred to media that is not available in the current Media Library context.");
          return asset;
        };
        const requireProject = id => {
          const entry = typeof id === "string" ? projectById.get(id) : null;
          if (!entry) throw new Error("An action referred to a project that is not available in the current Project Manager context.");
          return entry;
        };
        const validTrack = (clip, track) =>
          typeof track === "string" && validTracksForType[clip.type]?.includes(track);
        const validateChanges = (clip, changes) => {
          if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("Clip property changes must be an object.");
          const keys = Object.keys(changes);
          if (!keys.length || keys.length > 22) throw new Error("A clip property edit must contain 1 to 22 settings.");
          for (const key of keys) {
            if (!(propertyKeys[clip.type] || []).includes(key)) throw new Error("The AI proposed an unsupported property: " + key);
            const value = changes[key];
            if (propertyTypes.numeric.has(key) && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("A numeric clip property had an invalid value.");
            if (propertyRanges[key] && (value < propertyRanges[key][0] || value > propertyRanges[key][1])) throw new Error("A clip property is outside its safe range: " + key);
            if ((key === "speedStart" || key === "speedEnd") && ![0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].includes(value)) throw new Error("A speed setting is not a supported preset.");
            if (propertyTypes.boolean.has(key) && typeof value !== "boolean") throw new Error("A boolean clip property had an invalid value.");
            if (propertyTypes.string.has(key) && typeof value !== "string") throw new Error("A text clip property had an invalid value.");
            if (!propertyTypes.numeric.has(key) && !propertyTypes.boolean.has(key) && !propertyTypes.string.has(key)) throw new Error("A clip property had an unsupported data type.");
            if (Object.prototype.hasOwnProperty.call(enumValues, key) && !enumValues[key].includes(value)) throw new Error("A clip property used an unavailable option: " + key);
            if (["color", "bgColor", "chromaColor"].includes(key) && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("A clip colour must be a six-digit HEX value.");
            if (["name", "text"].includes(key) && (!value.trim() || value.length > (key === "text" ? 180 : 80))) throw new Error("A clip text field is empty or too long.");
            if (key === "weight" && ![500, 700, 900].includes(value)) throw new Error("Font weight is not supported.");
          }
          if (changes.maskTop !== undefined || changes.maskBottom !== undefined) {
            const top = changes.maskTop ?? 0, bottom = changes.maskBottom ?? 100;
            if (bottom < top + 5) throw new Error("Mask top and bottom lines must remain at least 5 percent apart.");
          }
        };
        const checkId = (item, key) => {
          if (typeof item[key] !== "string" || !item[key]) throw new Error("A required ID was missing from an AI action.");
          return item[key];
        };
        const checkNum = (item, key, min, max) => {
          if (!boundedNumber(item[key], min, max)) throw new Error("An AI action contains an invalid " + key + " value.");
          return item[key];
        };
        const supportedTool = (item, type) => {
          if (!AI_VIDEO_TOOLS.includes(item.tool)) throw new Error("The AI proposed a Video Studio tool that is not allowed.");
          if (toolClipTypes[item.tool]) resolveClipTarget(item, toolClipTypes[item.tool]);
          else if (item.tool === "caption_translation") {
            if (!clips.some(clip => clip.track === "captions" && clip.type === "text")) throw new Error("Caption translation needs existing captions.");
            if (!languageNames.includes(item.language)) throw new Error("Caption translation needs a supported target language.");
          } else if (item.tool === "ai_voice_over") {
            if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 2000 || !voiceIds.includes(item.voiceId || "angus")) throw new Error("The AI voice-over details are invalid.");
          } else if (item.tool === "add_sticker") {
            if (!["star", "heart", "circle", "rectangle", "arrow", "speech", "lightning", "check", "emoji-star", "emoji-fire", "emoji-heart", "emoji-clap", "emoji-target"].includes(item.preset || "star")) throw new Error("The sticker preset is not supported.");
            if (!/^#[0-9a-f]{6}$/i.test(item.color || "#a86bf2")) throw new Error("The sticker colour is invalid.");
          }
          if (item.tool === "auto_captions" && item.language && !autoCaptionLanguages.includes(item.language)) throw new Error("Auto Captions language is not supported.");
          if (item.tool === "motion_tracking" && item.target && !["person", "any"].includes(item.target)) throw new Error("Motion Tracking target is not supported.");
          if (item.tool === "reverse_video" && item.alsoReverseAudio !== undefined && typeof item.alsoReverseAudio !== "boolean") throw new Error("Reverse Video audio option must be true or false.");
        };

        const validateOperation = item => {
          if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") throw new Error("An AI operation was not a valid object.");
          switch (item.type) {
            case "set_clip_properties": {
              const clip = resolveClipTarget(item);
              validateChanges(clip, item.changes);
              break;
            }
            case "split_clip": {
              const clip = resolveClipTarget(item);
              if (!["video", "audio", "image", "text"].includes(clip.type)) throw new Error("This clip cannot be split.");
              if (!boundedNumber(item.atSeconds, clip.start + 0.151, clip.start + clip.duration - 0.151)) throw new Error("The split point must be inside the selected clip.");
              break;
            }
            case "move_clip": {
              const clip = resolveClipTarget(item);
              checkNum(item, "start", 0, 7200);
              if (item.track !== undefined && !validTrack(clip, item.track)) throw new Error("The clip cannot be moved to that track.");
              break;
            }
            case "duplicate_clip":
              resolveClipTarget(item);
              checkNum(item, "start", 0, 7200);
              break;
            case "delete_clip":
              resolveClipTarget(item);
              break;
            case "add_text_overlay":
              if (typeof item.text !== "string" || !item.text.trim() || item.text.length > 180) throw new Error("Text overlay content is invalid.");
              checkNum(item, "start", 0, 7200);
              checkNum(item, "duration", 0.2, 600);
              validateChanges({ type: "text" }, { ...(item.changes || {}), text: item.text, start: item.start, duration: item.duration });
              break;
            case "set_keyframes": {
              const clip = resolveClipTarget(item, ["video", "image", "text"]);
              if (!Array.isArray(item.keyframes) || item.keyframes.length < 2 || item.keyframes.length > 20) throw new Error("Keyframe count is outside the supported range.");
              for (const frame of item.keyframes) {
                if (!frame || typeof frame !== "object" || !boundedNumber(frame.time, 0, clip.duration) || !frame.values || typeof frame.values !== "object" || Array.isArray(frame.values)) throw new Error("A keyframe has invalid timing or values.");
                const keys = Object.keys(frame.values);
                if (!keys.length || keys.some(key => !["x", "y", "scale", "rotation", "opacity"].includes(key))) throw new Error("A keyframe contains an unsupported property.");
                for (const key of keys) if (typeof frame.values[key] !== "number" || !Number.isFinite(frame.values[key])) throw new Error("A keyframe transform must be numeric.");
              }
              break;
            }
            case "run_tool":
              supportedTool(item);
              break;
            case "trim_clip": {
              const clip = resolveClipTarget(item);
              if (item.preserveStart !== undefined && typeof item.preserveStart !== "boolean") {
                throw new Error("The trim preserveStart option must be true or false.");
              }
              checkNum(item, "duration", 0.2, 7200);
              // A shorter duration with no explicit source in-point is an
              // in-place shortening. Preserve the clip's current timeline start
              // even if Gemini guessed a different start or omitted the flag.
              const shorterInPlaceTrim =
                !explicitTrimInPoint &&
                item.duration <= clip.duration + 0.05 &&
                (item.preserveStart === true || durationOnlyTrimIntent);
              if (shorterInPlaceTrim) item.start = clip.start;
              checkNum(item, "start", 0, 7200);
              if (clip.type === "video" && clip.sourceTiming.speedSourceDuration > 0) throw new Error("Speed-ramped video clips must not be trimmed by AI.");
              const safeInPlaceShortening =
                Math.abs(item.start - clip.start) <= 0.001 &&
                item.duration <= clip.duration + 0.05;
              if (clip.assetId && ["video", "audio"].includes(clip.type) && !safeInPlaceShortening) {
                const asset = assetById.get(clip.assetId);
                const nextSourceStart = clip.sourceTiming.sourceStart + item.start - clip.start;
                if (!asset || nextSourceStart < 0 || nextSourceStart + item.duration > asset.duration + 0.05) throw new Error("The requested trim exceeds the available original media.");
              }
              break;
            }
            case "set_preview_controls":
              if (item.playback !== undefined && !["play", "pause", "stop"].includes(item.playback)) throw new Error("Preview playback mode is unsupported.");
              if (item.playhead !== undefined) checkNum(item, "playhead", 0, 7200);
              if (item.fit !== undefined && !["contain", "cover"].includes(item.fit)) throw new Error("Preview Fit/Fill option is unsupported.");
              if (item.guides !== undefined && typeof item.guides !== "boolean") throw new Error("Preview guides option must be true or false.");
              if (item.playback === undefined && item.playhead === undefined && item.fit === undefined && item.guides === undefined) throw new Error("Preview control action was empty.");
              break;
            case "set_timeline_controls":
              if (item.fitAll !== undefined && typeof item.fitAll !== "boolean") throw new Error("Fit All option must be true or false.");
              if (item.fitAll === true && item.zoom !== undefined) throw new Error("Fit All and custom zoom cannot be combined.");
              if (item.zoom !== undefined && (!boundedNumber(item.zoom, 24, 140) || item.zoom % 4 !== 0)) throw new Error("Timeline zoom must use a supported step.");
              if (item.snap !== undefined && typeof item.snap !== "boolean") throw new Error("Timeline snap option must be true or false.");
              if (item.scrollToClipId !== undefined) requireClip(item.scrollToClipId);
              if (item.fitAll === undefined && item.zoom === undefined && item.snap === undefined && item.scrollToClipId === undefined) throw new Error("Timeline control action was empty.");
              break;
            case "add_asset_to_timeline": {
              const asset = requireAsset(item.assetId);
              if (!validTracksForType[asset.type]?.includes(item.track || (asset.type === "audio" ? "audio" : asset.type === "video" ? "video" : "overlay"))) throw new Error("Media asset cannot be added to that track.");
              checkNum(item, "start", 0, 7200);
              checkNum(item, "duration", 0.2, 7200);
              if (["video", "audio"].includes(asset.type) && item.duration > asset.duration + 0.05) throw new Error("The new media clip is longer than the available original asset.");
              break;
            }
            case "rename_asset":
              requireAsset(item.assetId);
              if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 100) throw new Error("The new media name is invalid.");
              break;
            case "remove_asset": {
              const asset = requireAsset(item.assetId);
              if (clips.some(clip => clip.assetId === asset.id || (asset.proxyAssetId && clip.assetId === asset.proxyAssetId))) throw new Error("An asset that is already used on the timeline cannot be removed from the Media Library.");
              break;
            }
            case "create_video_proxy": {
              const asset = requireAsset(item.assetId);
              if (asset.type !== "video" || asset.proxyAvailable) throw new Error("A proxy can only be created for an original video without an existing proxy.");
              break;
            }
            case "set_proxy_usage": {
              const asset = requireAsset(item.assetId);
              if (asset.type !== "video" || !asset.proxyAvailable || typeof item.useProxy !== "boolean") throw new Error("Proxy usage settings are not available for this asset.");
              break;
            }
            case "rename_project":
              if (item.projectId && item.projectId !== editorContext.project.id) throw new Error("AI may rename only the current open project.");
              if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 60) throw new Error("The new project name is invalid.");
              break;
            case "create_project":
              if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 60) throw new Error("New project name is invalid.");
              if (!["16:9", "9:16", "1:1", "4:5", "custom"].includes(item.ratio || "16:9")) throw new Error("The requested project aspect ratio is not available.");
              if (typeof item.resolution !== "string" || !/^\d{3,4}x\d{3,4}$/.test(item.resolution)) throw new Error("New project resolution is invalid.");
              if (!boundedNumber(item.width, 240, 3840) || !boundedNumber(item.height, 240, 3840)) throw new Error("New project dimensions are outside the supported range.");
              const ratio = item.ratio || "16:9";
              const presetResolutions = {
                "16:9": ["1280x720", "1920x1080", "2560x1440", "3840x2160"],
                "9:16": ["1080x1920"], "1:1": ["1080x1080"], "4:5": ["1080x1350"]
              };
              if (ratio !== "custom" && !presetResolutions[ratio]?.includes(item.resolution)) throw new Error("New project resolution does not match the selected aspect-ratio preset.");
              if (![24, 30, 60].includes(item.fps ?? 30)) throw new Error("New project frame rate is not supported.");
              break;
            case "open_project":
            case "delete_project":
              requireProject(item.projectId);
              break;
            default:
              throw new Error("The AI proposed an operation that is not allowed in Video Studio.");
          }
        };

        const systemInstructions = [
          "You are TrivexaAI's Video Studio editing assistant. You operate ONLY the current TrivexaAI Video Studio editor and its local Project Manager.",
          "Understand the user's request in any language, writing system, transliteration, or mixture of languages. Do not reject a request because it is not written in English. Interpret the intended meaning carefully, then write understoodRequest, message, and any clarification question in clear, simple English.",
          "Return exactly one JSON object, with no markdown or code fences: {\"understoodRequest\":\"...\",\"message\":\"...\",\"needsClarification\":false,\"operations\":[...]}.",
          "The only allowed operation types are: " + AI_EDITOR_ACTIONS.join(", ") + ". The only allowed run_tool IDs are: " + AI_VIDEO_TOOLS.join(", ") + ". Never invent any other function, tool, action, property, project, asset, clip ID or track.",
          "Never generate HTML, CSS, JavaScript, commands, URLs, shell commands, export jobs or code. You cannot run arbitrary code.",
          "This AI assistant does NOT control the 17 separate homepage tools. It does NOT control Export, export settings, render/download, or the export queue. Never propose an export action.",
          "Only use IDs present in EDITOR_CONTEXT. The currently selected clip ID is authoritative when the user says selected clip, this clip, current clip, or otherwise clearly refers to the current selection. In that case, use selectedClipId and do not add a redundant clipName, clipTrack, or clipStart. If the user gives an exact clip name, match it against the timeline: when exactly one compatible clip has that name, use that clip's exact ID. Never combine one clip's ID with another clip's name or location. If a generated ID is missing or invalid, use the verified selected clip when compatible; otherwise, if exactly one compatible clip exists and clipsTruncated is false, use that clip. Do not ask the user to identify a clip when a compatible selected clip or a single compatible timeline clip already resolves the target. If multiple compatible clips or same-name clips remain and the request does not identify one safely, set needsClarification=true and operations=[]. Ask one concise question. Never guess between unresolved duplicate clips.",
          "Use only the minimum relevant operations. Never add extra edits, effects, captions, voice-over, stickers, audio changes, or project operations unless explicitly requested. Do not alter audio for a visual-only request or visuals for an audio-only request.",
          "Do not assume the user wants all clips changed when they say 'the video' if several candidates exist. If clipsTruncated or assetsTruncated is true, do not claim an action covers the whole project or whole library.",
          "If needsClarification=true, operations MUST be an empty array and message must ask one specific question. Otherwise, include 1 to 8 valid operations and explain briefly.",
          "For clip-target actions (set_clip_properties, split_clip, move_clip, duplicate_clip, delete_clip, set_keyframes, trim_clip and clip-based run_tool), include clipId when known. If needed, clipName may be the exact timeline name; clipTrack and clipStart (absolute timeline seconds) may disambiguate duplicate names. Example: {\"type\":\"set_clip_properties\",\"clipName\":\"match-highlight.mp4\",\"clipTrack\":\"video\",\"clipStart\":0,\"changes\":{\"brightness\":1.1},\"reason\":\"...\"}. Only use properties listed for the target clip type.",
          "Video properties: name, start, duration, scale, rotation, x, y, opacity, flipX, flipY, framingMode, filterPreset, brightness, contrast, saturation, blur, hue, transition, transitionDuration, volume, speedStart, speedEnd, chromaEnabled, chromaColor, chromaTolerance, chromaSoftness, maskShape, maskTop, maskBottom, maskFeather, maskAngle. Image clips use their matching image properties and do not support video-only speed/chroma/background-removal settings.",
          "Audio properties: name, start, duration, volume, fadeIn, fadeOut, audioBass, audioMid, audioTreble, audioPan. Text properties: name, start, duration, text, color, fontSize, font, weight, align, bgColor, bgOpacity, italic, rotation, opacity, textEffect, textTransition, textTransitionDuration, x, y, scale.",
          "Property enums: framingMode project/fit/fill/stretch; filterPreset none/cinematic/vivid/warm/cool/noir/vintage; transition none/fade/zoom/slide-left/wipe-left/blur-reveal; maskShape none/circle/ellipse/rounded/left-half/right-half/horizontal; align left/center/right; textEffect none/shadow/glow/neon/outline; textTransition none/fade/pop/slide-up/bounce; font Arial, sans-serif OR Inter, sans-serif OR Georgia, serif OR Impact, sans-serif OR system-ui, sans-serif; weight 500/700/900. Colours must be six-digit HEX. Use numeric values as JSON numbers, not strings.",
          "Use conservative adjustments. Numeric limits: start 0–7200, duration 0.2–7200, scale 0.1–4, rotation -180–180, x/y -100–100, opacity/volume 0–1, brightness/contrast 0.5–1.8, saturation 0–2, blur 0–12, hue -45–45, transitionDuration 0.1–2.5, speedStart/speedEnd only 0.25/0.5/0.75/1/1.5/2/3/4, chromaTolerance 20–220, chromaSoftness 0–160, maskTop 0–95, maskBottom 5–100, maskFeather 0–20, maskAngle -90–90, fadeIn/fadeOut 0–7200, audioBass/audioMid/audioTreble -12–12, audioPan -100–100, fontSize 10–120, bgOpacity 0–1, textTransitionDuration 0.1–2.",
          "For split_clip use {\"type\":\"split_clip\",\"clipId\":\"id\",\"atSeconds\":number}; atSeconds is absolute timeline time and must be inside that clip, not at its edge.",
          "For move_clip use {\"type\":\"move_clip\",\"clipId\":\"id\",\"start\":number,\"track\":\"video|overlay|audio|text|captions\"}. Move video/image clips only between Video and Overlay, audio only to Audio, and text only to Text or Captions. Keep detached audio linked and in sync when moving its video.",
          "For duplicate_clip use {\"type\":\"duplicate_clip\",\"clipId\":\"id\",\"start\":number}. For delete_clip use {\"type\":\"delete_clip\",\"clipId\":\"id\"} only when the user clearly asks to remove that timeline clip.",
          "For trim_clip use {\"type\":\"trim_clip\",\"clipId\":\"id\",\"start\":number,\"duration\":number,\"preserveStart\":true}. Start is an absolute timeline time and duration is the new duration. IMPORTANT: When the user asks only to change a clip's duration (for example, 'trim it to 8 seconds') and does not ask to move/reposition the clip or choose a new in-point, include preserveStart:true. The Worker will set start to the exact current timeline start of the resolved clip; never guess 0 or another start time. Only omit preserveStart when the user explicitly asks to change the clip's timeline position or source in-point, and then use the exact requested absolute timeline start. For duration-only video trims, do not create a separate trim operation for linked/detached audio: the editor automatically keeps linked audio aligned and equal in duration. Do not trim speed-ramped video. Never extend beyond the original source media.",
          "For add_text_overlay use {\"type\":\"add_text_overlay\",\"text\":\"...\",\"start\":number,\"duration\":number,\"changes\":{},\"reason\":\"...\"}. Keep text at 180 characters or less and only add it when the user asks.",
          "For set_keyframes use {\"type\":\"set_keyframes\",\"clipId\":\"id\",\"keyframes\":[{\"time\":0,\"values\":{\"x\":0,\"y\":0,\"scale\":1,\"rotation\":0,\"opacity\":1}},{\"time\":2,\"values\":{\"x\":10}}]}. Use 2–20 frames, relative times from 0 to clip duration, and only x/y/scale/rotation/opacity values.",
          "For run_tool use {\"type\":\"run_tool\",\"tool\":\"exact-tool-id\",\"clipId\":\"id\",\"reason\":\"...\"}. scene_detection: video; beat_sync: audio or video and existing music; remove_silence: audio or video; ai_colour_correction: video or image; caption_translation: existing captions and language exactly one of " + languageNames.join(", ") + "; auto_captions: video or audio with language empty for auto-detect or one of " + autoCaptionLanguages.join(", ") + "; reverse_video: video and alsoReverseAudio must be false unless the user explicitly asks to reverse audio too; motion_tracking: video and target person or any; enhance_audio: audio; remove_person_background: video; auto_reframe: video; detach_audio: video; ai_voice_over: exact user-provided script text (1–2000 chars) and voiceId from " + voiceIds.join(", ") + "; add_sticker: one of star/heart/circle/rectangle/arrow/speech/lightning/check/emoji-star/emoji-fire/emoji-heart/emoji-clap/emoji-target and optional six-digit HEX colour.",
          "Cloud AI actions that process audio/text or use cloud analysis must remain explicit. Never add Auto Captions, Caption Translation, AI Voice-over or AI Colour Correction as unsolicited extras. The frontend asks the user for consent before required Cloud AI processing.",
          "For set_preview_controls use {\"type\":\"set_preview_controls\",\"playback\":\"play|pause|stop\",\"playhead\":number,\"fit\":\"contain|cover\",\"guides\":true}. Include only the settings requested. This is preview-only and must not imply export changes.",
          "For set_timeline_controls use {\"type\":\"set_timeline_controls\",\"fitAll\":true,\"zoom\":64,\"snap\":true,\"scrollToClipId\":\"id\"}. Include only requested settings. Zoom uses steps of 4 between 24 and 140.",
          "For add_asset_to_timeline use {\"type\":\"add_asset_to_timeline\",\"assetId\":\"existing-media-id\",\"start\":number,\"track\":\"...\",\"duration\":number}. Choose only from Media Library assets in context; default tracks are video, audio or overlay according to media type. Do not invent or import local files.",
          "For rename_asset use {\"type\":\"rename_asset\",\"assetId\":\"id\",\"name\":\"new name\"}. For remove_asset use {\"type\":\"remove_asset\",\"assetId\":\"id\"}; only remove unused imported media, and only when the user explicitly asks. Removing an asset must be a separate request, not combined with another operation.",
          "For create_video_proxy use {\"type\":\"create_video_proxy\",\"assetId\":\"video-asset-id\"}. Proxies are local preview copies; original files remain available for export. For set_proxy_usage use {\"type\":\"set_proxy_usage\",\"assetId\":\"video-asset-id\",\"useProxy\":true}. Only switch on a proxy when proxyAvailable is true.",
          "For rename_project use {\"type\":\"rename_project\",\"projectId\":\"current-project-id\",\"name\":\"new name\"}. For create_project use {\"type\":\"create_project\",\"name\":\"...\",\"ratio\":\"16:9|9:16|1:1|4:5|custom\",\"resolution\":\"1920x1080\",\"width\":1920,\"height\":1080,\"fps\":30}. Allowed fps: 24, 30, 60; dimensions: 240–3840. Use correct presets: 16:9 = 1920x1080, 9:16 = 1080x1920, 1:1 = 1080x1080, 4:5 = 1080x1350 unless the user asks another allowed landscape resolution.",
          "For open_project use {\"type\":\"open_project\",\"projectId\":\"existing-project-id\"}. For delete_project use {\"type\":\"delete_project\",\"projectId\":\"existing-project-id\"}. Project navigation/deletion must be one separate operation only. The UI will still ask for an explicit second confirmation before deletion; do not claim it has already been deleted.",
          "Project create/open/delete actions must not be combined with clip or media edits. Do not change other projects. Never access account settings, user records, Firebase, D1, Worker secrets, or authentication.",
          "Return only the requested changes, in the smallest number of steps. Reasons must be short and user-friendly."
        ].join("\n");

        const userMessage = [
          "EDITOR_CONTEXT:",
          contextJson,
          "",
          "USER_REQUEST:",
          userRequest
        ].join("\n");
        let generatedText = "";
        let geminiFailure = null;
        if (env.GEMINI_API_KEY) {
          try {
            const geminiResponse = await fetchGeminiWithRetry(
              "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-goog-api-key": env.GEMINI_API_KEY
                },
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: systemInstructions }] },
                  contents: [{ role: "user", parts: [{ text: userMessage }] }],
                  generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 4500,
                    responseMimeType: "application/json"
                  }
                })
              }
            );
            let geminiData = {};
            try { geminiData = await geminiResponse.json(); } catch (parseError) {}
            if (!geminiResponse.ok) {
              throw Object.assign(new Error(String(geminiData.error?.message || "Gemini request failed.").slice(0, 500)), { status: geminiResponse.status });
            }
            generatedText = geminiData.candidates?.[0]?.content?.parts
              ?.map(part => typeof part.text === "string" ? part.text : "")
              .join("")
              .trim() || "";
            if (!generatedText) throw new Error("Gemini returned an empty edit plan.");
          } catch (error) {
            geminiFailure = error;
            console.warn("Video Studio AI Editor Gemini failed; trying OpenRouter fallback:", error?.message);
          }
        }
        if (!generatedText && env.OPENROUTER_API_KEY) {
          try {
            generatedText = await fetchOpenRouterText(systemInstructions, userMessage, 4500, 0.1);
          } catch (openRouterError) {
            console.error("Video Studio AI Editor OpenRouter error:", openRouterError);
            return reply({
              error: "Gemini and OpenRouter could not prepare the Video Studio edit plan.",
              details: String(openRouterError?.message || geminiFailure?.message || "Please try again shortly.").slice(0, 500),
              code: "AI_EDITOR_PROVIDERS_FAILED"
            }, openRouterError?.status === 429 ? 429 : 502);
          }
        }
        if (!generatedText || generatedText.length > 30000) {
          return reply({
            error: "The AI returned an empty or oversized edit plan. Please simplify your request.",
            details: String(geminiFailure?.message || "").slice(0, 300),
            code: "AI_EDITOR_EMPTY_PLAN"
          }, 502);
        }

        let plan;
        try {
          const firstBrace = generatedText.indexOf("{");
          const lastBrace = generatedText.lastIndexOf("}");
          const jsonText = firstBrace >= 0 && lastBrace > firstBrace
            ? generatedText.slice(firstBrace, lastBrace + 1)
            : generatedText;
          plan = JSON.parse(jsonText);
        } catch (planParseError) {
          return reply({ error: "The AI response was not a valid edit plan. Please try a clearer prompt.", code: "AI_EDITOR_INVALID_JSON" }, 502);
        }
        if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
          return reply({ error: "The AI returned an invalid edit plan.", code: "AI_EDITOR_INVALID_PLAN" }, 502);
        }
        const needsClarification = plan.needsClarification === true;
        const operations = Array.isArray(plan.operations) ? plan.operations : null;
        if (needsClarification) {
          if (!operations || operations.length !== 0) {
            return reply({ error: "The AI clarification response did not follow the required safe format. Please try again.", code: "AI_EDITOR_PLAN_REJECTED" }, 502);
          }
        } else if (!operations || operations.length < 1 || operations.length > 8) {
          return reply({ error: "The AI did not return a complete set of editing steps. Please make your request more specific.", code: "AI_EDITOR_PLAN_REJECTED" }, 502);
        }
        if (!str(plan.understoodRequest, 500)) {
          return reply({ error: "The AI did not clearly restate your requested edit. Please try again.", code: "AI_EDITOR_PLAN_REJECTED" }, 502);
        }
        if (operations) {
          try {
            for (const operation of operations) {
              if (!AI_EDITOR_ACTIONS.includes(operation?.type)) throw new Error("The AI proposed an unsupported operation.");
              validateOperation(operation);
              if (operation.reason !== undefined && typeof operation.reason !== "string") throw new Error("An action explanation must be plain text.");
              if (typeof operation.reason === "string") operation.reason = operation.reason.slice(0, 220);
            }
            const navigation = operations.filter(operation => ["create_project", "open_project", "delete_project"].includes(operation.type));
            if (navigation.length && operations.length !== 1) throw new Error("Project actions must be separate from editor changes.");
            if (operations.some(operation => operation.type === "remove_asset") && operations.length !== 1) throw new Error("Removing a Media Library asset must be a separate request.");
          } catch (validationError) {
            const validationMessage = String(validationError?.message || validationError);
            const clarificationPrefix = "AI_CLIP_TARGET_CLARIFICATION:";
            if (validationMessage.startsWith(clarificationPrefix)) {
              return reply({
                text: JSON.stringify({
                  understoodRequest: str(plan.understoodRequest, 500),
                  message: validationMessage.slice(clarificationPrefix.length).trim(),
                  needsClarification: true,
                  operations: []
                })
              });
            }
            console.warn("Video Studio AI Editor plan rejected:", validationMessage);
            return reply({
              error: "The AI edit plan failed a safety check: " + validationMessage.slice(0, 300) + " Nothing was changed. Please review the request and try again.",
              code: "AI_EDITOR_PLAN_REJECTED"
            }, 422);
          }
        }
        const cleanPlan = {
          understoodRequest: str(plan.understoodRequest, 500),
          message: str(plan.message, 700),
          needsClarification,
          operations: operations || []
        };
        return reply({ text: JSON.stringify(cleanPlan) });
      }

      // Photo Editor AI endpoints: Firebase auth + advanced access are enforced by the gateway.
      const photoAction=String(body.action||"");
      if(photoAction.startsWith("photo_editor_")){
        if(!["photo_editor_prompt_writer","photo_editor_thumbnail_critic"].includes(photoAction))return reply({error:"This Photo Editor AI action is not available in the free tool set.",code:"PHOTO_EDITOR_ACTION_UNAVAILABLE"},403);
        if(body.toolId!=="photo-editor-ai")return reply({error:"Photo Editor request rejected."},400);
        if(!env.GEMINI_API_KEY&&!env.OPENROUTER_API_KEY)return reply({error:"Photo Editor AI is not configured."},503);
        const textAI=async(parts,system,max=1000)=>{
          const containsImage=parts.some(part=>part&&typeof part==="object"&&(part.inlineData||part.fileData));
          const parseObject=raw=>{
            const first=raw.indexOf("{"),last=raw.lastIndexOf("}"),candidate=first>=0&&last>first?raw.slice(first,last+1):raw;
            const parsed=JSON.parse(candidate);
            if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("Gemini returned a response that was not a JSON object.");
            return parsed;
          };
          const geminiErrors=[];
          if(env.GEMINI_API_KEY){
            // Use Google's current Interactions API for Gemini 3.x multimodal input.
            // The first model is the current free Flash-Lite replacement for the
            // restricted 2.5 model; 3.1 remains a secondary fallback for availability.
            const interactionInput=parts.map(part=>{
              if(part&&typeof part.text==="string")return {type:"text",text:part.text};
              if(part&&part.inlineData&&typeof part.inlineData.data==="string")return {type:"image",data:part.inlineData.data,mime_type:part.inlineData.mimeType||"image/jpeg"};
              if(part&&part.fileData&&typeof part.fileData.fileUri==="string")return {type:"image",uri:part.fileData.fileUri,mime_type:part.fileData.mimeType||"image/jpeg"};
              return null;
            }).filter(Boolean);
            for(const model of ["gemini-3.5-flash-lite","gemini-3.1-flash-lite"]){
              try{
                const r=await fetchGeminiWithRetry("https://generativelanguage.googleapis.com/v1beta/interactions",{
                  method:"POST",
                  headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY,"Api-Revision":"2026-05-20"},
                  body:JSON.stringify({
                    model,
                    input:interactionInput,
                    ...(system?{system_instruction:system}:{}),
                    response_format:{type:"text",mime_type:"application/json"},
                    store:false
                  })
                });
                let d={};try{d=await r.json()}catch(e){}
                if(!r.ok)throw Object.assign(new Error(model+" returned HTTP "+r.status+": "+String(d.error?.message||"Gemini request failed.").slice(0,260)),{status:r.status});
                const modelSteps=Array.isArray(d.steps)?d.steps.filter(step=>step&&step.type==="model_output"):[];
                const raw=(typeof d.output_text==="string"?d.output_text:modelSteps.flatMap(step=>Array.isArray(step.content)?step.content:[]).map(item=>typeof item?.text==="string"?item.text:"").filter(Boolean).join("\n")).trim();
                if(!raw){const reason=d.status||"empty model response";throw Object.assign(new Error(model+" returned no analysis text ("+reason+")."),{status:502});}
                return parseObject(raw);
              }catch(error){geminiErrors.push(String(error?.message||"Gemini request failed.").slice(0,260));console.warn("Photo Editor Gemini model "+model+" failed:",error?.message);}
            }
          }
          // Never send thumbnail previews or other image bytes to OpenRouter.
          if(containsImage)throw Object.assign(new Error(geminiErrors.length?"Gemini image analysis failed: "+geminiErrors.join(" | "):"Image analysis needs a Gemini vision key; image data is never sent to OpenRouter."),{status:502});
          if(!env.OPENROUTER_API_KEY)throw new Error(geminiErrors.join(" | ")||"No text AI provider is configured.");
          const textParts=parts.map(part=>typeof part?.text==="string"?part.text:"").filter(Boolean).join("\n");
          const raw=await fetchOpenRouterText(system,textParts,max,.2);
          return parseObject(raw);
        };
        const failed=(e,message)=>reply({error:message,details:String(e?.message||"Try again shortly.").slice(0,500),code:"PHOTO_EDITOR_AI_FAILED"},e?.status===429?429:e?.status===503?503:502);
        if(photoAction==="photo_editor_prompt_writer"){
          const prompt=typeof body.prompt==="string"?body.prompt.trim():"";
          if(!prompt||prompt.length>1400)return reply({error:"Enter a photo-edit instruction under 1,400 characters."},400);
          try{
            const r=await textAI([{text:prompt}],"You are TrivexaAI Photo Editor's prompt improver. Interpret the user's request as written, including transliterated or mixed-language input. Preserve exactly what the user wants and all keep-unchanged instructions; do not add edits. Return only JSON {\"prompt\":\"...\"}, containing a clear, ready-to-use English image prompt under 1,200 characters. All returned text must be English only.",700);
            const improved=typeof r.prompt==="string"?r.prompt.trim().slice(0,1200):"";if(!improved)throw new Error("Gemini returned an empty prompt.");
            return reply({prompt:improved,needsClarification:false,question:""});
          }catch(e){console.error("Photo prompt writer:",e);return failed(e,"The AI providers could not improve this prompt.");}
        }
        if(photoAction==="photo_editor_thumbnail_critic"){
          const raw=typeof body.imageBase64==="string"?body.imageBase64.trim():"",mime=String(body.mimeType||"image/jpeg"),data=raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/i,"").replace(/\s/g,"");
          if(!data||data.length>3500000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)||!["image/png","image/jpeg","image/webp"].includes(mime))return reply({error:"Thumbnail preview is invalid or too large."},400);
          try{
            const r=await textAI([{inlineData:{mimeType:mime,data}},{text:"Review this YouTube/social thumbnail for phone readability, subject clarity, contrast, headline visibility, colors and composition. Return JSON only: score (0-100), summary in English, and suggestions (1-5). Each suggestion must have an English title, an English reason, and an adjustment. All returned text must be English only. Use clear, concise English and never return non-English or transliterated text. If the thumbnail contains non-English wording, describe it in English without repeating that wording. The adjustment may include only numeric brightness 0-200, contrast 0-200, saturation 0-200, exposure -100..100, temperature -100..100, sharpness 0-100, vignette 0-100, or hue -180..180. Suggest useful changes only; do not claim edits were applied."}],null,1200);
            const ranges={brightness:[0,200],contrast:[0,200],saturation:[0,200],exposure:[-100,100],temperature:[-100,100],sharpness:[0,100],vignette:[0,100],hue:[-180,180]};
            const suggestions=(Array.isArray(r.suggestions)?r.suggestions:[]).slice(0,5).filter(x=>x&&typeof x==="object"&&!Array.isArray(x)).map(x=>{
              const adjustment={};for(const [k,v] of Object.entries(x.adjustment||{})){const a=ranges[k];if(a&&typeof v==="number"&&Number.isFinite(v)&&v>=a[0]&&v<=a[1])adjustment[k]=v}
              return {title:String(x.title||"Suggested improvement").slice(0,100),reason:String(x.reason||"").slice(0,260),adjustment};
            });
            return reply({score:Number.isFinite(r.score)?Math.max(0,Math.min(100,Math.round(r.score))):null,summary:String(r.summary||"Review complete.").slice(0,700),suggestions});
          }catch(e){console.error("Photo thumbnail critic:",e);return failed(e,"Gemini could not analyze this thumbnail.");}
        }

      }

      // EXISTING TEXT AI TOOLS — Gemini primary, OpenRouter free-only fallback.
      if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
        return reply({ error: "No text AI provider is configured." }, 500);
      }

      const prompt = body.prompt;
      if (
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > 4000
      ) {
        return reply({
          error: "Enter a prompt of up to 4000 characters."
        }, 400);
      }

      let generatedText = "";
      let geminiFailure = null;
      if (env.GEMINI_API_KEY) {
        try {
          const response = await fetchGeminiWithRetry(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": env.GEMINI_API_KEY
              },
              body: JSON.stringify({
                contents: [{
                  parts: [{ text: prompt.trim() }]
                }]
              })
            }
          );
          let data = {};
          try { data = await response.json(); } catch (parseError) {}
          if (!response.ok) {
            throw Object.assign(new Error(String(data.error?.message || "Gemini request failed.").slice(0, 450)), { status: response.status });
          }
          generatedText = data.candidates?.[0]?.content?.parts
            ?.map(part => typeof part.text === "string" ? part.text : "")
            .join("") || "";
          if (!generatedText.trim()) throw new Error("Gemini returned an empty response.");
        } catch (error) {
          geminiFailure = error;
          console.warn("General text AI Gemini failed; trying OpenRouter fallback:", error?.message);
        }
      }
      if (!generatedText && env.OPENROUTER_API_KEY) {
        try {
          generatedText = await fetchOpenRouterText("", prompt.trim(), 1400, 0.35);
        } catch (openRouterError) {
          console.error("General text AI OpenRouter error:", openRouterError);
          return reply({
            error: "Gemini and OpenRouter could not complete this text request.",
            details: String(openRouterError?.message || geminiFailure?.message || "Please try again shortly.").slice(0, 450),
            code: "TEXT_AI_PROVIDERS_FAILED"
          }, openRouterError?.status === 429 ? 429 : 502);
        }
      }
      if (!generatedText.trim()) {
        return reply({
          error: "The AI could not complete this request.",
          details: String(geminiFailure?.message || "Please try again shortly.").slice(0, 400),
          code: "TEXT_AI_EMPTY_RESPONSE"
        }, 502);
      }
      return reply({ text: generatedText });
    } catch (error) {
      console.error("Worker error:", error);
      return reply({
        error: "The Worker could not complete this request.",
        details: error?.message || "Unknown Worker error.",
        code: "WORKER_INTERNAL_ERROR"
      }, 500);
    }
  }
};

export default {
 async fetch(request, env) {
  const origin=request.headers.get("Origin");
  const normalizeAllowedOrigin=value=>{
   let candidate=String(value||"").trim().replace(/^["']|["']$/g,"");
   if(!candidate)return "";
   if(!/^https?:\/\//i.test(candidate))candidate="https://"+candidate;
   try{
    const parsed=new URL(candidate);
    return parsed.protocol==="https:"||parsed.protocol==="http:"?parsed.origin:"";
   }catch(error){return "";}
  };
  // Always trust the official TrivexaAI GitHub Pages origin. ALLOWED_ORIGINS
  // may add extra origins, but a missing/misformatted variable must never
  // accidentally lock the primary website out of its own Worker.
  const configuredOrigins=String(env.ALLOWED_ORIGINS||"")
   .split(/[,;\n\r]+/).map(normalizeAllowedOrigin).filter(Boolean);
  const origins=new Set(["https://abubakar902.github.io",...configuredOrigins]);
  let requestOrigin="";
  try{requestOrigin=origin?new URL(origin).origin:"";}catch(error){}
  const allowed=!origin||origins.has(requestOrigin);
  const requestedHeaders=request.headers.get("Access-Control-Request-Headers");
  const cors={
   ...(origin&&allowed?{"Access-Control-Allow-Origin":requestOrigin}:{}),
   "Access-Control-Allow-Methods":"POST, OPTIONS",
   "Access-Control-Allow-Headers":requestedHeaders||"Content-Type, Authorization",
   "Access-Control-Max-Age":"86400",
   "Access-Control-Expose-Headers":"Content-Disposition",
   "Vary":"Origin","Cache-Control":"no-store"
  };
  const reply=(data,status=200)=>Response.json(data,{status,headers:cors});
  if(!allowed)return reply({error:"Website origin is not allowed.",code:"ORIGIN_NOT_ALLOWED"},403);
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(request.method!=="POST")return reply({error:"Please send a POST request."},405);
  let body;
  try{body=await request.json();}catch{return reply({error:"Send valid JSON."},400);}
  if(!env.TRIVEXA_DB||!env.FIREBASE_PROJECT_ID)return reply({error:"Authentication is not configured yet.",code:"AUTH_NOT_CONFIGURED"},503);
  const match=(request.headers.get("Authorization")||"").match(/^Bearer\s+(.+)$/i);
  if(!match)return reply({error:"Please sign in with Google.",code:"AUTH_REQUIRED"},401);
  let claims;
  try{claims=await verifyIdToken(match[1],env);}catch(e){console.warn("Auth rejected:",e?.message);return reply({error:"Google sign-in could not be verified. Please sign in again.",code:"AUTH_INVALID"},401);}
  let user;
  try{user=await getUser(env,claims);}catch(e){console.error("Account database error:",e);return reply({error:"Could not load your TrivexaAI account.",code:"ACCOUNT_UNAVAILABLE"},503);}
  if(!user)return reply({error:"Account unavailable."},503);
  if(user.status!=="active")return reply({error:user.status==="banned"?"This account has been disabled.":"This account is temporarily suspended.",code:user.status==="banned"?"ACCOUNT_BANNED":"ACCOUNT_SUSPENDED"},403);
  // Protect invite-code guessing and sensitive admin mutations. These routes
  // are handled before legacyWorker, so they need their own limiter check.
  const accountActionName=String(body.action||"").toLowerCase();
  if(env.CREATOR_LIMITER&&(accountActionName==="auth_redeem_invite"||accountActionName==="dashboard_data"||accountActionName.startsWith("admin_"))){
   const clientIP=request.headers.get("CF-Connecting-IP")||"unknown";
   try{
    const {success}=await env.CREATOR_LIMITER.limit({key:`auth:${clientIP}:${user.uid}:${accountActionName}`});
    if(!success)return reply({error:"Too many account requests. Please wait a minute and try again.",code:"ACCOUNT_RATE_LIMITED"},429);
   }catch(e){console.error("Account rate limiter error:",e);}
  }
  const accountResponse=await accountAction(body,env,user,reply);
  if(accountResponse)return accountResponse;
  const action=String(body.action||"generate_text").toLowerCase();
  if(ADVANCED_ACTIONS.has(action)&&user.role!=="admin"&&user.advanced_access!=="approved")return reply({error:"This feature needs an invite or admin approval.",code:"ADVANCED_ACCESS_REQUIRED"},403);
  const forwardHeaders=new Headers(request.headers);forwardHeaders.delete("Content-Length");forwardHeaders.delete("Host");
  // Overwrite any client-supplied value. Only the verified account ID reaches the internal legacy worker.
  forwardHeaders.set("X-Trivexa-Verified-Account",String(user.uid||claims.sub||""));
  const forwarded=new Request(request.url,{method:"POST",headers:forwardHeaders,body:JSON.stringify(body)});
  let response;
  try{response=await legacyWorker.fetch(forwarded,env);}catch(e){console.error("Legacy Worker error:",e);return reply({error:"The tool request failed."},500);}
  // Record successful allowlisted actions only; never persist request payloads.
  // For the shared text-generation endpoint, prefer the frontend's allowlisted tool ID.
  const requestedToolId=String(body.toolId||"").toLowerCase();
  const trackedAction=TRACKED_TOOL_IDS.has(requestedToolId)?requestedToolId:action;
  if(response.ok && (TRACKED_TOOL_ACTIONS.has(action)||TRACKED_TOOL_IDS.has(requestedToolId))){
   try{
    await env.TRIVEXA_DB.prepare("INSERT INTO user_activity(id,uid,action,created_at) VALUES(?,?,?,?)")
     .bind(crypto.randomUUID(),user.uid,trackedAction,Math.floor(Date.now()/1000)).run();
   }catch(e){console.warn("Usage analytics write skipped:",e?.message||e);}
  }
  const headers=new Headers(response.headers);
  headers.set("Cache-Control","no-store");
  if(origin)headers.set("Access-Control-Allow-Origin",origin);
  headers.set("Access-Control-Allow-Headers","Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods","POST, OPTIONS");
  headers.set("Vary","Origin");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }
};
// AI integration source update marker
