// Referência local do código do Cloudflare Worker luppus-mailer — não é publicado
// automaticamente. Cole isto no editor do Cloudflare (dash.cloudflare.com > Workers &
// Pages > luppus-mailer > Edit code) substituindo o conteúdo atual, e clique em Deploy.
//
// O que mudou em relação à versão anterior: em vez de checar uma senha fixa
// (X-App-Secret) que precisava ficar escrita no app.js — e por isso qualquer
// visitante do site conseguia ler — o worker agora verifica o próprio token de
// login do Firebase Auth que o usuário já usa pra entrar no LUPPUS. Ninguém sem
// login válido consegue mais chamar esse endpoint, e não existe mais segredo
// nenhum no lado do navegador.
const FIREBASE_PROJECT_ID = "luppus-painel-financeiro";
const FIREBASE_JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

function base64UrlToUint8Array(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(b64url)));
}

// Verifica assinatura, emissor, audiência e validade de um ID token do Firebase Auth.
// Lança erro se qualquer checagem falhar; retorna o payload (com uid em .sub) se válido.
async function verifyFirebaseIdToken(idToken) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed_token");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = base64UrlToJson(headerB64);
  const payload = base64UrlToJson(payloadB64);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("expired");
  if (typeof payload.iat !== "number" || payload.iat > now + 300) throw new Error("issued_in_future");
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("bad_audience");
  if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) throw new Error("bad_issuer");
  if (!payload.sub) throw new Error("no_subject");

  const jwkRes = await fetch(FIREBASE_JWK_URL);
  if (!jwkRes.ok) throw new Error("jwk_fetch_failed");
  const { keys } = await jwkRes.json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown_kid");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!valid) throw new Error("bad_signature");

  return payload;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://almirdd7-bot.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    const authHeader = request.headers.get("Authorization") || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    try {
      await verifyFirebaseIdToken(match[1]);
    } catch (err) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { to, type, companyName, data } = body;
    if (!to || !type) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let subject, html;
    if (type === "weekly_report") {
      subject = "LUPPUS — relatório semanal" + (companyName ? " de " + companyName : "");
      html = buildWeeklyReportHtml(companyName, data || {});
    } else if (type === "risk_alert") {
      subject = "LUPPUS — alerta: saldo projetado crítico";
      html = buildRiskAlertHtml(companyName, data || {});
    } else {
      return new Response(JSON.stringify({ error: "invalid_type" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "LUPPUS <onboarding@resend.dev>",
        to,
        subject,
        html
      })
    });

    const result = await resendRes.json();
    return new Response(JSON.stringify(result), {
      status: resendRes.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
};

function buildWeeklyReportHtml(companyName, data) {
  const label = companyName ? " — " + companyName : "";
  return '<div style="font-family: Arial, sans-serif; background:#070809; color:#F5F3ED; padding:32px;">' +
    '<h2 style="color:#D6B46A; letter-spacing:1px; margin:0;">LUPPUS</h2>' +
    '<p style="color:#8A8D89; font-size:11px; text-transform:uppercase; letter-spacing:2px; margin-top:4px;">find the signal</p>' +
    '<h3 style="margin-top:24px;">Relatório semanal' + label + '</h3>' +
    '<table style="width:100%; border-collapse:collapse; margin-top:16px;">' +
    '<tr><td style="padding:8px 0; color:#8A8D89;">Receita</td><td style="padding:8px 0; text-align:right; color:#39D477;">' + (data.receita || "R$ 0,00") + '</td></tr>' +
    '<tr><td style="padding:8px 0; color:#8A8D89;">Custos</td><td style="padding:8px 0; text-align:right; color:#F06C6C;">' + (data.custos || "R$ 0,00") + '</td></tr>' +
    '<tr><td style="padding:8px 0; color:#8A8D89;">Resultado líquido</td><td style="padding:8px 0; text-align:right;">' + (data.resultado || "R$ 0,00") + '</td></tr>' +
    '</table></div>';
}

function buildRiskAlertHtml(companyName, data) {
  const label = companyName ? " de " + companyName : "";
  return '<div style="font-family: Arial, sans-serif; background:#070809; color:#F5F3ED; padding:32px;">' +
    '<h2 style="color:#F06C6C; letter-spacing:1px; margin:0;">LUPPUS — ALERTA</h2>' +
    '<p style="margin-top:16px;">O saldo projetado' + label + ' está abaixo do limite configurado.</p>' +
    '<p style="font-size:24px; color:#F06C6C; margin-top:8px;">' + (data.saldo || "R$ 0,00") + '</p>' +
    '</div>';
}
