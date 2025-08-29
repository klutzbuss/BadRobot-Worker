/**
 * BadRobot worker - Nano Banana patch-regeneration
 */
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const sharp = require("sharp");
const Jimp = require("jimp");
const { GoogleGenerativeAI } = require("@google/generative-ai");


const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }
});

function pick(req, names) {
  for (const f of (req.files || [])) {
    if (names.some(n => f.fieldname === n || f.fieldname.startsWith(n + "_"))) return f;
  }
  return null;
}
function b64(bytes) { return Buffer.from(bytes).toString("base64"); }

async function maskBBox(maskJimp) {
  const { width, height, data } = maskJimp.bitmap;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const v = Math.max(data[idx], data[idx + 1], data[idx + 2]);
      if (v > 128) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
async function feather(mask, radius = 4) {
  const blurred = mask.clone().gaussian(radius);
  return blurred;
}
function clampBBox(bb, W, H) {
  const x = Math.max(0, Math.min(W - 1, bb.x));
  const y = Math.max(0, Math.min(H - 1, bb.y));
  const w = Math.max(1, Math.min(W - x, bb.w));
  const h = Math.max(1, Math.min(H - y, bb.h));
  return { x, y, w, h };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/process", upload.any(), async (req, res) => {
  try {
    const srcFile = pick(req, ["sourceImage","source_image","distorted","base"]);
    const refFile = pick(req, ["referenceImage","reference_image","reference","clean"]);
    const aFile   = pick(req, ["sourceMask","source_mask","mask","maskA"]);
    const bFile   = pick(req, ["referenceMask","reference_mask","maskB"]);

    if (!srcFile || !refFile || !aFile || !bFile) {
      return res.status(400).json({ error: "Missing files" });
    }

    const srcPng = await sharp(srcFile.buffer).png().toBuffer();
    const refPng = await sharp(refFile.buffer).png().toBuffer();
    const aPng   = await sharp(aFile.buffer).png().toBuffer();
    const bPng   = await sharp(bFile.buffer).png().toBuffer();

    const base = await Jimp.read(srcPng);
    let ref   = await Jimp.read(refPng);
    let maskA = await Jimp.read(aPng);
    let maskB = await Jimp.read(bPng);

    const W = base.bitmap.width, H = base.bitmap.height;
    ref.resize(W, H); maskA.resize(W, H); maskB.resize(W, H);

    const bbA = await maskBBox(maskA);
    const bbB = await maskBBox(maskB);
    if (!bbA || !bbB) return res.status(400).json({ error: "Empty mask" });

    const A = clampBBox(bbA, W, H), B = clampBBox(bbB, W, H);

    const refCrop = ref.clone().crop(B.x, B.y, B.w, B.h).resize(A.w, A.h);
    const distortedPatch = base.clone().crop(A.x, A.y, A.w, A.h);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const refCropBuf = await refCrop.getBufferAsync(Jimp.MIME_PNG);
    const distortedBuf = await distortedPatch.getBufferAsync(Jimp.MIME_PNG);

    const prompt = "Regenerate the distorted patch so it matches the reference design. Keep size/perspective unchanged.";

    const result = await model.generateContent([
      { inlineData: { mimeType: "image/png", data: b64(distortedBuf) } },
      { inlineData: { mimeType: "image/png", data: b64(refCropBuf) } },
      { text: prompt }
    ]);

    const parts = result?.response?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.data);
    if (!imgPart) return res.status(502).json({ error: "Model returned no image" });

    const nanoPatchBuf = Buffer.from(imgPart.inlineData.data, "base64");

    const refPatchCanvas = new Jimp(W, H, 0x00000000);
    const nanoPatch = await Jimp.read(nanoPatchBuf);
    nanoPatch.resize(A.w, A.h);
    refPatchCanvas.composite(nanoPatch, A.x, A.y);

    const feathered = await feather(maskA, 4);
    refPatchCanvas.mask(feathered, 0, 0);

    const out = base.clone().composite(refPatchCanvas, 0, 0);
    const png = await out.getBufferAsync(Jimp.MIME_PNG);
    res.set("Content-Type", "image/png").send(png);
  } catch (err) {
    console.error("Worker error:", err);
    res.status(500).json({ error: "Processing failed", details: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Worker listening on ${PORT}`));

