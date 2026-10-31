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
  searchProducts,
  getProductImage,
} = require("../controllers/productController");

const verifyToken = require("../middlewares/verifyToken");
const optionalAuth = require("../middlewares/optionalAuth");
const isStaff = require("../middlewares/isStaff");
const imageField = require("../middlewares/imageField");

const productImages = imageField(["image", "secondaryImage"]);

router.post("/", verifyToken, isStaff, productImages, createProduct);
router.get("/low-stock", verifyToken, isStaff, getLowStockProducts);
router.get("/search", optionalAuth, searchProducts);
router.get("/", optionalAuth, getProducts);
router.get("/:id/image/:slot", getProductImage); // public, long-cached product photos
router.get("/:id", optionalAuth, getProductById);
router.put("/:id", verifyToken, isStaff, productImages, updateProduct);
router.patch("/:id/stock", verifyToken, isStaff, updateProductStock);
router.delete("/:id", verifyToken, isStaff, deleteProduct);

module.exports = router;
