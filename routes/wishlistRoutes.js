const express = require("express");
const router = express.Router();
const {
  getWishlist,
  addWishlist,
  removeWishlist
} = require("../controllers/wishlistController");

const verifyToken = require("../middlewares/verifyToken");

router.use(verifyToken);

router.get("/", getWishlist);
router.post("/", addWishlist);
router.delete("/:id", removeWishlist);

module.exports = router;
