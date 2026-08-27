const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const http = require('http');
const { Server } = require('socket.io');

const log = require('./lib/logger');
const { LIMITS } = require('./config/constants');
const { notFound, errorHandler } = require('./middlewares/errorHandler');

// ─── 1. ENVIRONMENT ───────────────────────────────────────────────────────────
// NODE_ENV is informational only — the security controls below do NOT depend on
// it — but it decides which env vars are mandatory.
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

const requiredEnvs = [
  "PORT",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_WEB_API_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
];
// Fail closed on these only in production (local dev has safe fallbacks).
const prodRequiredEnvs = [
  "CORS_ORIGIN",
  "OTP_PEPPER",
  "RESERVATION_CLEANUP_SECRET",
];
const missingEnvs = [
  ...requiredEnvs,
  ...(IS_PROD ? prodRequiredEnvs : []),
].filter((env) => !process.env[env]);
if (missingEnvs.length > 0) {
  log.error('boot.missing_env', { missing: missingEnvs, env: process.env.NODE_ENV });
  process.exit(1);
}

// Number of proxy hops in front of the app, so req.ip / rate-limit keys resolve
// to the real client IP. 1 = a single nginx (or Render). 2 = Cloudflare -> nginx.
// Set TRUST_PROXY_HOPS to match your edge. Never leave this higher than reality:
// an over-count lets a client spoof X-Forwarded-For and bypass rate limits.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);

// ─── 2. SECURITY HEADERS ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://checkout.razorpay.com"],
      frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
    },
  },
}));

// ─── 3. REQUEST ID (server-generated only — inbound header is ignored) ─────────
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ─── 4. ACCESS LOG ────────────────────────────────────────────────────────────
if (process.env.LOG_LEVEL !== 'silent') {
  morgan.token('id', (req) => req.id);
  app.use(morgan(':id :method :url :status :res[content-length] - :response-time ms', {
    stream: { write: (line) => process.stdout.write(line) },
  }));
}

// ─── 5. CORS (fail closed against an explicit allow-list, every environment) ───
// IMPORTANT: set CORS_ORIGIN in the deployment env. The fallback below is a
// best-effort guess and may not match the real production frontend domain.
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:3000'];
const PROD_ORIGINS = [
  'https://alimenture.netlify.app',
  'https://alimenture.com',
  'https://www.alimenture.com',
];
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : (IS_PROD ? PROD_ORIGINS : [...DEV_ORIGINS, ...PROD_ORIGINS]);

if (IS_PROD && !process.env.CORS_ORIGIN) {
  log.warn('cors.no_explicit_origin', { using: allowedOrigins });
}

const corsOptions = {
  origin(origin, callback) {
    // Non-browser clients (curl, server-to-server, health checks) send no Origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ─── 6. BODY PARSING ──────────────────────────────────────────────────────────
// The Razorpay webhook MUST see the raw bytes for HMAC verification — mount it
// before any JSON parser.
app.use('/api/orders/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }));

// Routes that legitimately carry inline base64 images (catalogue media, cart
// item thumbnails, delivery proof-of-delivery photos). The first parser to
// populate req.body wins.
const largeJson = express.json({ limit: LIMITS.JSON_BODY_WITH_IMAGE });
['/api/products', '/api/super-grains', '/api/hero-slides', '/api/settings', '/api/orders']
  .forEach((p) => app.use(p, largeJson));

app.use(express.json({ limit: LIMITS.JSON_BODY }));
app.use(express.urlencoded({ extended: true, limit: LIMITS.JSON_BODY }));

// ─── 7. RATE LIMITING ─────────────────────────────────────────────────────────
// A generous catch-all; the tight per-route limiters (middlewares/rateLimiters.js)
// are the real control on sensitive endpoints.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.GLOBAL_RATE_MAX) || 1000,
  message: { success: false, error: "Too many requests from this IP, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", globalLimiter);

// ─── 8. ROUTES ────────────────────────────────────────────────────────────────
const productRoutes = require("./routes/productRoutes");
const userRoutes = require("./routes/userRoutes");
const orderRoutes = require("./routes/orderRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const chatRoutes = require("./routes/chatRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const superGrainsRoutes = require("./routes/superGrainsRoutes");
const heroSlideRoutes = require("./routes/heroSlideRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const couponRoutes = require("./routes/couponRoutes");
const addressRoutes = require("./routes/addressRoutes");
const wishlistRoutes = require("./routes/wishlistRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const cartRoutes = require("./routes/cartRoutes");
const clientErrorRoutes = require("./routes/clientErrorRoutes");

app.use("/api/users", userRoutes);
app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/super-grains", superGrainsRoutes);
app.use("/api/hero-slides", heroSlideRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/addresses", addressRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/client-errors", clientErrorRoutes);

// ─── 9. HEALTH ────────────────────────────────────────────────────────────────
const db = require('./config/firebase');
app.get("/health", async (req, res) => {
  try {
    // Cheap Firestore round-trip so a DB outage doesn't look healthy.
    await db.collection('_health').doc('ping').get();
    return res.status(200).json({ status: "ok", service: "alimentures-api", db: "ok" });
  } catch {
    return res.status(503).json({ status: "degraded", service: "alimentures-api", db: "unreachable" });
  }
});
app.get("/", (req, res) => res.json({ message: "Server Working!!", success: true }));

// ─── 10. ERROR HANDLING (must be last) ────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── 11. SERVER + SOCKET.IO ───────────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
});

const { chatSocket } = require("./controllers/chatController");
chatSocket(io); // installs the token-required handshake middleware

// ─── 12. PROCESS SAFETY NETS ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  log.error('process.unhandled_rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on('uncaughtException', (err) => {
  log.error('process.uncaught_exception', { err });
  // An uncaught exception leaves the process in an undefined state — exit and let Render restart.
  shutdown(1);
});

// ─── 13. GRACEFUL SHUTDOWN ────────────────────────────────────────────────────
function shutdown(code = 0) {
  log.info('server.shutdown', { code });
  server.close(() => {
    log.info('server.closed');
    process.exit(code);
  });
  setTimeout(() => {
    log.error('server.force_shutdown');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Only bind a port when run directly (`node index.js`); stay importable for tests.
if (require.main === module) {
  server.listen(PORT, () => {
    log.info('server.listening', { port: PORT, env: process.env.NODE_ENV, origins: allowedOrigins });
  });
}

module.exports = app;
module.exports.httpServer = server;
