const express = require("express");
const router = express.Router();
const settingsController = require("../controllers/settingsController");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const imageField = require("../middlewares/imageField");

// Public
router.get("/", settingsController.getSettings);

// Admin only
router.post("/", verifyToken, isAdmin, imageField(["newArrivalPoster"]), settingsController.updateSettings);

module.exports = router;
