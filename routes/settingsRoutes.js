const express = require("express");
const router = express.Router();
const settingsController = require("../controllers/settingsController");
const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const imageField = require("../middlewares/imageField");
const { validate } = require("../middlewares/validate");

// Public
router.get("/", settingsController.getSettings);

// Admin only
router.post("/", verifyToken, isAdmin, imageField(["newArrivalPoster"]), settingsController.updateSettings);
router.put("/social", verifyToken, isAdmin, settingsController.updateSocialLinks);
router.put("/hampers", verifyToken, isAdmin, settingsController.updateHampersVisibility);
router.put("/commitment", verifyToken, isAdmin, validate({
  body: {
    eyebrow: { type: "string", trim: true, max: 40 },
    headline: { type: "string", trim: true, max: 140, required: true },
    highlight: { type: "string", trim: true, max: 60 },
    pledges: { type: "array", maxItems: 3, of: { type: "string", trim: true, max: 60 } },
    ctaLabel: { type: "string", trim: true, max: 30 },
    // internal links only (e.g. /shop, /hampers)
    ctaLink: { type: "string", trim: true, max: 100, pattern: /^\/(?!\/)[A-Za-z0-9\-._~/?#=&%]*$/ },
  },
}), settingsController.updateCommitment);

module.exports = router;
