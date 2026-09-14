const express = require("express");
const router = express.Router();
const {
  createReview,
  updateReview,
  deleteReview,
  getProductReviews,
  getAdminReviews,
  getMyReviews,
  adminDeleteReview
} = require("../controllers/reviewController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { reviewLimiter } = require("../middlewares/rateLimiters");

// Public
router.get("/product/:productId", getProductReviews);

// Admin (view + spam removal — reviews go live immediately, no approval queue)
router.get("/admin", verifyToken, isAdmin, getAdminReviews);
router.delete("/admin/:id", verifyToken, isAdmin, adminDeleteReview);

// Customer
router.get("/mine", verifyToken, getMyReviews);
router.post("/", verifyToken, reviewLimiter, createReview);
router.put("/:id", verifyToken, reviewLimiter, updateReview);
router.delete("/:id", verifyToken, deleteReview);

module.exports = router;
