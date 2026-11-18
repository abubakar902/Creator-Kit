
/* TrivexaAI authentication gateway. Legacy AI tool handlers are retained below. */
const FIREBASE_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let firebaseKeys = null;
let firebaseKeysExpiry = 0;
const ADVANCED_ACTIONS = new Set([
  "generate_image", "generate_voice", "video_studio", "video_studio_create",
  "video_studio_export", "video_studio_ai_assistant", "ai_editing_assistant",
  "advanced_feature"
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

      // PER-TOOL RATE LIMITING
      // The frontend can send toolId, tool, toolName, or tool_name.
      // If none is supplied, requests are separated by their Worker action.
      const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
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
            key: `${clientIP}:${toolKey}`
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

      // EXISTING GEMINI AI TOOLS
      if (!env.GEMINI_API_KEY) {
        return reply({ error: "API key is not configured." }, 500);
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

      const response = await fetch(
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

      const data = await response.json();
      if (!response.ok) {
        return reply({
          error: "Gemini request failed.",
          details: data.error?.message || "Please check API access."
        }, 502);
      }

      const text = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("") || "";

      return reply({ text });
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
  const origins=String(env.ALLOWED_ORIGINS||"https://abubakar902.github.io").split(",").map(x=>x.trim()).filter(Boolean);
  const allowed=!origin||origins.includes(origin);
  const cors={
   ...(origin&&allowed?{"Access-Control-Allow-Origin":origin}:{}),
   "Access-Control-Allow-Methods":"POST, OPTIONS",
   "Access-Control-Allow-Headers":"Content-Type, Authorization",
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
  if(env.CREATOR_LIMITER&&(accountActionName==="auth_redeem_invite"||accountActionName.startsWith("admin_"))){
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
  const forwarded=new Request(request.url,{method:"POST",headers:forwardHeaders,body:JSON.stringify(body)});
  let response;
  try{response=await legacyWorker.fetch(forwarded,env);}catch(e){console.error("Legacy Worker error:",e);return reply({error:"The tool request failed."},500);}
  const headers=new Headers(response.headers);
  headers.set("Cache-Control","no-store");
  if(origin)headers.set("Access-Control-Allow-Origin",origin);
  headers.set("Access-Control-Allow-Headers","Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods","POST, OPTIONS");
  headers.set("Vary","Origin");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
 }
};
