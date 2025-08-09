// server.js
// TweetJuice minimal backend (Render-ready)
// - Serves /public (your index.html)
// - OpenAI-only endpoints: /api/rewrite, /api/punchline
// - Safe mock responses if OPENAI_API_KEY missing

const path = require("path");
const fs = require("fs");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const dotenv = require("dotenv");
const rateLimit = require("express-rate-limit");

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // adjust if you like

const app = express();

/* ------------------------------ Security/CORS ------------------------------ */
app.use(
  helmet({
    contentSecurityPolicy: false, // keep off unless you add nonces/hashes in HTML
  })
);
app.use(
  cors({
    origin: true, // tighten to your domain(s) if desired
    credentials: false,
  })
);
app.use(express.json({ limit: "512kb" }));

/* -------------------------------- Utilities ------------------------------- */
function clamp(text = "", max = 280) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
function lowercaseHookVersion(text) {
  const hook = "you’re missing this — ";
  const body = String(text).toLowerCase().replace(/^[\s-–—]+/, "");
  return clamp(hook + body);
}

async function callOpenAIChat(messages, { temperature = 0.7, max_tokens = 220 } = {}) {
  if (!OPENAI_API_KEY) return null; // signal to mock
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature, max_tokens }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

/* -------------------------------- Rate limits ------------------------------ */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 req/min/IP
  standardHeaders: true,
  legacyHeaders: false,
});

/* ------------------------------- Static files ------------------------------ */
const publicDir = path.join(process.cwd(), "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
if (!fs.existsSync(path.join(publicDir, "index.html"))) {
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>TweetJuice</title><h1>TweetJuice</h1><p>Place your index.html in /public.</p>`
  );
}
app.use(express.static(publicDir, { maxAge: "1h", index: "index.html" }));

/* --------------------------------- Healthz --------------------------------- */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* --------------------------------- Rewrite --------------------------------- */
// body: { text, preset?, keepTone?, lowercaseHook? }
app.post("/api/rewrite", aiLimiter, async (req, res) => {
  try {
    let { text, preset, keepTone, lowercaseHook } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    text = clamp(text, 560); // allow longer input; output clamps to 280

    // Mock if no key
    if (!OPENAI_API_KEY) {
      const after = lowercaseHook ? lowercaseHookVersion(text) : clamp(`we tightened this up: ${text}`);
      return res.json({
        before: clamp(text),
        after,
        rationale: "mock: tightened phrasing, front‑loaded value, reduced fluff.",
        mock: true,
      });
    }

    const system =
      "You are a writing assistant for short social posts (X/Twitter). Be brief, punchy, and clear. Keep the author's intent. Target 220–260 characters, hard limit 280. Avoid emojis unless present or explicitly requested.";
    const user = [
      `Original: ${text}`,
      `Preset: ${preset || "none"}`,
      `KeepTone: ${!!keepTone}`,
      `LowercaseHook: ${!!lowercaseHook}`,
      "Return JSON only with keys { after, rationale }.",
      lowercaseHook
        ? "The 'after' MUST be all lowercase and start with a short hook that draws the reader in."
        : "The 'after' should improve clarity, punch, and flow.",
    ].join("\n");

    const content = await callOpenAIChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.7, max_tokens: 300 }
    );

    let after = "";
    let rationale = "";
    if (content) {
      try {
        const parsed = JSON.parse(content);
        after = clamp(parsed.after || "");
        rationale = parsed.rationale || "";
      } catch {
        // Non‑JSON fallback
        after = clamp(String(content));
        rationale = "model returned non‑JSON, coerced to text";
      }
    }
    if (!after) after = lowercaseHook ? lowercaseHookVersion(text) : clamp(text);

    res.json({ before: clamp(text), after, rationale });
  } catch (err) {
    console.error("rewrite error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

/* -------------------------------- Punchline -------------------------------- */
// body: { text, vibe? = "witty" }
app.post("/api/punchline", aiLimiter, async (req, res) => {
  try {
    const { text, vibe } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }

    // Mock if no key
    if (!OPENAI_API_KEY) {
      const bank = {
        witty: [
          "because boring posts don’t spread",
          "hot take you’ll actually use",
          "proof inside — receipts included",
          "read this before you ship",
        ],
        direct: [
          "save this and fix it today",
          "steal this, execute, win",
          "copy this and go faster",
          "no fluff, just the play",
        ],
        friendly: [
          "here’s the shortcut we missed",
          "learned this the hard way",
          "sharing so you don’t struggle",
          "bookmark for your next launch",
        ],
      };
      const picks = bank[vibe] || bank.witty;
      const punchline = picks[Math.floor(Math.random() * picks.length)];
      return res.json({ punchline, mock: true });
    }

    const system =
      "You craft sharp, clean closers and hooks for X posts. Keep it 4–12 words. Avoid hashtags unless present in input.";
    const user = [
      `Text: ${text}`,
      `Vibe: ${vibe || "witty"}`,
      "Return JSON: { punchline: string }",
    ].join("\n");

    const content = await callOpenAIChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.8, max_tokens: 120 }
    );

    let punchline = "";
    if (content) {
      try {
        const parsed = JSON.parse(content);
        punchline = String(parsed.punchline || "").trim();
      } catch {
        punchline = String(content).trim();
      }
    }
    punchline = punchline.replace(/\s+/g, " ").trim();
    if (!punchline) punchline = "save this for later";

    res.json({ punchline });
  } catch (err) {
    console.error("punchline error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

/* --------------------------------- Start ---------------------------------- */
app.listen(PORT, () => {
  console.log(`✅ TweetJuice server listening on http://localhost:${PORT}`);
  console.log(
    OPENAI_API_KEY
      ? "🔐 OpenAI key detected: AI endpoints live."
      : "⚠️ No OPENAI_API_KEY set: endpoints will return mock data."
  );
});
