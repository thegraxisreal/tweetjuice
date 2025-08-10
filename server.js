// server.js (ESM)
// TweetJuice minimal backend (Render-ready, ESM)
// - Serves /public (your index.html)
// - OpenAI-only endpoints: /api/rewrite, /api/punchline
// - Safe mock responses if OPENAI_API_KEY missing

import path from "path";
import fs from "fs";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano"; // enforce model

const app = express();
// Behind Render's proxy; needed for accurate client IPs and rate limiting
app.set("trust proxy", 1);

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

async function callOpenAIChat(messages, { max_tokens = 220 } = {}) {
  if (!OPENAI_API_KEY) return null; // signal to mock
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, max_completion_tokens: max_tokens }),
  });
  if (!res.ok) {
    let txt = "";
    try{ txt = await res.text(); }catch{}
    // Include body we sent for easier debugging in logs
    console.error("openai request failed", { status: res.status, body: { model: OPENAI_MODEL, max_completion_tokens: max_tokens } });
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
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
if (!fs.existsSync(path.join(publicDir, "index.html"))) {
  fs.writeFileSync(
    path.join(publicDir, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>TweetJuice</title><h1>TweetJuice</h1><p>Place your index.html in /public.</p>`
  );
}
app.use(
  express.static(publicDir, {
    maxAge: "1h",
    index: "index.html",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

/* --------------------------------- Healthz --------------------------------- */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* --------------------------------- Rewrite --------------------------------- */
// body: { text, preset?, keepTone?, lowercaseHook? }
app.post("/api/rewrite", aiLimiter, async (req, res) => {
  try {
    let { text, mode, lowercase, customNote } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }
    text = clamp(text, 560); // allow longer input; output clamps to 280

    const effectiveMode = ["hook", "rephrase", "custom"].includes(mode) ? mode : "rephrase";
    const isLower = !!lowercase;

    // Mock if no key
    if (!OPENAI_API_KEY) {
      let after = clamp(text);
      if (effectiveMode === "hook") {
        after = clamp((isLower ? lowercaseHookVersion(text) : `Hot take: ${text}`));
      } else if (effectiveMode === "rephrase") {
        after = clamp(`we tightened this up: ${text}`);
      } else if (effectiveMode === "custom") {
        after = clamp(`${customNote ? customNote + ": " : ""}${text}`);
      }
      if (isLower) after = String(after).toLowerCase();
      return res.json({ after, mock: true });
    }

    const rules = [
      "You are a writing assistant for short social posts (X/Twitter).",
      "Output only the tweet text. No preamble, no explanations.",
      "Hard limit 280 characters. Target 220–260 when possible.",
      "Avoid emojis unless present or explicitly requested.",
      isLower ? "Respond entirely in lowercase." : "Use natural sentence case.",
    ];

    let instruction = "";
    if (effectiveMode === "hook") {
      instruction = isLower
        ? "Add a short lowercase hook at the start that draws the reader in, then the tweet."
        : "Add a short hook at the start that draws the reader in, then the tweet.";
    } else if (effectiveMode === "rephrase") {
      instruction = "Rewrite to improve clarity, punch, and flow; preserve original intent.";
    } else {
      instruction = `Follow this note: ${customNote || ""}`;
    }

    const system = rules.join(" \n");
    const user = [
      `Original: ${text}`,
      `Mode: ${effectiveMode}`,
      `Lowercase: ${isLower}`,
      instruction,
      "Return JSON only: { after: string }",
    ].join("\n");

    const content = await callOpenAIChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { max_tokens: 300 }
    );

    let after = "";
    if (content) {
      try {
        const parsed = JSON.parse(content);
        after = clamp(parsed.after || "");
      } catch {
        after = clamp(String(content));
      }
    }
    if (!after) after = clamp(text);
    res.json({ after });
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

/* ------------------------------- Compose Tweet ------------------------------ */
// body: { topic: string, lowercase?: boolean }
app.post("/api/compose", aiLimiter, async (req, res) => {
  try {
    const { topic, lowercase } = req.body || {};
    if (!topic || typeof topic !== "string") {
      return res.status(400).json({ error: "topic is required" });
    }

    if (!OPENAI_API_KEY) {
      let after = `quick take: ${topic} — here's what matters most`;
      if (lowercase) after = after.toLowerCase();
      return res.json({ after: clamp(after), mock: true });
    }

    const system = [
      "You write short social posts (X/Twitter) on request.",
      "Output only the tweet text. No preamble, no explanations.",
      "Hard limit 280 characters; target 220–260.",
      lowercase ? "Respond entirely in lowercase." : "Use natural sentence case.",
    ].join(" \n");
    const user = [
      `Topic: ${topic}`,
      "Return JSON only: { after: string }",
    ].join("\n");

    const content = await callOpenAIChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { max_tokens: 300 }
    );

    let after = "";
    if (content) {
      try {
        const parsed = JSON.parse(content);
        after = clamp(parsed.after || "");
      } catch {
        after = clamp(String(content));
      }
    }
    if (!after) after = clamp(topic);
    res.json({ after });
  } catch (err) {
    console.error("compose error:", err);
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