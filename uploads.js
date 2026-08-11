'use strict';

const multer = require('multer');
const db = require('../db');
const config = require('../config');

/**
 * Files are held in memory by multer and then written into PostgreSQL (bytea).
 * This is deliberate: Render's filesystem is ephemeral, so anything written to
 * disk disappears on redeploy. Storing bytes in the same persistent Postgres
 * instance means payment proof, chat attachments, voice notes and Proof of Work
 * images survive restarts and redeployments with no extra cloud credentials.
 */

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

const DOC_MIMES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/rtf',
  'application/zip',
];

const AUDIO_MIMES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/m4a',
  'audio/x-m4a',
  'audio/webm;codecs=opus',
];

const ALL_MIMES = [...IMAGE_MIMES, ...DOC_MIMES, ...AUDIO_MIMES];

const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();

function makeUploader(allowed) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxUploadBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
      const mime = baseMime(file.mimetype);
      if (!allowed.includes(mime)) {
        return cb(new Error(`Unsupported file type: ${file.mimetype}`));
      }
      cb(null, true);
    },
  });
}

const uploadAny = makeUploader(ALL_MIMES);
const uploadImage = makeUploader(IMAGE_MIMES);
const uploadProof = makeUploader([...IMAGE_MIMES, 'application/pdf']);

function classify(mimetype) {
  const mime = baseMime(mimetype);
  if (IMAGE_MIMES.includes(mime)) return 'image';
  if (AUDIO_MIMES.includes(mime)) return 'voice';
  return 'file';
}

async function saveFile({ buffer, originalname, mimetype, ownerId, kind = 'attachment', isPublic = false }) {
  const row = await db.one(
    `INSERT INTO files (owner_id, filename, mime_type, size_bytes, kind, data, is_public)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, filename, mime_type, size_bytes, kind, created_at`,
    [
      ownerId || null,
      String(originalname || 'upload').slice(0, 255),
      baseMime(mimetype) || 'application/octet-stream',
      buffer.length,
      kind,
      buffer,
      isPublic,
    ]
  );
  return row;
}

async function getFileMeta(id) {
  return db.one('SELECT id, owner_id, filename, mime_type, size_bytes, kind, is_public, created_at FROM files WHERE id = $1', [id]);
}

async function getFile(id) {
  return db.one('SELECT * FROM files WHERE id = $1', [id]);
}

/** Turns multer errors into clean, user-readable messages. */
function uploadErrorHandler(err, _req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Maximum size is ${config.maxUploadMb}MB.` });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (/Unsupported file type/.test(err.message)) {
    return res.status(415).json({ error: err.message });
  }
  return next(err);
}

module.exports = {
  uploadAny,
  uploadImage,
  uploadProof,
  saveFile,
  getFile,
  getFileMeta,
  classify,
  uploadErrorHandler,
  IMAGE_MIMES,
  DOC_MIMES,
  AUDIO_MIMES,
  ALL_MIMES,
};
