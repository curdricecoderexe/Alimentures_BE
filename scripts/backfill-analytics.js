const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const admin = require('firebase-admin');

if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
      admin.initializeApp();
    }
}

const db = admin.firestore();
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isExecute = args.includes('--execute');

if (!isDryRun && !isExecute) {
    console.log("Usage: node backfill-analytics.js [--dry-run] [--execute]");
    console.log("--dry-run: Scan and calculate without writing");
    console.log("--execute: Perform writes to Firestore");
    process.exit(1);
}

async function backfill() {
    console.log(`Starting analytics backfill in ${isDryRun ? 'DRY-RUN' : 'EXECUTE'} mode...`);
    
    // We will build objects in memory
    const dailyMap = {};
    const monthlyMap = {};
    const globalMap = { revenue: 0, orderCount: 0, paidOrderCount: 0, unitsSold: 0, codRevenue: 0, razorpayRevenue: 0 };
    const productMap = {};

    let processedCount = 0;
    
    // Batch process orders
    const snapshot = await db.collection("orders").get();
    
    console.log(`Found ${snapshot.size} total orders...`);
    
    snapshot.docs.forEach(doc => {
        const oData = doc.data();
        // Only count valid orders for revenue
        if (oData.status === 'payment_pending' || oData.status === 'cancelled' || oData.status === 'refunded') {
            return;
        }

        const date = oData.createdAt && oData.createdAt.toDate ? oData.createdAt.toDate() : new Date();
        const tzOffset = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(date.getTime() + tzOffset);
        const dateStr = istDate.toISOString().split('T')[0];
        const monthStr = dateStr.slice(0, 7);

        const revenue = Number(oData.totalAmount) || 0;
        let unitsSold = 0;
        const items = oData.items || [];
        items.forEach(item => { unitsSold += (Number(item.quantity) || 0); });

        const isRazorpay = oData.customerInfo?.paymentMethod === 'razorpay';
        const isCOD = oData.customerInfo?.paymentMethod === 'cod';

        // Helper to init/add
        const addStats = (map, key) => {
            if (!map[key]) map[key] = { revenue: 0, orderCount: 0, paidOrderCount: 0, unitsSold: 0, codRevenue: 0, razorpayRevenue: 0 };
            map[key].revenue += revenue;
            map[key].orderCount += 1;
            map[key].paidOrderCount += 1;
            map[key].unitsSold += unitsSold;
            map[key].codRevenue += isCOD ? revenue : 0;
            map[key].razorpayRevenue += isRazorpay ? revenue : 0;
        };

        addStats(dailyMap, dateStr);
        addStats(monthlyMap, monthStr);
        
        // Global
        globalMap.revenue += revenue;
        globalMap.orderCount += 1;
        globalMap.paidOrderCount += 1;
        globalMap.unitsSold += unitsSold;
        globalMap.codRevenue += isCOD ? revenue : 0;
        globalMap.razorpayRevenue += isRazorpay ? revenue : 0;

        // Products
        items.forEach(item => {
            const pid = item.productId || 'unknown';
            if (!productMap[pid]) productMap[pid] = { name: item.name || item.title || 'Unknown', unitsSold: 0, revenue: 0, category: item.category || 'General' };
            productMap[pid].unitsSold += (Number(item.quantity) || 0);
            productMap[pid].revenue += ((Number(item.price) || 0) * (Number(item.quantity) || 0));
        });

        processedCount++;
    });

    console.log(`Processed ${processedCount} valid orders.`);
    
    if (isDryRun) {
        console.log("DRY RUN RESULTS:");
        console.log("Global Analytics:", globalMap);
        console.log(`Would create/update ${Object.keys(dailyMap).length} daily records.`);
        console.log(`Would create/update ${Object.keys(monthlyMap).length} monthly records.`);
        console.log(`Would create/update ${Object.keys(productMap).length} product records.`);
        console.log("Exiting without making changes.");
        return;
    }

    // Execute writes in batches
    console.log("Writing to Firestore...");
    let batch = db.batch();
    let opCount = 0;

    const commitBatch = async () => {
        if (opCount > 0) {
            await batch.commit();
            batch = db.batch();
            opCount = 0;
        }
    };

    // Global
    batch.set(db.collection('analytics_sales_global').doc('overview'), globalMap, { merge: true });
    opCount++;

    // Daily
    for (const [dateStr, stats] of Object.entries(dailyMap)) {
        batch.set(db.collection('analytics_sales_daily').doc(dateStr), stats, { merge: true });
        opCount++;
        if (opCount >= 400) await commitBatch();
    }

    // Monthly
    for (const [monthStr, stats] of Object.entries(monthlyMap)) {
        batch.set(db.collection('analytics_sales_monthly').doc(monthStr), stats, { merge: true });
        opCount++;
        if (opCount >= 400) await commitBatch();
    }

    // Products
    for (const [pid, stats] of Object.entries(productMap)) {
        batch.set(db.collection('analytics_products_lifetime').doc(pid), stats, { merge: true });
        opCount++;
        if (opCount >= 400) await commitBatch();
    }

    await commitBatch();

    console.log("SUCCESS! Analytics successfully backfilled.");
}

backfill().catch(console.error);
