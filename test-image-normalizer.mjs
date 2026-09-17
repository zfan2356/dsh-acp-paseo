#!/usr/bin/env node
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { normalizeEncodedImageForAttachmentStore } from './lib/image-normalizer.js'

const limits = {
  maxImageBytes: 3.5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

async function encodedPng(width, height) {
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 32, g: 96, b: 160 },
    },
  })
    .png()
    .toBuffer()
  return bytes.toString('base64')
}

const oversized = {
  mediaType: 'image/png',
  data: await encodedPng(1_200, 2_400),
}
const normalized = await normalizeEncodedImageForAttachmentStore(oversized, limits)
const resized = await sharp(Buffer.from(normalized.data, 'base64')).metadata()

assert.deepEqual(
  { width: resized.width, height: resized.height, format: resized.format },
  { width: 1_000, height: 2_000, format: 'png' },
)
assert.notEqual(normalized.data, oversized.data)

const withinLimit = {
  mediaType: 'image/png',
  data: await encodedPng(800, 1_600),
}
assert.strictEqual(
  await normalizeEncodedImageForAttachmentStore(withinLimit, limits),
  withinLimit,
)

const invalid = { mediaType: 'image/png', data: 'not-base64' }
assert.strictEqual(await normalizeEncodedImageForAttachmentStore(invalid, limits), invalid)

console.log('ALL CHECKS PASSED')
