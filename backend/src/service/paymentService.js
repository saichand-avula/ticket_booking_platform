// ============================================================
// paymentService.js — Simple mock payment service
//
// Razorpay has been removed. Payment is confirmed directly
// when the user clicks "Payment Done" on the frontend.
//
// createMockPaymentOrder() — generates a mock order reference
// verifyPayment()          — always returns true (no signature)
// ============================================================

// createMockPaymentOrder(orderId, amount)
// Returns a simple mock payment reference for the frontend.
async function createMockPaymentOrder(orderId, amount) {
  return {
    paymentOrderId: `pay_order_${orderId}_${Date.now()}`,
    amount: amount,
    currency: 'INR',
    mock: true,
  };
}

// verifyPayment()
// No real payment gateway — always valid.
function verifyPayment() {
  return true;
}

module.exports = { createMockPaymentOrder, verifyPayment };
