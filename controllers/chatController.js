const admin = require("firebase-admin");
const db = require("../config/firebase");
const chatAuth = require("../socket/chatAuth");
const log = require("../lib/logger");
const { LIMITS } = require("../config/constants");

const isStaffRole = (role) => role === "admin" || role === "staff";

const CHAT_HISTORY_LIMIT = 500;

// Per-socket token bucket for send_message: BUCKET_MAX burst, refills 1/sec.
const BUCKET_MAX = 10;
const BUCKET_REFILL_MS = 1000;
function takeToken(socket) {
  const now = Date.now();
  const b = socket.data.msgBucket || { tokens: BUCKET_MAX, last: now, strikes: 0 };
  const refill = Math.floor((now - b.last) / BUCKET_REFILL_MS);
  if (refill > 0) {
    b.tokens = Math.min(BUCKET_MAX, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens <= 0) {
    b.strikes = (b.strikes || 0) + 1;
    socket.data.msgBucket = b;
    return false;
  }
  b.tokens -= 1;
  b.strikes = 0;
  socket.data.msgBucket = b;
  return true;
}

/** Can this user act on this chat? Staff/admin: any chat. Customer: only their own. */
const canAccessChat = (user, chatData) => {
  if (!user) return false;
  if (isStaffRole(user.role)) return true;
  return !!chatData && chatData.ownerUid === user.uid;
};

// ─── Socket layer ─────────────────────────────────────────────────────────────
exports.chatSocket = (io) => {
  chatAuth(io); // rejects any connection without a valid Firebase token

  io.on("connection", (socket) => {
    const user = socket.user; // { uid, email, role, name? }
    const senderType = isStaffRole(user.role) ? "staff" : "user";

    socket.on("join_chat", async (chatId) => {
      try {
        if (!chatId || typeof chatId !== "string") return;
        const chatDoc = await db.collection("chats").doc(chatId).get();
        if (!chatDoc.exists || !canAccessChat(user, chatDoc.data())) {
          socket.emit("chat_error", { error: "Not authorised for this chat" });
          return;
        }
        socket.join(chatId);
      } catch (err) {
        log.error("socket.join_chat_failed", { uid: user.uid, err });
      }
    });

    socket.on("send_message", async (data) => {
      try {
        const chatId = data && typeof data.chatId === "string" ? data.chatId : null;
        let text = data && typeof data.text === "string" ? data.text.trim() : "";
        if (!chatId || !text) return;
        if (text.length > LIMITS.CHAT_MESSAGE_MAX_LEN) {
          text = text.slice(0, LIMITS.CHAT_MESSAGE_MAX_LEN);
        }

        if (!takeToken(socket)) {
          socket.emit("chat_error", { error: "You're sending messages too fast. Slow down." });
          if ((socket.data.msgBucket?.strikes || 0) > 20) {
            log.warn("socket.flood_disconnect", { uid: user.uid });
            socket.disconnect(true);
          }
          return;
        }

        const chatRef = db.collection("chats").doc(chatId);
        const chatDoc = await chatRef.get();
        if (!chatDoc.exists || !canAccessChat(user, chatDoc.data())) {
          socket.emit("chat_error", { error: "Not authorised for this chat" });
          return;
        }

        // Sender identity is ALWAYS derived from the verified socket user.
        const message = {
          senderId: user.uid,
          senderName: user.name || user.email || (senderType === "staff" ? "Support" : "You"),
          senderType,
          text,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        };

        await chatRef.collection("messages").add(message);
        await chatRef.update({ updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        io.to(chatId).emit("receive_message", {
          ...message,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.error("socket.send_message_failed", { uid: user.uid, err });
      }
    });

    socket.on("disconnect", () => {});
  });
};

// ─── REST layer ───────────────────────────────────────────────────────────────

// POST /api/chat/init  (auth required)
exports.initChat = async (req, res, next) => {
  try {
    const { type, productId } = req.body || {};
    const allowedTypes = ["general", "product", "order", "person"];

    const newChat = {
      ownerUid: req.user.uid,
      guestName: req.user.name || req.user.email || "Customer",
      guestEmail: req.user.email || null,
      type: allowedTypes.includes(type) ? type : "general",
      productId: typeof productId === "string" ? productId.slice(0, 200) : null,
      status: "pending",
      assignedTo: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("chats").add(newChat);
    return res.status(201).json({ success: true, chatId: docRef.id });
  } catch (err) {
    next(err);
  }
};

// GET /api/chat/session/:chatId  (owner or staff)
exports.getChatSession = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists) {
      return res.status(404).json({ success: false, error: "Chat not found" });
    }

    if (!canAccessChat(req.user, chatDoc.data())) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    // Most recent CHAT_HISTORY_LIMIT messages, returned oldest-first.
    const msgsSnapshot = await db
      .collection("chats").doc(chatId).collection("messages")
      .orderBy("timestamp", "desc")
      .limit(CHAT_HISTORY_LIMIT)
      .get();
    const messages = msgsSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .reverse();

    return res.status(200).json({
      success: true,
      data: chatDoc.data(),
      messages,
      truncated: msgsSnapshot.size === CHAT_HISTORY_LIMIT,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/chat/admin/all  (admin)
exports.getAllChats = async (req, res, next) => {
  try {
    const snapshot = await db.collection("chats").orderBy("createdAt", "desc").limit(200).get();
    const chats = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.status(200).json({ success: true, data: chats });
  } catch (err) {
    next(err);
  }
};

// GET /api/chat/staff/pending  (staff)
exports.getPendingChats = async (req, res, next) => {
  try {
    const snapshot = await db.collection("chats").where("status", "==", "pending").limit(200).get();
    const chats = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    chats.sort((a, b) => {
      const at = a.createdAt?._seconds || a.createdAt?.seconds || 0;
      const bt = b.createdAt?._seconds || b.createdAt?.seconds || 0;
      return bt - at;
    });
    return res.status(200).json({ success: true, data: chats });
  } catch (err) {
    next(err);
  }
};

// POST /api/chat/staff/accept/:chatId  (staff)
exports.acceptChat = async (req, res, next) => {
  try {
    const { chatId } = req.params;
    const staffId = req.user.uid;
    const chatRef = db.collection("chats").doc(chatId);

    const result = await db.runTransaction(async (t) => {
      const doc = await t.get(chatRef);
      if (!doc.exists) return { status: 404, body: { success: false, error: "Chat not found" } };
      if (doc.data().status !== "pending") {
        return { status: 400, body: { success: false, error: "Chat is already accepted by someone" } };
      }
      t.update(chatRef, {
        status: "active",
        assignedTo: staffId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { status: 200, body: { success: true, message: "Chat accepted" } };
    });

    return res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
};

// GET /api/chat/staff/active  (staff)
exports.getMyActiveChats = async (req, res, next) => {
  try {
    const staffId = req.user.uid;
    const snapshot = await db
      .collection("chats")
      .where("assignedTo", "==", staffId)
      .where("status", "==", "active")
      .limit(200)
      .get();

    const chats = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    chats.sort((a, b) => {
      const at = a.updatedAt?._seconds || a.updatedAt?.seconds || 0;
      const bt = b.updatedAt?._seconds || b.updatedAt?.seconds || 0;
      return bt - at;
    });
    return res.status(200).json({ success: true, data: chats });
  } catch (err) {
    next(err);
  }
};
