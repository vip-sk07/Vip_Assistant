import { google } from 'googleapis';
import fs from 'fs/promises';
import path from 'path';

/**
 * Creates a Google Drive API client using API Key or Service Account credentials
 */
export function createDriveClient(config = {}) {
  const { apiKey, serviceAccountPath } = config;

  // 1. Service Account authentication
  const servicePath = serviceAccountPath || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;
  if (servicePath) {
    const auth = new google.auth.GoogleAuth({
      keyFile: servicePath,
      scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    return google.drive({ version: 'v3', auth });
  }

  // 2. OAuth2 Client Credentials (Client ID + Client Secret + Refresh Token / Access Token)
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  const oauthToken = process.env.GOOGLE_DRIVE_OAUTH_TOKEN;

  if (clientId && clientSecret) {
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    if (refreshToken) {
      auth.setCredentials({ refresh_token: refreshToken });
      return google.drive({ version: 'v3', auth });
    } else if (oauthToken) {
      auth.setCredentials({ access_token: oauthToken });
      return google.drive({ version: 'v3', auth });
    } else {
      const authUrl = auth.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/drive.readonly']
      });
      const err = new Error(`OAuth2 Refresh Token is missing. Please authorize your app via this URL:\n${authUrl}\nand set GOOGLE_REFRESH_TOKEN=your_refresh_token in vip-assistant/.env`);
      err.authUrl = authUrl;
      throw err;
    }
  }

  if (oauthToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: oauthToken });
    return google.drive({ version: 'v3', auth });
  }

  // 3. Fallback API Key authentication (for public drive files)
  const effectiveApiKey = apiKey || process.env.GOOGLE_DRIVE_API_KEY || process.env.GEMINI_API_KEY;
  if (effectiveApiKey) {
    return google.drive({ version: 'v3', auth: effectiveApiKey });
  }

  return null;
}

/**
 * List documents in a Google Drive folder or search by query string
 */
export async function listDriveFiles(drive, folderId = null, queryStr = '') {
  if (!drive) {
    throw new Error('Google Drive client is not initialized. Please provide an API key or Service Account key.');
  }

  let q = "trashed = false";
  if (folderId) {
    q += ` and '${folderId}' in parents`;
  }
  if (queryStr) {
    q += ` and (name contains '${queryStr}' or fullText contains '${queryStr}')`;
  }

  const res = await drive.files.list({
    q,
    pageSize: 50,
    fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
    orderBy: 'modifiedTime desc'
  });

  return res.data.files || [];
}

/**
 * Fetch text content of a Google Drive file (Google Docs, plain text, markdown, JSON, etc.)
 */
export async function fetchDriveFileContent(drive, fileId, mimeType) {
  if (!drive) {
    throw new Error('Google Drive client is not initialized.');
  }

  // Handle Google Docs format by exporting as plain text
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain'
    });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }

  // Handle Google Spreadsheets by exporting as CSV
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/csv'
    });
    return typeof res.data === 'string' ? res.data : String(res.data);
  }

  // Standard binary/text file download
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'text' }
  );

  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

/**
 * Index a Google Drive folder into VIP Assistant's vectorDb array
 */
export async function indexDriveFolderToRAG(drive, folderId, vectorDb, embedChunkFn, saveCacheFn) {
  if (!drive) {
    throw new Error('Google Drive client is not initialized.');
  }

  console.log(`[Google Drive Library] Syncing folder ID: ${folderId}...`);
  const files = await listDriveFiles(drive, folderId);
  let newlyIndexedCount = 0;

  for (const file of files) {
    // Skip folders or non-text binaries
    if (file.mimeType === 'application/vnd.google-apps.folder') continue;

    const drivePath = `[GoogleDrive]/${file.name}`;
    
    // Remove old vectors for this file if re-indexing
    for (let i = vectorDb.length - 1; i >= 0; i--) {
      if (vectorDb[i].filePath === drivePath) {
        vectorDb.splice(i, 1);
      }
    }

    try {
      const text = await fetchDriveFileContent(drive, file.id, file.mimeType);
      if (!text || text.trim().length === 0) continue;

      // Chunk text into 1000 character segments
      const CHUNK_SIZE = 1000;
      const CHUNK_OVERLAP = 200;
      let start = 0;
      let chunkIdx = 0;

      while (start < text.length) {
        const end = Math.min(start + CHUNK_SIZE, text.length);
        const chunkText = text.substring(start, end);
        
        // Generate embedding
        const embedding = await embedChunkFn(chunkText);

        vectorDb.push({
          filePath: drivePath,
          chunkIndex: chunkIdx,
          content: chunkText,
          embedding,
          fileId: file.id,
          webViewLink: file.webViewLink
        });

        chunkIdx++;
        start += (CHUNK_SIZE - CHUNK_OVERLAP);
        newlyIndexedCount++;
      }
      console.log(`[Google Drive Library] Indexed file: ${file.name} (${chunkIdx} chunks)`);
    } catch (err) {
      console.error(`[Google Drive Library] Failed to index ${file.name}:`, err.message);
    }
  }

  if (saveCacheFn && newlyIndexedCount > 0) {
    await saveCacheFn();
  }

  return { totalFiles: files.length, indexedChunks: newlyIndexedCount };
}
