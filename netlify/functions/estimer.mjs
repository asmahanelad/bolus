// Fonction serveur Netlify : garde la clé Gemini secrète et estime les glucides d'un repas.
// La clé se règle dans Netlify : Project configuration > Environment variables > GEMINI_API_KEY.
// Seuls la photo (ou la description) du repas et la langue arrivent ici : jamais la glycémie ni les doses.

const MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.0-flash"];
const MAX_IMAGE_B64 = 5000000; // ~3,7 Mo d'image, largement assez pour une photo réduite à 1280 px

const AI_RULES = `Méthode, aliment par aliment :
1. Nomme l'aliment précisément (ex. « couscous de blé cuit », pas « féculent »).
2. Estime le poids servi en grammes (ou le volume en ml pour une boisson). Pour une photo, prends comme repères le diamètre de l'assiette (plate ≈ 26 cm, creuse ≈ 22 cm), les couverts (fourchette ≈ 19 cm), le verre, le pain. Pense à l'épaisseur et à la hauteur des aliments, pas seulement à la surface.
3. Donne les glucides pour 100 g de l'aliment tel qu'il est servi (cuit), puis glucides_g = poids_g × glucides_pour_100g ÷ 100.

Repères de glucides pour 100 g (aliments cuits, tels que servis) :
riz blanc 28 · pâtes 30 · couscous de blé 23 · frik ou chorba (soupe) 7 · pomme de terre vapeur 17 · frites 35 · purée 14 · lentilles 17 · pois chiches 20 · haricots blancs (loubia) 15 · petits pois 10 · carottes 6 · autres légumes cuits 3 à 6 · khobz / pain blanc 52 · baguette 55 · galette kesra / matlou 50 · msemen 45 · pain complet 45 · dattes 65 · banane 20 · pomme ou poire 12 · orange 9 · raisin 16 · pastèque ou melon 7 · lait 5 · yaourt nature 5 · yaourt sucré 14 · jus de fruit ou soda 10 à 11 (par 100 ml) · sucre 100 · miel 80 · gâteaux orientaux (makrout, baklava) 55 à 65 · viande, poisson, œufs, fromage, huile 0.

Règles :
- Compte les sauces épaissies, le pain, les boissons sucrées et les desserts visibles.
- Si une portion est incertaine, garde l'estimation la plus probable (ni maximale ni minimale) et signale l'incertitude dans "remarques".

Réponds uniquement avec ce JSON, sans texte autour :
{"aliments":[{"nom":"Couscous de blé cuit","portion":"environ 1 grande louche","poids_g":250,"glucides_pour_100g":23,"glucides_g":57.5}],"confiance":"faible|moyenne|élevée","remarques":"une ou deux phrases"}`;
const LANG_RULE = lang => lang==="ar" ? `\n\nLangue : écris "nom", "portion" et "remarques" en arabe algérien (darja), en écriture arabe, avec des mots simples que comprend un enfant. Garde les chiffres en chiffres occidentaux.` : "";
const PROMPT_PHOTO = note => `Tu assistes une personne diabétique de type 1 en insulinothérapie fonctionnelle. Analyse la photo de son repas pour estimer les glucides.

- Identifie chaque aliment ou boisson visible et estime la portion servie en grammes (ou ml) d'après la taille de l'assiette, des couverts et les proportions.
- Si l'image ne montre pas de nourriture, renvoie une liste vide et explique pourquoi dans "remarques".
${AI_RULES}${note ? `\n\nPrécisions données par la personne (prioritaires sur ce que tu vois) : ${note}` : ""}`;
const PROMPT_TEXT = desc => `Tu assistes une personne diabétique de type 1 en insulinothérapie fonctionnelle. Estime les glucides du repas qu'elle décrit.

- Décompose le repas en aliments et boissons. Quand une quantité n'est pas précisée, prends une portion adulte habituelle et indique-la dans "portion".
- Si la description ne correspond pas à un repas, renvoie une liste vide et explique pourquoi dans "remarques".
${AI_RULES}

Description du repas : ${desc}`;


async function gemini(model, key, parts){
  let r;
  try{
    r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
      method:"POST",
      headers:{ "content-type":"application/json", "x-goog-api-key":key },
      body: JSON.stringify({ contents:[{role:"user", parts}], generationConfig:{ temperature:0.2, maxOutputTokens:8192 } })
    });
  }catch(e){ throw {code:"upstream_error", message:"Gemini injoignable : " + String(e && e.message || e)}; }
  const data = await r.json().catch(()=>({}));
  if (!r.ok){
    const m = (data.error && (data.error.status ? data.error.status + " : " : "") + data.error.message) || ("HTTP " + r.status);
    const code = r.status===401 || /api key|API_KEY|UNAUTHENTICATED|ACCESS_TOKEN/i.test(m) ? "bad_key"
      : r.status===429 ? "quota" : r.status===404 ? "bad_model"
      : /location|region|country/i.test(m) ? "region" : r.status===403 ? "forbidden"
      : r.status===400 ? "image_rejected" : "upstream_error";
    throw {code, message:"HTTP " + r.status + ", modèle " + model + " : " + m};
  }
  const cand = (data.candidates||[])[0];
  if (!cand && data.promptFeedback && data.promptFeedback.blockReason) throw {code:"refused", message:data.promptFeedback.blockReason};
  const text = ((cand && cand.content && cand.content.parts) || []).filter(p=>!p.thought).map(p=>p.text||"").join("\n");
  if (!text) throw {code:"empty_completion", message:"modèle " + model + ", fin : " + ((cand && cand.finishReason) || "inconnue")};
  return {text, model};
}

function readKey(){
  try{ if (globalThis.Netlify && Netlify.env && Netlify.env.get("GEMINI_API_KEY")) return Netlify.env.get("GEMINI_API_KEY"); }catch(e){}
  return (typeof process !== "undefined" && process.env && process.env.GEMINI_API_KEY) || "";
}

async function handle(req){
  if (req.method !== "POST") return {ok:false, code:"bad_request", message:"POST attendu"};
  const key = readKey();
  if (!key) return {ok:false, code:"server_config", message:"Variable GEMINI_API_KEY absente sur Netlify"};
  // Refuse les appels venant d'autres sites (le service ne sert que cette application)
  const origin = req.headers.get("origin");
  if (origin){ try{ if (new URL(origin).host !== new URL(req.url).host) return {ok:false, code:"forbidden_origin", message:origin}; }catch(e){} }
  let b; try{ b = await req.json(); }catch(e){ return {ok:false, code:"bad_request", message:"JSON invalide"}; }
  const mode = b.mode, lang = b.lang==="ar" ? "ar" : "fr", text = String(b.text||"").slice(0,2000);
  const parts = [];
  if (mode==="photo" || mode==="test"){
    if (typeof b.image !== "string" || !b.image || b.image.length > MAX_IMAGE_B64) return {ok:false, code:"image_rejected", message:"image absente ou trop lourde"};
    const mime = ["image/jpeg","image/png","image/webp"].includes(b.mime) ? b.mime : "image/jpeg";
    parts.push({inline_data:{mime_type:mime, data:b.image}});
  }
  let prompt;
  if (mode==="photo") prompt = PROMPT_PHOTO(text) + LANG_RULE(lang);
  else if (mode==="texte"){ if (text.trim().length < 3) return {ok:false, code:"bad_request", message:"description vide"}; prompt = PROMPT_TEXT(text) + LANG_RULE(lang); }
  else if (mode==="test") prompt = "Décris cette image en 5 mots maximum.";
  else return {ok:false, code:"bad_request", message:"mode inconnu"};
  parts.push({text:prompt});
  let last = {code:"upstream_error", message:"aucun modèle disponible"};
  for (const m of MODELS){
    try{ const r = await gemini(m, key, parts); return {ok:true, text:r.text, model:r.model}; }
    catch(e){ last = e; if (!["bad_model","quota","empty_completion","upstream_error"].includes(e.code)) break; }
  }
  return {ok:false, code:last.code, message:last.message};
}

// Réponse en flux : des espaces sont envoyés en attendant Gemini, ce qui évite la coupure des fonctions trop longues.
export default async (req) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller){
      controller.enqueue(enc.encode(" "));
      const keep = setInterval(()=>{ try{ controller.enqueue(enc.encode(" ")); }catch(e){} }, 4000);
      let out;
      try{ out = await handle(req); }catch(e){ out = {ok:false, code:"upstream_error", message:String(e && e.message || e)}; }
      clearInterval(keep);
      controller.enqueue(enc.encode(JSON.stringify(out)));
      controller.close();
    }
  });
  return new Response(stream, {headers:{"content-type":"application/json; charset=utf-8", "cache-control":"no-store"}});
};

export const config = { path: "/api/estimer" };
