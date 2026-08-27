const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const isStaff = require("../middlewares/isStaff");
const { chatLimiter } = require("../middlewares/rateLimiters");

// Start a chat session (authenticated customer)
router.post("/init", verifyToken, chatLimiter, chatController.initChat);

// Get chat history — owner or staff only
router.get("/session/:chatId", verifyToken, chatController.getChatSession);

// Admin: all chats
router.get("/admin/all", verifyToken, isAdmin, chatController.getAllChats);

// Staff desk
router.get("/staff/pending", verifyToken, isStaff, chatController.getPendingChats);
router.post("/staff/accept/:chatId", verifyToken, isStaff, chatController.acceptChat);
router.get("/staff/active", verifyToken, isStaff, chatController.getMyActiveChats);

module.exports = router;
