/**
 * BadRobot worker - Nano Banana patch-regeneration mode
 */

import express from "express";
import multer from "multer";
import cors from "cors";
import sharp from "sharp";
import Jimp from "jimp";
import { GoogleGenerativeAI } from "@google/generative-ai";

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

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

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
    console.log("---- /process ----");
    console.log("fields:", (req.files || []).map(f => `${f.fieldname}:${f.mimetype}:${f.size}`).join(", "));

    const srcFile = pick(req, ["sourceImage","source_image","distorted","base"]);
    const refFile = pick(req, ["referenceImage","reference_image","reference","clean"]);
    const aFile   = pick(req, ["sourceMask","source_mask","mask","maskA"]);
    const bFile   = pick(req, ["referenceMask","reference_ma_]()
