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
  assignDeliveryPerson,
  acceptRejectDelivery,
  addOrderFeedback,
  getAllFeedbacks,
  cleanupExpiredReservations,
  cancelOrder,
  cancelOrderAdmin,
  refundOrder
} = require("../controllers/orderController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const isStaff = require("../middlewares/isStaff");
const isStaffOrDelivery = require("../middlewares/isStaffOrDelivery");
const { orderLimiter } = require("../middlewares/rateLimiters");
const cronOrAdmin = require("../middlewares/cronAuth");

// Razorpay
router.post("/razorpay/verify", verifyToken, orderLimiter, verifyRazorpay);
router.post("/razorpay/webhook", razorpayWebhook);

// Admin ops (also callable by the reservation-cleanup cron via X-Cron-Secret)
router.post("/cleanup-reservations", cronOrAdmin, cleanupExpiredReservations);

router.post("/", verifyToken, orderLimiter, createOrder);
router.get("/", verifyToken, isStaffOrDelivery, getOrders);
router.get("/user/:email", verifyToken, isStaffOrDelivery, getOrdersByEmail);
router.get("/my-orders", verifyToken, getMyOrders);
router.get("/all/feedbacks", verifyToken, isAdmin, getAllFeedbacks);
router.get("/:id", verifyToken, getOrderById);

// Fulfilment status (staff / delivery) — cancellation & refunds are separate.
router.put("/:id/status", verifyToken, isStaffOrDelivery, updateOrderStatus);

// Cancellation
router.put("/:id/cancel", verifyToken, cancelOrder);                    // customer, own order
router.post("/:id/cancel-admin", verifyToken, isAdmin, cancelOrderAdmin); // admin, any order

// Refund (admin only)
router.post("/:id/refund", verifyToken, isAdmin, refundOrder);

router.patch("/:id/assign", verifyToken, isStaff, assignDeliveryPerson);
router.put("/:id/accept-delivery", verifyToken, isStaffOrDelivery, acceptRejectDelivery);
router.post("/:id/feedback", verifyToken, addOrderFeedback);

module.exports = router;
