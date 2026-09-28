// ============================================================
// qrCodeService.js — QR code generation for tickets
//
// Uses the `qrcode` npm package to generate QR codes as
// base64 data URLs. Each ticket gets a unique QR code
// encoding ticket details that can be scanned at the venue.
//
// The QR data is a JSON string containing:
//   { ticketId, eventId, seatId, section, row, seatNumber }
//
// The base64 data URL is stored directly in the tickets.qr_code
// column and rendered as an <img> in the frontend.
// ============================================================

const QRCode = require('qrcode');


// ============================================================
// generateQRCode(ticketData)
// ============================================================
// Takes ticket data object and returns a base64 data URL string
// that can be used directly in an <img src="..."> tag.
//
// Example output:
//   "data:image/png;base64,iVBORw0KGgoAAAANSUhE..."
// ============================================================
async function generateQRCode(ticketData) {
  const payload = JSON.stringify(ticketData);

  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: 'M', // Medium error correction
    margin: 2,
    width: 300,
    color: {
      dark: '#1e1b4b',  // Indigo-950 (matches our theme)
      light: '#ffffff',
    },
  });

  return dataUrl;
}


module.exports = { generateQRCode };
