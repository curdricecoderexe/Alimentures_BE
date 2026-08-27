const db = require('../config/firebase');

exports.validateCart = async (req, res) => {
  try {
    const { items, couponCode } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'Invalid cart data' });
    }

    if (items.length === 0) {
      return res.json({
        success: true,
        valid: true,
        items: [],
        subtotal: 0,
        shipping: 0,
        discount: 0,
        finalAmount: 0,
        warnings: []
      });
    }

    let subtotal = 0;
    const validatedItems = [];
    const warnings = [];
    let isValid = true;

    // Fetch products in parallel or deduplicate
    const uniqueProductIds = [...new Set(items.map(item => item.productId))];
    const productMap = new Map();

    for (const productId of uniqueProductIds) {
      const productDoc = await db.collection('products').doc(productId).get();
      if (productDoc.exists) {
        productMap.set(productId, productDoc.data());
      }
    }

    for (const item of items) {
      // Basic quantity validation
      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        warnings.push({
          productId: item.productId,
          selectedWeight: item.selectedWeight,
          message: `Invalid quantity for ${item.name}. Must be between 1 and 50.`
        });
        isValid = false;
        continue;
      }

      const product = productMap.get(item.productId);
      
      if (!product) {
        warnings.push({
          productId: item.productId,
          selectedWeight: item.selectedWeight,
          message: `${item.name || 'Product'} is no longer available.`
        });
        isValid = false;
        continue;
      }
      
      // Check active status
      if (product.status === 'inactive' || product.active === false) {
        warnings.push({
          productId: item.productId,
          selectedWeight: item.selectedWeight,
          message: `${product.name} is currently inactive.`
        });
        isValid = false;
        continue;
      }

      const variants = product.variants || [];
      let variantIndex = variants.findIndex(v => v.weight === item.selectedWeight);
      if (variantIndex === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight)) {
        if (variants.length > 0) variantIndex = 0;
      }

      if (variantIndex === -1) {
        warnings.push({
          productId: item.productId,
          selectedWeight: item.selectedWeight,
          message: `Variant "${item.selectedWeight || 'Default'}" not found for ${product.name}.`
        });
        isValid = false;
        continue;
      }

      const variant = variants[variantIndex];
      const stock = Number(variant.stock) || 0;
      
      if (stock < qty) {
        warnings.push({
          productId: item.productId,
          selectedWeight: item.selectedWeight,
          message: `Only ${stock} available for ${product.name} (${variant.weight}).`,
          availableStock: stock
        });
        isValid = false;
      }

      const authoritativePrice = Number(variant.price || product.price || 0);
      
      // Check for price changes (informational warning)
      if (item.price && authoritativePrice !== Number(item.price)) {
        warnings.push({
          productId: item.productId,
          selectedWeight: item.selectedWeight,
          message: `Price updated for ${product.name} from ₹${item.price} to ₹${authoritativePrice}.`
        });
        // We do not set isValid = false here, the price just updates gracefully.
      }

      subtotal += authoritativePrice * qty;

      validatedItems.push({
        ...item,
        name: product.name,
        price: authoritativePrice,
        image: product.image || item.image,
        category: product.category,
        stock: stock
      });
    }

    // Shipping calculation
    const shipping = subtotal > 500 || subtotal === 0 ? 0 : 50;

    // Coupon validation
    let discountAmount = 0;
    if (couponCode && isValid) {
      const couponSnapshot = await db.collection("coupons").where("code", "==", couponCode.toUpperCase().trim()).get();
      if (!couponSnapshot.empty) {
        const couponDoc = couponSnapshot.docs[0];
        const coupon = { id: couponDoc.id, ...couponDoc.data() };
        
        const isExpired = coupon.expiresAt && new Date(coupon.expiresAt.toDate ? coupon.expiresAt.toDate() : coupon.expiresAt) < new Date();
        const usageLimitReached = coupon.usedCount >= coupon.maxUsage;
        const meetsMinOrder = subtotal >= (coupon.minOrderValue || 0);
        
        if (!coupon.isActive) {
          warnings.push({ type: 'coupon', message: `Coupon is not active.` });
        } else if (isExpired) {
          warnings.push({ type: 'coupon', message: `Coupon has expired.` });
        } else if (usageLimitReached) {
          warnings.push({ type: 'coupon', message: `Coupon usage limit reached.` });
        } else if (!meetsMinOrder) {
          warnings.push({ type: 'coupon', message: `Minimum order value of ₹${coupon.minOrderValue} required for this coupon.` });
        } else {
           if (coupon.discountType === "percentage") {
              discountAmount = Math.round((subtotal * coupon.discountValue) / 100);
           } else {
              discountAmount = Math.min(coupon.discountValue, subtotal);
           }
        }
      } else {
        warnings.push({ type: 'coupon', message: `Invalid coupon code.` });
      }
    }

    const finalAmount = Math.max(0, subtotal + shipping - discountAmount);

    return res.status(200).json({
      success: true,
      valid: isValid,
      items: validatedItems,
      subtotal,
      shipping,
      discount: discountAmount,
      finalAmount,
      warnings
    });
  } catch (err) {
    console.error("Cart validation error:", err);
    return res.status(500).json({ success: false, error: 'Internal server error during validation' });
  }
};
