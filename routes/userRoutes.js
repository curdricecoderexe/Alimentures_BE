const express = require("express");
const router = express.Router();
const {
  createUser,
  loginUser,
  getUsers,
  getUser,
  updateUser,
  softDeleteUser,
  deleteUser,
  requestPasswordResetOtp,
  resetPasswordWithOtp,
  sendRegisterOtp,
  toggleUserStatus,
  getDeliveryPersons,
  setUserRole,
  logoutUser
} = require("../controllers/userController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const isStaff = require("../middlewares/isStaff");
const { authLimiter, otpLimiter } = require("../middlewares/rateLimiters");

// PUBLIC
router.post("/send-otp", otpLimiter, sendRegisterOtp);
router.post("/register", otpLimiter, createUser);
router.post("/login", authLimiter, loginUser);
router.post("/request-reset", otpLimiter, requestPasswordResetOtp);
router.post("/reset-password", otpLimiter, resetPasswordWithOtp);

// PROTECTED
router.post("/logout", verifyToken, logoutUser);
router.get("/", verifyToken, isAdmin, getUsers);
router.get("/delivery", verifyToken, isStaff, getDeliveryPersons);
router.get("/:uid", verifyToken, getUser);
router.put("/:uid", verifyToken, updateUser);

// ADMIN ONLY
router.patch("/toggle-status/:uid", verifyToken, isAdmin, toggleUserStatus);
router.patch("/:uid/role", verifyToken, isAdmin, setUserRole);
router.put("/:uid/role", verifyToken, isAdmin, setUserRole); // FE compat
router.post("/admin-create", verifyToken, isAdmin, createUser);
router.patch("/soft-delete/:uid", verifyToken, isAdmin, softDeleteUser);
router.delete("/:uid", verifyToken, isAdmin, deleteUser);

module.exports = router;