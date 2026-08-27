const express = require("express");
const router = express.Router();
const {
  createSuperGrain,
  getSuperGrains,
  updateSuperGrain,
  deleteSuperGrain
} = require("../controllers/superGrainsController");

const verifyToken = require("../middlewares/verifyToken");
const isAdmin = require("../middlewares/isAdmin");
const { validate } = require("../middlewares/validate");
const imageField = require("../middlewares/imageField");

const bodyShape = (required) => ({
  body: {
    name: { type: 'string', trim: true, max: 120, required },
    local: { type: 'string', trim: true, max: 120, required },
    benefit: { type: 'string', trim: true, max: 2000, required },
    image: { type: 'string', max: 5_000_000, required },
  },
});

// Public read
router.get("/", getSuperGrains);

// Admin only
router.post("/", verifyToken, isAdmin, validate(bodyShape(true)), imageField(['image']), createSuperGrain);
router.put("/:id", verifyToken, isAdmin, validate(bodyShape(false)), imageField(['image']), updateSuperGrain);
router.delete("/:id", verifyToken, isAdmin, deleteSuperGrain);

module.exports = router;
