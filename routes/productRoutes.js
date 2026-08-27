const express = require("express");
const router = express.Router();

const {
  createProduct,
  getProducts,
  getLowStockProducts,
  getProductById,
  updateProduct,
  deleteProduct,
  updateProductStock,
  searchProducts
} = require("../controllers/productController");

const verifyToken = require("../middlewares/verifyToken");
const optionalAuth = require("../middlewares/optionalAuth");
const isAdmin = require("../middlewares/isAdmin");
const isStaff = require("../middlewares/isStaff");
const imageField = require("../middlewares/imageField");

const productImages = imageField(["image", "secondaryImage"]);

router.post("/", verifyToken, isAdmin, productImages, createProduct);
router.get("/low-stock", verifyToken, isStaff, getLowStockProducts);
router.get("/search", optionalAuth, searchProducts);
router.get("/", optionalAuth, getProducts);
router.get("/:id", optionalAuth, getProductById);
router.put("/:id", verifyToken, isStaff, productImages, updateProduct);
router.patch("/:id/stock", verifyToken, isStaff, updateProductStock);
router.delete("/:id", verifyToken, isAdmin, deleteProduct);

module.exports = router;
