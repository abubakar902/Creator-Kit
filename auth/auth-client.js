import {initializeApp} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import {getAuth,GoogleAuthProvider,signInWithPopup,signInWithRedirect,setPersistence,browserLocalPersistence,onAuthStateChanged,signOut} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";
import {firebaseConfig} from "./firebase-config.js";
export const WORKER_URL="https://creatorkit-ai.abubakar647648.workers.dev";
const workerOrigin=new URL(WORKER_URL).origin, nativeFetch=window.fetch.bind(window);
export const authConfigured=Boolean(firebaseConfig?.apiKey&&!firebaseConfig.apiKey.startsWith("PASTE_")&&firebaseConfig?.projectId&&!firebaseConfig.projectId.startsWith("YOUR_")&&firebaseConfig?.appId&&!firebaseConfig.appId.startsWith("PASTE_"));
export let auth=null;let firstUser=null;let initError=null;let resolveReady;
export const authReady=new Promise(resolve=>resolveReady=resolve);
if(authConfigured){try{auth=getAuth(initializeApp(firebaseConfig));await setPersistence(auth,browserLocalPersistence);onAuthStateChanged(auth,u=>{firstUser=u;resolveReady(u);window.dispatchEvent(new CustomEvent("trivexaai-auth-state",{detail:{signedIn:!!u}}));});}catch(e){initError=e;resolveReady(null);console.error("TrivexaAI Firebase init:",e);}}else resolveReady(null);
const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:"select_account"});
function login(){const u=new URL("./login.html",import.meta.url);u.searchParams.set("next",location.href);location.assign(u.href);}
export function getSafeNextUrl(){const candidate=new URLSearchParams(location.search).get("next");const fallback=new URL("../",import.meta.url);try{const u=new URL(candidate||fallback.href,fallback);return u.origin===location.origin&&u.pathname.startsWith(fallback.pathname)?u.href:fallback.href;}catch{return fallback.href;}}
async function json(r){let d={};try{d=await r.json();}catch{}if(!r.ok){const e=new Error(d.error||"Request failed ("+r.status+")");e.status=r.status;e.code=d.code||"REQUEST_FAILED";throw e;}return d;}
export async function workerRequest(payload){if(!authConfigured||!auth)throw new Error("Google sign-in is not configured yet.");await authReady;const u=auth.currentUser||firstUser;if(!u){login();throw new Error("Please sign in with Google.");}const token=await u.getIdToken();const r=await nativeFetch(WORKER_URL,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:JSON.stringify(payload),cache:"no-store"});return json(r);}
export async function signInWithGoogle(){if(!authConfigured||!auth)throw new Error("Firebase has not been configured yet.");try{await signInWithPopup(auth,provider);}catch(e){if(e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment"){await signInWithRedirect(auth,provider);return {redirecting:true};}throw e;}return workerRequest({action:"auth_me"});}
export async function getAccountProfile(){return workerRequest({action:"auth_me"});}
export async function signOutTrivexaAI(){if(auth)await signOut(auth);}
export function getInitializationError(){return initError;}
if(authConfigured&&auth){
 window.fetch=async(input,init={})=>{let url="";try{url=typeof input==="string"?new URL(input,location.href).href:input instanceof URL?input.href:input?.url||"";}catch{return nativeFetch(input,init);}if(new URL(url,location.href).origin!==workerOrigin)return nativeFetch(input,init);await authReady;const u=auth.currentUser||firstUser;if(!u){login();throw new Error("Please sign in with Google.");}const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(init.headers||{}).forEach((v,k)=>headers.set(k,v));headers.set("Authorization","Bearer "+await u.getIdToken());return nativeFetch(input,{...init,headers,cache:"no-store"});};
 
 // Public homepage, SEO landing pages and account pages remain readable.
 // Their protected actions require sign-in before execution.
 const currentPath=window.location.pathname.toLowerCase();
 const isMainHome=currentPath.endsWith("/")||currentPath.endsWith("/index.html");
 const isAuthPage=currentPath.includes("/auth/");
 const isStandaloneToolPage=!isMainHome&&!isAuthPage;
 const replayed=new WeakSet();
 document.addEventListener("click",async e=>{
   if(replayed.has(e)){replayed.delete(e);return;}
   const selector=isStandaloneToolPage?"button, input[type='submit'], [data-requires-auth]":".tool[data-tool], [data-requires-auth]";
   const el=e.target instanceof Element?e.target.closest(selector):null;
   if(!el||auth.currentUser||firstUser)return;
   e.preventDefault();e.stopImmediatePropagation();
   await authReady;
   if(auth.currentUser||firstUser){
     const ev=new MouseEvent("click",{bubbles:true,cancelable:true,view:window});
     replayed.add(ev);el.dispatchEvent(ev);
   }else login();
 },true);
 let allowReplayedSubmit=false;
 document.addEventListener("submit",async e=>{
   if(allowReplayedSubmit){allowReplayedSubmit=false;return;}
   if(!isStandaloneToolPage||auth.currentUser||firstUser)return;
   e.preventDefault();e.stopImmediatePropagation();
   await authReady;
   if(auth.currentUser||firstUser){
     allowReplayedSubmit=true;
     e.target.requestSubmit(e.submitter||undefined);
   }else login();
 },true);
}
window.TrivexaAuth=Object.freeze({configured:authConfigured,auth,ready:authReady,signInWithGoogle,signOut:signOutTrivexaAI,getProfile:getAccountProfile,workerRequest,getSafeNextUrl,getInitializationError});