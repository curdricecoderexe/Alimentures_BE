const express = require("express");
const router = express.Router();

const {
  generateCoupon,
  getAllCoupons,
  deleteCoupon,
  toggleCoupon,
  validateCoupon,
} = require("../controllers/couponController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { couponLimiter } = require("../middlewares/rateLimiters");

// Admin routes
router.post("/generate", verifyToken, isAdmin, generateCoupon);
router.get("/", verifyToken, isAdmin, getAllCoupons);
router.delete("/:id", verifyToken, isAdmin, deleteCoupon);
router.patch("/:id/toggle", verifyToken, isAdmin, toggleCoupon);

// Customer preview — rate-limited to prevent code brute-forcing
router.post("/validate", verifyToken, couponLimiter, validateCoupon);

module.exports = router;
