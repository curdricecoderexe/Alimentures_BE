const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const isStaff = require("../middlewares/isStaff");
const { chatLimiter } = require("../middlewares/rateLimiters");
const optionalAuth = require("../middlewares/optionalAuth");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// FAQ assistant: generous for real conversations, blocks scripted abuse.
const botLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, error: "You're asking very quickly — please wait a moment." },
});

// FAQ assistant — answers from live site data; no sign-in needed.
router.post("/bot", botLimiter, optionalAuth, chatController.botReply);

// Start a chat session (authenticated customer)
router.post("/init", verifyToken, chatLimiter, chatController.initChat);

// A customer's own tickets — lets the widget resume/track a chat after it's
// been closed and reopened, instead of losing it once the modal closes.
router.get("/my-chats", verifyToken, chatController.getMyChats);

// Get chat history — owner or staff only
router.get("/session/:chatId", verifyToken, chatController.getChatSession);

// Close — owner (customer) or staff/admin. Reopen — staff/admin only.
router.put("/:chatId/close", verifyToken, chatController.closeChat);
router.put("/:chatId/reopen", verifyToken, chatController.reopenChat);

// Admin: all chats
router.get("/admin/all", verifyToken, isAdmin, chatController.getAllChats);
router.delete("/admin/:chatId", verifyToken, isAdmin, chatController.deleteChat);

// Staff desk
router.get("/staff/pending", verifyToken, isStaff, chatController.getPendingChats);
router.post("/staff/accept/:chatId", verifyToken, isStaff, chatController.acceptChat);
router.get("/staff/active", verifyToken, isStaff, chatController.getMyActiveChats);

module.exports = router;
