/**
 * Firebase Admin SDK - OPTIONAL
 * 
 * Firebase is completely optional for Sudo Studio.
 * If the service account JSON is not found, Firebase is disabled silently.
 * The application continues to work without Firebase.
 */

let admin = null;
let firebaseEnabled = false;

try {
  const adminSDK = require('firebase-admin');
  const serviceAccountPath = './config/sudo-studio-522bb-firebase-adminsdk-fbsvc-9d13a4a831.json';
  
  // Only initialize if the service account file exists
  const fs = require('fs');
  const path = require('path');
  const fullPath = path.join(__dirname, '..', serviceAccountPath.replace('./config/', ''));
  
  if (fs.existsSync(fullPath)) {
    const serviceAccount = require(fullPath);
    adminSDK.initializeApp({
      credential: adminSDK.credential.cert(serviceAccount),
    });
    admin = adminSDK;
    firebaseEnabled = true;
    console.log('[Firebase] ✅ Firebase Admin SDK initialized');
  } else {
    console.log('[Firebase] ℹ️ Service account not found - Firebase disabled (optional)');
    console.log('[Firebase] ℹ️ App will work without Firebase features');
  }
} catch (e) {
  console.log('[Firebase] ℹ️ Firebase not available:', e.message);
  console.log('[Firebase] ℹ️ Continuing without Firebase (optional service)');
}

module.exports = {
  admin,
  firebaseEnabled,
  // Helper to check if Firebase is available before using it
  isAvailable: () => firebaseEnabled && admin !== null
};
