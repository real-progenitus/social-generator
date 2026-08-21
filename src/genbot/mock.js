import crypto from "node:crypto";
import sharp from "sharp";

// MOCK_MODE placeholder generator — the repo's established stand-in for a
// test suite (see mockCover() in src/steps/generateCover.js, which does the
// same thing with an inline SVG). Rasterized to PNG rather than left as SVG
// because Telegram's sendPhoto rejects SVG; sharp is already a dependency.
//
// The image is derived from the prompt + agent, so tapping two different
// agents on the same prompt visibly produces two different pictures — which
// is what you need to see to trust the routing is working.
export async function mockImage({ prompt, label }) {
  const hash = crypto.createHash("sha256").update(`${label}:${prompt}`).digest();
  const hue = hash[0] * 360 / 256;
  const hue2 = (hue + 40 + hash[1] / 4) % 360;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue.toFixed(0)}, 62%, 22%)"/>
      <stop offset="1" stop-color="hsl(${hue2.toFixed(0)}, 58%, 48%)"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  ${Array.from({ length: 18 }, (_, i) => {
    const r = 40 + (hash[(i + 2) % hash.length] / 255) * 300;
    const cx = (hash[(i + 5) % hash.length] / 255) * 1024;
    const cy = (hash[(i + 11) % hash.length] / 255) * 1024;
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.18"/>`;
  }).join("\n  ")}
  <text x="512" y="500" font-family="Helvetica, Arial, sans-serif" font-size="46" font-weight="bold"
        fill="#ffffff" text-anchor="middle">MOCK · ${escapeXml(label)}</text>
  <text x="512" y="560" font-family="Helvetica, Arial, sans-serif" font-size="28"
        fill="#ffffff" opacity="0.8" text-anchor="middle">${escapeXml(prompt.slice(0, 60))}</text>
</svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { b64: png.toString("base64"), mime: "image/png" };
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c],
  );
}
