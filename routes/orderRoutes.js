const express = require("express");
const router = express.Router();

const {
  getOrders,
  getOrderById,
  createOrder,
  verifyRazorpay,
  razorpayWebhook,
  updateOrderStatus,
  getOrdersByEmail,
  getMyOrders,
  cleanupExpiredReservations,
  abandonPayment,
  refundOrder
} = require("../controllers/orderController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const isStaff = require("../middlewares/isStaff");
const { orderLimiter } = require("../middlewares/rateLimiters");
const cronOrAdmin = require("../middlewares/cronAuth");

// Razorpay
router.post("/razorpay/verify", verifyToken, orderLimiter, verifyRazorpay);
router.post("/razorpay/webhook", razorpayWebhook);

// Admin ops (also callable by the reservation-cleanup cron via X-Cron-Secret)
router.post("/cleanup-reservations", cronOrAdmin, cleanupExpiredReservations);

router.post("/", verifyToken, orderLimiter, createOrder);
router.get("/", verifyToken, isStaff, getOrders);
router.get("/user/:email", verifyToken, isStaff, getOrdersByEmail);
router.get("/my-orders", verifyToken, getMyOrders);
router.get("/:id", verifyToken, getOrderById);

// Fulfilment status (staff) — refunds are separate. Orders cannot
// be cancelled once placed — see abandon-payment below for the one exception.
router.put("/:id/status", verifyToken, isStaff, updateOrderStatus);

// Releases the stock reservation for an order that never got past payment
// (still `payment_pending`) — not a general cancellation route.
router.put("/:id/abandon-payment", verifyToken, abandonPayment);

// Refund (admin only)
router.post("/:id/refund", verifyToken, isAdmin, refundOrder);

module.exports = router;
