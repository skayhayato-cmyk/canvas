require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const { scrapeInstagramDownload } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || null;

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiter: max 20 request/menit per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: "Too many requests. Coba lagi dalam 1 menit.",
      retry_after: 60,
    });
  },
});
app.use("/api/", limiter);

// ─── API Key Middleware (opsional) ───────────────────────────
function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // skip jika API_KEY tidak di-set
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ success: false, error: "API key tidak valid" });
  }
  next();
}

// ─── Helper: validasi URL Instagram ─────────────────────────
function isValidInstagramUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.instagram.com" ||
      u.hostname === "instagram.com" ||
      u.hostname === "instagr.am"
    );
  } catch {
    return false;
  }
}

// ─── Routes ──────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "Instagram Downloader API",
    version: "1.0.0",
    endpoints: {
      download: "POST /api/download",
      health: "GET /api/health",
    },
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "online",
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

/**
 * POST /api/download
 * Body: { "url": "https://www.instagram.com/p/xxxxx/" }
 * Header: x-api-key: YOUR_KEY  (jika API_KEY di-set)
 */
app.post("/api/download", authMiddleware, async (req, res) => {
  const requestId = uuidv4();
  const startTime = Date.now();

  const { url } = req.body;

  // Validasi input
  if (!url) {
    return res.status(400).json({
      success: false,
      request_id: requestId,
      error: "Field 'url' wajib diisi",
      example: { url: "https://www.instagram.com/p/CxxxxxXXXXX/" },
    });
  }

  if (!isValidInstagramUrl(url)) {
    return res.status(400).json({
      success: false,
      request_id: requestId,
      error: "URL tidak valid. Harus URL Instagram (instagram.com/...)",
    });
  }

  console.log(`[${requestId}] Scraping: ${url}`);

  try {
    const result = await scrapeInstagramDownload(url);
    const elapsed = Date.now() - startTime;

    if (!result.success) {
      return res.status(502).json({
        success: false,
        request_id: requestId,
        error: result.error || "Gagal mengambil data dari sumber",
        elapsed_ms: elapsed,
      });
    }

    return res.json({
      success: true,
      request_id: requestId,
      elapsed_ms: elapsed,
      data: result.data,
    });
  } catch (err) {
    console.error(`[${requestId}] Error:`, err.message);
    return res.status(500).json({
      success: false,
      request_id: requestId,
      error: "Internal server error",
      elapsed_ms: Date.now() - startTime,
    });
  }
});

// GET versi (query param ?url=...)
app.get("/api/download", authMiddleware, async (req, res) => {
  const requestId = uuidv4();
  const startTime = Date.now();
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      success: false,
      request_id: requestId,
      error: "Query param 'url' wajib diisi",
      example: "/api/download?url=https://www.instagram.com/p/CxxxxxXXXXX/",
    });
  }

  if (!isValidInstagramUrl(url)) {
    return res.status(400).json({
      success: false,
      request_id: requestId,
      error: "URL tidak valid. Harus URL Instagram",
    });
  }

  console.log(`[${requestId}] Scraping (GET): ${url}`);

  try {
    const result = await scrapeInstagramDownload(url);
    const elapsed = Date.now() - startTime;

    if (!result.success) {
      return res.status(502).json({
        success: false,
        request_id: requestId,
        error: result.error,
        elapsed_ms: elapsed,
      });
    }

    return res.json({
      success: true,
      request_id: requestId,
      elapsed_ms: elapsed,
      data: result.data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      request_id: requestId,
      error: "Internal server error",
      elapsed_ms: Date.now() - startTime,
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint tidak ditemukan" });
});

// ─── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Instagram Scraper API berjalan di port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY ? "Aktif" : "Nonaktif (terbuka)"}`);
});
